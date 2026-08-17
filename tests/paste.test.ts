import { describe, expect, it } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { computePasteVerdict, registerPasteRoute, sniffImageExt } from '../src/bridge/paste.js'

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

describe('registerPasteRoute', () => {
  it('stores a pasted image in an isolated temporary directory', async () => {
    let handler: ((req: any, res: any) => Promise<void>) | undefined
    const ctx = {
      inject: (_services: string[], callback: (webCtx: any) => void) => callback({
        webServer: {
          register: (route: { handler: (req: any, res: any) => Promise<void> }) => {
            handler = route.handler
          },
        },
      }),
    }
    registerPasteRoute(ctx as never, { enabled: () => true })

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const request = Object.assign(Readable.from([bytes]), { method: 'POST', url: '/_dsh/mindseye/paste' })
    let status = 0
    let body = ''
    const response = {
      writeHead: (value: number) => { status = value },
      end: (value: string) => { body = value },
    }

    await handler?.(request, response)

    expect(status).toBe(200)
    const path = (JSON.parse(body) as { value: { path: string } }).value.path
    try {
      expect(basename(path)).toBe('paste.png')
      expect(basename(dirname(path))).toMatch(/^mindseye-paste-/)
      await expect(readFile(path)).resolves.toEqual(bytes)
    } finally {
      await rm(dirname(path), { recursive: true, force: true })
    }
  })
})
