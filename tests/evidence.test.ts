import { describe, expect, it } from 'vitest'
import { buildImageInfo, fingerprintBytes } from '../src/evidence.js'

describe('fingerprintBytes', () => {
  it('returns stable sha256 fingerprints', () => {
    const bytes = new TextEncoder().encode('mindseye')
    expect(fingerprintBytes(bytes)).toBe(fingerprintBytes(bytes))
    expect(fingerprintBytes(bytes)).toHaveLength(64)
  })
})

describe('buildImageInfo', () => {
  it('includes path only when provided', () => {
    expect(buildImageInfo({ sha256: 'a', width: 1, height: 2, format: 'png' }).path).toBeUndefined()
    expect(buildImageInfo({ sha256: 'a', width: 1, height: 2, format: 'png', path: '/a.png' }).path).toBe('/a.png')
  })
})
