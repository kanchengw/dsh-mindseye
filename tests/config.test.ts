import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'

describe('MindsEye config schema', () => {
  it('keeps takeover and memory enabled by default', () => {
    const config = Config({}) as {
      takeover: boolean
      memory: boolean
    }
    expect(config.takeover).toBe(true)
    expect(config.memory).toBe(true)
  })

  it('allows disabling takeover explicitly', () => {
    const config = Config({ takeover: false }) as { takeover: boolean }
    expect(config.takeover).toBe(false)
  })
})
