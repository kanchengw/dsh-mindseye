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
        size: options.spec.size,
        n: options.spec.n,
      }),
      signal: options.signal,
    },
  )
  if (!response.ok) {
    throw classifyImageGenerationHttpError(response.status, await response.text().catch(() => ''))
  }
  const body = await response.json() as Record<string, unknown>
  const images = decodeImages(body)
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

function decodeImages(body: Record<string, unknown>): GeneratedImage[] {
  if (!Array.isArray(body.data)) {
    throw new ImageGenerationProviderError('invalid-input', 'image provider returned an invalid response')
  }
  return body.data.map((value) => {
    if (typeof value !== 'object' || value === null) {
      throw new ImageGenerationProviderError('invalid-input', 'image provider returned an invalid image')
    }
    const encoded = (value as Record<string, unknown>).b64_json
    if (typeof encoded !== 'string' || encoded === '') {
      throw new ImageGenerationProviderError('invalid-input', 'image provider did not return b64_json')
    }
    const data = new Uint8Array(Buffer.from(encoded, 'base64'))
    return { data, mediaType: mediaTypeOf(data) }
  })
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
