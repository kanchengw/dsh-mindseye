export interface UserNoticeInput {
  cache: 'hit' | 'miss'
  source?: string
  softMemoryHits?: number
}

/**
 * Deterministic user-facing summary of a vision call. Only generated when
 * the call saved a model invocation or gained memory context; plain model
 * calls stay quiet.
 */
export function buildUserNotice(input: UserNoticeInput): string | undefined {
  if (input.cache === 'hit') {
    return '本次未调用视觉模型（精确缓存命中），节省一次调用。'
  }
  if (input.source === 'evidence') {
    return '本次未调用视觉模型，直接复用了已存储的图片证据。'
  }
  if (input.source === 'soft-memory' && (input.softMemoryHits ?? 0) > 0) {
    return `本次调用注入了 ${input.softMemoryHits} 条历史记忆，补强上下文一致性。`
  }
  return undefined
}
