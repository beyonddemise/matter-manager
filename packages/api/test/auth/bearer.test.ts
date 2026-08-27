import { describe, expect, it } from 'vitest'
import { bearerToken } from '../../src/auth/bearer.js'

describe('reading a bearer token', () => {
  it('reads the token after the scheme', () => {
    expect(bearerToken('Bearer a.b.c')).toBe('a.b.c')
  })

  it('accepts the scheme in any case', () => {
    // RFC 7235: the scheme is case-insensitive, and real clients send `bearer`.
    for (const header of ['bearer a.b.c', 'BEARER a.b.c', 'BeArEr a.b.c']) {
      expect(bearerToken(header)).toBe('a.b.c')
    }
  })

  it('is nothing when there is no header', () => {
    expect(bearerToken(undefined)).toBeUndefined()
  })

  it('is nothing for another scheme', () => {
    // `Basic` in particular: a service that read the credential after any scheme would accept
    // a base64 username and password as a token and then fail to verify it — the same 401,
    // reached in a way nobody would think to look at.
    expect(bearerToken('Basic YWRtaW46c2VjcmV0')).toBeUndefined()
  })

  it('is nothing for a header with no scheme at all', () => {
    // Somebody sending the raw token. Accepting it would mean two forms of the same header,
    // one of them undocumented.
    expect(bearerToken('a.b.c')).toBeUndefined()
  })

  it('is nothing when the token is empty', () => {
    // `Bearer ` with nothing after it. An empty string is not a credential, and passing one to
    // the verifier makes a malformed request look like an invalid signature.
    expect(bearerToken('Bearer ')).toBeUndefined()
  })

  it('is nothing when there is more than one token', () => {
    // `Bearer a.b.c d.e.f` — a service that took the first would be choosing which credential
    // counts, and a service that took the last would be choosing differently. Neither decision
    // belongs anywhere, so the header is simply not one this service understands.
    expect(bearerToken('Bearer a.b.c d.e.f')).toBeUndefined()
  })

  it('is nothing for a scheme with no space after it', () => {
    expect(bearerToken('Bearera.b.c')).toBeUndefined()
  })

  it('does not trim its way into accepting a padded header', () => {
    // Extra whitespace makes the split produce empty parts, so this is refused rather than
    // silently repaired. A parser that repairs input is a parser with opinions about what the
    // client meant.
    expect(bearerToken('Bearer  a.b.c')).toBeUndefined()
  })
})
