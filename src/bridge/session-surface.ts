import { sanitizeContentBlocks } from './sanitize.js'

interface SessionLike {
  events?: unknown[]
  surface?: { nodes?: readonly number[] }
  append?: (type: string, data: unknown, options: unknown) => unknown
}

interface SurfaceEventLike {
  type?: unknown
  data?: Record<string, unknown>
}

/**
 * Shadow-replace image blocks on the model-visible session surface with
 * attachment markers. The human transcript keeps the append-origin events
 * (the UI still renders images), while `Session.deriveMessages()` and the
 * model-selection admission see sanitized messages. This lets a session
 * switch to a text-only model without "model does not accept image input".
 */
export function sanitizeSessionSurface(session: unknown): void {
  if (session === null || typeof session !== 'object') return
  const target = session as SessionLike
  const events = target.events
  const nodes = target.surface?.nodes
  if (!Array.isArray(events) || !Array.isArray(nodes) || typeof target.append !== 'function') {
    return
  }

  let scan = surfaceScans.get(target)
  if (scan === undefined) {
    scan = { count: 0, done: new Set() }
    surfaceScans.set(target, scan)
  }
  if (nodes.length < scan.count) {
    scan.count = 0
    scan.done = new Set()
  }
  if (nodes.length === scan.count) return

  let processed = scan.count
  const errors: unknown[] = []
  for (const seq of nodes.slice(scan.count)) {
    const event = events[seq] as SurfaceEventLike | undefined
    if (event === undefined || scan.done.has(seq)) continue
    scan.done.add(seq)
    const replacement = sanitizedSurfaceData(event)
    if (replacement === undefined) {
      processed = seq + 1
      continue
    }
    try {
      target.append(event.type as string, replacement, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      processed = seq + 1
    } catch {
      // One failed shadow must not break the turn; the next scan retries it.
      scan.done.delete(seq)
      errors.push(new Error(`append replace failed for seq ${seq}`))
    }
  }
  scan.count = processed
  if (errors.length > 0) {
    throw new Error(`session surface sanitize failed: ${errors.map((error) => String(error)).join('; ')}`)
  }
}

const surfaceScans = new WeakMap<object, { count: number; done: Set<number> }>()

function sanitizedSurfaceData(event: SurfaceEventLike): Record<string, unknown> | undefined {
  if (event.type === 'user/message') {
    return sanitizeDirectContent(event.data)
  }
  if (event.type === 'assistant/message' || event.type === 'tool/result') {
    return sanitizeNestedMessage(event.data)
  }
  return undefined
}

function sanitizeDirectContent(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (data === undefined) return undefined
  const content = data.content
  if (!Array.isArray(content)) return undefined
  const rewritten = sanitizeContentBlocks(content)
  if (!rewritten.changed) return undefined
  return { ...data, content: rewritten.blocks }
}

function sanitizeNestedMessage(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (data === undefined) return undefined
  const message = data.message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return undefined
  const rewritten = sanitizeContentBlocks(content)
  if (!rewritten.changed) return undefined
  return { ...data, message: { ...(message as Record<string, unknown>), content: rewritten.blocks } }
}
