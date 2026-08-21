import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { adaptImageForDsh } from '../image-resize.js'
import type { GeneratedImageMediaType } from '../types.js'

const PASTE_MAX_BYTES = 25 * 1024 * 1024
const VERDICT_TTL_MS = 15_000
const VERDICT_CAP = 32

interface PasteRouteOptions {
  enabled: () => boolean
}

export function registerPasteRoute(ctx: Context, options: PasteRouteOptions): void {
  ctx.inject(['webServer'], (webCtx: any) => {
    webCtx.webServer.register({
      name: 'mindseye-paste',
      kind: 'exact',
      path: '/_dsh/mindseye/paste',
      handler: async (req: any, res: any) => {
        if (!options.enabled()) {
          res.writeHead(404).end()
          return
        }
        if (req.method === 'GET') {
          try {
            const label = new URL(req.url ?? '/', 'http://localhost').searchParams.get('model') ?? ''
            const convertToPath = await pathFallbackDecision(ctx, label)
            writeJson(res, 200, { ok: true, value: { convertToPath } })
          } catch (error) {
            writeJson(res, 500, { ok: false, error: { message: String(error instanceof Error ? error.message : error) } })
          }
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        try {
          const buffer = await readRawBody(req)
          const ext = sniffImageExt(buffer)
          if (ext === undefined) {
            writeJson(res, 400, { ok: false, error: { message: 'not a recognized image (png/jpeg/webp/gif)' } })
            return
          }
          const mode = new URL(req.url ?? '/', 'http://localhost').searchParams.get('mode')
          if (mode === 'adapt') {
            const mediaType = mediaTypeOf(ext)
            const adapted = await adaptImageForDsh({
              data: new Uint8Array(buffer),
              mediaType,
            })
            writeImage(res, adapted.data, mediaType, adapted.adapted)
            return
          }
          const dir = await mkdtemp(join(tmpdir(), 'mindseye-paste-'))
          const file = join(dir, `paste${ext}`)
          await writeFile(file, buffer, { mode: 0o600 })
          writeJson(res, 200, { ok: true, value: { path: file } })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: { message: String(error instanceof Error ? error.message : error) } })
        }
      },
    })
  })
}

const decisions = new Map<string, { convertToPath: boolean; at: number }>()

async function pathFallbackDecision(ctx: Context, label: string): Promise<boolean> {
  if (label.trim() === '') return false
  const cached = decisions.get(label)
  if (cached !== undefined && Date.now() - cached.at < VERDICT_TTL_MS) return cached.convertToPath
  const convertToPath = await shouldConvertImageToPath(ctx, label)
  decisions.delete(label)
  decisions.set(label, { convertToPath, at: Date.now() })
  if (decisions.size > VERDICT_CAP) {
    const oldest = decisions.keys().next().value
    if (oldest !== undefined) decisions.delete(oldest)
  }
  return convertToPath
}

/**
 * Should the browser convert a paste into a path? True only when every model
 * whose name appears in the selector label is confirmed text-only; any
 * image-capable match keeps the native paste.
 */
export async function shouldConvertImageToPath(ctx: Context, label: string): Promise<boolean> {
  const llm = ctx.get('llm') as
    | {
        listProviders: () => Array<{ id: string }>
        listModels: (provider: string) => Promise<Array<{
          id?: string
          name?: string
          inputModalities?: readonly string[]
        }>>
      }
    | undefined
  if (llm === undefined) return false
  const lowered = label.toLowerCase()
  let matchedAny = false
  for (const provider of llm.listProviders()) {
    let models: Awaited<ReturnType<typeof llm.listModels>>
    try {
      models = await llm.listModels(provider.id)
    } catch {
      return false
    }
    for (const model of models) {
      for (const candidate of [model.name, model.id]) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        if (!lowered.includes(candidate.toLowerCase())) continue
        const modalities = model.inputModalities
        if (!Array.isArray(modalities) || modalities.includes('image')) return false
        if (candidate.length >= 3) matchedAny = true
      }
    }
  }
  return matchedAny
}

export function sniffImageExt(buffer: Buffer): string | undefined {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return '.png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return '.webp'
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return '.gif'
  return undefined
}

function mediaTypeOf(ext: string): GeneratedImageMediaType {
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/gif'
}

async function readRawBody(req: {
  on: (event: 'data' | 'end' | 'error', listener: (...args: any[]) => void) => void
  destroy: () => void
}): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > PASTE_MAX_BYTES) {
        reject(new Error(`image over the ${PASTE_MAX_BYTES}-byte limit`))
        req.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', resolve)
    req.on('error', reject)
  })
  return Buffer.concat(chunks)
}

function writeJson(
  res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void },
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function writeImage(
  res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: Uint8Array) => void },
  data: Uint8Array,
  mediaType: GeneratedImageMediaType,
  adapted: boolean,
): void {
  res.writeHead(200, {
    'content-type': mediaType,
    'content-length': String(data.byteLength),
    'x-mindseye-image-adapted': String(adapted),
  })
  res.end(data)
}
