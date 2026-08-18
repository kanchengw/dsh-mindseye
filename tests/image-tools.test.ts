import { describe, expect, it, vi } from 'vitest'
import {
  createImageGenerationTool,
} from '../src/image-tools.js'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageGenerationRoute } from '../src/types.js'

const route: ImageGenerationRoute = {
  model: 'image-model',
  baseUrl: 'https://images.example/v1',
  apiKeyEnv: 'IMAGE_KEY',
}

describe('image generation tool', () => {
  it('returns an error before generating when no route is configured', async () => {
    const generate = vi.fn()
    const tool = createImageGenerationTool({
      routes: () => [],
      generate,
      saveImage: vi.fn(),
      probeImage: () => ({ width: 1, height: 1, format: 'png' }),
    })

    await expect(tool.execute({ request: 'a red eye', subject: 'eye logo' }, {} as never))
      .rejects.toThrow('no image generation route configured')
    expect(generate).not.toHaveBeenCalled()
  })

  it('saves the generated attachment without an extra QA pass', async () => {
    const tool = createImageGenerationTool({
      routes: () => [route],
      generate: async () => ({
        images: [{ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' as const }],
        provider: 'images.example',
        model: 'image-model',
        attempts: [],
      }),
      saveImage: async () => ({
        attachmentId: 'generated-1',
        mediaType: 'image/png',
        bytes: 8,
        width: 1,
        height: 1,
      } as ImageAttachmentRef),
      probeImage: () => ({ width: 1, height: 1, format: 'png' }),
    })

    const result = await tool.execute({
      request: 'a red eye',
      subject: 'eye logo',
      context: '主题是眼睛概念 logo',
    }, {} as never) as {
      images: Array<{ attachmentId?: string }>
    }
    expect(result.images[0]?.attachmentId).toBe('generated-1')
  })

  it('uses the latest user message as the request instead of model-provided text', async () => {
    const generate = vi.fn(async () => ({
      images: [{ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' as const }],
      provider: 'images.example',
      model: 'image-model',
      attempts: [],
    }))
    const tool = createImageGenerationTool({
      routes: () => [route],
      generate,
      saveImage: async () => ({
        attachmentId: 'generated-1',
        mediaType: 'image/png',
        bytes: 8,
        width: 1,
        height: 1,
      } as ImageAttachmentRef),
      probeImage: () => ({ width: 1, height: 1, format: 'png' }),
    })
    const exec = {
      agent: {
        session: {
          events: [
            {
              type: 'user/message',
              data: {
                content: [
                  { type: 'text', text: '换个风格' },
                  { type: 'image', attachment: { attachmentId: 'sha256:upload' } },
                ],
              },
            },
          ],
        },
      },
      signal: new AbortController().signal,
    }

    await tool.execute({
      request: 'A long expanded English description that must be ignored',
      subject: '眼睛概念 logo',
      context: '主题是眼睛概念 logo',
    }, exec as never)

    expect(generate).toHaveBeenCalledWith({
      prompt: '主题：眼睛概念 logo\n用户本次需求：换个风格\n上下文：主题是眼睛概念 logo',
      requestVersion: 'mindseye-image-generation-v1',
    }, [route], exec.signal)
  })

  it('keeps the model-facing result text-only and presents the image for the UI', async () => {
    const attachment = {
      attachmentId: 'generated-1',
      mediaType: 'image/png' as const,
      bytes: 8,
      width: 1,
      height: 1,
    }
    const tool = createImageGenerationTool({
      routes: () => [route],
      generate: async () => ({
        images: [{ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' as const }],
        provider: 'images.example',
        model: 'image-model',
        attempts: [],
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      }),
      saveImage: async () => attachment as unknown as ImageAttachmentRef,
      probeImage: () => ({ width: 1, height: 1, format: 'png' }),
    })
    const value = await tool.execute({
      request: '线条简单一点',
      subject: 'eye logo',
      context: '主题是眼睛概念 logo',
    }, {} as never)

    expect(tool.output.render({
      request: '线条简单一点',
      subject: 'eye logo',
      context: '主题是眼睛概念 logo',
    }, value as never)).toEqual([
      {
        type: 'text',
        text: '<generated-image attachment_id="generated-1"></generated-image>',
      },
      { type: 'image', attachment },
      { type: 'text', text: '(token_usage=5, 1x1, 8B)' },
    ])

    expect(tool.output.presentationMeta!({
      request: '线条简单一点',
      subject: 'eye logo',
      context: '主题是眼睛概念 logo',
    }, value as never)).toEqual({
      images: [{
        attachment,
        width: 1,
        height: 1,
      }],
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    })
    expect(tool.presentResult!({
      request: '线条简单一点',
      subject: 'eye logo',
      context: '主题是眼睛概念 logo',
    }, {
      content: tool.output.render({
        request: '线条简单一点',
        subject: 'eye logo',
        context: '主题是眼睛概念 logo',
      }, value as never),
      isError: false,
      meta: tool.output.presentationMeta!({
        request: '线条简单一点',
        subject: 'eye logo',
        context: '主题是眼睛概念 logo',
      }, value as never),
    })).toEqual({
      card: 'generic',
      content: [
        { type: 'image', attachment },
        { type: 'text', text: '(token_usage=5, 1x1, 8B)' },
      ],
    })
  })
})

