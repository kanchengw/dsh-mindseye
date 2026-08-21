import { describe, expect, it } from 'vitest'
import {
  imageFilesFromTransfer,
  replayImageInput,
  transferHasImage,
} from '../src/client/paste-fallback.js'

function imageFile(name: string, type = 'image/png') {
  return { name, type }
}

describe('imageFilesFromTransfer', () => {
  it('reads image files from clipboard items', () => {
    const image = imageFile('paste.png')
    const transfer = {
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => image },
      ],
      files: [],
    }

    expect(imageFilesFromTransfer(transfer)).toEqual([image])
  })

  it('falls back to data-transfer files for drag and drop', () => {
    const first = imageFile('first.png')
    const second = imageFile('notes.txt', 'text/plain')
    const transfer = { items: [], files: [first, second] }

    expect(imageFilesFromTransfer(transfer)).toEqual([first])
  })

  it('detects an image during dragover before the file becomes readable', () => {
    const transfer = {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
      files: [],
    }

    expect(transferHasImage(transfer)).toBe(true)
  })
})

describe('replayImageInput', () => {
  it('replays a paste with adapted files and the original plain text', () => {
    const dispatched: unknown[] = []
    const target = { dispatchEvent: (event: unknown) => { dispatched.push(event) } }
    class FakeTransfer {
      files: unknown[] = []
      text = ''
      items = { add: (file: unknown) => { this.files.push(file) } }
      setData(_type: string, value: string) { this.text = value }
    }
    class FakeClipboardEvent {
      constructor(public type: string, public init: Record<string, unknown>) {}
    }
    const first = imageFile('first.png')
    const second = imageFile('second.png')

    const replayed = replayImageInput(
      { type: 'paste', target },
      [first, second],
      'caption',
      {
        DataTransfer: FakeTransfer,
        ClipboardEvent: FakeClipboardEvent,
        DragEvent: class {},
      } as never,
    ) as unknown as FakeClipboardEvent

    expect(dispatched).toEqual([replayed])
    expect(replayed.type).toBe('paste')
    expect((replayed.init.clipboardData as FakeTransfer).files).toEqual([first, second])
    expect((replayed.init.clipboardData as FakeTransfer).text).toBe('caption')
    expect(replayed.init).toEqual(expect.objectContaining({ bubbles: true, cancelable: true }))
  })

  it('replays a drop with adapted files and the original plain text', () => {
    const dispatched: unknown[] = []
    const target = { dispatchEvent: (event: unknown) => { dispatched.push(event) } }
    class FakeTransfer {
      files: unknown[] = []
      text = ''
      items = { add: (file: unknown) => { this.files.push(file) } }
      setData(_type: string, value: string) { this.text = value }
    }
    class FakeDragEvent {
      constructor(public type: string, public init: Record<string, unknown>) {}
    }
    const image = imageFile('drop.png')

    const replayed = replayImageInput(
      { type: 'drop', target },
      [image],
      'caption',
      {
        DataTransfer: FakeTransfer,
        ClipboardEvent: class {},
        DragEvent: FakeDragEvent,
      } as never,
    ) as unknown as FakeDragEvent

    expect(dispatched).toEqual([replayed])
    expect(replayed.type).toBe('drop')
    expect((replayed.init.dataTransfer as FakeTransfer).files).toEqual([image])
    expect((replayed.init.dataTransfer as FakeTransfer).text).toBe('caption')
  })
})
