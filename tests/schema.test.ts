import { describe, expect, it } from 'vitest'
import { parseVisionResult, visionResultSchema } from '../src/schema.js'
import type { VisionResult } from '../src/types.js'

const valid: VisionResult = {
  version: 1,
  intent: 'ocr',
  query: '图片 文字',
  images: [{
    sha256: 'abc',
    path: '/tmp/a.png',
    width: 100,
    height: 50,
    format: 'png',
  }],
  evidence: {
    ocr: { fullText: 'hello', language: 'eng' },
  },
  answer: { text: 'hello' },
  meta: {
    provider: 'p',
    model: 'm',
    latencyMs: 10,
    attempts: [{ provider: 'p', model: 'm', ok: true, latencyMs: 10, error: '' }],
    cache: 'miss',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  },
}

describe('visionResultSchema', () => {
  it('parses a valid result', () => {
    expect(visionResultSchema.safeParse(valid).success).toBe(true)
    expect(parseVisionResult(valid).answer.text).toBe('hello')
  })

  it('rejects invalid intent and missing answer text', () => {
    expect(visionResultSchema.safeParse({ ...valid, intent: 'nope' }).success).toBe(false)
    expect(visionResultSchema.safeParse({ ...valid, answer: {} }).success).toBe(false)
  })

  it('rejects invalid color hex', () => {
    const invalid = {
      ...valid,
      evidence: { colors: [{ hex: 'white', share: 0.5 }] },
    }
    expect(visionResultSchema.safeParse(invalid).success).toBe(false)
  })
})
