import { describe, expect, it } from 'vitest'
import { buildUserNotice } from '../src/bridge/notice.js'

describe('buildUserNotice', () => {
  it('announces exact cache hits', () => {
    expect(buildUserNotice({ cache: 'hit' })).toContain('精确缓存')
  })

  it('announces evidence reuse', () => {
    expect(buildUserNotice({ cache: 'miss', source: 'evidence' })).toContain('图片证据')
  })

  it('announces soft memory injection', () => {
    const notice = buildUserNotice({ cache: 'miss', source: 'soft-memory', softMemoryHits: 2 })
    expect(notice).toContain('2 条历史记忆')
  })

  it('stays quiet for a plain model call', () => {
    expect(buildUserNotice({ cache: 'miss', source: 'model' })).toBeUndefined()
  })
})
