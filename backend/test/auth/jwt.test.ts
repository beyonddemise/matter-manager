import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  kidOf,
  mintToken,
  publicKeyForCouch,
  signingKeyFromPem,
  TokenError,
  verifyToken,
} from '../../src/auth/jwt.js'

/** A fresh EC P-256 key, as `openssl ecparam -name prime256v1` produces. */
function newKey(kid = 'test') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(kid, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

const soon = () => Math.floor(Date.now() / 1000) + 3600

describe('minting a token', () => {
  it('produces three base64url parts', () => {
    const token = mintToken(newKey(), { purpose: 'access', sub: 'google|abc', exp: soon() })

    expect(token.split('.')).toHaveLength(3)
    expect(token).not.toContain('+')
    expect(token).not.toContain('/')
    expect(token).not.toContain('=')
  })

  it('names ES256 and the key in the header', () => {
    // CouchDB reads `kid` to pick a key from `[jwt_keys]`. Without one it falls back to the key
    // named `_default` — which works right up until a second key exists, and then rotation
    // stops working in a way that only shows up under load.
    const token = mintToken(newKey('ec-2026-08'), {
      purpose: 'access',
      sub: 'google|abc',
      exp: soon(),
    })
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString())

    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'ec-2026-08' })
  })

  it('carries the claims it was given', () => {
    const key = newKey()
    const exp = soon()
    const token = mintToken(key, {
      purpose: 'access',
      sub: 'google|abc',
      exp,
      '_couchdb.roles': ['project_x_reader'],
    })

    expect(verifyToken(token, key.publicKey, 'access')).toEqual({
      purpose: 'access',
      sub: 'google|abc',
      exp,
      '_couchdb.roles': ['project_x_reader'],
    })
  })

  it('signs with the raw R‖S pair rather than DER', () => {
    // The line that would otherwise fail silently. Without `dsaEncoding: 'ieee-p1363'` Node
    // signs correctly and encodes the signature as DER — the same algorithm, different bytes,
    // rejected by CouchDB with no hint as to why. A P-256 R‖S signature is exactly 64 bytes;
    // a DER one is variable and starts with 0x30.
    const token = mintToken(newKey(), { purpose: 'access', sub: 'google|abc', exp: soon() })
    const signature = Buffer.from(token.split('.')[2] ?? '', 'base64url')

    expect(signature).toHaveLength(64)
    expect(signature[0]).not.toBe(0x30)
  })

  it('refuses a key that is not an EC key', () => {
    // An RSA key produces RS256-shaped signatures under an ES256 header — a token CouchDB
    // rejects for a reason nothing in the configuration explains.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

    expect(() =>
      signingKeyFromPem('rsa', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    ).toThrow(/EC key/)
  })
})

describe('verifying a token', () => {
  it('accepts one it just minted', () => {
    const key = newKey()
    const token = mintToken(key, { purpose: 'access', sub: 'google|abc', exp: soon() })

    expect(verifyToken(token, key.publicKey, 'access').sub).toBe('google|abc')
  })

  it('refuses one signed with another key', () => {
    // One of the three refusals `verify-jwt-model.sh` proves CouchDB makes. This service makes
    // the same one, so a token that would fail at CouchDB fails here first with a reason.
    const token = mintToken(newKey(), { purpose: 'access', sub: 'google|abc', exp: soon() })

    expect(() => verifyToken(token, newKey().publicKey, 'access')).toThrow(
      expect.objectContaining({ problem: 'signature' }),
    )
  })

  it('refuses one whose payload was edited', () => {
    // The attack the signature exists to stop: take a valid token, change `sub` to somebody
    // else's, and present it. The claim changes, the signature does not cover the new bytes.
    const key = newKey()
    const token = mintToken(key, { purpose: 'access', sub: 'google|abc', exp: soon() })
    const [header, payload, signature] = token.split('.') as [string, string, string]

    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString())
    edited.sub = 'google|someone-else'
    const forged = `${header}.${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${signature}`

    expect(() => verifyToken(forged, key.publicKey, 'access')).toThrow(
      expect.objectContaining({ problem: 'signature' }),
    )
  })

  it('refuses an expired one', () => {
    const key = newKey()
    const token = mintToken(key, { purpose: 'access', sub: 'google|abc', exp: 1_000 })

    expect(() => verifyToken(token, key.publicKey, 'access')).toThrow(
      expect.objectContaining({ problem: 'expired' }),
    )
  })

  it('refuses one that expires exactly now', () => {
    // Boundary, and the safe side of it: a token whose `exp` equals the current second has
    // expired. Accepting it means accepting a token CouchDB may already be refusing, which
    // presents as replication failing moments after a successful refresh.
    const key = newKey()
    const at = 1_700_000_000
    const token = mintToken(key, { purpose: 'access', sub: 'google|abc', exp: at })

    expect(() => verifyToken(token, key.publicKey, 'access', () => at)).toThrow(
      expect.objectContaining({ problem: 'expired' }),
    )
  })

  it('refuses a token claiming a different algorithm', () => {
    // The classic JWT vulnerability, in both its forms: `alg: none`, and an HMAC token
    // verified against the public key as though it were a shared secret. Checked *before* the
    // signature, because by the time a signature check has been performed the algorithm has
    // already been chosen.
    const key = newKey()
    const token = mintToken(key, { purpose: 'access', sub: 'google|abc', exp: soon() })
    const [, payload, signature] = token.split('.') as [string, string, string]

    for (const alg of ['none', 'HS256', 'RS256']) {
      const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url')
      expect(() =>
        verifyToken(`${header}.${payload}.${signature}`, key.publicKey, 'access'),
      ).toThrow(expect.objectContaining({ problem: 'algorithm' }))
    }
  })

  it('refuses a token with no signature at all', () => {
    const key = newKey()
    const token = mintToken(key, { purpose: 'access', sub: 'google|abc', exp: soon() })
    const [header, payload] = token.split('.') as [string, string]

    expect(() => verifyToken(`${header}.${payload}.`, key.publicKey, 'access')).toThrow(TokenError)
  })

  it.each([
    ['nothing at all', ''],
    ['two parts', 'a.b'],
    ['four parts', 'a.b.c.d'],
    ['not base64url', '!!!.???.###'],
  ])('refuses %s', (_case, token) => {
    expect(() => verifyToken(token, newKey().publicKey, 'access')).toThrow(TokenError)
  })

  it('tolerates a minute of clock skew on iat', () => {
    // Two machines' clocks differ, and a token minted a moment ago by a slightly fast server is
    // not an attack. More than a minute ahead is.
    const key = newKey()
    const at = 1_700_000_000
    const token = mintToken(key, {
      purpose: 'access',
      sub: 'google|abc',
      exp: at + 3600,
      iat: at + 30,
    })

    expect(verifyToken(token, key.publicKey, 'access', () => at).sub).toBe('google|abc')
    expect(() =>
      verifyToken(
        mintToken(key, { purpose: 'access', sub: 'google|abc', exp: at + 3600, iat: at + 600 }),
        key.publicKey,
        'access',
        () => at,
      ),
    ).toThrow(expect.objectContaining({ problem: 'not-yet-valid' }))
  })
})

describe('choosing a key', () => {
  it('reads the kid without verifying anything', () => {
    // Which is the point: the key needed to verify a token is named *by* the token, so the kid
    // has to be readable before any key has been chosen. It is untrusted input at that moment,
    // and is used only to look one up.
    expect(kidOf(mintToken(newKey('ec-b'), { purpose: 'access', sub: 'x', exp: soon() }))).toBe(
      'ec-b',
    )
  })

  it('answers nothing for a token it cannot read', () => {
    expect(kidOf('not-a-token')).toBeUndefined()
    expect(kidOf('')).toBeUndefined()
  })

  it('lets two keys coexist, which is what rotation needs', () => {
    // Tokens minted under the old key keep verifying while new ones are issued under the new
    // one. `verify-jwt-model.sh` proves CouchDB does the same, live, without a restart.
    const oldKey = newKey('ec-a')
    const newer = newKey('ec-b')
    const older = mintToken(oldKey, { purpose: 'access', sub: 'google|abc', exp: soon() })

    expect(kidOf(older)).toBe('ec-a')
    expect(verifyToken(older, oldKey.publicKey, 'access').sub).toBe('google|abc')
    expect(() => verifyToken(older, newer.publicKey, 'access')).toThrow()
  })
})

describe('the public key CouchDB is given', () => {
  it('is a single line with no PEM banner', () => {
    // CouchDB's config is an ini file, where a value cannot span lines. A PEM with its headers
    // and newlines intact is accepted into the config and then cannot be parsed — so every
    // token fails to verify while the configuration looks perfectly correct.
    const encoded = publicKeyForCouch(newKey().publicKey)

    expect(encoded).not.toContain('BEGIN')
    expect(encoded).not.toContain('\n')
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('round-trips back to the same key', () => {
    // The check that the stripping did not damage it. Reassembling the PEM and verifying a
    // real token with it proves the bytes CouchDB will hold are the bytes that work.
    const key = newKey()
    const encoded = publicKeyForCouch(key.publicKey)
    const pem = `-----BEGIN PUBLIC KEY-----\n${(encoded.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----\n`

    const token = mintToken(key, { purpose: 'access', sub: 'google|abc', exp: soon() })
    expect(verifyToken(token, createPublicKey(pem), 'access').sub).toBe('google|abc')
  })
})
