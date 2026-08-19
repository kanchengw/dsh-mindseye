import { describe, expect, it } from 'vitest'
import {
  CONTEXT_MAX_LENGTH,
  latestUserRequest,
  prepareGeneration,
  prepareVision,
} from '../src/prepare.js'
import type { SessionLike } from '../src/prepare.js'

function session(messages: string[]): SessionLike {
  return {
    agent: {
      session: {
        events: messages.map((text) => ({
          type: 'user/message',
          data: { content: [{ type: 'text', text }] },
        })),
      },
    },
  }
}

describe('prepare stage', () => {
  it('extracts only the latest user message verbatim', () => {
    const exec = session(['生成一张 4K 海报', '再给我一张小一点的'])
    expect(latestUserRequest(exec)).toBe('再给我一张小一点的')
  })

  it('prefers the current user message over model-provided request text', () => {
    const prepared = prepareGeneration({
      request: 'A long expanded description that must be ignored',
      exec: session(['换个风格']),
    })
    expect(prepared.currentRequest).toBe('换个风格')
  })

  it('keeps a grounded size with its user evidence', () => {
    const prepared = prepareGeneration({
      size: '2K',
      sizeEvidence: '小一点',
      exec: session(['生成一张 4K 海报', '再给我一张小一点的']),
    })
    expect(prepared.size).toBe('2K')
    expect(prepared.sizeReason).toBeUndefined()
  })

  it('accepts grounded context evidence and injects the matching history', () => {
    const exec = session([
      '上次的布局是左 60% 地图、右 40% 双卡',
      '按上次的布局换一个配色',
    ])
    const prepared = prepareGeneration({
      context: '上次的布局是左 60% 地图、右 40% 双卡',
      contextEvidence: ['上次的布局'],
      exec,
    })
    expect(prepared.context).toBe('上次的布局是左 60% 地图、右 40% 双卡')
    expect(prepared.contextEvidence).toEqual(['上次的布局'])
    expect(prepared.historyContext).toEqual(['上次的布局是左 60% 地图、右 40% 双卡'])
  })

  it('drops context when it has no evidence', () => {
    const prepared = prepareGeneration({
      context: '上次的布局是左 60% 地图、右 40% 双卡',
      exec: session(['随便来一张']),
    })
    expect(prepared.context).toBeUndefined()
    expect(prepared.contextReason).toContain('contextEvidence')
  })

  it('falls back to the last five previous user messages', () => {
    const messages = Array.from({ length: 7 }, (_, index) => `历史消息 ${index}`)
    const prepared = prepareVision(session([...messages, '当前需求']))
    expect(prepared.historyContext).toEqual([
      '历史消息 2',
      '历史消息 3',
      '历史消息 4',
      '历史消息 5',
      '历史消息 6',
    ])
  })

  it('drops a size whose evidence is not in user context', () => {
    const prepared = prepareGeneration({
      size: '4K',
      sizeEvidence: '还是用 8K',
      exec: session(['随便来一张']),
    })
    expect(prepared.size).toBeUndefined()
    expect(prepared.sizeReason).toContain('sizeEvidence')
  })

  it('drops a size outside the provider format', () => {
    const prepared = prepareGeneration({
      size: '16:9',
      sizeEvidence: '16:9',
      exec: session(['来一张 16:9 的']),
    })
    expect(prepared.size).toBeUndefined()
    expect(prepared.sizeReason).toContain('格式')
  })

  it('drops an oversized supplement context', () => {
    const prepared = prepareVision(undefined, 'x'.repeat(CONTEXT_MAX_LENGTH + 1))
    expect(prepared.context).toBeUndefined()
    expect(prepared.contextReason).toContain('超过')
  })

  it('grounds attachment-id evidence and injects the carrying user message', () => {
    const exec = {
      agent: { session: { events: [
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: '参考这张图' }, { type: 'image', attachment: { attachmentId: 'sha256:abc' } }] },
        },
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: '按这张图改' }] },
        },
      ] } },
    } as SessionLike
    const prepared = prepareGeneration({ context: '参考这张图', contextEvidence: ['sha256:abc'], exec })
    expect(prepared.contextEvidence).toEqual(['sha256:abc'])
    expect(prepared.historyContext).toEqual(['参考这张图'])
  })

  it('injects matched vision tool results into generation context', () => {
    const visionText = JSON.stringify({
      version: 1,
      intent: 'visual-qa',
      images: [{ sha256: 'sha256:abc' }],
      answer: { text: '这是海报' },
    })
    const exec = {
      agent: { session: { events: [
        { type: 'tool/result', data: { message: { content: [{ type: 'text', text: visionText }] } } },
        { type: 'user/message', data: { content: [{ type: 'text', text: '按这张图改' }] } },
      ] } },
    } as SessionLike
    const prepared = prepareGeneration({ context: '参考图内容', contextEvidence: ['sha256:abc'], exec })
    expect(prepared.toolResults).toEqual(['[识图 visual-qa] 这是海报'])
  })

  it('injects generated-image records when evidence matches the generated id', () => {
    const exec = {
      agent: { session: { events: [
        { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '<generated-image attachment_id="sha256:gen"></generated-image> (token_usage=1, 1024x1024)' }] } } },
        { type: 'user/message', data: { content: [{ type: 'text', text: '按上次生成图改' }] } },
      ] } },
    } as SessionLike
    const prepared = prepareGeneration({ context: '上一版结果', contextEvidence: ['sha256:gen'], exec })
    expect(prepared.toolResults?.[0]).toContain('[生成记录] 附件 sha256:gen')
  })
})
