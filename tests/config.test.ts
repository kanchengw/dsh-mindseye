import { describe, expect, it } from 'vitest'
import { Config, resolveMindsEyeConfig } from '../src/config.js'

describe('MindsEye config schema', () => {
  it('keeps memory enabled without exposing an image-input fallback', () => {
    const config = Config({}) as {
      memory: boolean
      pasteToPath?: boolean
    }
    expect(config.memory).toBe(true)
    expect(config.pasteToPath).toBeUndefined()
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

  it('migrates legacy route fields into the current config shape', () => {
    const legacy = {
      routes: { understand: [{ model: 'v', baseUrl: 'https://v.example', apiKeyEnv: 'V', protocol: 'responses' }] },
      fallbacks: [{ model: 'f', baseUrl: 'https://f.example', apiKeyEnv: 'F', protocol: 'responses' }],
      image: { routes: [{ model: 'g', baseUrl: 'https://g.example', apiKeyEnv: 'G' }], edits: [] },
    } as const
    const normalized = resolveMindsEyeConfig(Config(legacy as any) as any)
    expect(normalized.vision.routes.understand?.[0]?.model).toBe('v')
    expect(normalized.vision.fallbacks[0]?.model).toBe('f')
    expect(normalized.image.generate[0]?.model).toBe('g')
  })

  it('prefers current route fields when legacy and current fields coexist', () => {
    const normalized = resolveMindsEyeConfig({
      routes: { understand: [{ model: 'legacy', baseUrl: 'https://legacy.example', apiKeyEnv: 'L', protocol: 'responses' }] },
      vision: {
        routes: { understand: [{ model: 'current', baseUrl: 'https://current.example', apiKeyEnv: 'C', protocol: 'responses' }] },
        fallbacks: [],
      },
      image: {
        routes: [{ model: 'legacy-image', baseUrl: 'https://legacy.example', apiKeyEnv: 'L' }],
        generate: [{ model: 'current-image', baseUrl: 'https://current.example', apiKeyEnv: 'C' }],
        edit: [],
        edits: [],
      },
    })
    expect(normalized.vision.routes.understand?.[0]?.model).toBe('current')
    expect(normalized.image.generate[0]?.model).toBe('current-image')
  })

  it('keeps GUI disabled by default and applies safe limits', () => {
    const config = Config({}) as any

    expect(config.gui).toMatchObject({
      enabled: false,
      browser: 'auto',
      restrictHosts: false,
      allowedHosts: [],
      executablePath: '',
      maxSteps: 20,
      timeoutMs: 30_000,
    })
    expect(() => Config({ gui: { maxSteps: 0 } } as any)).toThrow()
    expect(() => Config({ gui: { timeoutMs: 99 } } as any)).toThrow()
  })

  it('preserves an explicit GUI executable path during normalization', () => {
    const normalized = resolveMindsEyeConfig({
      gui: {
        enabled: true,
        allowedHosts: ['localhost'],
        executablePath: 'C:\\Chrome\\chrome.exe',
      },
    })

    expect(normalized.gui).toMatchObject({
      enabled: true,
      browser: 'auto',
      allowedHosts: ['localhost'],
      executablePath: 'C:\\Chrome\\chrome.exe',
      maxSteps: 20,
      timeoutMs: 30_000,
    })
  })
})
