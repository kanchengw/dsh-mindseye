import sharp from 'sharp'
import type { GeneratedImageMediaType } from './types.js'

export const HOST_IMAGE_DIMENSION_LIMIT = 2_000
export const DSH_IMAGE_RESIZE_BOUND = 1_980

export interface DshImageResizeInput {
  data: Uint8Array
  mediaType: GeneratedImageMediaType
  width: number
  height: number
}

export interface ImageDimensions {
  width: number
  height: number
  format: string
}

export interface AdaptedImage extends ImageDimensions {
  data: Uint8Array
  adapted: boolean
  sourceWidth: number
  sourceHeight: number
}

export interface ImageAdapterDeps {
  probeImage?: (bytes: Uint8Array) => ImageDimensions | Promise<ImageDimensions>
  resizeImage?: (input: DshImageResizeInput) => Promise<Uint8Array>
}

export async function adaptImageForDsh(
  input: { data: Uint8Array; mediaType: GeneratedImageMediaType },
  deps: ImageAdapterDeps = {},
): Promise<AdaptedImage> {
  const probeImage = deps.probeImage ?? defaultProbeImage
  const source = await probeImage(input.data)
  if (Math.max(source.width, source.height) <= HOST_IMAGE_DIMENSION_LIMIT) {
    return {
      data: input.data,
      adapted: false,
      sourceWidth: source.width,
      sourceHeight: source.height,
      ...source,
    }
  }

  const data = await (deps.resizeImage ?? resizeImageForDsh)({
    ...input,
    width: DSH_IMAGE_RESIZE_BOUND,
    height: DSH_IMAGE_RESIZE_BOUND,
  })
  const adapted = await probeImage(data)
  return {
    data,
    adapted: true,
    sourceWidth: source.width,
    sourceHeight: source.height,
    ...adapted,
  }
}

export async function resizeImageForDsh(input: DshImageResizeInput): Promise<Uint8Array> {
  const data = await sharp(input.data, { animated: input.mediaType === 'image/gif' })
    .resize({
      width: input.width,
      height: input.height,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toBuffer()
  return new Uint8Array(data)
}

async function defaultProbeImage(bytes: Uint8Array): Promise<ImageDimensions> {
  const metadata = await sharp(bytes, { animated: true }).metadata()
  if (metadata.width === undefined || metadata.height === undefined || metadata.format === undefined) {
    throw new Error('mindseye: image dimensions are unavailable')
  }
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
  }
}
