import { describe, expect, it } from 'vitest'
import { deriveKid } from '../../../src/domain/crypto/kid.js'

/**
 * The kid derivation the whole key hierarchy hangs on: SHA-256 over the raw SPKI DER,
 * as 64 lowercase hex characters. It must equal the backend's derivation — F2 (#299)
 * pins that agreement with shared vectors; these vectors pin this module alone, each
 * corroborated outside this codebase (lesson L1): `openssl dgst -sha256` over the same
 * bytes, and for `""` and `"abc"` the published FIPS 180-2 example values agree too.
 */
describe('deriveKid', () => {
  it('hashes the decoded SPKI bytes, not the base64 text', async () => {
    // base64 "AQID" is the bytes 0x01 0x02 0x03; hashing the string "AQID" instead
    // would produce a different digest, so this one assertion tells the two apart.
    expect(await deriveKid('AQID')).toBe(
      '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    )
  })

  it('matches the published SHA-256 vector for "abc"', async () => {
    expect(await deriveKid('YWJj')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('handles base64 padding', async () => {
    // "YWJjZA==" is "abcd": two padding characters, so the decoder's tail is exercised.
    expect(await deriveKid('YWJjZA==')).toBe(
      '88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589',
    )
  })

  it('derives the empty-input digest for an empty SPKI', async () => {
    expect(await deriveKid('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('is full 64 lowercase hex', async () => {
    expect(await deriveKid('AQID')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects input that is not base64', async () => {
    await expect(deriveKid('not base64!')).rejects.toThrow()
  })
})
