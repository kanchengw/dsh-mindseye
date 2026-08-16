import { describe, expect, it } from 'vitest'
import {
  collectImageRefs,
  imageMarkerText,
  messagesContainImage,
  sanitizeMessages,
} from '../src/bridge/sanitize.js'

describe('sanitizeMessages', () => {
  it('rewrites top-level image blocks into text markers', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', attachment: { attachmentId: 'sha256:abc', name: 'a.png' } },
      ],
    }]
    const sanitized = sanitizeMessages(messages)
    const content = sanitized[0]?.content as unknown[]
    expect(content[1]).toMatchObject({ type: 'text' })
    expect((content[1] as { text?: string })?.text).toContain('sha256:abc')
    expect((content[1] as { text?: string })?.text).toContain('mindseye_read_image')
    expect(messages[0]?.content?.[1]?.type).toBe('image')
  })

  it('rewrites image blocks nested inside tool-result content', () => {
    const messages = [{
      role: 'tool',
      content: [{
        type: 'tool-result',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'image', attachment: { id: 'sha256:xyz', name: 'shot.png' } },
        ],
      }],
    }]
    const sanitized = sanitizeMessages(messages)
    const result = (sanitized[0]?.content as unknown[])[0] as { content?: unknown[] }
    expect(result.content?.[1]).toMatchObject({ type: 'text' })
    expect((result.content?.[1] as { text?: string })?.text).toContain('sha256:xyz')
  })

  it('keeps messages without images unchanged', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    expect(sanitizeMessages(messages)).toBe(messages)
  })
})

describe('collectImageRefs', () => {
  it('collects distinct attachment refs across nested blocks', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'sha256:a', name: 'a.png' } },
        {
          type: 'tool-result',
          content: [{ type: 'image', attachment: { attachmentId: 'sha256:b', name: 'b.png' } }],
        },
        { type: 'image', attachment: { attachmentId: 'sha256:a', name: 'a.png' } },
      ],
    }]
    const refs = collectImageRefs(messages)
    expect(refs.map((ref) => ref.attachmentId)).toEqual(['sha256:a', 'sha256:b'])
  })
})

describe('messagesContainImage', () => {
  it('detects image blocks at any depth', () => {
    expect(messagesContainImage([{
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'sha256:a' } }],
    }])).toBe(true)
    expect(messagesContainImage([{
      role: 'tool',
      content: [{
        type: 'tool-result',
        content: [{ type: 'image', attachment: { id: 'sha256:b' } }],
      }],
    }])).toBe(true)
    expect(messagesContainImage([{
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    }])).toBe(false)
  })
})

describe('imageMarkerText', () => {
  it('falls back to unknown id and default name', () => {
    expect(imageMarkerText({ type: 'image', attachment: {} })).toContain('unknown')
    expect(imageMarkerText({ type: 'image', attachment: {} })).toContain('「图片」')
  })
})
