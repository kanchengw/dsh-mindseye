import type { JsonValue, TokenUsage, VisionReadOptions, VisionResult } from './types.js'
import type { VisionRoute } from './types.js'
import { classifyIntent } from './intent.js'
import { normalizeQuery } from './query.js'
import { cacheKeyOf, type CacheIdentity } from './cache.js'
import { buildImageInfo, fingerprintBytes } from './evidence.js'
import { normalizeBaseUrl, routeLabel } from './route.js'
import type { BatchVisionResult } from './providers.js'
import type { VisionIntent } from './types.js'
import { extractStructured, parseStructuredValue } from './bridge/evidence-extract.js'

export const PROMPT_VERSION = 'mindseye-v1'

export interface CreateVisionToolDeps {
  readImage: (input: { path?: string; attachmentId?: string }) => Promise<Uint8Array>
  probeImage: (bytes: Uint8Array) => Promise<{ width: number; height: number; format: string }>
  cache?: {
    get: (key: string) => VisionResult | undefined
    set: (key: string, result: VisionResult) => void
  }
  runVision: (options: {
    dataUrl: string
    prompt: string
    route: VisionRoute
  }) => Promise<{ analysis: VisionResult['answer']; usage?: TokenUsage }>
  buildPrompt: (intent: VisionResult['intent'], query?: string, region?: string) => string
  toDataUrl: (bytes: Uint8Array, format: string) => string
}

export interface CreateBatchVisionToolDeps {
  readImage: (input: { path?: string; attachmentId?: string }) => Promise<Uint8Array>
  probeImage: (bytes: Uint8Array) => Promise<{ width: number; height: number; format: string }>
  runVisionBatch: (options: {
    images: Array<{ id: string; dataUrl: string }>
    prompt: string
    routes: VisionRoute[]
  }) => Promise<BatchVisionResult>
  buildBatchPrompt: (intent: VisionResult['intent'], ids: string[], query?: string, region?: string) => string
  toDataUrl: (bytes: Uint8Array, format: string) => string
}

export interface VisionReadResponse {
  result: VisionResult
  fromCache: boolean
}

export async function readImageWithMindsEye(
  options: VisionReadOptions,
  deps: CreateVisionToolDeps,
  routes: VisionRoute[],
): Promise<VisionReadResponse> {
  const bytes = await deps.readImage({
    path: options.path,
    attachmentId: options.attachmentId,
  })
  const sha256 = fingerprintBytes(bytes)
  const image = buildImageInfo({ ...(await deps.probeImage(bytes)), sha256, path: options.path })
  const classification = classifyIntent(options.query, options.intent)
  const normalizedQuery = normalizeQuery(options.query)
  const route = routes[0]
  if (route === undefined) {
    throw new Error('mindseye: no vision route configured')
  }
  const identity: CacheIdentity = {
    sha256,
    query: normalizedQuery,
    region: options.region,
    baseUrl: normalizeBaseUrl(route.baseUrl),
    model: options.model ?? route.model,
    promptVersion: PROMPT_VERSION,
  }
  const key = cacheKeyOf(identity)
  const cached = deps.cache?.get(key)
  if (cached !== undefined) {
    return {
      result: {
        ...cached,
        meta: { ...cached.meta, cache: 'hit' as const },
      },
      fromCache: true,
    }
  }

  const started = Date.now()
  const prompt = deps.buildPrompt(classification.intent, options.query, options.region)
  const vision = await deps.runVision({
    dataUrl: deps.toDataUrl(bytes, image.format),
    prompt,
    route,
  })
  const extracted = extractStructured(vision.analysis.text, classification.intent)
  const answer = extracted === undefined
    ? vision.analysis
    : { text: extracted.answer, structured: extracted.evidence }
  const result: VisionResult = {
    version: 1,
    intent: classification.intent,
    ...(normalizedQuery === '' ? {} : { query: normalizedQuery }),
    images: [image],
    evidence: extracted?.evidence ?? {},
    answer,
    meta: {
      provider: routeLabel(route.baseUrl),
      model: identity.model,
      latencyMs: Date.now() - started,
      attempts: [{ provider: routeLabel(route.baseUrl), model: identity.model, ok: true, latencyMs: Date.now() - started, error: '' }],
      cache: 'miss',
      ...(vision.usage === undefined ? {} : { usage: vision.usage }),
      ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    },
  }
  deps.cache?.set(key, result)
  return { result, fromCache: false }
}

export interface BatchReadOptions {
  attachmentIds: string[]
  intent: VisionIntent
  query?: string
  region?: string
  fallback?: string
}

export async function readImagesWithMindsEye(
  options: BatchReadOptions,
  deps: CreateBatchVisionToolDeps,
  routes: VisionRoute[],
): Promise<VisionResult> {
  const route = routes[0]
  if (route === undefined) {
    throw new Error('mindseye: no vision route configured')
  }
  const images: VisionResult['images'] = []
  const payload: Array<{ id: string; dataUrl: string }> = []
  for (const id of options.attachmentIds) {
    const bytes = await deps.readImage({ attachmentId: id })
    const sha256 = fingerprintBytes(bytes)
    const info = buildImageInfo({ ...(await deps.probeImage(bytes)), sha256, path: undefined })
    images.push(info)
    payload.push({ id, dataUrl: deps.toDataUrl(bytes, info.format) })
  }

  const started = Date.now()
  const outcome = await deps.runVisionBatch({
    images: payload,
    prompt: deps.buildBatchPrompt(options.intent, options.attachmentIds, options.query, options.region),
    routes,
  })
  const resultsJson: Record<string, JsonValue> = {}
  const errorsJson: Record<string, JsonValue> = {}
  for (const [id, text] of outcome.results) {
    const structured = parseStructuredValue(text)
    resultsJson[id] = structured === undefined
      ? { text }
      : {
          text: structured.text,
          ...(Object.keys(structured.evidence).length > 0 ? { evidence: structured.evidence } : {}),
        }
  }
  for (const [id, message] of outcome.errors) {
    errorsJson[id] = { error: message }
  }
  const structured: JsonValue = { results: resultsJson, errors: errorsJson }
  return {
    version: 1,
    intent: options.intent,
    ...(normalizeQuery(options.query) === '' ? {} : { query: normalizeQuery(options.query) }),
    images,
    evidence: {},
    answer: { text: JSON.stringify(structured, null, 2), structured },
    meta: {
      provider: routeLabel(route.baseUrl),
      model: route.model,
      latencyMs: Date.now() - started,
      attempts: outcome.attempts as unknown as VisionResult['meta']['attempts'],
      cache: 'miss',
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    },
  }
}
