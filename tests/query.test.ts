import { describe, expect, it } from 'vitest'
import { canonicalQuestionKey, normalizeQuery } from '../src/query.js'

describe('normalizeQuery', () => {
  it('normalizes unicode, case, punctuation and whitespace', () => {
    expect(normalizeQuery('  PLEASE  help me read the TEXT？ ')).toBe('help me read the text')
  })

  it('removes polite prefixes and suffixes', () => {
    expect(normalizeQuery('请帮我看看图片里的按钮，谢谢')).toBe('图片按钮')
  })

  it('maps image and button synonyms', () => {
    expect(normalizeQuery('how many buttons in this screenshot?')).toBe('数量 按钮 in 图片')
  })

  it('normalizes count expressions', () => {
    expect(normalizeQuery('图片里有 3 个按钮')).toBe('图片有 3 按钮')
  })

  it('returns empty string for undefined or blank input', () => {
    expect(normalizeQuery(undefined)).toBe('')
    expect(normalizeQuery('   ')).toBe('')
  })
})

describe('canonicalQuestionKey', () => {
  it('stabilizes equivalent questions', () => {
    expect(canonicalQuestionKey('请帮我看看图里一共有多少个按钮'))
      .toBe(canonicalQuestionKey('这张截图上有几个按钮？'))
  })

  it('distinguishes different question operators', () => {
    expect(canonicalQuestionKey('图里的按钮在哪'))
      .not.toBe(canonicalQuestionKey('图里有多少按钮'))
  })
})
