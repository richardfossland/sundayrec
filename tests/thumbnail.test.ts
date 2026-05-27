/**
 * Smoke tests for src/main/thumbnail.ts magic-byte detection. The image
 * dimension readers and IPC plumbing are integration concerns covered by
 * manual QA; here we just guard the format gate so a corrupted/spoofed file
 * can't sneak past format validation.
 */

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/sundayrec-test-thumb') },
}))

jest.mock('../src/main/store', () => ({
  get: jest.fn(),
  set: jest.fn(),
}))

import { isValidImage } from '../src/main/thumbnail'

describe('isValidImage', () => {
  it('accepts a JPEG magic-byte prefix', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 0)])
    expect(isValidImage(buf)).toEqual({ format: 'jpeg' })
  })

  it('accepts a PNG magic-byte prefix', () => {
    const buf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16, 0),
    ])
    expect(isValidImage(buf)).toEqual({ format: 'png' })
  })

  it('accepts a WebP RIFF/WEBP prefix', () => {
    // 0–3: "RIFF", 4–7: size, 8–11: "WEBP"
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
      0, 0, 0, 0,
    ])
    expect(isValidImage(buf)).toEqual({ format: 'webp' })
  })

  it('rejects random garbage', () => {
    expect(isValidImage(Buffer.from('hello world, definitely not an image'))).toBeNull()
  })

  it('rejects a GIF prefix', () => {
    const buf = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 0)])
    expect(isValidImage(buf)).toBeNull()
  })

  it('rejects a too-short buffer', () => {
    expect(isValidImage(Buffer.from([0xff, 0xd8]))).toBeNull()
  })

  it('rejects a JPEG-looking 3-byte buffer (below minimum length)', () => {
    expect(isValidImage(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull()
  })
})
