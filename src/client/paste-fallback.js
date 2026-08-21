const replayedImageInputs = new WeakSet()

export function filesFromTransfer(transfer) {
  if (!transfer) return []
  const files = []
  const items = transfer.items
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length > 0) return files
  const transferred = transfer.files
  if (!transferred) return files
  for (let i = 0; i < transferred.length; i += 1) {
    const file = transferred[i]
    if (file) files.push(file)
  }
  return files
}

export function imageFilesFromTransfer(transfer) {
  return filesFromTransfer(transfer).filter(file => /^image\//.test(file.type))
}

export function transferHasImage(transfer) {
  if (!transfer) return false
  const items = transfer.items
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind === 'file' && /^image\//.test(item.type)) return true
    }
  }
  const files = transfer.files
  if (!files) return false
  for (let i = 0; i < files.length; i += 1) {
    if (/^image\//.test(files[i]?.type || '')) return true
  }
  return false
}

export function consumeReplayedImageInput(event) {
  if (!replayedImageInputs.has(event)) return false
  replayedImageInputs.delete(event)
  return true
}

export function replayImageInput(sourceEvent, files, text = '', runtime = globalThis) {
  const transfer = new runtime.DataTransfer()
  for (const file of files) transfer.items.add(file)
  if (text !== '') transfer.setData('text/plain', text)
  const init = { bubbles: true, cancelable: true }
  const replayed = sourceEvent.type === 'paste'
    ? new runtime.ClipboardEvent('paste', { ...init, clipboardData: transfer })
    : new runtime.DragEvent('drop', { ...init, dataTransfer: transfer })
  replayedImageInputs.add(replayed)
  sourceEvent.target.dispatchEvent(replayed)
  return replayed
}
