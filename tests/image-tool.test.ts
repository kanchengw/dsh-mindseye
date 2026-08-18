import { describe, expect, it, vi } from 'vitest'
import { generateImagesWithMindsEye } from '../src/image-tool.js'
import type { ImageGenerationRoute } from '../src/types.js'

const route: ImageGenerationRoute = {
  model: 'image-model',
  baseUrl: 'https://images.example/v1',
  apiKeyEnv: 'IMAGE_KEY',
  defaultSize: '1024x1024',
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
    const qa = vi.fn(async () => 'The image is readable and depicts the requested subject.')

    const result = await generateImagesWithMindsEye({ prompt: 'a coral red eye', n: 1 }, {
      generate,
      saveImage,
      probeImage: () => ({ width: 10, height: 20, format: 'png' }),
      qa,
    }, [route])

    expect(generate).toHaveBeenCalledWith({
      prompt: 'a coral red eye',
      size: '1024x1024',
      n: 1,
      requestVersion: 'mindseye-image-generation-v1',
    }, [route])
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ data: png, mediaType: 'image/png' }))
    expect(result.images).toEqual([expect.objectContaining({
      attachmentId: 'image-1',
      width: 10,
      height: 20,
      format: 'png',
    })])
    expect(result.meta.qa).toEqual(['The image is readable and depicts the requested subject.'])
  })

  it('rejects candidate counts outside the public tool contract before calling a provider', async () => {
    const generate = vi.fn()

    await expect(generateImagesWithMindsEye({ prompt: 'a coral red eye', n: 5 }, {
      generate,
      saveImage: vi.fn(),
      probeImage: () => ({ width: 10, height: 20, format: 'png' }),
    }, [route])).rejects.toThrow('n must be between 1 and 4')

    expect(generate).not.toHaveBeenCalled()
  })
})
