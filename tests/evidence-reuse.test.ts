import { describe, expect, it } from 'vitest'
import {
  evidenceContextOf,
  evidenceToRecord,
  isWholeImageColorQuery,
  pureEvidenceAnswer,
} from '../src/memory/evidence.js'
import type { VisualEvidenceRecord } from '../src/memory/types.js'

const record: VisualEvidenceRecord = {
  id: 'ev-1',
  sha256: 'sha256:a',
  width: 10,
  height: 20,
  format: 'png',
  ocr: { fullText: 'hello', language: 'eng' },
  layout: [{ region: '1,2,3,4', content: 'title' }],
  elements: [{ type: 'button', label: 'Send', box: { x1: 1, y1: 2, x2: 3, y2: 4 } }],
  colors: [{ hex: '#ff0000', share: 0.5 }],
  createdAt: 1,
}

describe('pureEvidenceAnswer', () => {
  it('answers ocr directly from stored full text', () => {
    const result = pureEvidenceAnswer('ocr', record)
    expect(result?.text).toBe('hello')
    expect(result?.evidence).toEqual({ ocr: { fullText: 'hello', language: 'eng' } })
  })

  it('answers layout from stored evidence', () => {
    expect(pureEvidenceAnswer('layout', record)?.evidence).toEqual({ layout: record.layout })
  })

  it('answers whole-image color questions from stored palette', () => {
    const result = pureEvidenceAnswer('color', record, '整体主色是什么')
    expect(result?.text).toContain('#ff0000')
    expect(result?.text).toContain('50%')
    expect(result?.evidence).toEqual({ colors: record.colors })
  })

  it('does not skip color when the question targets a subject or region', () => {
    expect(pureEvidenceAnswer('color', record, '桌上碗碟的颜色')).toBeUndefined()
    expect(pureEvidenceAnswer('color', record, '按钮是什么颜色')).toBeUndefined()
    expect(pureEvidenceAnswer('color', record)).toBeUndefined()
  })

  it('does not reuse an empty palette', () => {
    expect(pureEvidenceAnswer('color', { ...record, colors: [] }, '整体主色是什么')).toBeUndefined()
  })

  it('does not skip grounding or semantic intents', () => {
    expect(pureEvidenceAnswer('grounding', record)).toBeUndefined()
    expect(pureEvidenceAnswer('visual-qa', record)).toBeUndefined()
  })

  it('does not skip when the needed evidence part is missing', () => {
    expect(pureEvidenceAnswer('ocr', { ...record, ocr: undefined })).toBeUndefined()
  })
})

describe('isWholeImageColorQuery', () => {
  it('accepts explicit whole-image color questions', () => {
    expect(isWholeImageColorQuery('整体主色是什么')).toBe(true)
    expect(isWholeImageColorQuery('整张图有哪些颜色')).toBe(true)
    expect(isWholeImageColorQuery('全局配色方案')).toBe(true)
  })

  it('rejects targeted or non-color questions', () => {
    expect(isWholeImageColorQuery('桌上碗碟的颜色')).toBe(false)
    expect(isWholeImageColorQuery('按钮的整体颜色')).toBe(false)
    expect(isWholeImageColorQuery('整体布局')).toBe(false)
    expect(isWholeImageColorQuery(undefined)).toBe(false)
  })
})

describe('evidenceToRecord', () => {
  it('maps structured evidence fields onto a storage record', () => {
    expect(evidenceToRecord({
      ocr: { fullText: 'x', language: 'eng' },
      layout: [{ region: '1,2,3,4', content: 'y' }],
      elements: [{ type: 'button' }],
      colors: [{ hex: '#000000', share: 0.1 }],
    })).toEqual({
      ocr: { fullText: 'x', language: 'eng' },
      layout: [{ region: '1,2,3,4', content: 'y' }],
      elements: [{ type: 'button' }],
      colors: [{ hex: '#000000', share: 0.1 }],
    })
  })

  it('omits unknown evidence keys', () => {
    expect(evidenceToRecord({ mystery: true })).toEqual({})
  })
})

describe('evidenceContextOf', () => {
  it('projects stored fields for prompt injection', () => {
    expect(evidenceContextOf(record)).toEqual({
      ocr: { fullText: 'hello', language: 'eng' },
      layout: record.layout,
      elements: record.elements,
      colors: record.colors,
    })
  })
})
