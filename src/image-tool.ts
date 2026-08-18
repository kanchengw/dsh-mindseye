import { fingerprintBytes } from './evidence.js'
import type {
  GeneratedImageMediaType,
  ImageGenerationAttempt,
  ImageGenerationRoute,
  ImageGenerationSpec,
  TokenUsage,
} from './types.js'

export const IMAGE_GENERATION_REQUEST_VERSION = 'mindseye-image-generation-v1'
const NO_WATERMARK_INSTRUCTION = 'Do not include a watermark, signature, logo, or any unrelated readable text.'

export interface ImageGenerationToolInput {
  prompt: string
  size?: string
  n?: number
}

export interface SavedGeneratedImage {
  attachmentId: string
  sha256: string
  width: number
  height: number
  format: string
}

export interface ImageGenerationToolResult {
  images: SavedGeneratedImage[]
  failures: Array<{ candidate: number; stage: 'probe' | 'save'; error: string }>
  meta: {
    provider: string
    model: string
    latencyMs: number
    attempts: ImageGenerationAttempt[]
    requestVersion: string
    source: 'generated'
    qa: Array<GeneratedImageQa & { attachmentId: string }>
  }
}

export interface GeneratedImageQa {
  text: string
  latencyMs: number
  attempts: Array<{
    provider: string
    model: string
    ok: boolean
    latencyMs: number
    error?: string
    usage?: TokenUsage
  }>
  provider?: string
  model?: string
  usage?: TokenUsage
  skipped?: boolean
}

export interface ImageGenerationToolDeps {
  generate: (
    spec: ImageGenerationSpec,
    routes: ImageGenerationRoute[],
    signal?: AbortSignal,
  ) => Promise<{
    images: Array<{ data: Uint8Array; mediaType: GeneratedImageMediaType }>
    provider: string
    model: string
    attempts: ImageGenerationAttempt[]
  }>
  saveImage: (input: {
    data: Uint8Array
    mediaType: GeneratedImageMediaType
    name?: string
  }) => Promise<{ attachmentId: string }>
  probeImage: (bytes: Uint8Array) => { width: number; height: number; format: string }
  qa?: (input: { attachmentId: string; prompt: string }, signal?: AbortSignal) => Promise<GeneratedImageQa>
}

export async function generateImagesWithMindsEye(
  input: ImageGenerationToolInput,
  deps: ImageGenerationToolDeps,
  routes: ImageGenerationRoute[],
  signal?: AbortSignal,
): Promise<ImageGenerationToolResult> {
  const spec = normalizeImageGenerationSpec(input, routes)
  const started = Date.now()
  const generated = await deps.generate(spec, routes, signal)
  const images: SavedGeneratedImage[] = []
  const failures: ImageGenerationToolResult['failures'] = []
  const qa: Array<GeneratedImageQa & { attachmentId: string }> = []
  for (const [index, image] of generated.images.entries()) {
    let dimensions: { width: number; height: number; format: string }
    try {
      dimensions = deps.probeImage(image.data)
    } catch (error) {
      failures.push({ candidate: index + 1, stage: 'probe', error: errorMessage(error) })
      continue
    }
    try {
      const saved = await deps.saveImage({
        data: image.data,
        mediaType: image.mediaType,
        name: `mindseye-generated-${index + 1}.${image.mediaType.slice('image/'.length)}`,
      })
      images.push({
        attachmentId: saved.attachmentId,
        sha256: fingerprintBytes(image.data),
        width: dimensions.width,
        height: dimensions.height,
        format: dimensions.format,
      })
      if (deps.qa !== undefined) {
        try {
          qa.push({
            attachmentId: saved.attachmentId,
            ...(await deps.qa({ attachmentId: saved.attachmentId, prompt: spec.prompt }, signal)),
          })
        } catch (error) {
          qa.push({
            attachmentId: saved.attachmentId,
            text: `QA unavailable: ${errorMessage(error)}`,
            latencyMs: 0,
            attempts: [],
          })
        }
      }
    } catch (error) {
      failures.push({ candidate: index + 1, stage: 'save', error: errorMessage(error) })
    }
  }
  return {
    images,
    failures,
    meta: {
      provider: generated.provider,
      model: generated.model,
      latencyMs: Date.now() - started,
      attempts: generated.attempts,
      requestVersion: spec.requestVersion,
      source: 'generated',
      qa,
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeImageGenerationSpec(
  input: ImageGenerationToolInput,
  routes: ImageGenerationRoute[],
): ImageGenerationSpec {
  const prompt = input.prompt.trim()
  if (prompt === '') throw new Error('mindseye_generate_image: prompt is required')
  if (prompt.length > 4_000) throw new Error('mindseye_generate_image: prompt exceeds 4000 characters')
  const n = input.n ?? 1
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw new Error('mindseye_generate_image: n must be between 1 and 4')
  }
  if (routes.length === 0) throw new Error('mindseye_generate_image: no image generation route configured')
  const size = input.size?.trim() ?? ''
  if (size === '') throw new Error('mindseye_generate_image: size is required')
  return {
    prompt: `${prompt}\n\n${NO_WATERMARK_INSTRUCTION}`,
    size,
    n,
    requestVersion: IMAGE_GENERATION_REQUEST_VERSION,
  }
}
