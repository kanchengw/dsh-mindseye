import { describe, expect, it } from 'vitest'
import { buildBatchPrompt, buildPrompt } from '../src/prompt.js'

describe('buildPrompt with extract', () => {
  it('requests combined structured evidence in one envelope', () => {
    const prompt = buildPrompt('visual-qa', {
      currentRequest: '看文字和颜色',
      extract: ['ocr', 'colors'],
    })
    expect(prompt).toContain('"answer": "<你的回答>"')
    expect(prompt).toContain('"ocr": {"fullText"')
    expect(prompt).toContain('"colors": [{"hex"')
    expect(prompt).toContain('Question: 看文字和颜色')
  })

  it('keeps the single-intent evidence instruction when extract is empty', () => {
    const prompt = buildPrompt('color', { currentRequest: '整体主色' })
    expect(prompt).toContain('"evidence": {"colors"')
    expect(prompt).not.toContain('"ocr": {"fullText"')
  })

  it('deduplicates repeated extract kinds', () => {
    const prompt = buildPrompt('visual-qa', { extract: ['ocr', 'ocr', 'layout'] })
    expect(prompt.indexOf('"ocr"')).toBe(prompt.lastIndexOf('"ocr"'))
    expect(prompt).toContain('"layout"')
  })
})

describe('buildBatchPrompt with extract', () => {
  it('asks every image for the requested evidence fields', () => {
    const prompt = buildBatchPrompt('visual-qa', ['sha256:a', 'sha256:b'], {
      extract: ['ocr', 'layout'],
    })
    expect(prompt).toContain('2 张图')
    expect(prompt).toContain('每张图的 evidence 必须包含请求的字段')
    expect(prompt).toContain('"ocr": {"fullText"')
    expect(prompt).toContain('"layout": [{"region"')
  })
})
