import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'

describe('MindsEye config schema', () => {
  it('enables tool activation defaults', () => {
    const config = Config({}) as {
      autoActivateOnImage: boolean
      progressiveTools: boolean
      takeover: boolean
      memory: boolean
    }
    expect(config.autoActivateOnImage).toBe(true)
    expect(config.progressiveTools).toBe(true)
    expect(config.takeover).toBe(true)
    expect(config.memory).toBe(true)
  })

  it('allows disabling tool activation explicitly', () => {
    const config = Config({ autoActivateOnImage: false, progressiveTools: false }) as {
      autoActivateOnImage: boolean
      progressiveTools: boolean
    }
    expect(config.autoActivateOnImage).toBe(false)
    expect(config.progressiveTools).toBe(false)
  })
})
