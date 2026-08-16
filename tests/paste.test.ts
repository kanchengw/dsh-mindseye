import { describe, expect, it } from 'vitest'
import { computePasteVerdict, sniffImageExt } from '../src/bridge/paste.js'

describe('sniffImageExt', () => {
  it('recognizes png, jpeg, webp, and gif', () => {
    expect(sniffImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('.png')
    expect(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('.jpg')
    expect(sniffImageExt(Buffer.from('RIFFxxxxWEBP', 'ascii'))).toBe('.webp')
    expect(sniffImageExt(Buffer.from('GIF89a', 'ascii'))).toBe('.gif')
  })

  it('rejects unrecognized bytes', () => {
    expect(sniffImageExt(Buffer.from('plain text'))).toBeUndefined()
  })
})

describe('computePasteVerdict', () => {
  function contextWithLlm(llm: unknown) {
    return { get: (name: string) => (name === 'llm' ? llm : undefined) }
  }

  it('takes over when every matched model is text-only', async () => {
    const llm = {
      listProviders: () => [{ id: 'deepseek-official' }],
      listModels: async () => [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        inputModalities: ['text'],
      }],
    }
    await expect(computePasteVerdict(contextWithLlm(llm) as never, '当前模型 DeepSeek-V4-Flash'))
      .resolves.toBe(true)
  })

  it('keeps native paste when a matched model supports images', async () => {
    const llm = {
      listProviders: () => [{ id: 'vision' }],
      listModels: async () => [{
        id: 'qwen-vl',
        name: 'Qwen VL',
        inputModalities: ['text', 'image'],
      }],
    }
    await expect(computePasteVerdict(contextWithLlm(llm) as never, '当前模型 Qwen VL'))
      .resolves.toBe(false)
  })

  it('returns false for unknown labels', async () => {
    const llm = {
      listProviders: () => [{ id: 'deepseek-official' }],
      listModels: async () => [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        inputModalities: ['text'],
      }],
    }
    await expect(computePasteVerdict(contextWithLlm(llm) as never, 'unknown'))
      .resolves.toBe(false)
  })
})
