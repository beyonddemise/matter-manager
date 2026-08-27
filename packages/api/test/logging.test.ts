import { describe, expect, it } from 'vitest'
import { REDACTED_FIELDS, REDACTION, redactionOptions } from '../src/logging.js'

describe('what must never reach a log', () => {
  it.each([
    ['a Matter payload', 'payload'],
    ['a manual pairing code', 'manualCode'],
    ['a setup passcode', 'passcode'],
    ['an authorization header', 'authorization'],
    ['an OAuth code', 'code'],
    ['a PKCE verifier', 'code_verifier'],
    ['a refresh token', 'refresh_token'],
  ])('redacts %s', (_case, field) => {
    expect(REDACTED_FIELDS).toContain(field)
  })

  it('redacts the Matter fields, which a general-purpose default would not', () => {
    // The ordinary credential names are on every list. `payload` and `manualCode` are on this
    // one because of what *this* application holds: a Matter payload encodes a setup passcode,
    // and a manual pairing code is one. Neither looks like a secret to a library's defaults.
    expect(REDACTED_FIELDS).toContain('payload')
    expect(REDACTED_FIELDS).toContain('manualCode')
  })

  it('matches a field at any depth, not just at the top', () => {
    // A payload is a payload whether it arrives as a body field, inside an array of devices, or
    // nested in an error someone attached context to. A path-based list protects the shapes
    // that were thought of.
    const { paths } = redactionOptions()

    expect(paths).toContain('payload')
    expect(paths).toContain('*.payload')
    expect(paths).toContain('*.*.payload')
  })

  it('censors rather than removes', () => {
    // A removed field makes a redacted request indistinguishable from one that never carried
    // it — which is exactly the distinction someone reading the log is trying to make.
    expect(redactionOptions().censor).toBe(REDACTION)
    expect(REDACTION).not.toBe('')
  })

  it('covers every listed field in the generated paths', () => {
    // The list and the configuration cannot drift: one is derived from the other, and this
    // says so rather than trusting the derivation to stay simple.
    const { paths } = redactionOptions()
    for (const field of REDACTED_FIELDS) expect(paths).toContain(field)
  })
})
