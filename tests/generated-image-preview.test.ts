import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCloseOutline16: 'close-icon',
  Modal: 'modal',
}))

import { GeneratedImagePreview } from '../src/client/generated-image-preview.js'
import { CSS } from '../src/client/styles.js'

describe('GeneratedImagePreview', () => {
  it('declares an intrinsic-size image that fits its container without cropping', () => {
    expect(CSS).toContain('.mindseye-generated-image{display:block;width:auto;height:auto;max-width:100%;max-height:480px;')
    expect(CSS).toContain('object-fit:contain;object-position:center}')
    expect(CSS).toContain('.mindseye-generated-image-trigger{appearance:none;display:block;width:100%;max-width:100%;overflow:hidden')
  })

  it('opens the generated image from a keyboard-accessible zoom control', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const view = GeneratedImagePreview({
      url: 'blob:generated-image',
      alt: 'mindseye-generated-1.jpeg',
      open: true,
      onOpen,
      onClose,
      openerRef: { current: null },
      closeRef: { current: null },
    })
    const [trigger, modal] = view.props.children as [{
      type: unknown
      props: Record<string, any>
    }, {
      type: unknown
      props: Record<string, any>
    }]

    expect(trigger.type).toBe('button')
    expect(trigger.props.title).toBe('查看大图')
    expect(trigger.props['aria-label']).toBe('查看大图：mindseye-generated-1.jpeg')
    expect(trigger.props.children.props.src).toBe('blob:generated-image')
    trigger.props.onClick()
    expect(onOpen).toHaveBeenCalledOnce()

    expect(modal.props.open).toBe(true)
    expect(modal.props.title).toBe('图片预览')
    expect(modal.props.children[0].props.src).toBe('blob:generated-image')
    modal.props.children[1].props.onClick()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
