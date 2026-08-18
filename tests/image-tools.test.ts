import { describe, expect, it, vi } from 'vitest'
import {
  createImageGenerationTool,
  imageGenerationApprovalGate,
} from '../src/image-tools.js'
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

    await expect(tool.execute({ prompt: 'a red eye' }, {} as never))
      .rejects.toThrow('no image generation route configured')
    expect(generate).not.toHaveBeenCalled()
  })

  it('runs visual QA after saving a generated attachment', async () => {
    const tool = createImageGenerationTool({
      routes: () => [route],
      generate: async () => ({
        images: [{ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' as const }],
        provider: 'images.example',
        model: 'image-model',
        attempts: [],
      }),
      saveImage: async () => ({ attachmentId: 'generated-1' }),
      probeImage: () => ({ width: 1, height: 1, format: 'png' }),
      qa: async ({ attachmentId }) => ({ text: `QA ${attachmentId}`, latencyMs: 1, attempts: [] }),
    })

    const result = await tool.execute({ prompt: 'a red eye' }, {} as never) as {
      images: Array<{ attachmentId?: string }>
      meta: { qa: Array<{ text: string }> }
    }
    expect(result.images[0]?.attachmentId).toBe('generated-1')
    expect(result.meta.qa).toEqual([expect.objectContaining({ text: 'QA generated-1' })])
  })
})

describe('imageGenerationApprovalGate', () => {
  it('delegates image generation to the Harness permission policy', async () => {
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(imageGenerationApprovalGate({ name: 'mindseye_generate_image' }, next))
      .resolves.toEqual({ kind: 'allow' })
    await expect(imageGenerationApprovalGate({ name: 'other' }, next))
      .resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledTimes(2)
  })
})
