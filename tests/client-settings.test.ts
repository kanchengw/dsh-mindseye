import { describe, expect, it } from 'vitest'
import {
  decodeSettings,
  encodeSettings,
  imageRouteIsComplete,
  imageRouteValidationError,
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

const completeImageRoute = {
  model: 'doubao-seed-2-0-pro-260215',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKeyEnv: 'ARK_API_KEY',
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

  it('round-trips only the image primary route and drops fallback slots', () => {
    const draft = decodeSettings({
      image: { routes: [completeImageRoute, { ...completeImageRoute, model: 'doubao-seedream-5-0-260128' }] },
    })
    expect(draft.imagePrimary.model).toBe('doubao-seed-2-0-pro-260215')
    const encoded = encodeSettings(draft)
    expect(encoded.routes).toEqual({})
    expect(encoded.image.routes).toEqual([completeImageRoute])
  })

  it('keeps incomplete routes out of saved settings', () => {
    const draft = decodeSettings({})
    const incomplete = updateRoute(draft.defaultRoute, { ...complete, model: '' })
    const encoded = encodeSettings({ ...draft, defaultRoute: incomplete })
    expect(encoded.fallbacks).toEqual([])
    expect(encoded.routes).toEqual({})
  })


  it('round-trips image edit routes', () => {
    const draft = decodeSettings({ image: { edits: [completeImageRoute] } })
    expect(draft.imageEdits.model).toBe('doubao-seed-2-0-pro-260215')
    const encoded = encodeSettings(draft)
    expect(encoded.image.edits).toEqual([completeImageRoute])
  })

  it('validates model, url and credential fields', () => {
    expect(routeIsComplete(complete)).toBe(true)
    expect(routeValidationError({ ...complete, protocol: '' })).toBeDefined()
    expect(routeValidationError({ ...complete, model: '' })).toBeDefined()
    expect(routeValidationError({ ...complete, baseUrl: 'not-a-url' })).toBeDefined()
    expect(routeValidationError({ ...complete, apiKeyEnv: '' })).toBeDefined()
    expect(routeValidationError({ ...complete, maxTokens: '0' })).toBeDefined()
  })

  it('requires image model, URL and credential fields', () => {
    expect(imageRouteIsComplete(completeImageRoute)).toBe(true)
    expect(imageRouteValidationError({ ...completeImageRoute, model: '' })).toBeDefined()
    expect(imageRouteValidationError({ ...completeImageRoute, baseUrl: 'not-a-url' })).toBeDefined()
  })

  it('allows optional override routes to stay empty', () => {
    const draft = decodeSettings({}) as any
    expect(optionalRouteValidationError(draft.overrides.extract)).toBeUndefined()
    const partial = updateRoute(draft.overrides.extract, { model: 'qwen3-vl-ocr' })
    expect(optionalRouteValidationError(partial)).toBeDefined()
  })

})
