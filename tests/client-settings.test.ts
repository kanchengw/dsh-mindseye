import { describe, expect, it } from 'vitest'
import {
  decodeSettings,
  encodeSettings,
  optionalRouteValidationError,
  routeIsComplete,
  routeValidationError,
  updateRoute,
} from '../src/client/settings.js'

const complete = {
  model: 'qwen3-vl-plus',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  protocol: 'chat-completions',
  maxTokens: '2048',
}

describe('client settings codec', () => {
  it('decodes default route and intent overrides', () => {
    const draft = decodeSettings({
      routes: {
        understand: [complete],
        extract: [{ ...complete, model: 'qwen3-vl-ocr' }],
      },
    }) as any
    expect(draft.defaultRoute.model).toBe('qwen3-vl-plus')
    expect(draft.defaultRoute.protocol).toBe('chat-completions')
    expect(draft.overrides.extract?.model).toBe('qwen3-vl-ocr')
  })

  it('encodes complete routes back to settings shape', () => {
    const draft = decodeSettings({})
    const next = updateRoute(draft.defaultRoute, complete)
    const encoded = encodeSettings({ ...draft, defaultRoute: next })
    expect(encoded.fallbacks).toEqual([])
    expect(encoded.routes.understand).toHaveLength(1)
    expect(encoded.routes.understand[0]?.model).toBe('qwen3-vl-plus')
    expect(encoded.routes.understand[0]?.protocol).toBe('chat-completions')
  })

  it('keeps incomplete routes out of saved settings', () => {
    const draft = decodeSettings({})
    const incomplete = updateRoute(draft.defaultRoute, { ...complete, model: '' })
    const encoded = encodeSettings({ ...draft, defaultRoute: incomplete })
    expect(encoded.fallbacks).toEqual([])
    expect(encoded.routes).toEqual({})
  })

  it('validates model, url and credential fields', () => {
    expect(routeIsComplete(complete)).toBe(true)
    expect(routeValidationError({ ...complete, protocol: '' })).toBeDefined()
    expect(routeValidationError({ ...complete, model: '' })).toBeDefined()
    expect(routeValidationError({ ...complete, baseUrl: 'not-a-url' })).toBeDefined()
    expect(routeValidationError({ ...complete, apiKeyEnv: '' })).toBeDefined()
    expect(routeValidationError({ ...complete, maxTokens: '0' })).toBeDefined()
  })

  it('allows optional override routes to stay empty', () => {
    const draft = decodeSettings({}) as any
    expect(optionalRouteValidationError(draft.overrides.extract)).toBeUndefined()
    const partial = updateRoute(draft.overrides.extract, { model: 'qwen3-vl-ocr' })
    expect(optionalRouteValidationError(partial)).toBeDefined()
  })

  it('round-trips tool activation toggles', () => {
    const encoded = encodeSettings({
      ...decodeSettings({}),
      autoActivateOnImage: false,
      progressiveTools: false,
    } as any)
    expect(encoded.autoActivateOnImage).toBe(false)
    expect(encoded.progressiveTools).toBe(false)
    const decoded = decodeSettings(encoded)
    expect(decoded.autoActivateOnImage).toBe(false)
    expect(decoded.progressiveTools).toBe(false)
  })
})
