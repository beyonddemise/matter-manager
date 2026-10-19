import { describe, expect, it } from 'vitest'
import { decodeUtf8, encodeUtf8, Utf8Error } from '../../../src/domain/text/utf8.js'

/**
 * UTF-8 without `TextEncoder`, because `domain` reaches for nothing ambient.
 *
 * The platform's own encoder and strict decoder are the independent reference: every case is
 * checked against them, so this is a test of agreement with a second implementation rather
 * than of expectations written by hand.
 */

const platformEncode = (text: string): Uint8Array => new TextEncoder().encode(text)
const platformDecode = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes)

const SAMPLES = [
  '',
  'plain ASCII',
  'Küche, Straße, Ärmel',
  'Ελληνικά and русский',
  '日本語のテキスト',
  'emoji 🏠🔌 and a flag 🇩🇪',
  '\u0000 and \u007f and \u0080 and ߿ and ࠀ and ￿',
  '\u{10000} \u{10ffff}',
  'Küche',
]

describe('encoding', () => {
  it.each(SAMPLES)('agrees with TextEncoder for %j', (text) => {
    expect(encodeUtf8(text)).toEqual(platformEncode(text))
  })

  it('writes a lone surrogate as U+FFFD, as TextEncoder does', () => {
    expect(encodeUtf8('a\ud800b')).toEqual(platformEncode('a\ud800b'))
    expect(encodeUtf8('\udc00')).toEqual(platformEncode('\udc00'))
  })
})

describe('decoding', () => {
  it.each(SAMPLES)('round-trips %j', (text) => {
    expect(decodeUtf8(platformEncode(text))).toBe(text)
  })

  it.each([
    ['a lone continuation byte', [0x80]],
    ['a truncated two-byte sequence', [0xc3]],
    ['a truncated three-byte sequence', [0xe2, 0x82]],
    ['a truncated four-byte sequence', [0xf0, 0x9f, 0x8f]],
    ['an overlong NUL', [0xc0, 0x80]],
    ['an overlong slash', [0xe0, 0x80, 0xaf]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ['a code point past U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['an invalid lead byte', [0xff]],
    ['a lead byte where a continuation belongs', [0xc3, 0x41]],
  ])('refuses %s, as a strict TextDecoder does', (_label, bytes) => {
    const input = new Uint8Array(bytes)
    expect(() => platformDecode(input)).toThrow()
    expect(() => decodeUtf8(input)).toThrow(Utf8Error)
  })

  it('accepts a byte-order mark as text, as TextDecoder with ignoreBOM would', () => {
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('﻿A')
  })
})
