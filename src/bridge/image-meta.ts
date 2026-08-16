export interface ImageDimensions {
  width: number
  height: number
}

/**
 * Parse intrinsic dimensions from image headers without native decoders.
 * Supports png, jpeg, webp, and gif; returns 0,0 for anything malformed.
 */
export function probeDimensions(bytes: Uint8Array, format: string): ImageDimensions {
  if (format === 'png') return pngDimensions(bytes)
  if (format === 'jpeg') return jpegDimensions(bytes)
  if (format === 'webp') return webpDimensions(bytes)
  if (format === 'gif') return gifDimensions(bytes)
  return { width: 0, height: 0 }
}

function pngDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.length < 24) return { width: 0, height: 0 }
  return {
    width: readUint32BE(bytes, 16)!,
    height: readUint32BE(bytes, 20)!,
  }
}

function gifDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.length < 10) return { width: 0, height: 0 }
  return {
    width: bytes[6]! | (bytes[7]! << 8),
    height: bytes[8]! | (bytes[9]! << 8),
  }
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]!
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      }
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    if (length < 2) return { width: 0, height: 0 }
    offset += 2 + length
  }
  return { width: 0, height: 0 }
}

function webpDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.length < 30) return { width: 0, height: 0 }
  const kind = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  if (kind === 'VP8 ') {
    if (bytes.length < 27) return { width: 0, height: 0 }
    return {
      width: bytes[23]! | ((bytes[24]! & 0x3f) << 8),
      height: bytes[25]! | ((bytes[26]! & 0x3f) << 8),
    }
  }
  if (kind === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return { width: 0, height: 0 }
    return {
      width: 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)),
      height: 1 + (((bytes[22]! & 0xc0) >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x03) << 10)),
    }
  }
  if (kind === 'VP8X') {
    if (bytes.length < 30) return { width: 0, height: 0 }
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    }
  }
  return { width: 0, height: 0 }
}

function readUint32BE(bytes: Uint8Array, offset: number): number | undefined {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}
