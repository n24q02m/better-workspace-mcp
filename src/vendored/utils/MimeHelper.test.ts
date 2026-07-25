import { describe, it, expect, vi, afterEach } from 'vitest'
import { MimeHelper } from './MimeHelper.js'

// Only the multipart path generates a boundary, so every case here sends one attachment.
const encodeWithAttachment = () =>
  MimeHelper.createMimeMessageWithAttachments({
    to: 'to@example.com',
    subject: 'hello',
    body: 'body text',
    attachments: [{ filename: 'note.txt', content: 'aGVsbG8=' }]
  })

const boundaryOf = (encoded: string): string => {
  const message = MimeHelper.decodeBase64Url(encoded)
  const match = message.match(/Content-Type: multipart\/mixed; boundary="([^"]*)"/)
  if (!match) throw new Error(`no multipart boundary in message: ${message.slice(0, 200)}`)
  return match[1]
}

describe('vendored MimeHelper multipart boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps a non-empty random suffix even when Math.random() stringifies short', () => {
    // Upstream did `Math.random().toString(36).substring(7)`. 0.5 -> "0.i", whose
    // index 7 does not exist, so the suffix was '' and the boundary collapsed to
    // `boundary_<ms>_`. Stubbing both sources reproduces exactly that draw.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    expect(boundaryOf(encodeWithAttachment())).toMatch(/^boundary_1700000000000_[0-9a-f]{32}$/)
  })

  it('gives two messages built in the same millisecond different boundaries', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    expect(boundaryOf(encodeWithAttachment())).not.toBe(boundaryOf(encodeWithAttachment()))

    const boundaries = new Set(Array.from({ length: 50 }, () => boundaryOf(encodeWithAttachment())))
    expect(boundaries.size).toBe(50)
  })

  it('stays inside the RFC 2046 boundary charset and length limit, and delimits the parts', () => {
    const encoded = encodeWithAttachment()
    const boundary = boundaryOf(encoded)

    // bcharsnospace: DIGIT / ALPHA / "'" / "(" / ")" / "+" / "_" / "," / "-" / "." / "/" / ":" / "=" / "?"
    expect(boundary).toMatch(/^[0-9A-Za-z'()+_,\-./:=?]+$/)
    expect(boundary.length).toBeLessThan(70)

    const message = MimeHelper.decodeBase64Url(encoded)
    expect(message).toContain(`--${boundary}\r\n`)
    expect(message.endsWith(`--${boundary}--`)).toBe(true)
  })
})
