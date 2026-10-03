import { describe, expect, it } from 'vitest'
import { userDocId, userKey } from '../../src/users/key.js'

describe('userKey', () => {
  it('is base64url of the trimmed, lower-cased address, without padding', () => {
    // "ab@c.d" is 6 bytes, so standard base64 has no padding; "a@b.c" (5 bytes) would.
    expect(userKey('a@b.c')).toBe(Buffer.from('a@b.c').toString('base64url'))
    expect(userKey('a@b.c')).not.toContain('=')
  })

  it('gives one key for one address however it was typed', () => {
    expect(userKey('  Ada@Example.COM ')).toBe(userKey('ada@example.com'))
  })

  it('uses the URL-safe alphabet', () => {
    // Bytes chosen so standard base64 would emit `+` and `/`.
    const key = userKey('ÿ?>@x.y')
    expect(key).not.toMatch(/[+/=]/)
  })

  it('refuses an empty address rather than keying everybody to `user:`', () => {
    expect(() => userKey('   ')).toThrow(TypeError)
  })

  it('prefixes the document id', () => {
    expect(userDocId('ada@example.com')).toBe(`user:${userKey('ada@example.com')}`)
  })
})
