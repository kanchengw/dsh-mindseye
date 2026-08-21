import type { Context } from '@deepseek-ai/cordis'
import { messagesContainImage, type MessageLike } from './sanitize.js'

export function registerImageTurnActivation(
  ctx: Context,
  activate: () => unknown,
): void {
  (ctx as any).on('agent/inbox/inserted', (payload: { message?: MessageLike }) => {
    if (payload.message === undefined || !messagesContainImage([payload.message])) return
    try {
      activate()
    } catch (error) {
      ctx.logger?.warn('mindseye: failed to auto-mount vision tools on an image turn', error)
    }
  })
}
