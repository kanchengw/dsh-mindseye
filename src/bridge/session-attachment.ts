import { collectImageRefs, type ImageAttachmentLike } from './sanitize.js'

export interface AgentLike {
  session?: {
    events?: unknown[]
  }
}

/**
 * Resolve an attachment id by scanning the durable session log. The in-memory
 * image-reference cache can be empty after a restart or when old messages were
 * sanitized, so the log is the authoritative reference source.
 */
export function sessionAttachmentOf(
  agent: unknown,
  attachmentId: string,
): ImageAttachmentLike | undefined {
  const events = (agent as AgentLike | null | undefined)?.session?.events
  if (!Array.isArray(events)) return undefined
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const entry = event as { type?: unknown; data?: unknown }
    const data = entry.data
    if (typeof data !== 'object' || data === null) continue
    const record = data as Record<string, unknown>
    let content: unknown
    if (entry.type === 'user/message') {
      content = record.content
    } else if (entry.type === 'assistant/message' || entry.type === 'tool/result') {
      const message = record.message
      content = typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>).content
        : undefined
    } else {
      continue
    }
    if (!Array.isArray(content)) continue
    const hit = collectImageRefs([{ content }]).find((ref) =>
      String(ref.attachmentId ?? ref.id ?? '') === attachmentId)
    if (hit !== undefined) return hit
  }
  return undefined
}
