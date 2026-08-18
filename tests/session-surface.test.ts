import { describe, expect, it, vi } from 'vitest'
import { sanitizeSessionSurface } from '../src/bridge/session-surface.js'

function imageBlock(attachmentId: string) {
  return {
    type: 'image',
    attachment: { attachmentId, name: '图.png' },
  }
}

function makeSession() {
  const events = [
    {
      seq: 0,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        content: [{ type: 'text', text: '看这张图' }, imageBlock('sha256:a')],
        source: { kind: 'user' },
      },
    },
    {
      seq: 1,
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          content: [{
            type: 'tool-result',
            content: [imageBlock('sha256:b')],
          }],
        },
      },
    },
  ]
  const appended: Array<{ type: string; data: Record<string, any>; options: Record<string, any> }> = []
  const session = {
    events,
    surface: { nodes: [0, 1] },
    append: vi.fn((type: string, data: Record<string, any>, options: Record<string, any>) => {
      appended.push({ type, data, options })
    }),
  }
  return { session, events, appended }
}

describe('sanitizeSessionSurface', () => {
  it('shadow-replaces image blocks with attachment markers', () => {
    const { session, appended } = makeSession()
    sanitizeSessionSurface(session)

    expect(appended).toHaveLength(2)
    expect(appended[0]?.type).toBe('user/message')
    expect(appended[0]?.data.content?.[1]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('sha256:a'),
    })
    expect(appended[1]?.type).toBe('tool/result')
    const nested = appended[1]?.data.message?.content?.[0]?.content?.[0]
    expect(nested).toMatchObject({ type: 'text', text: expect.stringContaining('sha256:b') })

    for (const entry of appended) {
      expect(entry.options).toEqual({
        surfaceOp: { op: 'replace', start: entry.options.surfaceOp.start, end: entry.options.surfaceOp.end },
        sourceEventSeqs: [entry.options.surfaceOp.start],
      })
    }
  })

  it('keeps the append-origin transcript untouched and skips on rescan', () => {
    const { session, events, appended } = makeSession()
    sanitizeSessionSurface(session)
    sanitizeSessionSurface(session)

    expect(events[0]?.data?.content?.[1]?.type).toBe('image')
    expect(appended).toHaveLength(2)
  })

  it('ignores events without image content', () => {
    const events = [
      {
        seq: 0,
        type: 'user/message',
        surfaceOp: 'append',
        data: { content: [{ type: 'text', text: 'no image' }], source: { kind: 'user' } },
      },
    ]
    const appended: unknown[] = []
    sanitizeSessionSurface({
      events,
      surface: { nodes: [0] },
      append: (type: string, data: unknown, options: unknown) => {
        appended.push({ type, data, options })
      },
    })
    expect(appended).toHaveLength(0)
  })
})
