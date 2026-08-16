import { describe, expect, it, vi } from 'vitest'
import type { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import { VisionWrapperAdapter } from '../src/bridge/deepseek.js'

function fakeNative() {
  return {
    providerInfo: vi.fn((provider: string) => ({ id: provider, name: 'DeepSeek' })),
    providerRetryPolicy: vi.fn(() => undefined),
    listModels: vi.fn(async () => [
      { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'Flash' },
    ]),
    resolveModel: vi.fn(async (_provider: string, model: string) => ({
      provider: 'deepseek-official',
      id: model,
      name: model,
    })),
    stream: vi.fn(async function* () {
      yield { type: 'delta' as const, text: 'ok' }
    }),
  }
}

describe('VisionWrapperAdapter', () => {
  it('stamps image input on catalog and exact model metadata', async () => {
    const native = fakeNative()
    const wrapper = new VisionWrapperAdapter(
      native as unknown as DeepSeekAdapter,
      new Map(),
    )
    const listed = await wrapper.listModels('deepseek-official')
    expect(listed[0]?.inputModalities).toEqual(['text', 'image'])
    const resolved = await wrapper.resolveModel('deepseek-official', 'deepseek-v4-flash')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
  })

  it('rewrites image blocks before delegating and indexes attachment refs', async () => {
    const native = fakeNative()
    const refs = new Map()
    const wrapper = new VisionWrapperAdapter(
      native as unknown as DeepSeekAdapter,
      refs,
    )
    const messages = [{
      role: 'user' as const,
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', attachment: { attachmentId: 'sha256:abc', name: 'a.png' } },
      ],
    }]
    const chunks = []
    for await (const chunk of wrapper.stream({ provider: 'deepseek-official', model: 'm', messages } as never)) {
      chunks.push(chunk)
    }
    expect(refs.get('sha256:abc')?.name).toBe('a.png')
    const delegated = ((native.stream.mock.calls as unknown as Array<Array<unknown>>)[0]?.[0] ?? {}) as {
      messages: Array<{ content: unknown[] }>
    }
    expect(delegated.messages[0]?.content[1]).toMatchObject({ type: 'text' })
    expect((delegated.messages[0]?.content[1] as { text?: string })?.text).toContain('sha256:abc')
    expect(chunks).toHaveLength(1)
  })
})
