import { describe, expect, it } from 'vitest'
import { bm25Scores, tokenize } from '../src/memory/bm25.js'

describe('tokenize', () => {
  it('splits ascii words and Chinese character bigrams', () => {
    expect(tokenize('识别 图片 QR code')).toContain('识别')
    expect(tokenize('识别 图片')).toContain('识别')
    expect(tokenize('识别图片')).toContain('别图')
    expect(tokenize('qwen3.6-flash')).toContain('qwen3')
    expect(tokenize('qwen3.6-flash')).toContain('flash')
  })
})

describe('bm25Scores', () => {
  it('ranks documents sharing query tokens higher', () => {
    const documents = [
      { id: 'a', text: '图片中有几个按钮' },
      { id: 'b', text: '识别图片里的所有文字' },
      { id: 'c', text: '今天的天气怎么样' },
    ]
    const scores = bm25Scores('识别图片里的文字', documents)
    expect(scores[0]?.id).toBe('b')
    expect(scores.map((item) => item.id)).toContain('a')
    expect(scores.map((item) => item.id)).not.toContain('c')
  })

  it('returns empty for an empty query', () => {
    expect(bm25Scores('', [{ id: 'a', text: 'x' }])).toEqual([])
  })
})
