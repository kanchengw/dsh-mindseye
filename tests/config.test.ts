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

  it('accepts a separate image generation route', () => {
    const config = Config({
      image: {
        routes: [{
          model: 'image-model',
          baseUrl: 'https://images.example/v1',
          apiKeyEnv: 'IMAGE_KEY',
        }],
      },
    }) as { image: { routes: Array<{ model: string; baseUrl: string; apiKeyEnv: string }> } }
    expect(config.image.routes[0]).toMatchObject({
      model: 'image-model',
      baseUrl: 'https://images.example/v1',
      apiKeyEnv: 'IMAGE_KEY',
    })
  })
})
