import { describe, expect, it, vi } from 'vitest'
import { createGuiTools } from '../src/gui/tools.js'

describe('GUI tool definitions', () => {
  it('registers the M1-M3 browser tool surface', () => {
    const manager = {
      open: vi.fn(),
      snapshot: vi.fn(),
      wait: vi.fn(),
      click: vi.fn(),
      type: vi.fn(),
      keypress: vi.fn(),
      scroll: vi.fn(),
      close: vi.fn(),
    }
    const tools = createGuiTools(manager as never)

    expect(tools.map((tool) => tool.name)).toEqual([
      'mindseye_gui_open',
      'mindseye_gui_snapshot',
      'mindseye_gui_wait',
      'mindseye_gui_click',
      'mindseye_gui_type',
      'mindseye_gui_keypress',
      'mindseye_gui_scroll',
      'mindseye_gui_close',
    ])
    const openParameters = tools[0]?.parameters as unknown as {
      properties: Record<string, unknown>
      required?: string[]
    }
    const clickParameters = tools[3]?.parameters as unknown as {
      properties: Record<string, unknown>
      required?: string[]
    }
    const typeParameters = tools[4]?.parameters as unknown as {
      properties: Record<string, unknown>
    }
    expect(openParameters.properties.url).toMatchObject({ type: 'string' })
    expect(openParameters.required).toEqual(['url'])
    expect(clickParameters.properties.snapshotId).toMatchObject({ type: 'string' })
    expect(clickParameters.required).toContain('snapshotId')
    expect((clickParameters.properties.target as { properties: Record<string, unknown> }).properties.kind)
      .toMatchObject({ enum: ['element', 'point'] })
    expect((typeParameters.properties.target as { properties: Record<string, unknown> }).properties.kind)
      .toMatchObject({ enum: ['element', 'focus'] })
  })

  it('renders a snapshot as an image block plus machine-readable result text', () => {
    const tools = createGuiTools({} as never)
    const snapshotTool = tools.find((tool) => tool.name === 'mindseye_gui_snapshot')
    const value = {
      result: {
        runId: 'gui-1',
        snapshotId: 'snapshot-1',
        url: 'http://localhost:3000/',
        title: 'Fixture',
        state: 'blocked',
        control: 'model',
        reason: 'security-verification',
        viewport: { width: 800, height: 600 },
        elements: [],
        attachment: { attachmentId: 'sha256:shot', mediaType: 'image/png' },
      },
    }

    expect(snapshotTool?.output.render({}, value as never)).toEqual([
      { type: 'image', attachment: value.result.attachment },
      { type: 'text', text: JSON.stringify(value.result, null, 2) },
    ])
    expect((snapshotTool?.output.render({}, value as never)[1] as { text: string }).text)
      .toContain('"control": "model"')
  })

  it('keeps the snapshot image in the completed tool presentation', () => {
    const tools = createGuiTools({} as never)
    const snapshotTool = tools.find((tool) => tool.name === 'mindseye_gui_snapshot')
    const value = {
      content: [
        { type: 'image', attachment: { attachmentId: 'sha256:shot', mediaType: 'image/png' } },
        { type: 'text', text: '{"snapshotId":"snapshot-1"}' },
      ],
      isError: false,
    }

    expect(snapshotTool?.presentResult?.({}, value as never)).toEqual({
      card: 'generic',
      title: 'mindseye_gui_snapshot',
      content: value.content,
    })
  })

  it('forwards tool arguments and agent identity to the manager', async () => {
    const manager = {
      open: vi.fn(async () => ({ runId: 'gui-1', url: 'http://localhost:3000', title: 'Fixture' })),
      snapshot: vi.fn(async () => ({
        runId: 'gui-1',
        snapshotId: 'snapshot-1',
        url: 'http://localhost:3000',
        title: 'Fixture',
        viewport: { width: 800, height: 600 },
        elements: [],
        attachment: { attachmentId: 'sha256:shot', mediaType: 'image/png' },
      })),
      wait: vi.fn(async () => ({ runId: 'gui-1', action: 'wait', completed: true, nextStep: 'snapshot-required' })),
      click: vi.fn(async () => ({ runId: 'gui-1', action: 'click', completed: true, nextStep: 'snapshot-required' })),
      type: vi.fn(async () => ({ runId: 'gui-1', action: 'type', completed: true, nextStep: 'snapshot-required' })),
      keypress: vi.fn(async () => ({ runId: 'gui-1', action: 'keypress', completed: true, nextStep: 'snapshot-required' })),
      scroll: vi.fn(async () => ({ runId: 'gui-1', action: 'scroll', completed: true, nextStep: 'snapshot-required' })),
      close: vi.fn(async () => undefined),
    }
    const tools = createGuiTools(manager as never)
    const exec = { agent: 'agent-a' } as never

    await tools[0]!.execute({ url: 'http://localhost:3000' }, exec)
    await tools[1]!.execute({}, exec)
    await tools[2]!.execute({ milliseconds: 25 }, exec)
    await tools[3]!.execute({ snapshotId: 'snapshot-1', target: { kind: 'point', value: '1,2' } }, exec)
    await tools[4]!.execute({ snapshotId: 'snapshot-1', target: { kind: 'element', value: 'element-search' }, text: 'hello' }, exec)
    await tools[5]!.execute({ snapshotId: 'snapshot-1', key: 'Enter' }, exec)
    await tools[6]!.execute({ snapshotId: 'snapshot-1', deltaY: 200 }, exec)
    await tools[7]!.execute({}, exec)

    expect(manager.open).toHaveBeenCalledWith('agent-a', 'http://localhost:3000')
    expect(manager.snapshot).toHaveBeenCalledWith('agent-a')
    expect(manager.wait).toHaveBeenCalledWith('agent-a', 25)
    expect(manager.click).toHaveBeenCalledWith('agent-a', 'snapshot-1', { kind: 'point', value: '1,2' })
    expect(manager.type).toHaveBeenCalledWith('agent-a', 'snapshot-1', { kind: 'element', value: 'element-search' }, 'hello')
    expect(manager.keypress).toHaveBeenCalledWith('agent-a', 'snapshot-1', 'Enter')
    expect(manager.scroll).toHaveBeenCalledWith('agent-a', 'snapshot-1', 0, 200)
    expect(manager.close).toHaveBeenCalledWith('agent-a')
  })

  it('uses native user questions to gate a blocked browser run', async () => {
    const blockedSnapshot = {
      runId: 'gui-1',
      snapshotId: 'snapshot-blocked',
      url: 'https://example.com/captcha',
      title: 'Verification',
      state: 'blocked',
      control: 'model',
      reason: 'security-verification',
      viewport: { width: 800, height: 600 },
      elements: [],
      attachment: { attachmentId: 'sha256:blocked', mediaType: 'image/png' },
    }
    const readySnapshot = {
      ...blockedSnapshot,
      snapshotId: 'snapshot-ready',
      state: 'ready' as const,
      control: 'model' as const,
      reason: undefined,
      attachment: { attachmentId: 'sha256:ready', mediaType: 'image/png' },
    }
    const manager = {
      open: vi.fn(async () => ({
        runId: 'gui-1',
        url: blockedSnapshot.url,
        title: blockedSnapshot.title,
        state: 'blocked' as const,
        control: 'model' as const,
      })),
      snapshot: vi.fn()
        .mockResolvedValueOnce(blockedSnapshot)
        .mockResolvedValueOnce(readySnapshot),
      takeover: vi.fn(async () => ({ runId: 'gui-1', state: 'blocked', control: 'user' })),
      resume: vi.fn(async () => ({ runId: 'gui-1', state: 'ready', control: 'model' })),
      close: vi.fn(async () => undefined),
    }
    const askUser = vi.fn()
      .mockResolvedValueOnce({ answers: [{ id: 'browser-handoff', selected: ['接管验证'] }] })
      .mockResolvedValueOnce({ answers: [{ id: 'browser-resume', selected: ['我已手动完成验证，请继续'] }] })
    const tools = createGuiTools(manager as never, { askUser })
    const exec = { agent: 'agent-a', signal: new AbortController().signal } as never

    const result = await tools[0]!.execute({ url: blockedSnapshot.url }, exec) as { result: Record<string, unknown> }

    expect(result.result).toMatchObject({ snapshotId: 'snapshot-ready', state: 'ready', control: 'model' })
    expect(askUser).toHaveBeenCalledTimes(2)
    expect(askUser.mock.calls[0]?.[0].questions[0]?.options).toEqual([
      expect.objectContaining({ label: '接管验证' }),
      expect.objectContaining({ label: '放弃' }),
    ])
    expect(askUser.mock.calls[0]?.[0].questions[0]?.question)
      .toBe('浏览器页面需要用户完成验证或登录，是否接管真实浏览器？')
    expect(askUser.mock.calls[0]?.[0].questions[0]?.detail)
      .toBe('\u3000\u00a0\u00a0页面标题：Verification  \n\u3000\u00a0\u00a0当前域名：example.com')
    expect(askUser.mock.calls[1]?.[0].questions[0]?.options).toEqual([
      expect.objectContaining({ label: '我已手动完成验证，请继续' }),
      expect.objectContaining({ label: '放弃' }),
    ])
    expect(askUser.mock.calls[1]?.[0].questions[0]?.question)
      .toBe('完成浏览器中的手动操作后，是否让模型继续？')
    expect(askUser.mock.calls[1]?.[0].questions[0]?.detail)
      .toBe('\u3000\u00a0\u00a0请在刚刚聚焦的真实浏览器窗口中完成验证码、登录或权限确认。  \n\u3000\u00a0\u00a0页面标题：Verification  \n\u3000\u00a0\u00a0当前域名：example.com')
    expect(manager.takeover).toHaveBeenCalledWith('gui-1')
    expect(manager.resume).toHaveBeenCalledWith('gui-1')
  })

  it('closes a blocked browser run when the user chooses to abandon it', async () => {
    const manager = {
      open: vi.fn(async () => ({ runId: 'gui-1', url: 'https://example.com', title: 'Blocked', state: 'blocked', control: 'model' })),
      snapshot: vi.fn(async () => ({
        runId: 'gui-1', snapshotId: 'snapshot-1', url: 'https://example.com', title: 'Blocked',
        state: 'blocked', control: 'model', reason: 'security-verification', viewport: { width: 800, height: 600 },
        elements: [], attachment: { attachmentId: 'sha256:blocked', mediaType: 'image/png' },
      })),
      close: vi.fn(async () => undefined),
    }
    const askUser = vi.fn(async () => ({ answers: [{ id: 'browser-handoff', selected: ['放弃'] }] }))
    const tools = createGuiTools(manager as never, { askUser })

    const result = await tools[0]!.execute({ url: 'https://example.com' }, { agent: 'agent-a', signal: new AbortController().signal } as never) as { result: Record<string, unknown> }

    expect(result.result).toMatchObject({ handoff: 'aborted' })
    expect(manager.close).toHaveBeenCalledWith('agent-a')
    expect(askUser).toHaveBeenCalledOnce()
  })

  it('treats skipping the first handoff question as a fresh page check', async () => {
    const blockedSnapshot = {
      runId: 'gui-1',
      snapshotId: 'snapshot-blocked',
      url: 'https://example.com/captcha',
      title: 'Verification',
      state: 'blocked' as const,
      control: 'model' as const,
      reason: 'security-verification' as const,
      viewport: { width: 800, height: 600 },
      elements: [],
      attachment: { attachmentId: 'sha256:blocked', mediaType: 'image/png' },
    }
    const readySnapshot = {
      ...blockedSnapshot,
      snapshotId: 'snapshot-ready',
      state: 'ready' as const,
      reason: undefined,
      attachment: { attachmentId: 'sha256:ready', mediaType: 'image/png' },
    }
    const manager = {
      open: vi.fn(async () => ({
        runId: 'gui-1', url: blockedSnapshot.url, title: blockedSnapshot.title,
        state: 'blocked', control: 'model', reason: 'security-verification',
      })),
      snapshot: vi.fn()
        .mockResolvedValueOnce(blockedSnapshot)
        .mockResolvedValueOnce(readySnapshot),
      takeover: vi.fn(),
      close: vi.fn(async () => undefined),
    }
    const askUser = vi.fn(async () => ({ answers: [{ id: 'browser-handoff', selected: [] }] }))
    const tools = createGuiTools(manager as never, { askUser })

    const result = await tools[0]!.execute(
      { url: blockedSnapshot.url },
      { agent: 'agent-a', signal: new AbortController().signal } as never,
    ) as { result: Record<string, unknown> }

    expect(result.result).toMatchObject({ snapshotId: 'snapshot-ready', state: 'ready' })
    expect(manager.snapshot).toHaveBeenCalledTimes(2)
    expect(manager.takeover).not.toHaveBeenCalled()
    expect(manager.close).not.toHaveBeenCalled()
  })

  it('treats skipping the resume question as abandoning the browser run', async () => {
    const blockedSnapshot = {
      runId: 'gui-1',
      snapshotId: 'snapshot-blocked',
      url: 'https://example.com/captcha',
      title: 'Verification',
      state: 'blocked' as const,
      control: 'model' as const,
      reason: 'security-verification' as const,
      viewport: { width: 800, height: 600 },
      elements: [],
      attachment: { attachmentId: 'sha256:blocked', mediaType: 'image/png' },
    }
    const manager = {
      open: vi.fn(async () => ({
        runId: 'gui-1', url: blockedSnapshot.url, title: blockedSnapshot.title,
        state: 'blocked', control: 'model', reason: 'security-verification',
      })),
      snapshot: vi.fn(async () => blockedSnapshot),
      takeover: vi.fn(async () => ({ runId: 'gui-1', state: 'blocked', control: 'user' })),
      resume: vi.fn(),
      close: vi.fn(async () => undefined),
    }
    const askUser = vi.fn()
      .mockResolvedValueOnce({ answers: [{ id: 'browser-handoff', selected: ['接管验证'] }] })
      .mockResolvedValueOnce({ answers: [{ id: 'browser-resume', selected: [] }] })
    const tools = createGuiTools(manager as never, { askUser })

    const result = await tools[0]!.execute(
      { url: blockedSnapshot.url },
      { agent: 'agent-a', signal: new AbortController().signal } as never,
    ) as { result: Record<string, unknown> }

    expect(result.result).toMatchObject({ handoff: 'aborted' })
    expect(manager.resume).not.toHaveBeenCalled()
    expect(manager.close).toHaveBeenCalledWith('agent-a')
  })
})
