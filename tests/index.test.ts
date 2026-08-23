import { describe, expect, it } from 'vitest'
import { inject } from '../src/index.js'

describe('plugin service dependencies', () => {
  it('does not require per-call approval for browser automation', () => {
    expect(inject).not.toContain('approval')
    expect(inject).toEqual(expect.arrayContaining(['tools', 'attachments']))
  })
})
