import { fingerprintBytes } from './evidence.js'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  GeneratedImageMediaType,
  ImageGenerationAttempt,
  ImageGenerationRoute,
  ImageGenerationSpec,
  TokenUsage,
} from './types.js'

export const IMAGE_GENERATION_REQUEST_VERSION = 'mindseye-image-generation-v1'

export interface ImageGenerationToolInput {
  request: string
  context?: string
  historyContext?: string[]
  toolResults?: string[]
  size?: string
  image?: { data: Uint8Array; mediaType: GeneratedImageMediaType }
}

export interface SavedGeneratedImage {
  attachmentId: string
  attachment: ImageAttachmentRef
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
    usage?: TokenUsage
  }
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
    usage?: TokenUsage
  }>
  saveImage: (input: {
    data: Uint8Array
    mediaType: GeneratedImageMediaType
    name?: string
  }) => Promise<ImageAttachmentRef>
  probeImage: (bytes: Uint8Array) => { width: number; height: number; format: string }
}

export async function generateImagesWithMindsEye(
  input: ImageGenerationToolInput,
  deps: ImageGenerationToolDeps,
  routes: ImageGenerationRoute[],
  signal?: AbortSignal,
): Promise<ImageGenerationToolResult> {
  const spec = normalizeImageGenerationSpec(input, routes)
  const generated = await deps.generate(spec, routes, signal)
  const images: SavedGeneratedImage[] = []
  for (const [index, image] of generated.images.entries()) {
    const dimensions = deps.probeImage(image.data)
    const saved = await deps.saveImage({
      data: image.data,
      mediaType: image.mediaType,
      name: `mindseye-generated-${index + 1}.${image.mediaType.slice('image/'.length)}`,
    })
    images.push({
      attachmentId: saved.attachmentId,
      attachment: saved,
      sha256: fingerprintBytes(image.data),
      width: dimensions.width,
      height: dimensions.height,
      format: dimensions.format,
    })
  }
  return {
    images,
    meta: {
      provider: generated.provider,
      model: generated.model,
      ...(generated.usage === undefined ? {} : { usage: generated.usage }),
    },
  }
}

function normalizeImageGenerationSpec(
  input: ImageGenerationToolInput,
  routes: ImageGenerationRoute[],
): ImageGenerationSpec {
  if (routes.length === 0) throw new Error('mindseye_generate_image: no image generation route configured')
  const request = input.request.trim()
  if (request === '') throw new Error('mindseye_generate_image: request is required')
  const context = input.context?.trim() ?? ''
  const history = input.historyContext ?? []
  const toolResults = input.toolResults ?? []
  const parts = [`用户本次需求：${request}`]
  if (context !== '') parts.push(`上下文：${context}`)
  if (history.length > 0) {
    parts.push(`历史上下文（用户原文，供核对引用）：\n${history.map((text, index) => `${index + 1}. ${text}`).join('\n')}`)
  }
  if (toolResults.length > 0) {
    parts.push(`识图/生成历史结果（供核对引用）：\n${toolResults.map((text, index) => `${index + 1}. ${text}`).join('\n')}`)
  }
  const prompt = parts.join('\n')
  if (prompt.length > 4_000) throw new Error('mindseye_generate_image: combined request and context exceeds 4000 characters')
  const size = input.size?.trim()
  return {
    prompt,
    requestVersion: IMAGE_GENERATION_REQUEST_VERSION,
    ...(size === undefined || size === '' ? {} : { size }),
    ...(input.image === undefined ? {} : { image: input.image }),
  }
}
