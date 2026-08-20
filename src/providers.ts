import type { TokenUsage, VisionAnalysis, VisionRoute } from './types.js'
import { routeLabel } from './route.js'

export type ProviderErrorKind =
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'invalid-input'
  | 'network'
  | 'unknown'

export class VisionProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface ProviderCallOptions {
  dataUrl: string
  prompt: string
  route: VisionRoute
  apiKey: string
  signal?: AbortSignal
}

export interface ProviderBatchImage {
  id: string
  dataUrl: string
}

export interface ProviderBatchCallOptions {
  images: ProviderBatchImage[]
  prompt: string
  route: VisionRoute
  apiKey: string
  signal?: AbortSignal
}

export interface ProviderChainOptions {
  routes: VisionRoute[]
  dataUrl: string
  prompt: string
  resolveApiKey: (route: VisionRoute) => Promise<string>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export async function callProvider(
  options: ProviderCallOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<{ analysis: VisionAnalysis; usage?: TokenUsage }> {
  const started = Date.now()
  const protocol = options.route.protocol ?? 'chat-completions'
  const payload = protocol === 'responses'
    ? buildResponsesPayload(options)
    : buildChatCompletionsPayload(options)
  const response = await fetchImpl(
    `${options.route.baseUrl.replace(/\/$/, '')}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    },
  )
  if (!response.ok) {
    throw classifyHttpError(response.status, await response.text().catch(() => ''))
  }
  const body = await response.json() as Record<string, unknown>
  const text = extractText(body, protocol)
  if (text.trim() === '') {
    throw new VisionProviderError('unknown', 'vision provider returned empty text')
  }
  return { analysis: { text }, usage: extractUsage(body, protocol) }
}

export async function callProviderBatch(
  options: ProviderBatchCallOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<{ analysis: VisionAnalysis; usage?: TokenUsage }> {
  const protocol = options.route.protocol ?? 'chat-completions'
  const payload = protocol === 'responses'
    ? buildResponsesBatchPayload(options)
    : buildChatCompletionsBatchPayload(options)
  const response = await fetchImpl(
    `${options.route.baseUrl.replace(/\/$/, '')}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    },
  )
  if (!response.ok) {
    throw classifyHttpError(response.status, await response.text().catch(() => ''))
  }
  const body = await response.json() as Record<string, unknown>
  const text = extractText(body, protocol)
  if (text.trim() === '') {
    throw new VisionProviderError('unknown', 'vision provider returned empty text')
  }
  return { analysis: { text }, usage: extractUsage(body, protocol) }
}

export interface BatchVisionAttempt {
  provider: string
  model: string
  ok: boolean
  latencyMs: number
  error?: string
  images: number
}

export interface BatchVisionResult {
  results: Map<string, string>
  errors: Map<string, string>
  attempts: BatchVisionAttempt[]
  sources?: Map<string, { provider: string; model: string }>
  usage?: TokenUsage
}

export interface ProviderBatchChainOptions {
  images: ProviderBatchImage[]
  prompt: string
  routes: VisionRoute[]
  resolveApiKey: (route: VisionRoute) => Promise<string>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * Analyze many images in one provider call, halving the batch on 4xx-class
 * failures instead of degrading to single images immediately.
 */
export async function runVisionBatchChain(
  options: ProviderBatchChainOptions,
): Promise<BatchVisionResult> {
  const results = new Map<string, string>()
  const errors = new Map<string, string>()
  const attempts: BatchVisionAttempt[] = []
  const sources = new Map<string, { provider: string; model: string }>()
  let usage: TokenUsage | undefined

  const attempt = async (images: ProviderBatchImage[]): Promise<void> => {
    if (images.length === 0) return
    let lastError: unknown
    for (const route of options.routes) {
      const started = Date.now()
      try {
        const apiKey = await options.resolveApiKey(route)
        const outcome = await callProviderBatch({
          images,
          prompt: options.prompt,
          route,
          apiKey,
          signal: options.signal,
        }, options.fetchImpl)
        attempts.push({
          provider: routeLabel(route.baseUrl),
          model: route.model,
          ok: true,
          latencyMs: Date.now() - started,
          images: images.length,
        })
        if (outcome.usage !== undefined) {
          usage = mergeUsage(usage, outcome.usage)
        }
        const parsed = parseBatchText(outcome.analysis.text, images)
        for (const [id, text] of parsed.results) {
          results.set(id, text)
          sources.set(id, { provider: routeLabel(route.baseUrl), model: route.model })
        }
        for (const [id, message] of parsed.errors) errors.set(id, message)
        return
      } catch (error) {
        lastError = error
        attempts.push({
          provider: routeLabel(route.baseUrl),
          model: route.model,
          ok: false,
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
          images: images.length,
        })
        if (isDegradeEligible(error) && images.length > 1) break
      }
    }
    if (isDegradeEligible(lastError) && images.length > 1) {
      const middle = Math.ceil(images.length / 2)
      await attempt(images.slice(0, middle))
      await attempt(images.slice(middle))
      return
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    for (const image of images) {
      if (!results.has(image.id)) errors.set(image.id, message)
    }
  }

  await attempt(options.images)
  return { results, errors, attempts, sources, ...(usage === undefined ? {} : { usage }) }
}

export function parseBatchText(
  text: string,
  images: ProviderBatchImage[],
): { results: Map<string, string>; errors: Map<string, string> } {
  const results = new Map<string, string>()
  const errors = new Map<string, string>()
  const parsed = tryParseJson(text)
  if (parsed !== undefined) {
    for (const image of images) {
      const value = parsed[image.id]
      if (typeof value === 'string') results.set(image.id, value)
      else if (typeof value === 'object' && value !== null) {
        results.set(image.id, JSON.stringify(value))
      } else {
        errors.set(image.id, 'batch response omitted this image')
      }
    }
    return { results, errors }
  }
  for (const image of images) {
    const section = extractMarkerSection(text, image.id)
    if (section !== undefined) results.set(image.id, section)
    else errors.set(image.id, 'model did not return structured JSON for this image')
  }
  return { results, errors }
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function extractMarkerSection(text: string, id: string): string | undefined {
  const pattern = new RegExp(
    `(?:图\\d+\\s*)?[（(]?id[:：]\\s*${escapeRegExp(id)}[）)]?[：:\\s]*([\\s\\S]*?)(?=(?:图\\d+\\s*)?[（(]?id[:：]\\s*[^）)：:\\s]{6,}[）)]?[：:]|$)`,
    'i',
  )
  const match = text.match(pattern)
  return match?.[1]?.trim() || undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isDegradeEligible(error: unknown): boolean {
  return error instanceof VisionProviderError
    && (error.kind === 'invalid-input' || error.kind === 'quota' || error.kind === 'rate-limit')
}

function mergeUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b.totalTokens ?? 0),
  }
}

function buildChatCompletionsBatchPayload(options: ProviderBatchCallOptions): unknown {
  const content: unknown[] = [{ type: 'text', text: options.prompt }]
  options.images.forEach((image, index) => {
    content.push({ type: 'text', text: `图${index + 1}（id: ${image.id}）:` })
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } })
  })
  return {
    model: options.route.model,
    messages: [{ role: 'user', content }],
    ...(options.route.maxTokens === undefined ? {} : { max_tokens: options.route.maxTokens }),
  }
}

function buildResponsesBatchPayload(options: ProviderBatchCallOptions): unknown {
  const content: unknown[] = [{ type: 'input_text', text: options.prompt }]
  options.images.forEach((image, index) => {
    content.push({ type: 'input_text', text: `图${index + 1}（id: ${image.id}）:` })
    content.push({ type: 'input_image', image_url: image.dataUrl })
  })
  return {
    model: options.route.model,
    input: [{ role: 'user', content }],
    ...(options.route.maxTokens === undefined ? {} : { max_output_tokens: options.route.maxTokens }),
  }
}

export async function runProviderChain(
  options: ProviderChainOptions,
): Promise<{ analysis: VisionAnalysis; provider: string; model: string; attempts: Array<{
    provider: string
    model: string
    ok: boolean
    latencyMs: number
    error?: string
    usage?: TokenUsage
  }>; usage?: TokenUsage }> {
  const attempts: Array<{
    provider: string
    model: string
    ok: boolean
    latencyMs: number
    error?: string
    usage?: TokenUsage
  }> = []
  let lastError: unknown
  for (const route of options.routes) {
    const started = Date.now()
    try {
      const apiKey = await options.resolveApiKey(route)
      const result = await callProvider(
        {
          dataUrl: options.dataUrl,
          prompt: options.prompt,
          route,
          apiKey,
          signal: options.signal,
        },
        options.fetchImpl,
      )
      attempts.push({
        provider: routeLabel(route.baseUrl),
        model: route.model,
        ok: true,
        latencyMs: Date.now() - started,
        error: '',
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      })
      return {
        analysis: result.analysis,
        provider: routeLabel(route.baseUrl),
        model: route.model,
        usage: result.usage,
        attempts,
      }
    } catch (error) {
      lastError = error
      attempts.push({
        provider: routeLabel(route.baseUrl),
        model: route.model,
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  throw new VisionProviderError(
    'unknown',
    `all vision providers failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

function buildChatCompletionsPayload(options: ProviderCallOptions): unknown {
  return {
    model: options.route.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: options.prompt },
          { type: 'image_url', image_url: { url: options.dataUrl } },
        ],
      },
    ],
    ...(options.route.maxTokens === undefined ? {} : { max_tokens: options.route.maxTokens }),
  }
}

function buildResponsesPayload(options: ProviderCallOptions): unknown {
  return {
    model: options.route.model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: options.prompt },
          { type: 'input_image', image_url: options.dataUrl },
        ],
      },
    ],
    ...(options.route.maxTokens === undefined ? {} : { max_output_tokens: options.route.maxTokens }),
  }
}

function extractText(body: Record<string, unknown>, protocol: string): string {
  if (protocol === 'responses') {
    const output = body.output
    if (Array.isArray(output)) {
      const texts: string[] = []
      for (const item of output) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as Record<string, unknown>
        if (record.type !== 'message' || !Array.isArray(record.content)) continue
        for (const block of record.content as unknown[]) {
          if (typeof block !== 'object' || block === null) continue
          const part = block as Record<string, unknown>
          if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
        }
      }
      return texts.join('\n')
    }
    return ''
  }
  const choices = body.choices
  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined
    const message = first?.message as Record<string, unknown> | undefined
    const content = message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter((part): part is Record<string, unknown> =>
          typeof part === 'object' && part !== null)
        .map((part) => part.text)
        .filter((text): text is string => typeof text === 'string')
        .join('\n')
    }
  }
  return ''
}

function extractUsage(body: Record<string, unknown>, protocol: string): TokenUsage | undefined {
  const usage = body.usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const record = usage as Record<string, unknown>
  const usageValue = protocol === 'responses'
    ? {
        inputTokens: numberOrUndefined(record.input_tokens),
        outputTokens: numberOrUndefined(record.output_tokens),
        totalTokens: numberOrUndefined(record.total_tokens),
      }
    : {
        inputTokens: numberOrUndefined(record.prompt_tokens),
        outputTokens: numberOrUndefined(record.completion_tokens),
        totalTokens: numberOrUndefined(record.total_tokens),
      }
  if (
    usageValue.inputTokens === undefined
    && usageValue.outputTokens === undefined
    && usageValue.totalTokens === undefined
  ) {
    return undefined
  }
  return usageValue
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function classifyHttpError(status: number, body: string): VisionProviderError {
  if (status === 401 || status === 403) {
    return new VisionProviderError('auth', `vision provider rejected credentials (HTTP ${status})`, status)
  }
  if (status === 402) {
    return new VisionProviderError('quota', `vision provider quota exceeded (HTTP ${status})`, status)
  }
  if (status === 429) {
    return new VisionProviderError('rate-limit', `vision provider rate limited (HTTP ${status})`, status)
  }
  if (status >= 400 && status < 500) {
    return new VisionProviderError('invalid-input', `vision provider rejected request (HTTP ${status}): ${body.slice(0, 200)}`, status)
  }
  if (status >= 500) {
    return new VisionProviderError('network', `vision provider failed (HTTP ${status})`, status)
  }
  return new VisionProviderError('unknown', `vision provider returned HTTP ${status}`, status)
}
