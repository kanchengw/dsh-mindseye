import { describe, expect, it } from 'vitest'
import { sessionAttachmentOf } from '../src/bridge/session-attachment.js'

function imageBlock(attachmentId: string) {
  return {
    type: 'image',
    attachment: { attachmentId, mediaType: 'image/png', width: 1, height: 1 },
  }
}

describe('sessionAttachmentOf', () => {
  it('finds an image attachment in a user message', () => {
    const agent = {
      session: {
        events: [
          {
            type: 'user/message',
            data: {
              content: [{ type: 'text', text: '看这张图' }, imageBlock('sha256:user')],
            },
          },
        ],
      },
    }

    expect(sessionAttachmentOf(agent, 'sha256:user')).toMatchObject({
      attachmentId: 'sha256:user',
    })
  })

  it('finds an image attachment nested in a tool result', () => {
    const agent = {
      session: {
        events: [
          {
            type: 'tool/result',
            data: {
              message: {
                content: [{
                  type: 'tool-result',
                  content: [imageBlock('sha256:generated')],
                }],
              },
            },
          },
        ],
      },
    }

    expect(sessionAttachmentOf(agent, 'sha256:generated')).toMatchObject({
      attachmentId: 'sha256:generated',
    })
  })

  it('returns undefined when the attachment is not in the session log', () => {
    const agent = {
      session: {
        events: [
          {
            type: 'user/message',
            data: { content: [{ type: 'text', text: '没有图片' }] },
          },
        ],
      },
    }

    expect(sessionAttachmentOf(agent, 'sha256:missing')).toBeUndefined()
  })
})
