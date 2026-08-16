export interface ImageAttachmentLike {
  attachmentId?: unknown
  id?: unknown
  name?: unknown
}

export interface ImageBlockLike {
  type?: unknown
  attachment?: ImageAttachmentLike
}

export interface ContentBlockLike {
  type?: unknown
  content?: unknown
  attachment?: ImageAttachmentLike
  [key: string]: unknown
}

export interface MessageLike {
  content?: unknown
  [key: string]: unknown
}

export function isImageBlock(block: ContentBlockLike): boolean {
  return block.type === 'image'
}

export function attachmentIdOf(block: ImageBlockLike): string {
  const value = block.attachment?.attachmentId ?? block.attachment?.id
  return typeof value === 'string' && value.length > 0 ? value : 'unknown'
}

export function attachmentNameOf(block: ImageBlockLike): string {
  const value = block.attachment?.name
  return typeof value === 'string' && value.length > 0 ? value : '图片'
}

export function imageMarkerText(block: ImageBlockLike): string {
  const name = attachmentNameOf(block)
  const id = attachmentIdOf(block)
  return `[图片「${name}」已上传，附件 id 为「${id}」。当前文本模型无法直接查看图片；需要看图时调用 mindseye_read_image 工具并传入 attachmentId: "${id}" 和具体问题。]`
}

/**
 * Rewrite image blocks in the model input into text markers. The session log
 * keeps the original blocks, so the web UI still renders the image; only the
 * model sees a marker pointing at the durable attachment id.
 */
export function sanitizeMessages(messages: readonly MessageLike[]): MessageLike[] {
  let changed = false
  const next = messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    const rewritten = rewriteBlocks(message.content)
    if (rewritten.changed) changed = true
    return rewritten.changed ? { ...message, content: rewritten.blocks } : message
  })
  return changed ? next : (messages as MessageLike[])
}

export function collectImageRefs(messages: readonly MessageLike[]): ImageAttachmentLike[] {
  const refs: ImageAttachmentLike[] = []
  const seen = new Set<string>()
  const visit = (content: unknown): void => {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const entry = block as ContentBlockLike
      if (isImageBlock(entry) && entry.attachment !== undefined) {
        const id = attachmentIdOf(entry as ImageBlockLike)
        if (id !== 'unknown' && !seen.has(id)) {
          seen.add(id)
          refs.push(entry.attachment)
        }
      }
      visit(entry.content)
    }
  }
  for (const message of messages) visit(message.content)
  return refs
}

export function messagesContainImage(messages: readonly MessageLike[]): boolean {
  for (const message of messages) {
    if (Array.isArray(message.content) && blocksContainImage(message.content)) return true
  }
  return false
}

function blocksContainImage(content: unknown[]): boolean {
  for (const value of content) {
    if (typeof value !== 'object' || value === null) continue
    const block = value as ContentBlockLike
    if (isImageBlock(block)) return true
    if (Array.isArray(block.content) && blocksContainImage(block.content)) return true
  }
  return false
}

function rewriteBlocks(blocks: unknown[]): { blocks: unknown[]; changed: boolean } {
  let changed = false
  const next = blocks.map((value) => {
    if (typeof value !== 'object' || value === null) return value
    const block = value as ContentBlockLike
    if (isImageBlock(block)) {
      changed = true
      return { type: 'text', text: imageMarkerText(block as ImageBlockLike) } satisfies ContentBlockLike
    }
    if (Array.isArray(block.content)) {
      const nested = rewriteBlocks(block.content)
      if (nested.changed) {
        changed = true
        return { ...block, content: nested.blocks }
      }
    }
    return value
  })
  return { blocks: next, changed }
}
