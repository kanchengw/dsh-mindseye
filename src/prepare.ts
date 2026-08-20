export const CONTEXT_MAX_LENGTH = 800
export const HISTORY_WINDOW = 5
export const GENERATION_SIZE_PATTERN = /^(?:auto|1024x1024|1536x1024|1024x1536)$/i

export interface SessionLike {
  agent?: {
    session?: {
      events?: unknown[]
    }
  }
}

interface HistoryEntry {
  kind: 'user' | 'tool-result'
  text: string
  attachmentIds: string[]
}

export interface PreparedVision {
  currentRequest: string
  context?: string
  contextReason?: string
  contextEvidence?: string[]
  historyContext?: string[]
}

export interface PreparedGeneration extends PreparedVision {
  size?: string
  sizeReason?: string
  toolResults?: string[]
}

function contentBlocksOf(raw: unknown): Array<Record<string, unknown>> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const content = (raw as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  return content as Array<Record<string, unknown>>
}

function historyEntries(exec: SessionLike | undefined): HistoryEntry[] {
  const events = exec?.agent?.session?.events
  if (!Array.isArray(events)) return []
  const entries: HistoryEntry[] = []
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue
    const event = raw as { type?: unknown; data?: Record<string, unknown> }
    if (event.type === 'user/message') {
      const entry = userEntry(event.data)
      if (entry !== undefined) entries.push(entry)
      continue
    }
    if (event.type === 'tool/result') {
      const entry = toolResultEntry(contentBlocksOf(event.data?.message))
      if (entry !== undefined) entries.push(entry)
    }
  }
  return entries
}

function userEntry(data: Record<string, unknown> | undefined): HistoryEntry | undefined {
  const blocks = contentBlocksOf(data)
  if (blocks === undefined) return undefined
  const textParts: string[] = []
  const attachmentIds: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text)
    const attachment = block.attachment as { attachmentId?: unknown } | undefined
    if (typeof attachment?.attachmentId === 'string') attachmentIds.push(attachment.attachmentId)
  }
  const text = textParts.join('\n').trim()
  if (isRuntimeContextSnapshot(text)) return undefined
  if (text === '' && attachmentIds.length === 0) return undefined
  return { kind: 'user', text, attachmentIds }
}

function toolResultEntry(blocks: Array<Record<string, unknown>> | undefined): HistoryEntry | undefined {
  if (blocks === undefined) return undefined
  const textParts: string[] = []
  const attachmentIds: string[] = []
  collectContentBlocks(blocks, textParts, attachmentIds)
  const text = textParts.join('\n').trim()
  const generated = /<generated-image attachment_id="([^"]+)"/.exec(text)
  if (generated !== null) {
    const id = generated[1] ?? ''
    const annotation = /\(\s*[^)]*(?:token_usage|KB|MB)[^)]*\)/.exec(text)?.[0] ?? ''
    return {
      kind: 'tool-result',
      text: `[生成记录] 附件 ${id}${annotation === '' ? '' : ` ${annotation}`}`,
      attachmentIds: [...new Set([...attachmentIds, id])],
    }
  }
  const vision = parseVisionToolResult(text)
  if (vision !== undefined) {
    return { kind: 'tool-result', text: vision.text, attachmentIds: vision.ids }
  }
  return undefined
}

function collectContentBlocks(
  blocks: Array<Record<string, unknown>>,
  textParts: string[],
  attachmentIds: string[],
): void {
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text)
    const attachment = block.attachment as { attachmentId?: unknown } | undefined
    if (typeof attachment?.attachmentId === 'string') attachmentIds.push(attachment.attachmentId)
    if (Array.isArray(block.content)) {
      collectContentBlocks(block.content as Array<Record<string, unknown>>, textParts, attachmentIds)
    }
  }
}

function parseVisionToolResult(text: string): { text: string; ids: string[] } | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (parsed.version !== 1 || typeof parsed.intent !== 'string') return undefined
  const answer = parsed.answer as { text?: unknown } | undefined
  const answerText = typeof answer?.text === 'string' ? answer.text : ''
  const ids = Array.isArray(parsed.images)
    ? parsed.images
      .map((item) => (item as { sha256?: unknown } | undefined)?.sha256)
      .filter((value): value is string => typeof value === 'string')
    : []
  if (answerText === '' && ids.length === 0) return undefined
  return { text: `[识图 ${parsed.intent}] ${answerText}`, ids }
}

function isRuntimeContextSnapshot(text: string): boolean {
  return /^Current runtime context\./.test(text) || /^上下文注入/.test(text)
}
/**
 * Extract the most recent non-empty user message verbatim. This is the
 * current-turn anchor; model-provided prose is never accepted as a substitute.
 */
export function latestUserRequest(exec: SessionLike | undefined): string {
  const messages = historyEntries(exec).filter((entry) => entry.kind === 'user')
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index]?.text ?? ''
    if (text !== '') return text
  }
  return ''
}

export function allUserMessages(exec: SessionLike | undefined): string[] {
  return historyEntries(exec)
    .filter((entry) => entry.kind === 'user')
    .map((entry) => entry.text)
    .filter((text) => text !== '')
}


function normalizeEvidence(evidence: unknown): string[] {
  if (!Array.isArray(evidence)) return []
  return evidence
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value !== '')
}

export function normalizeContext(
  value?: string,
  evidence?: unknown,
  previousTexts: string[] = [],
  attachmentIds: string[] = [],
): { value?: string; evidence?: string[]; reason?: string } {
  const text = value?.trim() ?? ''
  if (text === '') return {}
  if (text.length > CONTEXT_MAX_LENGTH) {
    return { reason: `context 超过 ${CONTEXT_MAX_LENGTH} 字符，已忽略` }
  }
  const evidenceList = normalizeEvidence(evidence)
  if (evidenceList.length === 0) {
    return { reason: 'context 缺少 contextEvidence，已忽略' }
  }
  const grounded = evidenceList.filter((entry) =>
    previousTexts.some((message) => message.includes(entry))
    || attachmentIds.includes(entry))
  if (grounded.length === 0) {
    return { reason: 'contextEvidence 未在历史上下文、附件 id 或生成记录中找到，已忽略' }
  }
  const reconstructed = previousTexts.filter((message) =>
    grounded.some((entry) => message.includes(entry)))
  const attachmentContext = grounded
    .filter((entry) => attachmentIds.includes(entry))
    .map((entry) => `[附件 ${entry}]`)
  const trustedContext = [...new Set([...reconstructed, ...attachmentContext])].join('\n').trim()
  return {
    ...(trustedContext === '' ? {} : { value: trustedContext }),
    evidence: grounded,
  }
}

function selectHistory(
  evidence: string[],
  entries: HistoryEntry[],
  currentRequest: string,
): { users: string[]; toolResults: string[] } {
  if (evidence.length === 0) {
    return {
      users: entries
        .filter((entry) => entry.kind === 'user' && entry.text !== currentRequest)
        .slice(-HISTORY_WINDOW)
        .map((entry) => entry.text),
      toolResults: [],
    }
  }
  const matched = entries.filter((entry) =>
    evidence.some((item) => entry.text.includes(item) || entry.attachmentIds.includes(item)))
  const matchedUsers = matched
    .filter((entry) => entry.kind === 'user' && entry.text !== currentRequest)
    .slice(-HISTORY_WINDOW)
    .map((entry) => entry.text)
  const matchedTools = matched
    .filter((entry) => entry.kind === 'tool-result')
    .slice(-HISTORY_WINDOW)
    .map((entry) => entry.text)
  return {
    users: matchedUsers.length > 0
      ? matchedUsers
      : entries.filter((entry) => entry.kind === 'user' && entry.text !== currentRequest).slice(-HISTORY_WINDOW).map((entry) => entry.text),
    toolResults: matchedTools,
  }
}

export function normalizeGenerationSize(
  size?: string,
  evidence?: string,
  userTexts: string[] = [],
): { size?: string; reason?: string } {
  const raw = size?.trim() ?? ''
  if (raw === '') return {}
  const quote = evidence?.trim() ?? ''
  if (quote === '') return { reason: 'size 缺少 sizeEvidence' }
  if (!GENERATION_SIZE_PATTERN.test(raw)) {
    return { reason: 'size 不是 OpenAI-compatible 格式枚举（auto、1024x1024、1536x1024 或 1024x1536）' }
  }
  const grounded = userTexts.some((text) => text.includes(quote))
  if (!grounded) return { reason: 'sizeEvidence 未出现在用户上下文中' }
  return { size: raw.toLowerCase() }
}

export function prepareVision(
  exec: SessionLike | undefined,
  context?: string,
  contextEvidence?: unknown,
): PreparedVision {
  const entries = historyEntries(exec)
  const users = entries.filter((entry) => entry.kind === 'user')
  const currentRequest = latestUserRequest(exec)
  const previousTexts = users
    .map((entry) => entry.text)
    .filter((text) => text !== '' && text !== currentRequest)
  const allAttachmentIds = entries.flatMap((entry) => entry.attachmentIds)
  const normalized = normalizeContext(context, contextEvidence, previousTexts, allAttachmentIds)
  const history = selectHistory(normalized.evidence ?? [], entries, currentRequest)
  return {
    currentRequest,
    ...(normalized.value === undefined ? {} : { context: normalized.value }),
    ...(normalized.evidence === undefined ? {} : { contextEvidence: normalized.evidence }),
    ...(history.users.length === 0 ? {} : { historyContext: history.users }),
    ...(normalized.reason === undefined ? {} : { contextReason: normalized.reason }),
  }
}

export function prepareGeneration(input: {
  request?: string
  context?: string
  contextEvidence?: unknown
  size?: string
  sizeEvidence?: string
  exec?: SessionLike
}): PreparedGeneration {
  const entries = historyEntries(input.exec)
  const users = entries.filter((entry) => entry.kind === 'user')
  const currentRequest = latestUserRequest(input.exec) || input.request?.trim() || ''
  const previousTexts = users
    .map((entry) => entry.text)
    .filter((text) => text !== '' && text !== currentRequest)
  const allAttachmentIds = entries.flatMap((entry) => entry.attachmentIds)
  const normalizedContext = normalizeContext(
    input.context,
    input.contextEvidence,
    previousTexts,
    allAttachmentIds,
  )
  const history = selectHistory(normalizedContext.evidence ?? [], entries, currentRequest)
  const userTexts = [...previousTexts, ...allUserMessages(input.exec)]
  if (currentRequest !== '' && !userTexts.includes(currentRequest)) userTexts.push(currentRequest)
  const normalizedSize = normalizeGenerationSize(input.size, input.sizeEvidence, userTexts)
  return {
    currentRequest,
    ...(normalizedContext.value === undefined ? {} : { context: normalizedContext.value }),
    ...(normalizedContext.evidence === undefined ? {} : { contextEvidence: normalizedContext.evidence }),
    ...(history.users.length === 0 ? {} : { historyContext: history.users }),
    ...(history.toolResults.length === 0 ? {} : { toolResults: history.toolResults }),
    ...(normalizedContext.reason === undefined ? {} : { contextReason: normalizedContext.reason }),
    ...(normalizedSize.size === undefined ? {} : { size: normalizedSize.size }),
    ...(normalizedSize.reason === undefined ? {} : { sizeReason: normalizedSize.reason }),
  }
}
