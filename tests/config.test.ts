import { describe, expect, it } from 'vitest'
import { Config, resolveMindsEyeConfig } from '../src/config.js'

describe('MindsEye config schema', () => {
  it('keeps memory enabled and takeover is no longer configurable', () => {
    const config = Config({}) as {
      memory: boolean
    }
    expect(config.memory).toBe(true)
  })

  it('does not expose promptVersion as user configuration', () => {
    const normalized = resolveMindsEyeConfig({ promptVersion: 'legacy-value' } as any) as unknown as Record<string, unknown>
    expect(normalized.promptVersion).toBeUndefined()
  })

  it('accepts a separate image generation route', () => {
    const config = Config({
      image: {
        generate: [{
          model: 'image-model',
          baseUrl: 'https://images.example/v1',
          apiKeyEnv: 'IMAGE_KEY',
        }],
      },
    }) as {
      image: {
        generate: Array<{
          model: string
          baseUrl: string
          apiKeyEnv: string
          endpoint?: string
          bodyMode?: string
          imageField?: string
        }>
      }
    }
    expect(config.image.generate[0]).toMatchObject({
      model: 'image-model',
      baseUrl: 'https://images.example/v1',
      apiKeyEnv: 'IMAGE_KEY',
    })
    expect(config.image.generate[0]?.endpoint).toBeUndefined()
    expect(config.image.generate[0]?.bodyMode).toBeUndefined()
    expect(config.image.generate[0]?.imageField).toBeUndefined()
  })

  it('drops removed legacy route fields instead of normalizing them', () => {
    const legacy = {
      routes: { understand: [{ model: 'v', baseUrl: 'https://v.example', apiKeyEnv: 'V', protocol: 'responses' }] },
      fallbacks: [{ model: 'f', baseUrl: 'https://f.example', apiKeyEnv: 'F', protocol: 'responses' }],
      image: { routes: [{ model: 'g', baseUrl: 'https://g.example', apiKeyEnv: 'G' }], edits: [] },
    } as const
    const normalized = resolveMindsEyeConfig(Config(legacy as any) as any)
    expect(normalized.vision.routes).toEqual({})
    expect(normalized.vision.fallbacks).toEqual([])
    expect(normalized.image.generate).toEqual([])
  })
})
