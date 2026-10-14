import { describe, expect, it } from 'vitest'
import {
  assertionToJSON,
  attestationToJSON,
  b64urlToBuffer,
  bufferToB64url,
  parseCreationOptions,
  parseRequestOptions,
} from '../../src/ui/webauthn-json.js'

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer
const view = (buffer: BufferSource | null | undefined): number[] =>
  Array.from(new Uint8Array(buffer as ArrayBuffer))

describe('base64url', () => {
  it('round-trips empty input', () => {
    expect(bufferToB64url(bytes())).toBe('')
    expect(view(b64urlToBuffer(''))).toEqual([])
  })

  it.each([
    [[1], 'AQ'],
    [[1, 2], 'AQI'],
    [[1, 2, 3], 'AQID'],
  ])('encodes %j without padding as %s', (input, expected) => {
    expect(bufferToB64url(bytes(...input))).toBe(expected)
    expect(view(b64urlToBuffer(expected))).toEqual(input)
  })

  it('uses the - and _ alphabet', () => {
    expect(bufferToB64url(bytes(0xfb, 0xff, 0xfe))).toBe('-__-')
    expect(view(b64urlToBuffer('-__-'))).toEqual([0xfb, 0xff, 0xfe])
  })
})

describe('parseRequestOptions', () => {
  it('decodes the challenge and passes the rest through', () => {
    const result = parseRequestOptions({
      challenge: 'AQID',
      rpId: 'example.org',
      userVerification: 'preferred',
      timeout: 60000,
    })
    expect(view(result?.publicKey?.challenge)).toEqual([1, 2, 3])
    expect(result?.publicKey?.rpId).toBe('example.org')
    expect(result?.publicKey?.userVerification).toBe('preferred')
    expect(result?.publicKey?.timeout).toBe(60000)
  })

  it.each([['<html>'], [null], [undefined], [{}], [{ challenge: 5 }]])(
    'answers undefined for %j',
    (body) => {
      expect(parseRequestOptions(body)).toBeUndefined()
    },
  )
})

describe('parseCreationOptions', () => {
  const body = {
    challenge: 'AQID',
    rp: { name: 'Matter Manager', id: 'example.org' },
    user: { id: 'AQI', name: 'a@b.c', displayName: 'A' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    excludeCredentials: [
      { type: 'public-key', id: 'AQ' },
      { type: 'public-key', id: '-__-' },
    ],
  }

  it('decodes challenge, user.id and each excluded credential id', () => {
    const result = parseCreationOptions(body)
    const key = result?.publicKey
    expect(view(key?.challenge)).toEqual([1, 2, 3])
    expect(view(key?.user.id)).toEqual([1, 2])
    expect(key?.user.name).toBe('a@b.c')
    expect(key?.rp.id).toBe('example.org')
    expect(key?.excludeCredentials?.map((c) => view(c.id))).toEqual([[1], [0xfb, 0xff, 0xfe]])
    expect(key?.excludeCredentials?.[0]?.type).toBe('public-key')
  })

  it('tolerates a missing excludeCredentials', () => {
    const { excludeCredentials: _omit, ...rest } = body
    expect(parseCreationOptions(rest)?.publicKey?.excludeCredentials).toEqual([])
  })

  it.each([['<html>'], [null], [{}], [{ challenge: 'AQID' }], [{ challenge: 'AQID', user: {} }]])(
    'answers undefined for %j',
    (input) => {
      expect(parseCreationOptions(input)).toBeUndefined()
    },
  )
})

describe('ceremony results', () => {
  const credential = (response: object): PublicKeyCredential =>
    ({ id: 'cred-id', type: 'public-key', rawId: bytes(1, 2), response }) as PublicKeyCredential

  it('assertionToJSON encodes every buffer, keeping a null userHandle null', () => {
    const json = assertionToJSON(
      credential({
        clientDataJSON: bytes(1),
        authenticatorData: bytes(1, 2),
        signature: bytes(1, 2, 3),
        userHandle: null,
      }),
    )
    expect(json).toEqual({
      id: 'cred-id',
      type: 'public-key',
      rawId: 'AQI',
      response: {
        clientDataJSON: 'AQ',
        authenticatorData: 'AQI',
        signature: 'AQID',
        userHandle: null,
      },
    })
  })

  it('assertionToJSON encodes a present userHandle', () => {
    const json = assertionToJSON(
      credential({
        clientDataJSON: bytes(),
        authenticatorData: bytes(),
        signature: bytes(),
        userHandle: bytes(0xfb, 0xff, 0xfe),
      }),
    ) as { response: { userHandle: string } }
    expect(json.response.userHandle).toBe('-__-')
  })

  it('attestationToJSON encodes rawId, clientDataJSON and attestationObject', () => {
    const json = attestationToJSON(
      credential({ clientDataJSON: bytes(1), attestationObject: bytes(1, 2, 3) }),
    )
    expect(json).toEqual({
      id: 'cred-id',
      type: 'public-key',
      rawId: 'AQI',
      response: { clientDataJSON: 'AQ', attestationObject: 'AQID' },
    })
  })
})
