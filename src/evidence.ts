import { createHash } from 'node:crypto'
import type { ImageInfo } from './types.js'

export function fingerprintBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function buildImageInfo(input: {
  sha256: string
  width: number
  height: number
  format: string
  path?: string
}): ImageInfo {
  return {
    sha256: input.sha256,
    width: input.width,
    height: input.height,
    format: input.format,
    ...(input.path === undefined ? {} : { path: input.path }),
  }
}
