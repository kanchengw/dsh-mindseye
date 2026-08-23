import { describe, expect, it } from 'vitest'
import {
  extractStructured,
  parseStructuredValue,
  structuredEvidenceIntent,
} from '../src/bridge/evidence-extract.js'

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
      answer: 'hello world',
      evidence: { ocr: { fullText: 'hello world', language: 'eng' } },
    })
  })

  it('derives the ocr answer from fullText when answer is absent', () => {
    const result = extractStructured(JSON.stringify({
      evidence: { ocr: { fullText: '只有证据没有 answer' } },
    }), 'ocr')
    expect(result).toEqual({
      answer: '只有证据没有 answer',
      evidence: { ocr: { fullText: '只有证据没有 answer' } },
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

  it('normalizes qwen-style ocr answer arrays into fullText evidence', () => {
    const result = extractStructured(JSON.stringify({
      answer: [
        { rotate_rect: '<1><2><3><4><0>', text: '第一行' },
        { rotate_rect: '<5><6><7><8><0>', text: '第二行' },
      ],
    }), 'ocr')
    expect(result).toEqual({
      answer: '第一行\n第二行',
      evidence: { ocr: { fullText: '第一行\n第二行' } },
    })
  })

  it('normalizes qwen-style ocr output in batch values', () => {
    const result = parseStructuredValue(JSON.stringify({
      answer: [{ text: '批量文字' }],
    }), 'ocr')
    expect(result).toEqual({
      text: '批量文字',
      evidence: { ocr: { fullText: '批量文字' } },
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

  it('rejects grounding boxes outside the source image bounds', () => {
    expect(extractStructured(JSON.stringify({
      answer: '搜索框',
      evidence: { elements: [{ type: 'input', box: { x1: 281, y1: 306, x2: 999, y2: 474 } }] },
    }), 'grounding', undefined, { width: 800, height: 600 })).toBeUndefined()
  })
})

describe('extractStructured with extract', () => {
  it('parses a combined answer and evidence envelope for a semantic intent', () => {
    const result = extractStructured(JSON.stringify({
      answer: '海报内容如下',
      evidence: {
        ocr: { fullText: '领取免费资源包' },
        colors: [{ hex: '#e9ebff', share: 0.7 }],
      },
    }), 'visual-qa', ['ocr', 'colors'])
    expect(result?.answer).toBe('海报内容如下')
    expect(result?.evidence).toEqual({
      ocr: { fullText: '领取免费资源包' },
      colors: [{ hex: '#e9ebff', share: 0.7 }],
    })
  })

  it('parses combined batch values', () => {
    const result = parseStructuredValue(JSON.stringify({
      text: 'ok',
      evidence: { layout: [{ region: '1,2,3,4', content: 'title' }] },
    }), 'visual-qa', ['layout'])
    expect(result?.evidence).toEqual({ layout: [{ region: '1,2,3,4', content: 'title' }] })
  })

  it('rejects a combined envelope without an answer', () => {
    expect(extractStructured(JSON.stringify({ evidence: { ocr: { fullText: 'x' } } }), 'visual-qa', ['ocr'])).toBeUndefined()
  })

  it('rejects requested evidence when a field is missing or malformed', () => {
    expect(extractStructured(JSON.stringify({
      answer: 'ok',
      evidence: { colors: [{ hex: 'red' }] },
    }), 'visual-qa', ['ocr', 'colors'])).toBeUndefined()
    expect(extractStructured(JSON.stringify({
      answer: 'ok',
      evidence: { colors: [{ hex: '#ff0000', share: 2 }] },
    }), 'visual-qa', ['colors'])).toBeUndefined()
  })
})
