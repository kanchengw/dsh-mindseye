import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PreparedGeneration } from './prepare.js'
import {
  generateImagesWithMindsEye,
  type ImageGenerationToolDeps,
} from './image-tool.js'
import type { GeneratedImageMediaType, ImageGenerationRoute, JsonValue } from './types.js'

export const IMAGE_GENERATION_TOOL_NAME = 'mindseye_generate_image'
export const IMAGE_EDIT_TOOL_NAME = 'mindseye_edit_image'

export interface CreateImageGenerationToolDeps extends ImageGenerationToolDeps {
  routes: () => ImageGenerationRoute[]
  editsRoutes?: () => ImageGenerationRoute[]
  readImage?: (input: { attachmentId: string; agent?: unknown }) => Promise<Uint8Array>
  loadPrepared?: (intentId: string, session: unknown) => PreparedGeneration | undefined
  onGenerated?: () => void
}

function formatImageBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

function imageUsageText(usage: unknown): string {
  if (usage === null || typeof usage !== 'object') return 'token_usage=n/a'
  const record = usage as Record<string, unknown>
  const total = typeof record.totalTokens === 'number'
    ? record.totalTokens
    : typeof record.inputTokens === 'number' && typeof record.outputTokens === 'number'
      ? record.inputTokens + record.outputTokens
      : undefined
  return total === undefined ? 'token_usage=n/a' : `token_usage=${total}`
}

interface GeneratedImageView {
  attachment?: ImageAttachmentRef
  width?: number
  height?: number
}

function imageViewsOf(value: unknown): GeneratedImageView[] {
  if (typeof value !== 'object' || value === null) return []
  const images = (value as { images?: unknown }).images
  return Array.isArray(images) ? images as GeneratedImageView[] : []
}

function imageToolOutput() {
  return {
    schema: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        images: { type: 'json' as const, required: true as const },
        meta: { type: 'json' as const, required: true as const },
      },
    },
    render: (_args: unknown, value: unknown) => {
      const usage = typeof value === 'object' && value !== null
        ? (value as { meta?: { usage?: unknown } }).meta?.usage
        : undefined
      const images = imageViewsOf(value)
      const blocks: ContentBlock[] = []
      const attachmentIds: string[] = []
      const sizeTexts: string[] = []
      for (const image of images) {
        if (image.attachment === undefined) continue
        attachmentIds.push(String(image.attachment.attachmentId))
        sizeTexts.push(`${image.width ?? 0}x${image.height ?? 0}, ${formatImageBytes(image.attachment.bytes ?? 0)}`)
        blocks.push({ type: 'image', attachment: image.attachment })
      }
      if (attachmentIds.length > 0) {
        blocks.unshift({
          type: 'text',
          text: `<generated-image attachment_id="${attachmentIds.join(',')}"></generated-image>`,
        })
        blocks.push({ type: 'text', text: `(${imageUsageText(usage)}, ${sizeTexts.join(' / ')})` })
      }
      return blocks
    },
    presentationMeta: (_args: unknown, value: unknown) => {
      const usage = typeof value === 'object' && value !== null
        ? (value as { meta?: { usage?: unknown } }).meta?.usage
        : undefined
      return {
        images: imageViewsOf(value)
          .filter((image) => image.attachment !== undefined)
          .map((image) => ({
            attachment: image.attachment,
            width: image.width ?? 0,
            height: image.height ?? 0,
          })),
        usage,
      } as unknown as JsonValue
    },
  }
}

function imageToolPresentResult(_args: unknown, result: unknown) {
  const meta = (result as { meta?: { images?: GeneratedImageView[]; usage?: unknown } }).meta
  const blocks: ContentBlock[] = []
  const sizeTexts: string[] = []
  for (const image of meta?.images ?? []) {
    if (image.attachment === undefined) continue
    sizeTexts.push(`${image.width ?? 0}x${image.height ?? 0}, ${formatImageBytes(image.attachment.bytes ?? 0)}`)
    blocks.push({ type: 'image', attachment: image.attachment })
  }
  if (blocks.length > 0) {
    blocks.push({ type: 'text', text: `(${imageUsageText(meta?.usage)}, ${sizeTexts.join(' / ')})` })
  }
  return { card: 'generic' as const, content: blocks }
}

function imageToolPresentCall(args: unknown, title: string) {
  const intentId = (args as { intentId?: string }).intentId?.trim() ?? ''
  const attachmentId = (args as { attachmentId?: string }).attachmentId?.trim() ?? ''
  const rawInput: Record<string, string> = {}
  if (intentId !== '') rawInput.intentId = intentId
  if (attachmentId !== '') rawInput.attachmentId = attachmentId
  return { card: 'generic' as const, title, rawInput }
}

export function createImageGenerationTool(deps: CreateImageGenerationToolDeps) {
  return defineTool({
    name: IMAGE_GENERATION_TOOL_NAME,
    description:
      '生成图片，生成结果会直接显示在会话中。'
      + '必须先调用 mindseye_plan 获取 intentId，再把 intentId 传给本工具；'
      + '不要在本工具中填写或改写画面描述、尺寸或上下文，这些都由 mindseye_plan 负责。'
      + '生成完成后立即返回结果，不要自动保存、复制或导出图片到任何本地路径。'
      + '不要继续调用视觉工具验证、裁剪或“修复”图片。',
    parameters: {
      intentId: {
        type: 'string',
        required: true,
        description: '必须先用 mindseye_plan 提取当轮需求后返回的 intentId。',
      },
    },
    output: imageToolOutput(),
    presentResult: imageToolPresentResult,
    presentCall: (args) => imageToolPresentCall(args, '生成图片'),
    async execute(args, exec) {
      const intentId = (args as { intentId?: string }).intentId?.trim() ?? ''
      if (intentId === '') {
        throw new Error('mindseye_generate_image: 请先调用 mindseye_plan 获取 intentId')
      }
      const prepared = deps.loadPrepared?.(intentId, exec.agent?.session)
      if (prepared === undefined) {
        throw new Error('mindseye_generate_image: intentId 无效或已失效，请重新调用 mindseye_plan')
      }
      const result = await generateImagesWithMindsEye({
        request: prepared.currentRequest,
        ...(prepared.context === undefined ? {} : { context: prepared.context }),
        ...(prepared.historyContext === undefined ? {} : { historyContext: prepared.historyContext }),
        ...(prepared.toolResults === undefined ? {} : { toolResults: prepared.toolResults }),
        ...(prepared.size === undefined ? {} : { size: prepared.size }),
      }, deps, deps.routes(), exec.signal)
      deps.onGenerated?.()
      return result as unknown as { images: JsonValue; meta: JsonValue }
    },
  })
}

export function createImageEditTool(deps: CreateImageGenerationToolDeps) {
  return defineTool({
    name: IMAGE_EDIT_TOOL_NAME,
    description:
      '基于参考图编辑/改风格，生成结果会直接显示在会话中。'
      + '当用户上传图片并要求“改成/换成/参考这张图/重做这种风格”时，优先使用本工具；'
      + '必须先调用 mindseye_plan 获取 intentId，再传入参考图 attachmentId；'
      + '不要为了“改 UI”去搜索项目代码，本工具直接把原图交给生图模型。'
      + '不要在本工具中填写或改写画面描述、尺寸或上下文，这些都由 mindseye_plan 负责。',
    parameters: {
      intentId: {
        type: 'string',
        required: true,
        description: '必须先用 mindseye_plan 提取当轮需求后返回的 intentId。',
      },
      attachmentId: {
        type: 'string',
        required: true,
        description: '参考图附件 id（如 sha256:...）。',
      },
    },
    output: imageToolOutput(),
    presentResult: imageToolPresentResult,
    presentCall: (args) => imageToolPresentCall(args, '编辑图片'),
    async execute(args, exec) {
      const intentId = (args as { intentId?: string }).intentId?.trim() ?? ''
      const attachmentId = (args as { attachmentId?: string }).attachmentId?.trim() ?? ''
      if (intentId === '') throw new Error('mindseye_edit_image: 请先调用 mindseye_plan 获取 intentId')
      if (attachmentId === '') throw new Error('mindseye_edit_image: attachmentId 不能为空')
      const prepared = deps.loadPrepared?.(intentId, exec.agent?.session)
      if (prepared === undefined) throw new Error('mindseye_edit_image: intentId 无效或已失效，请重新调用 mindseye_plan')
      if (deps.readImage === undefined) throw new Error('mindseye_edit_image: readImage is not available')
      const bytes = await deps.readImage({ attachmentId, agent: exec.agent })
      const info = deps.probeImage(bytes)
      const result = await generateImagesWithMindsEye({
        request: prepared.currentRequest,
        ...(prepared.context === undefined ? {} : { context: prepared.context }),
        ...(prepared.historyContext === undefined ? {} : { historyContext: prepared.historyContext }),
        ...(prepared.toolResults === undefined ? {} : { toolResults: prepared.toolResults }),
        ...(prepared.size === undefined ? {} : { size: prepared.size }),
        image: { data: bytes, mediaType: `image/${info.format}` as GeneratedImageMediaType },
      }, deps, deps.editsRoutes?.() ?? [], exec.signal)
      deps.onGenerated?.()
      return result as unknown as { images: JsonValue; meta: JsonValue }
    },
  })
}
