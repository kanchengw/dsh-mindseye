import { describe, expect, it, vi } from 'vitest'
import { generateImagesWithMindsEye } from '../src/image-tool.js'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageGenerationRoute } from '../src/types.js'

const route: ImageGenerationRoute = {
  model: 'image-model',
  baseUrl: 'https://images.example/v1',
  apiKeyEnv: 'IMAGE_KEY',
}

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 10, 0, 0, 0, 20,
])

describe('generateImagesWithMindsEye', () => {
  it('saves every generated image and returns durable attachment metadata', async () => {
    const generate = vi.fn(async () => ({
      images: [{ data: png, mediaType: 'image/png' as const }],
      provider: 'images.example',
      model: 'image-model',
      attempts: [{ provider: 'images.example', model: 'image-model', ok: true, latencyMs: 1 }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }))
    const saveImage = vi.fn(async () => ({
      attachmentId: 'image-1',
      mediaType: 'image/png',
      bytes: 8,
      width: 10,
      height: 20,
    } as ImageAttachmentRef))
    const result = await generateImagesWithMindsEye({
      request: 'a coral red eye',
      context: '纯图形，严禁任何文字',
    }, {
      generate,
      saveImage,
      probeImage: () => ({ width: 10, height: 20, format: 'png' }),
    }, [route])

    expect(generate).toHaveBeenCalledWith({
      prompt: '用户本次需求：a coral red eye\n上下文：纯图形，严禁任何文字',
      requestVersion: 'mindseye-image-generation-v1',
    }, [route], undefined)
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ data: png, mediaType: 'image/png' }))
    expect(result.images).toEqual([expect.objectContaining({
      attachmentId: 'image-1',
      width: 10,
      height: 20,
      format: 'png',
    })])
    expect(result.meta).toEqual({
      provider: 'images.example',
      model: 'image-model',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
  })

  it('uses only the current request when no cross-turn context is provided', async () => {
    const generate = vi.fn(async () => ({
      images: [{ data: png, mediaType: 'image/png' as const }],
      provider: 'images.example',
      model: 'image-model',
      attempts: [{ provider: 'images.example', model: 'image-model', ok: true, latencyMs: 1 }],
    }))

    await generateImagesWithMindsEye({
      request: '线条简单一点',
    }, {
      generate,
      saveImage: vi.fn(async () => ({
        attachmentId: 'image-1',
        mediaType: 'image/png',
        bytes: 8,
        width: 10,
        height: 20,
      } as ImageAttachmentRef)),
      probeImage: () => ({ width: 10, height: 20, format: 'png' }),
    }, [route])

    expect(generate).toHaveBeenCalledWith({
      prompt: '用户本次需求：线条简单一点',
      requestVersion: 'mindseye-image-generation-v1',
    }, [route], undefined)
  })

  it('rejects an empty request before calling the provider', async () => {
    const generate = vi.fn()

    await expect(generateImagesWithMindsEye({ request: '   ' }, {
      generate,
      saveImage: vi.fn(),
      probeImage: () => ({ width: 1, height: 1, format: 'png' }),
    }, [route])).rejects.toThrow('request is required')

    expect(generate).not.toHaveBeenCalled()
  })

  it('forwards an optional size to the provider spec', async () => {
    const generate = vi.fn(async () => ({
      images: [{ data: png, mediaType: 'image/png' as const }],
      provider: 'images.example',
      model: 'image-model',
      attempts: [{ provider: 'images.example', model: 'image-model', ok: true, latencyMs: 1 }],
    }))

    await generateImagesWithMindsEye({
      request: '生成一张竖版图',
      size: '1440x2560',
    }, {
      generate,
      saveImage: vi.fn(async () => ({
        attachmentId: 'image-1',
        mediaType: 'image/png',
        bytes: 8,
        width: 10,
        height: 20,
      } as ImageAttachmentRef)),
      probeImage: () => ({ width: 10, height: 20, format: 'png' }),
    }, [route])

    expect(generate).toHaveBeenCalledWith({
      prompt: '用户本次需求：生成一张竖版图',
      requestVersion: 'mindseye-image-generation-v1',
      size: '1440x2560',
    }, [route], undefined)
  })
})
