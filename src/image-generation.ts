import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { routeLabel } from './route.js'
import type {
  GeneratedImage,
  GeneratedImageMediaType,
  ImageGenerationAttempt,
  ImageGenerationRoute,
  ImageGenerationSpec,
} from './types.js'

export type ImageGenerationErrorKind =
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'invalid-input'
  | 'network'
  | 'unknown'

export class ImageGenerationProviderError extends Error {
  constructor(
    readonly kind: ImageGenerationErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface ImageGenerationProviderOptions {
  route: ImageGenerationRoute
  apiKey: string
  spec: ImageGenerationSpec
  signal?: AbortSignal
  resolveHost?: (hostname: string) => Promise<Array<{ address: string }>>
}

export interface ImageGenerationChainOptions {
  routes: ImageGenerationRoute[]
  spec: ImageGenerationSpec
  resolveApiKey: (route: ImageGenerationRoute) => Promise<string>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface ImageGenerationChainResult {
  images: GeneratedImage[]
  provider: string
  model: string
  attempts: ImageGenerationAttempt[]
}

export async function callImageGenerationProvider(
  options: ImageGenerationProviderOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<{ images: GeneratedImage[] }> {
  const response = await fetchImpl(
    `${options.route.baseUrl.replace(/\/$/, '')}/images/generations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.route.model,
        prompt: options.spec.prompt,
      }),
      signal: options.signal,
    },
  )
  if (!response.ok) {
    throw classifyImageGenerationHttpError(response.status, await response.text().catch(() => ''))
  }
  const body = await response.json() as Record<string, unknown>
  const images = await decodeImages(body, fetchImpl, options.signal, options.resolveHost)
  if (images.length === 0) {
    throw new ImageGenerationProviderError('invalid-input', 'image provider returned no images')
  }
  return { images }
}

export async function runImageGenerationChain(
  options: ImageGenerationChainOptions,
): Promise<ImageGenerationChainResult> {
  const attempts: ImageGenerationAttempt[] = []
  let lastError: unknown
  for (const route of options.routes) {
    const started = Date.now()
    try {
      const apiKey = await options.resolveApiKey(route)
      const result = await callImageGenerationProvider({
        route,
        apiKey,
        spec: options.spec,
        signal: options.signal,
      }, options.fetchImpl)
      attempts.push({
        provider: routeLabel(route.baseUrl),
        model: route.model,
        ok: true,
        latencyMs: Date.now() - started,
      })
      return {
        ...result,
        provider: routeLabel(route.baseUrl),
        model: route.model,
        attempts,
      }
    } catch (error) {
      attempts.push({
        provider: routeLabel(route.baseUrl),
        model: route.model,
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
      if (!isRetryableImageGenerationError(error)) throw error
      lastError = error
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new ImageGenerationProviderError('unknown', 'no image generation route configured')
}

async function decodeImages(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  resolveHost: (hostname: string) => Promise<Array<{ address: string }>> = (hostname) => lookup(hostname, { all: true }),
): Promise<GeneratedImage[]> {
  if (!Array.isArray(body.data)) {
    throw new ImageGenerationProviderError('invalid-input', 'image provider returned an invalid response')
  }
  return Promise.all(body.data.map(async (value) => {
    if (typeof value !== 'object' || value === null) {
      throw new ImageGenerationProviderError('invalid-input', 'image provider returned an invalid image')
    }
    const image = value as Record<string, unknown>
    if (typeof image.b64_json === 'string' && image.b64_json !== '') {
      const data = new Uint8Array(Buffer.from(image.b64_json, 'base64'))
      if (data.byteLength > MAX_IMAGE_BYTES) {
        throw new ImageGenerationProviderError('invalid-input', 'image provider returned an oversized image')
      }
      return { data, mediaType: mediaTypeOf(data) }
    }
    if (typeof image.url === 'string' && image.url !== '') {
      return downloadGeneratedImage(image.url, fetchImpl, signal, resolveHost)
    }
    throw new ImageGenerationProviderError('invalid-input', 'image provider did not return b64_json or URL')
  }))
}

async function downloadGeneratedImage(
  rawUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  resolveHost: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<GeneratedImage> {
  const url = await safeImageUrl(rawUrl, resolveHost)
  const response = await fetchImpl(url, { redirect: 'error', signal })
  if (!response.ok) {
    throw new ImageGenerationProviderError('network', `image provider URL download failed (HTTP ${response.status})`, response.status)
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new ImageGenerationProviderError('invalid-input', 'image provider returned an oversized image')
  }
  const data = await readResponseBytes(response)
  return { data, mediaType: mediaTypeOf(data) }
}

const MAX_IMAGE_BYTES = 25 * 1024 * 1024

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel()
      throw new ImageGenerationProviderError('invalid-input', 'image provider returned an oversized image')
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function safeImageUrl(
  rawUrl: string,
  resolveHost: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<string> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ImageGenerationProviderError('invalid-input', 'image provider returned an invalid image URL')
  }
  if (url.protocol !== 'https:') {
    throw new ImageGenerationProviderError('invalid-input', 'image provider URL must use HTTPS')
  }
  const addresses = await resolveHost(url.hostname).catch(() => [])
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new ImageGenerationProviderError('invalid-input', 'image provider URL resolves to a restricted address')
  }
  return url.toString()
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number)
    const first = parts[0] ?? 0
    const second = parts[1] ?? 0
    if (first === 10 || first === 127 || first >= 224 || first === 0) return false
    if (first === 169 && second === 254) return false
    if (first === 172 && second >= 16 && second <= 31) return false
    if (first === 192 && second === 168) return false
    return true
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    return normalized !== '::1' && normalized !== '::' && !normalized.startsWith('fc')
      && !normalized.startsWith('fd') && !normalized.startsWith('fe8')
      && !normalized.startsWith('fe9') && !normalized.startsWith('fea')
      && !normalized.startsWith('feb')
  }
  return false
}

function mediaTypeOf(data: Uint8Array): GeneratedImageMediaType {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(Buffer.from(data.subarray(0, 6)).toString('ascii'))) return 'image/gif'
  throw new ImageGenerationProviderError('invalid-input', 'image provider returned an unsupported image format')
}

function isRetryableImageGenerationError(error: unknown): boolean {
  return error instanceof ImageGenerationProviderError
    && ['quota', 'rate-limit', 'network'].includes(error.kind)
}

function classifyImageGenerationHttpError(status: number, body: string): ImageGenerationProviderError {
  if (status === 401 || status === 403) return new ImageGenerationProviderError('auth', 'image provider rejected credentials', status)
  if (status === 402) return new ImageGenerationProviderError('quota', 'image provider quota exceeded', status)
  if (status === 429) return new ImageGenerationProviderError('rate-limit', 'image provider rate limited', status)
  if (status >= 400 && status < 500) return new ImageGenerationProviderError('invalid-input', `image provider rejected request (HTTP ${status}): ${body.slice(0, 200)}`, status)
  if (status >= 500) return new ImageGenerationProviderError('network', `image provider failed (HTTP ${status})`, status)
  return new ImageGenerationProviderError('unknown', `image provider returned HTTP ${status}`, status)
}
