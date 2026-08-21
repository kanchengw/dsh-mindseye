import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { adaptImageForDsh } from '../src/image-resize.js'

describe('adaptImageForDsh', () => {
  it('fits a real image inside 1980x1980 without changing its aspect ratio or format', async () => {
    const source = await sharp({
      create: {
        width: 2048,
        height: 1024,
        channels: 3,
        background: '#336699',
      },
    }).jpeg().toBuffer()

    const adapted = await adaptImageForDsh({
      data: new Uint8Array(source),
      mediaType: 'image/jpeg',
    })
    const metadata = await sharp(adapted.data).metadata()

    expect(metadata).toEqual(expect.objectContaining({
      width: 1980,
      height: 990,
      format: 'jpeg',
    }))
    expect(adapted).toEqual(expect.objectContaining({
      adapted: true,
      sourceWidth: 2048,
      sourceHeight: 1024,
      width: 1980,
      height: 990,
      format: 'jpeg',
    }))
  })

  it('returns compliant image bytes without re-encoding them', async () => {
    const source = new Uint8Array(await sharp({
      create: {
        width: 2000,
        height: 1000,
        channels: 4,
        background: '#336699',
      },
    }).png().toBuffer())

    const adapted = await adaptImageForDsh({ data: source, mediaType: 'image/png' })

    expect(adapted.adapted).toBe(false)
    expect(adapted.data).toBe(source)
    expect(adapted).toEqual(expect.objectContaining({
      sourceWidth: 2000,
      sourceHeight: 1000,
      width: 2000,
      height: 1000,
      format: 'png',
    }))
  })
})
