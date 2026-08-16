import { describe, expect, it } from 'vitest'
import { probeDimensions } from '../src/bridge/image-meta.js'

describe('probeDimensions', () => {
  it('parses png dimensions from IHDR', () => {
    const png = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
    png.writeUInt32BE(1000, 16)
    png.writeUInt32BE(600, 20)
    expect(probeDimensions(png, 'png')).toEqual({ width: 1000, height: 600 })
  })

  it('parses gif dimensions', () => {
    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'ascii'),
      Buffer.from([0xe8, 0x03, 0x58, 0x02]),
    ])
    expect(probeDimensions(gif, 'gif')).toEqual({ width: 1000, height: 600 })
  })

  it('parses jpeg dimensions from SOF0', () => {
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x58, 0x03, 0xe8, 0x01, 0x11, 0x00,
    ])
    expect(probeDimensions(jpeg, 'jpeg')).toEqual({ width: 1000, height: 600 })
  })

  it('parses webp VP8X canvas dimensions', () => {
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBP', 8, 'ascii')
    webp.write('VP8X', 12, 'ascii')
    webp[16] = 10
    webp[24] = 0xe7
    webp[25] = 0x03
    webp[27] = 0x57
    webp[28] = 0x02
    expect(probeDimensions(webp, 'webp')).toEqual({ width: 1000, height: 600 })
  })

  it('returns zeros for malformed input', () => {
    expect(probeDimensions(Buffer.from('nope'), 'png')).toEqual({ width: 0, height: 0 })
    expect(probeDimensions(Buffer.from('x'), 'gif')).toEqual({ width: 0, height: 0 })
  })
})
