import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  generateImagesWithMindsEye,
  type ImageGenerationToolDeps,
} from './image-tool.js'
import type { ImageGenerationRoute, JsonValue } from './types.js'

export const IMAGE_GENERATION_TOOL_NAME = 'mindseye_generate_image'

export interface CreateImageGenerationToolDeps extends ImageGenerationToolDeps {
  routes: () => ImageGenerationRoute[]
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

function latestUserRequest(exec: { agent?: { session?: { events?: unknown[] } } }): string | undefined {
  const events = exec.agent?.session?.events
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: unknown; data?: { content?: unknown } } | undefined
    if (event?.type !== 'user/message') continue
    const content = event.data?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block): block is { type: string; text: string } =>
        typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

export function createImageGenerationTool(deps: CreateImageGenerationToolDeps) {
  return defineTool({
    name: IMAGE_GENERATION_TOOL_NAME,
    description:
      '生成图片，生成结果会直接显示在会话中。'
      + '工具会自动使用你最新收到的用户消息作为本次需求，模型不要填写任何画面描述；'
      + 'subject 必须填本次要生成的主体/主题（例如“眼睛概念 logo”），从用户消息或历史对话提取；'
      + 'context 只补充风格/约束背景（例如“纯图形，严禁任何文字”），不要写整段画面描述。'
      + '生成完成后立即返回结果，不要自动保存、复制或导出图片到任何本地路径。'
      + '不要继续调用视觉工具验证、裁剪或“修复”图片。',
    parameters: {
      subject: {
        type: 'string',
        required: true,
        description:
          '本次要生成的主体/主题，从用户消息或历史对话提取，例如“眼睛概念 logo”。不要写整段画面描述。',
      },
      context: {
        type: 'string',
        description:
          '可选，来自更早对话的风格/约束背景，例如“纯图形，严禁任何文字”。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: { type: 'json', required: true },
          meta: { type: 'json', required: true },
        },
      },
      render: (args, value) => {
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
          blocks.push({
            type: 'text',
            text: `(${imageUsageText(usage)}, ${sizeTexts.join(' / ')})`,
          })
        }
        return blocks
      },
      presentationMeta: (_args, value) => {
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
    },
    presentResult: (_args, result) => {
      const meta = result.meta as { images?: GeneratedImageView[]; usage?: unknown } | undefined
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
      return { card: 'generic', content: blocks }
    },
    presentCall: (args) => {
      const subject = (args as { subject?: string }).subject?.trim() ?? ''
      const context = (args as { context?: string }).context?.trim() ?? ''
      return {
        card: 'generic',
        title: '生成图片',
        rawInput: {
          ...(subject === '' ? {} : { subject }),
          ...(context === '' ? {} : { context }),
        },
      }
    },
    async execute(args, exec) {
      const request = latestUserRequest(exec as { agent?: { session?: { events?: unknown[] } } })
        ?? (args as { request?: string }).request?.trim()
        ?? ''
      if (request === '') throw new Error('mindseye_generate_image: request is required')
      const subject = (args as { subject?: string }).subject?.trim() ?? ''
      if (subject === '') throw new Error('mindseye_generate_image: subject is required')
      const result = await generateImagesWithMindsEye({
        subject,
        ...(args as { context?: string }),
        request,
      }, deps, deps.routes(), exec.signal)
      deps.onGenerated?.()
      return result as unknown as { images: JsonValue; meta: JsonValue }
    },
  })
}
