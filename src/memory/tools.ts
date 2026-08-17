import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import { deepEqualJson } from '@deepseek-ai/dsh-settings'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { evidenceToRecord } from './evidence.js'
import type { JsonlMemoryStore } from './store.js'
import type { VisualEvidenceRecord } from './types.js'
import type { VisualEvidence } from '../types.js'

export const MEMORY_TOOL_NAMES = [
  'mindseye_memory_put',
  'mindseye_memory_get',
  'mindseye_memory_search',
  'mindseye_memory_diff',
] as const

const MEMORY_TOOL_SET = new Set<string>(MEMORY_TOOL_NAMES)

export function memoryApprovalReason(name: string): string {
  return name === 'mindseye_memory_put'
    ? '写入 MindsEye 视觉记忆'
    : '读取 MindsEye 视觉记忆'
}

export async function memoryApprovalGate(
  exec: { name: string },
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  if (!MEMORY_TOOL_SET.has(exec.name)) return next()
  return { kind: 'ask', reason: memoryApprovalReason(exec.name) }
}

export function createMemoryTools(store: JsonlMemoryStore) {
  return [
    defineTool({
      name: 'mindseye_memory_put',
      description: '写入或合并一条图片级视觉记忆。same sha256 时按字段合并，不整条替换。',
      parameters: {
        sha256: { type: 'string', required: true, description: '图片 sha256' },
        record: {
          type: 'json',
          description: 'Evidence 字段：ocr/layout/elements/colors 及可选的 width/height/format/path/provider/model/createdAt',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            sha256: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        if (args.sha256.trim() === '') throw new Error('mindseye: sha256 is required')
        await store.putEvidence(normalizeEvidenceRecord(args.sha256, args.record))
        return { ok: true, sha256: args.sha256 }
      },
    }),
    defineTool({
      name: 'mindseye_memory_get',
      description: '按图片 sha256 读取一条视觉记忆证据，未找到时 record 为 null。',
      parameters: {
        sha256: { type: 'string', required: true, description: '图片 sha256' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            record: { type: 'json', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const record = store.getEvidence(args.sha256)
        return { found: record !== undefined, record: (record ?? null) as JsonValue }
      },
    }),
    defineTool({
      name: 'mindseye_memory_search',
      description: '搜索视觉记忆：按 sha256 过滤 evidence，带 query 时额外返回软记忆命中。',
      parameters: {
        sha256: { type: 'string', description: '可选，只返回该图的证据' },
        query: { type: 'string', description: '可选，软记忆检索问题' },
        limit: { type: 'integer', description: '软记忆返回条数上限，默认 3，最大 20' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            evidence: { type: 'json', required: true },
            softMemory: { type: 'json', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const evidence = await store.searchEvidence({ sha256: args.sha256 })
        const query = args.query?.trim() ?? ''
        const softMemory = query === ''
          ? []
          : await store.searchSoftMemory({
              query,
              evidenceId: args.sha256,
              limit: Math.min(Math.max(args.limit ?? 3, 1), 20),
            })
        return {
          evidence: evidence as unknown as JsonValue,
          softMemory: softMemory as unknown as JsonValue,
        }
      },
    }),
    defineTool({
      name: 'mindseye_memory_diff',
      description: '对比两张图的存储证据，返回字段级差异。',
      parameters: {
        fromSha256: { type: 'string', required: true, description: '基准图片 sha256' },
        toSha256: { type: 'string', required: true, description: '对比图片 sha256' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            changed: { type: 'boolean', required: true },
            fields: { type: 'json', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        return diffEvidence(
          store.getEvidence(args.fromSha256) ?? null,
          store.getEvidence(args.toSha256) ?? null,
        )
      },
    }),
  ]
}

export function diffEvidence(
  from: VisualEvidenceRecord | null,
  to: VisualEvidenceRecord | null,
): { changed: boolean; fields: Record<string, { from: JsonValue; to: JsonValue }> } {
  const keys = ['ocr', 'layout', 'elements', 'colors', 'width', 'height', 'format', 'path'] as const
  const fields: Record<string, { from: JsonValue; to: JsonValue }> = {}
  for (const key of keys) {
    const left = from?.[key] ?? null
    const right = to?.[key] ?? null
    if (!deepEqualJson(left, right)) {
      fields[key] = { from: left as JsonValue, to: right as JsonValue }
    }
  }
  return { changed: Object.keys(fields).length > 0, fields }
}

function normalizeEvidenceRecord(sha256: string, raw: unknown): VisualEvidenceRecord {
  const value = typeof raw === 'object' && raw !== null
    ? raw as Record<string, unknown>
    : {}
  return {
    id: sha256,
    sha256,
    width: typeof value.width === 'number' ? value.width : 0,
    height: typeof value.height === 'number' ? value.height : 0,
    format: typeof value.format === 'string' ? value.format : 'png',
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...evidenceToRecord(value as VisualEvidence),
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
  }
}

export function registerMemoryTools(ctx: Context, store: JsonlMemoryStore): void {
  for (const tool of createMemoryTools(store)) ctx.tools.register(tool)
  ctx.on('tools/pre-execute', (exec, next) => memoryApprovalGate(exec, next))
}
