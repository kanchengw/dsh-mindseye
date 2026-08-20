import type { JsonValue, TokenUsage, VisionReadOptions, VisionResult } from './types.js'
import type { VisionRoute } from './types.js'
import { normalizeQuery } from './query.js'
import { cacheKeyOf, type CacheIdentity } from './cache.js'
import { buildImageInfo, fingerprintBytes } from './evidence.js'
import { normalizeBaseUrl, routeLabel } from './route.js'
import type { BatchVisionResult } from './providers.js'
import type { VisionIntent } from './types.js'
import type { EvidenceKind } from './types.js'
import { extractStructured, parseStructuredValue } from './bridge/evidence-extract.js'
import { buildUserNotice } from './bridge/notice.js'
import { evidenceContextOf, evidenceToRecord, pureEvidenceAnswer } from './memory/evidence.js'
import { pureExtractEvidenceAnswer } from './memory/evidence.js'
import type { SoftMemoryHit, SoftMemoryQuery, VisualAnalysisRecord, VisualEvidenceRecord } from './memory/types.js'
import type { PromptOptions } from './prompt.js'

export const PROMPT_VERSION = 'mindseye-v1'

function normalizeExtract(extract: EvidenceKind[] | undefined): EvidenceKind[] {
  if (!Array.isArray(extract)) return []
  const kinds: EvidenceKind[] = []
  for (const value of extract) {
    if (value === 'ocr' || value === 'layout' || value === 'colors') kinds.push(value)
  }
  return [...new Set(kinds)]
}

export interface CreateVisionToolDeps {
  readImage: (input: { path?: string; attachmentId?: string; agent?: unknown }) => Promise<Uint8Array>
  probeImage: (bytes: Uint8Array) => Promise<{ width: number; height: number; format: string }>
  cache?: {
    get: (key: string) => VisionResult | undefined
    set: (key: string, result: VisionResult) => void
  }
  runVision: (options: {
    dataUrl: string
    prompt: string
    routes: VisionRoute[]
  }) => Promise<{
    analysis: VisionResult['answer']
    usage?: TokenUsage
    provider?: string
    model?: string
    attempts?: VisionResult['meta']['attempts']
  }>
  memory?: {
    getEvidence: (sha256: string) => VisualEvidenceRecord | undefined
    putEvidence: (record: VisualEvidenceRecord) => Promise<void>
    putAnalysis?: (record: VisualAnalysisRecord) => Promise<void>
    searchSoftMemory?: (query: SoftMemoryQuery) => Promise<SoftMemoryHit[]>
  }
  userNotice?: boolean
  buildPrompt: (intent: VisionResult['intent'], options?: PromptOptions) => string
  toDataUrl: (bytes: Uint8Array, format: string) => string
}

export interface CreateBatchVisionToolDeps {
  readImage: (input: { path?: string; attachmentId?: string; agent?: unknown }) => Promise<Uint8Array>
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
    putAnalysis?: (record: VisualAnalysisRecord) => Promise<void>
    searchSoftMemory?: (query: SoftMemoryQuery) => Promise<SoftMemoryHit[]>
  }
  userNotice?: boolean
  buildBatchPrompt: (intent: VisionResult['intent'], ids: string[], options?: PromptOptions) => string
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
    agent: options.agent,
  })
  const sha256 = fingerprintBytes(bytes)
  const image = buildImageInfo({ ...(await deps.probeImage(bytes)), sha256, path: options.path })
  const intent = options.intent ?? 'visual-qa'
  const normalizedQuery = normalizeQuery(options.query)
  const exactQuery = options.query?.trim() ?? ''
  const extract = normalizeExtract(options.extract)
  const route = routes[0]
  if (route === undefined) {
    throw new Error('mindseye: no vision route configured')
  }
  const identity: CacheIdentity = {
    sha256,
    query: normalizedQuery,
    intent,
    extract,
    context: options.context ?? '',
    historyContext: options.historyContext ?? [],
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
    : extract.length > 0
      ? pureExtractEvidenceAnswer(extract, stored)
      : pureEvidenceAnswer(intent, stored, options.query)
  if (pureHit !== undefined && stored !== undefined) {
    const result: VisionResult = {
      version: 1,
      intent,
      ...(exactQuery === '' ? {} : { query: exactQuery }),
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
  let prompt = deps.buildPrompt(intent, {
    currentRequest: options.query,
    context: options.context,
    historyContext: options.historyContext,
    region: options.region,
    extract,
  })
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
    routes,
  })
  const actualProvider = vision.provider ?? routeLabel(route.baseUrl)
  const actualModel = vision.model ?? identity.model
  const actualAttempts = vision.attempts ?? [{
    provider: actualProvider,
    model: actualModel,
    ok: true,
    latencyMs: Date.now() - started,
    error: '',
  }]
  const extracted = extractStructured(vision.analysis.text, intent, extract)
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
        provider: actualProvider,
        model: actualModel,
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
    ...(exactQuery === '' ? {} : { query: exactQuery }),
    images: [image],
    evidence: extracted?.evidence ?? {},
    answer,
    meta: {
      provider: actualProvider,
      model: actualModel,
      latencyMs: Date.now() - started,
      attempts: actualAttempts,
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
  if (deps.memory?.putAnalysis !== undefined) {
    const now = Date.now()
    await deps.memory.putAnalysis({
      id: `analysis-${now}-${Math.random().toString(36).slice(2)}`,
      evidenceId: sha256,
      intent,
      normalizedQuery,
      ...(options.region === undefined ? {} : { region: options.region }),
      provider: actualProvider,
      model: actualModel,
      promptVersion: PROMPT_VERSION,
      answerText: answer.text,
      source: 'model-inferred',
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      importance: 1,
    })
  }
  deps.cache?.set(key, result)
  return { result, fromCache: false }
}

export interface BatchReadOptions {
  attachmentIds: string[]
  agent?: unknown
  intent: VisionIntent
  query?: string
  extract?: EvidenceKind[]
  context?: string
  historyContext?: string[]
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
  const exactQuery = options.query?.trim() ?? ''
  const extract = normalizeExtract(options.extract)
  const images: VisionResult['images'] = []
  const pending: Array<{ id: string; dataUrl: string }> = []
  const resultsJson: Record<string, JsonValue> = {}
  const errorsJson: Record<string, JsonValue> = {}
  const matchedEvidenceIds: string[] = []
  const infoBySha = new Map<string, { width: number; height: number; format: string }>()
  for (const id of options.attachmentIds) {
    const bytes = await deps.readImage({ attachmentId: id, agent: options.agent })
    const sha256 = fingerprintBytes(bytes)
    const info = buildImageInfo({ ...(await deps.probeImage(bytes)), sha256, path: undefined })
    images.push(info)
    infoBySha.set(sha256, { width: info.width, height: info.height, format: info.format })
    const stored = deps.memory?.getEvidence(sha256)
    if (stored !== undefined) {
      const pure = extract.length > 0
        ? pureExtractEvidenceAnswer(extract, stored)
        : pureEvidenceAnswer(options.intent, stored, options.query)
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
    images.map((image) => image.sha256),
    normalizeQuery(options.query),
    options.intent,
    extract.join(','),
    options.context ?? '',
    (options.historyContext ?? []).join('\n'),
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
      prompt: deps.buildBatchPrompt(options.intent, pending.map((item) => item.id), {
        currentRequest: options.query,
        context: options.context,
        historyContext: options.historyContext,
        region: options.region,
        extract,
      }),
      routes,
    })
    for (const [id, text] of outcome.results) {
      const source = outcome.sources?.get(id) ?? { provider: routeLabel(route.baseUrl), model: route.model }
      const structured = parseStructuredValue(text, options.intent, extract)
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
            provider: source.provider,
            model: source.model,
            createdAt: Date.now(),
          })
        }
      }
      if (deps.memory?.putAnalysis !== undefined) {
        const now = Date.now()
        await deps.memory.putAnalysis({
          id: `analysis-${now}-${Math.random().toString(36).slice(2)}`,
          evidenceId: id,
          intent: options.intent,
          normalizedQuery: normalizeQuery(options.query),
          provider: source.provider,
          model: source.model,
          promptVersion: PROMPT_VERSION,
          answerText: structured?.text ?? text,
          source: 'model-inferred',
          createdAt: now,
          lastAccessedAt: now,
          accessCount: 0,
          importance: 1,
        })
      }
    }
    for (const [id, message] of outcome.errors) {
      errorsJson[id] = { error: message }
    }
  }
  const structured: JsonValue = { results: resultsJson, errors: errorsJson }
  const successfulSources = [...new Map(
    [...(outcome?.sources?.values() ?? [])].map((source) => [`${source.provider}\u0000${source.model}`, source]),
  ).values()]
  const batchSource = successfulSources.length === 1
    ? successfulSources[0]!
    : successfulSources.length > 1
      ? { provider: 'mixed', model: 'mixed' }
      : { provider: routeLabel(route.baseUrl), model: route.model }
  const result: VisionResult = {
    version: 1,
    intent: options.intent,
    ...(exactQuery === '' ? {} : { query: exactQuery }),
    images,
    evidence: {},
    answer: { text: JSON.stringify(structured, null, 2), structured },
    meta: {
      provider: batchSource.provider,
      model: batchSource.model,
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
