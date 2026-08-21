import { describe, expect, it } from 'vitest'
import { rememberImageRef } from '../src/bridge/image-refs.js'

describe('rememberImageRef', () => {
  it('keeps only the 128 most recently used attachment refs', () => {
    const refs = new Map()
    for (let index = 0; index < 128; index += 1) {
      rememberImageRef(refs, `sha256:${index}`, { attachmentId: `sha256:${index}` })
    }
    rememberImageRef(refs, 'sha256:0', { attachmentId: 'sha256:0' })
    rememberImageRef(refs, 'sha256:128', { attachmentId: 'sha256:128' })

    expect(refs).toHaveLength(128)
    expect(refs.has('sha256:0')).toBe(true)
    expect(refs.has('sha256:1')).toBe(false)
    expect(refs.has('sha256:128')).toBe(true)
  })
})
