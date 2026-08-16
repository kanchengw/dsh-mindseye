import { describe, expect, it, vi } from 'vitest'
import {
  callProvider,
  parseBatchText,
  runProviderChain,
  runVisionBatchChain,
  VisionProviderError,
} from '../src/providers.js'
import type { VisionRoute } from '../src/types.js'

const route: VisionRoute = {
  model: 'm',
  baseUrl: 'https://vision.example/v1',
  apiKeyEnv: 'VISION_KEY',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('callProvider', () => {
  it('extracts text from chat completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'the answer' } }],
    }))
    const result = await callProvider({
      dataUrl: 'data:image/png;base64,aa',
      prompt: 'describe',
      route,
      apiKey: 'key',
    }, fetchMock as unknown as typeof fetch)
    expect(result.analysis.text).toBe('the answer')
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(JSON.parse(String(request?.body)).model).toBe('m')
  })

  it('extracts text from responses protocol', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
    }))
    const result = await callProvider({
      dataUrl: 'data:image/png;base64,aa',
      prompt: 'describe',
      route: { ...route, protocol: 'responses' },
      apiKey: 'key',
    }, fetchMock as unknown as typeof fetch)
    expect(result.analysis.text).toBe('hello')
  })

  it('returns token usage from chat completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    }))
    const result = await callProvider({
      dataUrl: 'data:image/png;base64,aa',
      prompt: 'describe',
      route,
      apiKey: 'key',
    }, fetchMock as unknown as typeof fetch)
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 })
  })

  it('classifies auth errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad key' }, 401))
    await expect(callProvider({
      dataUrl: 'data:image/png;base64,aa',
      prompt: 'describe',
      route,
      apiKey: 'bad',
    }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('runProviderChain', () => {
  it('fails over to the next provider', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'quota' }, 402))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    const result = await runProviderChain({
      routes: [route, { ...route, baseUrl: 'https://q/v1' }],
      dataUrl: 'data:image/png;base64,aa',
      prompt: 'describe',
      resolveApiKey: async () => 'key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result.provider).toBe('q')
    expect(result.attempts[0]?.ok).toBe(false)
    expect(result.attempts[1]?.ok).toBe(true)
    expect(result.usage?.totalTokens).toBe(2)
  })

  it('throws when every provider fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'quota' }, 402))
    await expect(runProviderChain({
      routes: [route],
      dataUrl: 'data:image/png;base64,aa',
      prompt: 'describe',
      resolveApiKey: async () => 'key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toBeInstanceOf(VisionProviderError)
  })
})

describe('parseBatchText', () => {
  const images = [
    { id: 'sha256:a', dataUrl: 'x' },
    { id: 'sha256:b', dataUrl: 'y' },
  ]

  it('parses JSON keyed by image id', () => {
    const parsed = parseBatchText(JSON.stringify({
      'sha256:a': { text: 'answer A', evidence: { ocr: { fullText: 'hi' } } },
      'sha256:b': 'answer B',
    }), images)
    expect(parsed.results.get('sha256:a')).toBe(JSON.stringify({
      text: 'answer A',
      evidence: { ocr: { fullText: 'hi' } },
    }))
    expect(parsed.results.get('sha256:b')).toBe('answer B')
    expect(parsed.errors.size).toBe(0)
  })

  it('falls back to marker sections when JSON is missing', () => {
    const parsed = parseBatchText(
      '图1（id: sha256:a）: 内容 A\n图2（id: sha256:b）: 内容 B',
      images,
    )
    expect(parsed.results.get('sha256:a')).toBe('内容 A')
    expect(parsed.results.get('sha256:b')).toBe('内容 B')
  })
})

describe('runVisionBatchChain', () => {
  it('halves the batch on 4xx and still returns every image', async () => {
    const route: VisionRoute = {
      model: 'm',
      baseUrl: 'https://vision.example/v1',
      apiKeyEnv: 'VISION_KEY',
    }
    const images = ['a', 'b', 'c', 'd'].map((id) => ({ id: `sha256:${id}`, dataUrl: `data:image/png;base64,${id}` }))
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: Array<{ type?: string; text?: string }> }>
      }
      const ids = body.messages[0]?.content
        .filter((block) => typeof block.text === 'string' && block.text.includes('（id:'))
        .map((block) => block.text?.match(/id:\s*([^）：\s]+)/)?.[1])
        .filter((id): id is string => id !== undefined) ?? []
      if (ids.length === 4) return jsonResponse({ error: 'too many images' }, 413)
      const perImage: Record<string, string> = {}
      for (const id of ids) perImage[id] = `answer-${id}`
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(perImage) } }] })
    })

    const result = await runVisionBatchChain({
      images,
      prompt: 'analyze',
      routes: [route],
      resolveApiKey: async () => 'key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result.results.size).toBe(4)
    expect(result.results.get('sha256:a')).toBe('answer-sha256:a')
    expect(result.errors.size).toBe(0)
    expect(result.attempts.some((attempt) => !attempt.ok)).toBe(true)
    expect(result.attempts.filter((attempt) => attempt.ok).length).toBe(2)
  })
})
