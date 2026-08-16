import { describe, expect, it } from 'vitest'
import { extractStructured, structuredEvidenceIntent } from '../src/bridge/evidence-extract.js'

describe('extractStructured', () => {
  it('extracts ocr evidence from a JSON response', () => {
    const result = extractStructured(
      JSON.stringify({
        answer: '转写完成',
        evidence: { ocr: { fullText: 'hello world', language: 'eng' } },
      }),
      'ocr',
    )
    expect(result).toEqual({
      answer: '转写完成',
      evidence: { ocr: { fullText: 'hello world', language: 'eng' } },
    })
  })

  it('normalizes colors and layout entries', () => {
    const result = extractStructured(
      JSON.stringify({
        answer: 'ok',
        evidence: {
          colors: [{ hex: '#ff0000', share: 0.5 }],
          layout: [{ region: '1,2,3,4', content: 'title' }],
        },
      }),
      'color',
    )
    expect(result?.evidence).toEqual({
      colors: [{ hex: '#ff0000', share: 0.5 }],
      layout: [{ region: '1,2,3,4', content: 'title' }],
    })
  })

  it('returns undefined for plain text or non-structured intents', () => {
    expect(extractStructured('plain answer', 'ocr')).toBeUndefined()
    expect(extractStructured(JSON.stringify({ answer: 'A' }), 'visual-qa')).toBeUndefined()
  })

  it('marks structured intents', () => {
    expect(structuredEvidenceIntent('ocr')).toBe(true)
    expect(structuredEvidenceIntent('visual-qa')).toBe(false)
  })
})
