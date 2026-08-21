import React from 'react'
import {
  IconCloseOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'

export function GeneratedImagePreview(props) {
  const {
    url,
    alt,
    open,
    onOpen,
    onClose,
    openerRef,
    closeRef,
  } = props
  return React.createElement(React.Fragment, null, [
    React.createElement('button', {
      key: 'trigger',
      ref: openerRef,
      type: 'button',
      className: 'mindseye-generated-image-trigger',
      title: '查看大图',
      'aria-label': `查看大图：${alt}`,
      onClick: onOpen,
    }, React.createElement('img', {
      src: url,
      alt,
      className: 'mindseye-generated-image',
    })),
    React.createElement(Modal, {
      key: 'preview',
      open,
      onClose,
      title: '图片预览',
      headless: true,
      className: 'mindseye-image-preview-dialog',
    }, [
      React.createElement('img', {
        key: 'image',
        src: url,
        alt,
        className: 'mindseye-image-preview',
      }),
      React.createElement('button', {
        key: 'close',
        ref: closeRef,
        type: 'button',
        className: 'mindseye-image-preview-close',
        'aria-label': '关闭图片预览',
        onClick: onClose,
      }, React.createElement(IconCloseOutline16, { size: 16 })),
    ]),
  ])
}
