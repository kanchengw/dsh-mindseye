import { describe, expect, it, vi } from 'vitest'
import {
  createImageEditTool,
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
      loadPrepared: () => ({ currentRequest: 'a red eye' }),
    })

    await expect(tool.execute({ intentId: 'intent-1' }, {} as never))
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
      loadPrepared: () => ({
        currentRequest: 'a red eye',
        context: '主题是眼睛概念 logo',
      }),
    })

    const result = await tool.execute({
      intentId: 'intent-2',
    }, {} as never) as {
      images: Array<{ attachmentId?: string }>
    }
    expect(result.images[0]?.attachmentId).toBe('generated-1')
  })

  it('requires an intentId from mindseye_plan', async () => {
    const generate = vi.fn()
    const tool = createImageGenerationTool({
      routes: () => [route],
      generate,
      saveImage: vi.fn(),
      probeImage: () => ({ width: 1, height: 1, format: 'png' }),
    })

    await expect(tool.execute({}, {} as never))
      .rejects.toThrow('missing required property "intentId"')
    expect(generate).not.toHaveBeenCalled()
  })

  it('rejects a stale or invalid intentId', async () => {
    const generate = vi.fn()
    const tool = createImageGenerationTool({
      routes: () => [route],
      generate,
      saveImage: vi.fn(),
      probeImage: () => ({ width: 1, height: 1, format: 'png' }),
      loadPrepared: () => undefined,
    })

    await expect(tool.execute({ intentId: 'stale' }, {} as never))
      .rejects.toThrow('intentId 无效或已失效')
    expect(generate).not.toHaveBeenCalled()
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
      loadPrepared: () => ({
        currentRequest: '换个风格',
        context: '主题是眼睛概念 logo',
      }),
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
      intentId: 'intent-3',
    }, exec as never)

    expect(generate).toHaveBeenCalledWith({
      prompt: '用户本次需求：换个风格\n上下文：主题是眼睛概念 logo',
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
      loadPrepared: () => ({ currentRequest: '线条简单一点' }),
    })
    const value = await tool.execute({
      intentId: 'intent-4',
    }, {} as never)

    expect(tool.output.render({
      intentId: 'intent-4',
    }, value as never)).toEqual([
      {
        type: 'text',
        text: '<generated-image attachment_id="generated-1"></generated-image>',
      },
      { type: 'image', attachment },
      { type: 'text', text: '(token_usage=5, 1x1, 8B)' },
    ])

    expect(tool.output.presentationMeta!({
      intentId: 'intent-4',
    }, value as never)).toEqual({
      images: [{
        attachment,
        width: 1,
        height: 1,
      }],
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    })
    expect(tool.presentResult!({
      intentId: 'intent-4',
    }, {
      content: tool.output.render({
        intentId: 'intent-4',
      }, value as never),
      isError: false,
      meta: tool.output.presentationMeta!({
        intentId: 'intent-4',
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

describe('image edit tool', () => {
  it('checks edit routes before reading the reference image', async () => {
    const readImage = vi.fn()
    const tool = createImageEditTool({
      routes: () => [route],
      editsRoutes: () => [],
      generate: vi.fn(),
      readImage,
      probeImage: () => ({ width: 1, height: 1, format: 'png' }),
      saveImage: vi.fn(),
      loadPrepared: () => ({ currentRequest: '改成浅色' }),
    })
    await expect(tool.execute({ intentId: 'edit-1', attachmentId: 'sha256:abc' }, {} as never))
      .rejects.toThrow('no image edit route configured')
    expect(readImage).not.toHaveBeenCalled()
  })

  it('loads the reference image and routes through editsRoutes', async () => {
    const editRoute = { ...route, model: 'edit-model' }
    const generate = vi.fn(async () => ({
      images: [{ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' as const }],
      provider: 'images.example',
      model: 'edit-model',
      attempts: [],
    }))
    const onGenerated = vi.fn()
    const clearPrepared = vi.fn()
    const tool = createImageEditTool({
      routes: () => [route],
      editsRoutes: () => [editRoute],
      generate,
      readImage: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      probeImage: () => ({ width: 1, height: 1, format: 'png' }),
      saveImage: async () => ({
        attachmentId: 'generated-1',
        mediaType: 'image/png',
        bytes: 8,
        width: 1,
        height: 1,
      } as ImageAttachmentRef),
      loadPrepared: () => ({ currentRequest: '改成浅色' }),
      clearPrepared,
      onGenerated,
    })
    const exec = { agent: { session: {} }, signal: new AbortController().signal }
    await tool.execute({ intentId: 'edit-1', attachmentId: 'sha256:abc' }, exec as never)
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('改成浅色'),
        image: expect.objectContaining({ mediaType: 'image/png' }),
      }),
      [editRoute],
      exec.signal,
    )
    expect(onGenerated).toHaveBeenCalledOnce()
    expect(clearPrepared).toHaveBeenCalledWith('edit-1', exec.agent.session)
  })

  it('resizes an oversized edit result before saving it as an attachment', async () => {
    const original = new Uint8Array([1])
    const resized = new Uint8Array([2])
    const resizeImage = vi.fn(async () => resized)
    const probeImage = vi.fn()
      .mockReturnValueOnce({ width: 758, height: 696, format: 'png' })
      .mockReturnValueOnce({ width: 2048, height: 2048, format: 'jpeg' })
      .mockReturnValueOnce({ width: 1980, height: 1980, format: 'jpeg' })
    const saveImage = vi.fn(async () => ({
      attachmentId: 'generated-1',
      mediaType: 'image/jpeg',
      bytes: resized.byteLength,
      width: 1980,
      height: 1980,
    } as ImageAttachmentRef))
    const tool = createImageEditTool({
      routes: () => [route],
      editsRoutes: () => [route],
      generate: async () => ({
        images: [{ data: original, mediaType: 'image/jpeg' as const }],
        provider: 'images.example',
        model: 'image-model',
        attempts: [],
      }),
      readImage: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      probeImage,
      resizeImage,
      saveImage,
      loadPrepared: () => ({ currentRequest: '改成深色主题' }),
    })

    const result = await tool.execute({
      intentId: 'edit-2',
      attachmentId: 'sha256:source',
    }, {} as never) as { images: Array<{
      width: number
      height: number
      sourceWidth?: number
      sourceHeight?: number
    }> }

    expect(resizeImage).toHaveBeenCalledOnce()
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ data: resized }))
    expect(result.images[0]).toEqual(expect.objectContaining({
      width: 1980,
      height: 1980,
      sourceWidth: 2048,
      sourceHeight: 2048,
    }))
    expect(tool.output.render({ intentId: 'edit-2' }, result as never)).toContainEqual({
      type: 'text',
      text: '(token_usage=n/a, 2048×2048 → 1980×1980 （ dsh 对图片限制 2000x2000px ）, 1B)',
    })
  })
})

