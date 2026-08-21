import { describe, expect, it, vi } from 'vitest'
import { registerImageTurnActivation } from '../src/bridge/image-turn.js'

describe('registerImageTurnActivation', () => {
  it('activates vision tools when an image enters the agent inbox', () => {
    let event = ''
    let listener: ((payload: unknown) => void) | undefined
    const ctx = {
      on: (name: string, callback: typeof listener) => {
        event = name
        listener = callback
      },
      logger: { warn: vi.fn() },
    }
    const activate = vi.fn()

    registerImageTurnActivation(ctx as never, activate)
    listener?.({
      message: {
        content: [{ type: 'image', attachment: { attachmentId: 'sha256:image' } }],
      },
    })

    expect(event).toBe('agent/inbox/inserted')
    expect(activate).toHaveBeenCalledOnce()
  })

  it('does not activate vision tools for a text-only inbox message', () => {
    let listener: ((payload: unknown) => void) | undefined
    const ctx = {
      on: (_name: string, callback: typeof listener) => { listener = callback },
      logger: { warn: vi.fn() },
    }
    const activate = vi.fn()

    registerImageTurnActivation(ctx as never, activate)
    listener?.({ message: { content: [{ type: 'text', text: 'hello' }] } })

    expect(activate).not.toHaveBeenCalled()
  })
})
