import { describe, expect, it } from 'vitest'
import {
  type CatalogLookup,
  decodePayload,
  deriveManualCode,
  encodePayload,
  testVendorAnswer,
} from '../../../src/domain/index.js'

/** The verified public reference device: vendor 0xFFF1, product 0x8000. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const NOW = new Date('2026-10-09T08:00:00.000Z')

const reference = decodePayload(PAYLOAD)
/** The 21-digit form of the reference device, which carries the ids. */
const LONG_CODE = deriveManualCode({
  discriminator: reference.discriminator,
  passcode: reference.passcode,
  vendorId: reference.vendorId,
  productId: reference.productId,
})

/** The same device under a real (non-test) vendor id. */
const realVendor = encodePayload({ ...reference, vendorId: 0x1234 })

/** Exactly what the backend's `testVendorLookup` answers (`backend/src/catalog/policy.ts`). */
const expected = (vendorId: number, productId: number): CatalogLookup => ({
  vendorId,
  productId,
  source: 'test-vendor',
  vendor: { name: 'Test vendor', preferredName: null, legalName: null, landingPageUrl: null },
  product: null,
  fetchedAt: NOW.toISOString(),
  stale: false,
})

/** #238: test-vendor codes are answered here, so they never leave the device. */
describe('testVendorAnswer', () => {
  it('answers a QR payload from a test vendor as the server would', () => {
    expect(testVendorAnswer(PAYLOAD, NOW)).toEqual(expected(0xfff1, 0x8000))
  })

  it('answers a 21-digit manual code from a test vendor, separators and all', () => {
    expect(LONG_CODE).toHaveLength(21)
    expect(testVendorAnswer(LONG_CODE, NOW)).toEqual(expected(0xfff1, 0x8000))
    const grouped = `${LONG_CODE.slice(0, 4)}-${LONG_CODE.slice(4, 11)} ${LONG_CODE.slice(11)}`
    expect(testVendorAnswer(grouped, NOW)).toEqual(expected(0xfff1, 0x8000))
  })

  it.each([0xfff1, 0xfff2, 0xfff3, 0xfff4])('covers vendor %i', (vendorId) => {
    const code = encodePayload({ ...reference, vendorId })
    expect(testVendorAnswer(code, NOW)?.vendorId).toBe(vendorId)
  })

  it.each([0xfff0, 0xfff5, 0x1234])('leaves vendor %i to the server', (vendorId) => {
    expect(testVendorAnswer(encodePayload({ ...reference, vendorId }), NOW)).toBeUndefined()
  })

  it('leaves a real vendor to the server', () => {
    expect(testVendorAnswer(realVendor, NOW)).toBeUndefined()
  })

  it('leaves to the server what it cannot decode, or what carries no ids', () => {
    const short = deriveManualCode({
      discriminator: reference.discriminator,
      passcode: reference.passcode,
    })
    expect(testVendorAnswer(short, NOW)).toBeUndefined()
    // A wrong check digit: mistyped, so the server is the one to say so.
    const mistyped = `${LONG_CODE.slice(0, 20)}${(Number(LONG_CODE.at(-1)) + 1) % 10}`
    expect(testVendorAnswer(mistyped, NOW)).toBeUndefined()
    expect(testVendorAnswer(PAYLOAD.replace('MT:', 'mt:'), NOW)).toBeUndefined()
    expect(testVendorAnswer('MT:', NOW)).toBeUndefined()
    expect(testVendorAnswer('not a code', NOW)).toBeUndefined()
    expect(testVendorAnswer('', NOW)).toBeUndefined()
  })
})
