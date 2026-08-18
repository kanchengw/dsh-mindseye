import { describe, expect, it, vi } from 'vitest'
import { generateImagesWithMindsEye } from '../src/image-tool.js'
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
    }))
    const saveImage = vi.fn(async () => ({ attachmentId: 'image-1' }))
    const qa = vi.fn(async () => ({
      text: 'The image is readable and depicts the requested subject.',
      latencyMs: 1,
      attempts: [],
    }))

    const result = await generateImagesWithMindsEye({ prompt: 'a coral red eye' }, {
      generate,
      saveImage,
      probeImage: () => ({ width: 10, height: 20, format: 'png' }),
      qa,
    }, [route])

    expect(generate).toHaveBeenCalledWith({
      prompt: 'a coral red eye\n\nDo not include a watermark, signature, logo, or any unrelated readable text.',
      requestVersion: 'mindseye-image-generation-v1',
    }, [route], undefined)
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ data: png, mediaType: 'image/png' }))
    expect(result.images).toEqual([expect.objectContaining({
      attachmentId: 'image-1',
      width: 10,
      height: 20,
      format: 'png',
    })])
    expect(result.meta.qa).toEqual([expect.objectContaining({
      attachmentId: 'image-1',
      text: 'The image is readable and depicts the requested subject.',
    })])
  })

  it('keeps a saved candidate when a later candidate cannot be stored', async () => {
    const result = await generateImagesWithMindsEye({ prompt: 'two eyes' }, {
      generate: async () => ({
        images: [
          { data: png, mediaType: 'image/png' as const },
          { data: png, mediaType: 'image/png' as const },
        ],
        provider: 'images.example',
        model: 'image-model',
        attempts: [],
      }),
      saveImage: vi.fn()
        .mockResolvedValueOnce({ attachmentId: 'image-1' })
        .mockRejectedValueOnce(new Error('attachment store unavailable')),
      probeImage: () => ({ width: 10, height: 20, format: 'png' }),
    }, [route])

    expect(result.images).toHaveLength(1)
    expect(result.failures).toEqual([{
      candidate: 2,
      stage: 'save',
      error: 'attachment store unavailable',
    }])
  })

  it('reports QA failures without discarding a saved candidate', async () => {
    const result = await generateImagesWithMindsEye({ prompt: 'an eye' }, {
      generate: async () => ({
        images: [{ data: png, mediaType: 'image/png' as const }],
        provider: 'images.example',
        model: 'image-model',
        attempts: [],
      }),
      saveImage: async () => ({ attachmentId: 'image-1' }),
      probeImage: () => ({ width: 10, height: 20, format: 'png' }),
      qa: async () => { throw new Error('vision route unavailable') },
    }, [route])

    expect(result.images).toHaveLength(1)
    expect(result.meta.qa).toEqual([expect.objectContaining({
      attachmentId: 'image-1',
      text: 'QA unavailable: vision route unavailable',
    })])
  })
})
