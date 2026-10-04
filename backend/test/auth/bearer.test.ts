import { generateKeyPairSync } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { bearerClaims, bearerSubject, bearerToken } from '../../src/auth/bearer.js'
import { denyList } from '../../src/auth/deny-list.js'
import { mintToken, signingKeyFromPem } from '../../src/auth/jwt.js'

function newKey(kid = 'ec-test') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(kid, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

const requestWith = (token: string) =>
  ({ headers: { authorization: `Bearer ${token}` } }) as FastifyRequest

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

describe('reading the caller from an access token', () => {
  it('returns the subject, address and name', () => {
    const key = newKey()
    const token = mintToken(key, {
      purpose: 'access',
      sub: 's',
      email: 'ada@example.com',
      name: 'Ada',
      jti: 'j1',
      exp: 100,
    })
    expect(bearerClaims(requestWith(token), key, () => 0)).toEqual({
      sub: 's',
      email: 'ada@example.com',
      name: 'Ada',
    })
  })

  it('omits what the token does not carry', () => {
    const key = newKey()
    const token = mintToken(key, { purpose: 'access', sub: 's', exp: 100 })
    expect(bearerClaims(requestWith(token), key, () => 0)).toEqual({ sub: 's' })
  })

  it('refuses a denied access token', () => {
    const key = newKey()
    const deny = denyList(() => 0)
    const token = mintToken(key, { purpose: 'access', sub: 's', jti: 'j1', exp: 100 })
    deny.deny('j1', 100)
    const request = { headers: { authorization: `Bearer ${token}` } } as FastifyRequest
    expect(bearerClaims(request, key, () => 0, deny)).toBeUndefined()
    expect(bearerSubject(request, key, () => 0, deny)).toBeUndefined()
  })

  it('accepts a token the deny list does not name', () => {
    const key = newKey()
    const deny = denyList(() => 0)
    deny.deny('someone-else', 100)
    const token = mintToken(key, { purpose: 'access', sub: 's', jti: 'j1', exp: 100 })
    expect(bearerSubject(requestWith(token), key, () => 0, deny)).toBe('s')
  })

  it('refuses a refresh token presented as a bearer', () => {
    const key = newKey()
    const token = mintToken(key, { purpose: 'refresh', sub: 's', jti: 'j1', exp: 100 })
    expect(bearerClaims(requestWith(token), key, () => 0)).toBeUndefined()
  })
})
