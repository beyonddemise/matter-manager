import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { REDACTED_FIELDS, REDACTION, redactionOptions } from '../src/logging.js'

/** Distinctive enough that finding it in a line is unambiguous. */
const SECRET = 'MT:Y.K90SO527JA0648G00'

/** What this service would actually write, given this object. */
function logLine(logged: Record<string, unknown>): string {
  const lines: string[] = []
  const log = pino({ ...redactionOptions(), level: 'info' }, { write: (line) => lines.push(line) })
  log.info(logged, 'under test')
  return lines.join('')
}

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

  it.each([
    ['at the top', { payload: SECRET }],
    ['one level down', { device: { payload: SECRET } }],
    ['two levels down', { body: { device: { payload: SECRET } } }],
    ['three levels down', { a: { b: { c: { payload: SECRET } } } }],
    ['four levels down', { a: { b: { c: { d: { payload: SECRET } } } } }],
    ['inside an array', { devices: [{ payload: SECRET }] }],
    [
      'on an error somebody attached context to',
      { err: { cause: { request: { payload: SECRET } } } },
    ],
  ])('is redacted %s', (_case, logged) => {
    // Asserted by **logging it**, not by inspecting a list of paths. The test this replaces was
    // called "matches a field at any depth" and checked that three strings were in an array —
    // which was true, and which said nothing about whether anything was redacted. Pino's
    // wildcards are not recursive: `*.payload` matches one level and `*.*.payload` two, so the
    // list covered depths nought to two and the fourth case above went to the log in clear.
    expect(logLine(logged)).not.toContain(SECRET)
  })

  it('says a value was there', () => {
    // The positive control for the cases above: deleting the field entirely would pass every
    // one of them, and would destroy the distinction the censor exists to keep.
    expect(logLine({ device: { payload: SECRET } })).toContain(REDACTION)
  })

  it('leaves everything else alone', () => {
    // The other positive control. Censoring the whole object would also hide every secret.
    expect(logLine({ device: { name: 'Kitchen lamp', payload: SECRET } })).toContain('Kitchen lamp')
  })

  it('censors rather than removes', () => {
    // A removed field makes a redacted request indistinguishable from one that never carried
    // it — which is exactly the distinction someone reading the log is trying to make.
    const line = logLine({ device: { payload: SECRET } })

    expect(line).toContain('payload')
    expect(line).toContain(REDACTION)
    expect(REDACTION).not.toBe('')
  })

  it.each(REDACTED_FIELDS.map((field) => [field]))('redacts %s in a real log line', (field) => {
    // The list and the configuration cannot drift, and this checks the *behaviour* rather than
    // the derivation: the previous version asserted that each name appeared in a generated
    // array of paths, which stayed true after the paths stopped being how redaction works.
    expect(logLine({ nested: { [field]: SECRET } })).not.toContain(SECRET)
  })

  it('keeps an error readable', () => {
    // `main.ts` logs `{ err: error }` on a failed start and a failed shutdown. `message` and
    // `stack` are **non-enumerable** own properties, so `Object.entries` does not see them —
    // a formatter that rebuilds an Error as a plain object silently produces a log line that
    // records that something failed and nothing about what.
    const failure = new Error('CouchDB refused the write')

    const line = logLine({ err: failure })

    expect(line).toContain('CouchDB refused the write')
    expect(JSON.parse(line).err?.stack).toBeTruthy()
  })

  it('still redacts context attached to an error', () => {
    // The positive control for the test above: handing the Error through untouched would keep
    // the message and leak everything somebody attached to it. Both have to hold at once.
    const failure = Object.assign(new Error('write refused'), { payload: SECRET })

    const line = logLine({ err: failure })

    expect(line).toContain('write refused')
    expect(line).not.toContain(SECRET)
  })

  it('redacts inside an error cause', () => {
    const failure = new Error('outer', { cause: { payload: SECRET } })

    expect(logLine({ err: failure })).not.toContain(SECRET)
  })

  it('does not hand back an unredacted object when it stops descending', () => {
    // The bound has to fail closed. Returning the value at `MAX_DEPTH` means everything below
    // it is serialised untouched — so nesting past the bound is not a way to lose a secret in
    // the noise, it is a way to publish one.
    let deep: Record<string, unknown> = { payload: SECRET }
    for (let level = 0; level < 15; level += 1) deep = { [`level${level}`]: deep }

    expect(logLine(deep)).not.toContain(SECRET)
  })

  it('does not follow a cycle forever', () => {
    // A log object is built from request data. Nothing should be able to turn a log line into
    // a stack overflow in the logger.
    const cyclic: Record<string, unknown> = { payload: SECRET }
    cyclic.self = cyclic

    expect(() => logLine(cyclic)).not.toThrow()
    expect(logLine(cyclic)).not.toContain(SECRET)
  })
})
