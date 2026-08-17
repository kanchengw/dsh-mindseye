import type { JsonValue, TokenUsage, VisionReadOptions, VisionResult } from './types.js'
import type { VisionRoute } from './types.js'
import { normalizeQuery } from './query.js'
import { cacheKeyOf, type CacheIdentity } from './cache.js'
import { buildImageInfo, fingerprintBytes } from './evidence.js'
import { normalizeBaseUrl, routeLabel } from './route.js'
import type { BatchVisionResult } from './providers.js'
import type { VisionIntent } from './types.js'
import { extractStructured, parseStructuredValue } from './bridge/evidence-extract.js'
import { buildUserNotice } from './bridge/notice.js'
import { evidenceContextOf, evidenceToRecord, pureEvidenceAnswer } from './memory/evidence.js'
import type { SoftMemoryHit, SoftMemoryQuery, VisualEvidenceRecord } from './memory/types.js'

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
  memory?: {
    getEvidence: (sha256: string) => VisualEvidenceRecord | undefined
    putEvidence: (record: VisualEvidenceRecord) => Promise<void>
    searchSoftMemory?: (query: SoftMemoryQuery) => Promise<SoftMemoryHit[]>
  }
  userNotice?: boolean
  buildPrompt: (intent: VisionResult['intent'], query?: string, region?: string) => string
  toDataUrl: (bytes: Uint8Array, format: string) => string
}

export interface CreateBatchVisionToolDeps {
  readImage: (input: { path?: string; attachmentId?: string }) => Promise<Uint8Array>
  probeImage: (bytes: Uint8Array) => Promise<{ width: number; height: number; format: string }>
  cache?: {
    get: (key: string) => VisionResult | undefined
    set: (key: string, result: VisionResult) => void
  }
  runVisionBatch: (options: {
    images: Array<{ id: string; dataUrl: string }>
    prompt: string
    routes: VisionRoute[]
  }) => Promise<BatchVisionResult>
  memory?: {
    getEvidence: (sha256: string) => VisualEvidenceRecord | undefined
    putEvidence: (record: VisualEvidenceRecord) => Promise<void>
    searchSoftMemory?: (query: SoftMemoryQuery) => Promise<SoftMemoryHit[]>
  }
  userNotice?: boolean
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
  const intent = options.intent ?? 'visual-qa'
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
        meta: {
          ...cached.meta,
          cache: 'hit' as const,
          source: 'exact-cache',
          modelCall: false,
          ...(deps.userNotice !== false ? { userNotice: buildUserNotice({ cache: 'hit' }) } : {}),
        },
      },
      fromCache: true,
    }
  }

  const stored = deps.memory?.getEvidence(sha256)
  const pureHit = stored === undefined
    ? undefined
    : pureEvidenceAnswer(intent, stored, options.query)
  if (pureHit !== undefined && stored !== undefined) {
    const result: VisionResult = {
      version: 1,
      intent,
      ...(normalizedQuery === '' ? {} : { query: normalizedQuery }),
      images: [image],
      evidence: pureHit.evidence,
      answer: { text: pureHit.text, structured: pureHit.evidence },
      meta: {
        provider: routeLabel(route.baseUrl),
        model: identity.model,
        latencyMs: 0,
        attempts: [],
        cache: 'miss',
        matchedEvidenceIds: [stored.id],
        source: 'evidence',
        modelCall: false,
        ...(deps.userNotice !== false ? { userNotice: buildUserNotice({ cache: 'miss', source: 'evidence' }) } : {}),
      },
    }
    return { result, fromCache: false }
  }

  const started = Date.now()
  let prompt = deps.buildPrompt(intent, options.query, options.region)
  if (stored !== undefined) {
    prompt += `\n\n已存储的图片证据（图片级，可信，无需重新提取）：\n${JSON.stringify(evidenceContextOf(stored))}`
  }
  const softStart = Date.now()
  const softHits = deps.memory?.searchSoftMemory === undefined
    ? []
    : await deps.memory.searchSoftMemory({
        query: normalizedQuery,
        evidenceId: sha256,
        limit: 3,
      })
  const retrievalMs = Date.now() - softStart
  if (softHits.length > 0) {
    prompt += '\n\n历史参考（未验证，仅供上下文补强）：\n'
      + softHits.map((hit) => `Q: ${hit.record.normalizedQuery}\nA: ${hit.record.answerText}`).join('\n\n')
  }
  const vision = await deps.runVision({
    dataUrl: deps.toDataUrl(bytes, image.format),
    prompt,
    route,
  })
  const extracted = extractStructured(vision.analysis.text, intent)
  if (deps.memory !== undefined && extracted !== undefined && Object.keys(extracted.evidence).length > 0) {
    const storedFields = evidenceToRecord(extracted.evidence)
    if (Object.keys(storedFields).length > 0) {
      await deps.memory.putEvidence({
        id: sha256,
        sha256,
        width: image.width,
        height: image.height,
        format: image.format,
        ...storedFields,
        provider: routeLabel(route.baseUrl),
        model: identity.model,
        createdAt: Date.now(),
      })
    }
  }
  const answer = extracted === undefined
    ? vision.analysis
    : { text: extracted.answer, structured: extracted.evidence }
  const result: VisionResult = {
    version: 1,
    intent,
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
      ...(stored === undefined ? {} : { matchedEvidenceIds: [stored.id] }),
      ...(softHits.length === 0 ? {} : { softMemoryHits: softHits.length, retrievalMs }),
      source: softHits.length > 0 ? 'soft-memory' : 'model',
      modelCall: true,
      ...(softHits.length > 0 && deps.userNotice !== false
        ? { userNotice: buildUserNotice({ cache: 'miss', source: 'soft-memory', softMemoryHits: softHits.length }) }
        : {}),
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
  const pending: Array<{ id: string; dataUrl: string }> = []
  const resultsJson: Record<string, JsonValue> = {}
  const errorsJson: Record<string, JsonValue> = {}
  const matchedEvidenceIds: string[] = []
  const infoBySha = new Map<string, { width: number; height: number; format: string }>()
  for (const id of options.attachmentIds) {
    const bytes = await deps.readImage({ attachmentId: id })
    const sha256 = fingerprintBytes(bytes)
    const info = buildImageInfo({ ...(await deps.probeImage(bytes)), sha256, path: undefined })
    images.push(info)
    infoBySha.set(sha256, { width: info.width, height: info.height, format: info.format })
    const stored = deps.memory?.getEvidence(sha256)
    if (stored !== undefined) {
      const pure = pureEvidenceAnswer(options.intent, stored, options.query)
      if (pure !== undefined) {
        matchedEvidenceIds.push(stored.id)
        resultsJson[sha256] = { text: pure.text, evidence: pure.evidence }
        continue
      }
      matchedEvidenceIds.push(stored.id)
    }
    pending.push({ id: sha256, dataUrl: deps.toDataUrl(bytes, info.format) })
  }

  const cacheKey = JSON.stringify([
    images.map((image) => image.sha256).sort(),
    normalizeQuery(options.query),
    options.region ?? '',
    normalizeBaseUrl(route.baseUrl),
    route.model,
    PROMPT_VERSION,
  ])
  const cached = deps.cache?.get(cacheKey)
  if (cached !== undefined) {
    return {
      ...cached,
      meta: {
        ...cached.meta,
        cache: 'hit' as const,
        source: 'exact-cache',
        modelCall: false,
        ...(deps.userNotice !== false ? { userNotice: buildUserNotice({ cache: 'hit' }) } : {}),
      },
    }
  }

  const started = Date.now()
  let outcome: BatchVisionResult | undefined
  if (pending.length > 0) {
    outcome = await deps.runVisionBatch({
      images: pending,
      prompt: deps.buildBatchPrompt(options.intent, pending.map((item) => item.id), options.query, options.region),
      routes,
    })
    for (const [id, text] of outcome.results) {
      const structured = parseStructuredValue(text, options.intent)
      const evidence = structured?.evidence
      resultsJson[id] = structured === undefined
        ? { text }
        : {
            text: structured.text,
            ...(evidence !== undefined && Object.keys(evidence).length > 0 ? { evidence } : {}),
          }
      if (deps.memory !== undefined && evidence !== undefined && Object.keys(evidence).length > 0) {
        const storedFields = evidenceToRecord(evidence)
        if (Object.keys(storedFields).length > 0) {
          const info = infoBySha.get(id)
          await deps.memory.putEvidence({
            id,
            sha256: id,
            width: info?.width ?? 0,
            height: info?.height ?? 0,
            format: info?.format ?? 'png',
            ...storedFields,
            provider: routeLabel(route.baseUrl),
            model: route.model,
            createdAt: Date.now(),
          })
        }
      }
    }
    for (const [id, message] of outcome.errors) {
      errorsJson[id] = { error: message }
    }
  }
  const structured: JsonValue = { results: resultsJson, errors: errorsJson }
  const result: VisionResult = {
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
      attempts: (outcome?.attempts ?? []) as unknown as VisionResult['meta']['attempts'],
      cache: 'miss',
      ...(outcome?.usage === undefined ? {} : { usage: outcome.usage }),
      ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
      ...(matchedEvidenceIds.length === 0 ? {} : { matchedEvidenceIds }),
      source: pending.length === 0 ? 'evidence' : 'model',
      modelCall: pending.length > 0,
      ...(pending.length === 0 && deps.userNotice !== false
        ? { userNotice: buildUserNotice({ cache: 'miss', source: 'evidence' }) }
        : {}),
    },
  }
  deps.cache?.set(cacheKey, result)
  return result
}
