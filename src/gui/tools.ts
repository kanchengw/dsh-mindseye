import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type {
  GuiActionResult,
  GuiInputTarget,
  GuiKey,
  GuiSessionManager,
  GuiSnapshotResult,
  GuiTarget,
} from './browser.js'

const GUI_TOOL_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      result: { type: 'json' as const, required: true as const },
    },
  },
  render: (_args: unknown, value: unknown) => {
    const result = (value as { result?: unknown }).result ?? value
    return [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
  },
}

const TAKEOVER_LABEL = '接管验证'
const ABORT_LABEL = '放弃'
const RESUME_LABEL = '我已手动完成验证，请继续'
const DETAIL_INDENT = '\u3000\u00a0\u00a0'

interface GuiToolOptions {
  askUser?: (request: {
    questions: AskUserQuestionItem[]
    agent?: unknown
    signal?: AbortSignal
  }) => Promise<AskUserQuestionAnswer>
}

type GuiSnapshotFlowResult = GuiSnapshotResult & {
  handoff?: 'aborted'
}

function snapshotOutput(value: GuiSnapshotResult): {
  result: JsonValue
} {
  return { result: value as unknown as JsonValue }
}

function snapshotRender(_args: unknown, value: unknown): ContentBlock[] {
  const result = (value as { result?: GuiSnapshotResult }).result
  if (result === undefined || result.attachment === undefined) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
  return [
    { type: 'image', attachment: result.attachment as never },
    { type: 'text', text: JSON.stringify(result, null, 2) },
  ]
}

function snapshotPresentResult(_args: unknown, result: {
  content: ContentBlock[]
  isError: boolean
}) {
  if (result.isError) return undefined
  return {
    card: 'generic' as const,
    title: 'mindseye_gui_snapshot',
    content: result.content,
  }
}

function actionOutput(value: GuiActionResult): { result: JsonValue } {
  return { result: value as unknown as JsonValue }
}

function selectedAnswer(answer: AskUserQuestionAnswer, id: string): string | undefined {
  return answer.answers.find((item) => item.id === id)?.selected[0]
}

function handoffDetail(snapshot: GuiSnapshotResult): string {
  let host = snapshot.url
  try {
    host = new URL(snapshot.url).hostname
  } catch {
    // Keep the raw value only when the browser adapter returned a non-URL string.
  }
  return `${DETAIL_INDENT}页面标题：${snapshot.title}  \n${DETAIL_INDENT}当前域名：${host}`
}

async function blockedSnapshotFlow(
  manager: GuiSessionManager,
  snapshot: GuiSnapshotResult,
  exec: { agent?: unknown; signal: AbortSignal },
  askUser: NonNullable<GuiToolOptions['askUser']>,
): Promise<GuiSnapshotFlowResult> {
  const takeoverAnswer = await askUser({
    questions: [{
      id: 'browser-handoff',
      header: '浏览器验证',
      question: '浏览器页面需要用户完成验证或登录，是否接管真实浏览器？',
      detail: handoffDetail(snapshot),
      options: [
        { label: TAKEOVER_LABEL, description: '聚焦真实 Edge/Chrome 窗口，由你完成验证码、登录或权限确认。' },
        { label: ABORT_LABEL, description: '关闭当前浏览器运行，结束这次操作。' },
      ],
    }],
    agent: exec.agent,
    signal: exec.signal,
  })
  const takeoverSelection = selectedAnswer(takeoverAnswer, 'browser-handoff')
  if (takeoverSelection === undefined) {
    // Skipping the first question may mean the user finished verification outside the card.
    return await manager.snapshot(exec.agent)
  }
  if (takeoverSelection !== TAKEOVER_LABEL) {
    await manager.close(exec.agent)
    return { ...snapshot, handoff: 'aborted' }
  }

  await manager.takeover(snapshot.runId)
  let status = '请在刚刚聚焦的真实浏览器窗口中完成验证码、登录或权限确认。'
  while (true) {
    const resumeAnswer = await askUser({
      questions: [{
        id: 'browser-resume',
        header: '继续浏览器任务',
        question: '完成浏览器中的手动操作后，是否让模型继续？',
        detail: `${DETAIL_INDENT}${status}  \n${handoffDetail(snapshot)}`,
        options: [
          { label: RESUME_LABEL, description: '重新检查页面状态，并在验证完成后恢复模型控制。' },
          { label: ABORT_LABEL, description: '关闭当前浏览器运行，结束这次操作。' },
        ],
      }],
      agent: exec.agent,
      signal: exec.signal,
    })
    if (selectedAnswer(resumeAnswer, 'browser-resume') !== RESUME_LABEL) {
      await manager.close(exec.agent)
      return { ...snapshot, handoff: 'aborted' }
    }

    const resumed = await manager.resume(snapshot.runId)
    if (resumed.state === 'ready' && resumed.control === 'model') {
      return await manager.snapshot(exec.agent)
    }
    snapshot = await manager.snapshot(exec.agent)
    status = '页面仍处于阻塞状态。请先在真实浏览器中完成验证，完成后再选择继续。'
  }
}

async function snapshotWithHandoff(
  manager: GuiSessionManager,
  exec: { agent?: unknown; signal: AbortSignal },
  askUser: GuiToolOptions['askUser'],
): Promise<GuiSnapshotFlowResult> {
  const snapshot = await manager.snapshot(exec.agent)
  if (snapshot.state !== 'blocked') return snapshot
  if (askUser === undefined) {
    throw new Error('mindseye_gui: blocked page requires the DSH user-questions service')
  }
  return blockedSnapshotFlow(manager, snapshot, exec, askUser)
}

export function createGuiTools(manager: GuiSessionManager, options: GuiToolOptions = {}) {
  return [
    defineTool({
      name: 'mindseye_gui_open',
      description:
        '打开一个浏览器页面并创建当前会话隔离的 GUI 运行。'
        + '仅允许访问配置的 allowlist 主机。'
        + '如果返回 state=blocked，表示页面需要安全验证，停止 GUI 操作并请用户处理。'
        + '用户要求页面交互时，不要用拼接查询参数的 URL 替代输入、点击或键盘动作；只有用户明确要求打开该 URL 时才直达。'
        + '打开后先调用 mindseye_gui_snapshot，不要直接执行动作。',
      parameters: {
        url: { type: 'string', required: true, description: 'http 或 https 页面 URL。' },
      },
      output: GUI_TOOL_OUTPUT,
      async execute(args, exec) {
        const opened = await manager.open(exec.agent, args.url)
        if (opened.state !== 'blocked') return { result: opened as unknown as JsonValue }
        const snapshot = await snapshotWithHandoff(manager, exec, options.askUser)
        return snapshotOutput(snapshot)
      },
    }),
    defineTool({
      name: 'mindseye_gui_snapshot',
      description:
        '截取当前浏览器页面并作为 dsh 图片附件返回。'
        + '返回的 elements 是本次截图对应的通用交互元素清单，坐标均为 viewport 像素。'
        + '优先使用 elements[].elementId，不要猜测站点私有 CSS selector。'
        + '返回的 snapshotId 只对下一次动作有效；任何动作或等待后必须重新截图。',
      parameters: {},
      output: {
        ...GUI_TOOL_OUTPUT,
        render: snapshotRender,
      },
      presentResult: snapshotPresentResult,
      async execute(_args, exec) {
        return snapshotOutput(await snapshotWithHandoff(manager, exec, options.askUser))
      },
    }),
    defineTool({
      name: 'mindseye_gui_wait',
      description: '等待当前页面变化。等待结束后必须重新调用 mindseye_gui_snapshot。',
      parameters: {
        milliseconds: { type: 'integer', required: true, description: '等待毫秒数，不得超过配置的单步超时。' },
      },
      output: GUI_TOOL_OUTPUT,
      async execute(args, exec) {
        return actionOutput(await manager.wait(exec.agent, args.milliseconds))
      },
    }),
    defineTool({
      name: 'mindseye_gui_click',
      description:
        '在最近一次 GUI snapshot 对应的页面状态上执行点击。'
        + '必须提供最近的 snapshotId；动作后必须重新 snapshot。',
      parameters: {
        snapshotId: { type: 'string', required: true, description: '最近一次 mindseye_gui_snapshot 返回的 token。' },
        target: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['element', 'point'], required: true },
            value: { type: 'string', required: true, description: 'snapshot 返回的 elementId 或 viewport 内 x,y 坐标。' },
          },
        },
      },
      output: GUI_TOOL_OUTPUT,
      async execute(args, exec) {
        return actionOutput(await manager.click(exec.agent, args.snapshotId, args.target as GuiTarget))
      },
    }),
    defineTool({
      name: 'mindseye_gui_type',
      description:
        '向最近一次 GUI snapshot 对应页面输入文本。优先提供 snapshot 返回的 elementId；省略 target 时使用当前焦点元素。'
        + '必须提供最近的 snapshotId；动作后必须重新 snapshot。',
      parameters: {
        snapshotId: { type: 'string', required: true, description: '最近一次 mindseye_gui_snapshot 返回的 token。' },
        target: {
          type: 'object',
          description: '可选输入目标。优先使用 snapshot 返回的 elementId。',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['element', 'focus'], required: true },
            value: { type: 'string', description: 'snapshot 返回的 elementId；focus 不需要 value。' },
          },
        },
        text: { type: 'string', required: true, description: '要输入的文本。' },
      },
      output: GUI_TOOL_OUTPUT,
      async execute(args, exec) {
        return actionOutput(await manager.type(exec.agent, args.snapshotId, args.target as GuiInputTarget | undefined, args.text))
      },
    }),
    defineTool({
      name: 'mindseye_gui_keypress',
      description:
        '向当前浏览器焦点发送一个通用键盘动作，例如 Enter 提交表单、Tab 切换焦点或 Escape 关闭弹层。'
        + '必须提供最近的 snapshotId；动作后必须重新 snapshot。',
      parameters: {
        snapshotId: { type: 'string', required: true, description: '最近一次 mindseye_gui_snapshot 返回的 token。' },
        key: {
          type: 'string',
          enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
          required: true,
        },
      },
      output: GUI_TOOL_OUTPUT,
      async execute(args, exec) {
        return actionOutput(await manager.keypress(exec.agent, args.snapshotId, args.key as GuiKey))
      },
    }),
    defineTool({
      name: 'mindseye_gui_scroll',
      description:
        '滚动最近一次 GUI snapshot 对应页面。'
        + '必须提供最近的 snapshotId；动作后必须重新 snapshot。',
      parameters: {
        snapshotId: { type: 'string', required: true, description: '最近一次 mindseye_gui_snapshot 返回的 token。' },
        deltaX: { type: 'integer', description: '水平滚动距离，默认 0。' },
        deltaY: { type: 'integer', required: true, description: '垂直滚动距离。' },
      },
      output: GUI_TOOL_OUTPUT,
      async execute(args, exec) {
        return actionOutput(await manager.scroll(exec.agent, args.snapshotId, args.deltaX ?? 0, args.deltaY))
      },
    }),
    defineTool({
      name: 'mindseye_gui_close',
      description: '关闭当前会话的浏览器运行并释放资源。',
      parameters: {},
      output: GUI_TOOL_OUTPUT,
      async execute(_args, exec) {
        await manager.close(exec.agent)
        return { result: { closed: true } as JsonValue }
      },
    }),
  ]
}

export type GuiTools = ReturnType<typeof createGuiTools>
