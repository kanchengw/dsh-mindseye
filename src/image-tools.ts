import { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import {
  generateImagesWithMindsEye,
  type ImageGenerationToolDeps,
} from './image-tool.js'
import type { ImageGenerationRoute, JsonValue } from './types.js'

export const IMAGE_GENERATION_TOOL_NAME = 'mindseye_generate_image'

export interface CreateImageGenerationToolDeps extends ImageGenerationToolDeps {
  routes: () => ImageGenerationRoute[]
}

export function createImageGenerationTool(deps: CreateImageGenerationToolDeps) {
  return defineTool({
    name: IMAGE_GENERATION_TOOL_NAME,
    description: '按文字描述生成图片并保存为 MindsEye 附件。生成后会尝试视觉回验。',
    parameters: {
      prompt: { type: 'string', required: true, description: '要生成的画面描述。' },
      size: { type: 'string', description: '可选画布尺寸，未指定时使用图片生成路由默认值。' },
      n: { type: 'integer', description: '可选候选数，1-4，默认 1。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: { type: 'json', required: true },
          failures: { type: 'json', required: true },
          meta: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const result = await generateImagesWithMindsEye(args, deps, deps.routes(), exec.signal)
      return result as unknown as { images: JsonValue; failures: JsonValue; meta: JsonValue }
    },
  })
}

export async function imageGenerationApprovalGate(
  exec: { name: string },
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  if (exec.name !== IMAGE_GENERATION_TOOL_NAME) return next()
  return { kind: 'ask', reason: '生成图片并保存为 MindsEye 附件' }
}
