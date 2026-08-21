import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import { VisionWrapperAdapter } from '../src/bridge/deepseek.js'

function fakeNative() {
  return {
    providerInfo: vi.fn((provider: string) => ({ id: provider, name: 'DeepSeek' })),
    providerRetryPolicy: vi.fn(() => undefined),
    listModels: vi.fn(async () => [
      {
        provider: 'deepseek-official',
        id: 'deepseek-v4-flash',
        name: 'Flash',
        inputModalities: ['text'],
      },
      {
        provider: 'deepseek-official',
        id: 'deepseek-v4-vision',
        name: 'Vision',
        inputModalities: ['text', 'image'],
      },
    ]),
    resolveModel: vi.fn(async (_provider: string, model: string) => ({
      provider: 'deepseek-official',
      id: model,
      name: model,
      inputModalities: model === 'deepseek-v4-vision' ? ['text', 'image'] : ['text'],
    })),
    stream: vi.fn(async function* (_options: unknown) {
      yield { type: 'delta' as const, text: 'ok' }
    }),
  }
}

const imageMessages = [{
  role: 'user' as const,
  content: [
    { type: 'text', text: 'inspect this' },
    { type: 'image', attachment: { attachmentId: 'sha256:abc', name: 'a.png' } },
  ],
}]

describe('VisionWrapperAdapter', () => {
  it('keeps one model entry while exposing the composed image capability', async () => {
    const native = fakeNative()
    const wrapper = new VisionWrapperAdapter(native as unknown as DeepSeekAdapter, new Map())

    const listed = await wrapper.listModels('deepseek-official')
    expect(listed.map(model => model.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-vision',
    ])
    expect(listed.every(model => model.inputModalities?.includes('image'))).toBe(true)

    const resolved = await wrapper.resolveModel('deepseek-official', 'deepseek-v4-flash')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
  })

  it('rewrites image blocks only for a native text-only model', async () => {
    const native = fakeNative()
    const refs = new Map()
    const wrapper = new VisionWrapperAdapter(native as unknown as DeepSeekAdapter, refs)

    for await (const _chunk of wrapper.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: imageMessages,
    } as never)) {
      // Consume the delegated stream.
    }

    const delegated = native.stream.mock.calls[0]?.[0] as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>
    }
    expect(delegated.messages[0]?.content[1]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('sha256:abc'),
    })
    expect(refs.get('sha256:abc')).toMatchObject({ name: 'a.png' })
    expect(imageMessages[0]?.content[1]).toMatchObject({
      type: 'image',
      attachment: { attachmentId: 'sha256:abc' },
    })
  })

  it('passes native image content through unchanged for a multimodal model', async () => {
    const native = fakeNative()
    const wrapper = new VisionWrapperAdapter(native as unknown as DeepSeekAdapter, new Map())

    for await (const _chunk of wrapper.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-vision',
      messages: imageMessages,
    } as never)) {
      // Consume the delegated stream.
    }

    const delegated = native.stream.mock.calls[0]?.[0] as { messages: unknown }
    expect(delegated.messages).toBe(imageMessages)
  })

  it('sanitizes inside the prepared adapter registration without restarting the waterfall', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const native = fakeNative()
    const wrapper = new VisionWrapperAdapter(native as unknown as DeepSeekAdapter, new Map())
    ctx.llm.registerAdapter(['deepseek-official'], wrapper)
    let waterfallPasses = 0
    ctx.on('llm/stream', (_options, next) => {
      waterfallPasses += 1
      return next()
    })
    const prepared = await ctx.llm.prepareCall({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })

    for await (const _chunk of prepared.stream({
      ...prepared.config,
      messages: imageMessages,
    } as never)) {
      // Consume the prepared stream.
    }

    expect(waterfallPasses).toBe(1)
    expect(native.stream).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
