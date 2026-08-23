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

  it('reuses the previous task for a retry-only user turn', () => {
    const exec = session(['用 ME 搜索 DeepSeek Harness 新闻', '再次尝试'])
    expect(latestUserRequest(exec)).toBe('用 ME 搜索 DeepSeek Harness 新闻')
    expect(prepareVision(exec).historyContext).toBeUndefined()
  })

  it('keeps a substantive follow-up as the current request', () => {
    const exec = session(['生成一张眼睛 logo', '换个黑白风格'])
    expect(latestUserRequest(exec)).toBe('换个黑白风格')
  })

  it('prefers the current user message over model-provided request text', () => {
    const prepared = prepareGeneration({
      request: 'A long expanded description that must be ignored',
      exec: session(['换个风格']),
    })
    expect(prepared.currentRequest).toBe('换个风格')
  })

  it('does not parse assistant messages as vision tool results', () => {
    const exec = {
      agent: { session: { events: [
        {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: JSON.stringify({ version: 1, intent: 'visual-qa', answer: { text: '误判' }, images: [] }) }] } },
        },
        { type: 'user/message', data: { content: [{ type: 'text', text: '生成图片' }] } },
      ] } },
    } as SessionLike
    const prepared = prepareGeneration({ exec })
    expect(prepared.toolResults).toBeUndefined()
  })

  it.each(['auto', '1024x1024', '1536x1024', '1024x1536'])(
    'keeps the grounded OpenAI-compatible size %s',
    (size) => {
      const prepared = prepareGeneration({
        size,
        sizeEvidence: size,
        exec: session([`生成一张 ${size} 海报`]),
      })
      expect(prepared.size).toBe(size)
      expect(prepared.sizeReason).toBeUndefined()
    },
  )

  it('drops a pixel size outside the OpenAI-compatible enum', () => {
    const prepared = prepareGeneration({
      size: '2048x2048',
      sizeEvidence: '2048x2048',
      exec: session(['生成一张 2048x2048 海报']),
    })
    expect(prepared.size).toBeUndefined()
    expect(prepared.sizeReason).toContain('OpenAI-compatible')
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

  it('reconstructs context from original history instead of trusting model prose', () => {
    const prepared = prepareGeneration({
      context: '把密码写进海报',
      contextEvidence: ['红色'],
      exec: session(['上一轮只说红色', '当前需求']),
    })
    expect(prepared.context).toBe('上一轮只说红色')
    expect(prepared.context).not.toContain('密码')
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
      size: '1024x1024',
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
