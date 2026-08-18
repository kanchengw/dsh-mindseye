import { describe, expect, it, vi } from 'vitest'
import {
  callImageGenerationProvider,
  ImageGenerationProviderError,
  runImageGenerationChain,
} from '../src/image-generation.js'
import type { ImageGenerationRoute } from '../src/types.js'

const route: ImageGenerationRoute = {
  model: 'primary-image-model',
  baseUrl: 'https://images.example/v1',
  apiKeyEnv: 'IMAGE_KEY',
  defaultSize: '1024x1024',
}

const pngBase64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString('base64')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('callImageGenerationProvider', () => {
  it('sends the normalized request and decodes b64 image data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ b64_json: pngBase64 }],
    }))

    const result = await callImageGenerationProvider({
      route,
      apiKey: 'secret',
      spec: { prompt: 'a precise image', size: '1536x1024', n: 1, requestVersion: 'v1' },
    }, fetchMock as unknown as typeof fetch)

    expect(result.images).toHaveLength(1)
    expect(result.images[0]?.mediaType).toBe('image/png')
    expect(result.images[0]?.data).toEqual(new Uint8Array(Buffer.from(pngBase64, 'base64')))
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: route.model,
      prompt: 'a precise image',
      size: '1536x1024',
      n: 1,
    })
  })
})

describe('runImageGenerationChain', () => {
  it('uses the fallback route after a retryable provider failure', async () => {
    const fallback = { ...route, model: 'fallback-image-model' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, 429))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: pngBase64 }] }))

    const result = await runImageGenerationChain({
      routes: [route, fallback],
      spec: { prompt: 'a precise image', size: '1024x1024', n: 1, requestVersion: 'v1' },
      resolveApiKey: async () => 'secret',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.model).toBe('fallback-image-model')
    expect(result.images).toHaveLength(1)
    expect(result.attempts).toHaveLength(2)
  })

  it('does not try a fallback after an authentication failure', async () => {
    const fallback = { ...route, model: 'fallback-image-model' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad key' }, 401))

    await expect(runImageGenerationChain({
      routes: [route, fallback],
      spec: { prompt: 'a precise image', size: '1024x1024', n: 1, requestVersion: 'v1' },
      resolveApiKey: async () => 'secret',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({
      kind: 'auth',
    } satisfies Partial<ImageGenerationProviderError>)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
