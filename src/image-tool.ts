import { fingerprintBytes } from './evidence.js'
import type {
  GeneratedImageMediaType,
  ImageGenerationAttempt,
  ImageGenerationRoute,
  ImageGenerationSpec,
} from './types.js'

export const IMAGE_GENERATION_REQUEST_VERSION = 'mindseye-image-generation-v1'

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
  meta: {
    provider: string
    model: string
    latencyMs: number
    attempts: ImageGenerationAttempt[]
    requestVersion: string
    source: 'generated'
    qa: string[]
  }
}

export interface ImageGenerationToolDeps {
  generate: (
    spec: ImageGenerationSpec,
    routes: ImageGenerationRoute[],
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
  qa?: (input: { attachmentId: string; prompt: string }) => Promise<string>
}

export async function generateImagesWithMindsEye(
  input: ImageGenerationToolInput,
  deps: ImageGenerationToolDeps,
  routes: ImageGenerationRoute[],
): Promise<ImageGenerationToolResult> {
  const spec = normalizeImageGenerationSpec(input, routes)
  const started = Date.now()
  const generated = await deps.generate(spec, routes)
  const images: SavedGeneratedImage[] = []
  const qa: string[] = []
  for (const [index, image] of generated.images.entries()) {
    const saved = await deps.saveImage({
      data: image.data,
      mediaType: image.mediaType,
      name: `mindseye-generated-${index + 1}.${image.mediaType.slice('image/'.length)}`,
    })
    const dimensions = deps.probeImage(image.data)
    images.push({
      attachmentId: saved.attachmentId,
      sha256: fingerprintBytes(image.data),
      width: dimensions.width,
      height: dimensions.height,
      format: dimensions.format,
    })
    if (deps.qa !== undefined) {
      qa.push(await deps.qa({ attachmentId: saved.attachmentId, prompt: spec.prompt }))
    }
  }
  return {
    images,
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
  const size = input.size?.trim() || routes[0]?.defaultSize
  if (size === undefined || size === '') throw new Error('mindseye_generate_image: no image generation route configured')
  return { prompt, size, n, requestVersion: IMAGE_GENERATION_REQUEST_VERSION }
}
