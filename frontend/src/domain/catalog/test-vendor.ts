/**
 * Answering test-vendor codes on the device, so they never reach the API (#238).
 *
 * The backend answers the four test vendor ids without touching the DCL, so sending such a
 * code is a round trip that only moves a secret (it holds the passcode) for nothing. Deciding
 * here is data minimising: the answer is the same, and the code stays where it is.
 *
 * The answer mirrors the backend's `testVendorLookup` (`backend/src/catalog/policy.ts`) field for
 * field, so a device filed offline is indistinguishable from one the server answered.
 *
 * @module
 */

import { parseManualCode } from '../matter/manual-code.js'
import { decodePayload, PAYLOAD_PREFIX } from '../matter/payload.js'
import { TEST_VENDOR_NAME } from './copy.js'
import type { CatalogLookup } from './types.js'

/** The vendor ids the Matter specification reserves for testing, 0xFFF1–0xFFF4. */
const TEST_VENDOR_FIRST = 0xfff1
const TEST_VENDOR_LAST = 0xfff4

/** The vendor and product ids in a setup code, or `undefined` if it carries none we can read. */
function idsOf(code: string): { vendorId: number; productId: number } | undefined {
  const trimmed = code.trim()
  try {
    // Upper-case only, as `decodePayload` and the backend both insist: a typed `mt:` is not a
    // code either of them accepts, and answering it here would file what the server refuses.
    if (trimmed.startsWith(PAYLOAD_PREFIX)) {
      const { vendorId, productId } = decodePayload(trimmed)
      return { vendorId, productId }
    }
    const { vendorId, productId } = parseManualCode(trimmed)
    // An 11-digit code carries neither id; the server answers it as unusable.
    return vendorId === undefined || productId === undefined ? undefined : { vendorId, productId }
  } catch {
    // Not a code this side can read. The server decides what it is, as it did before; nothing
    // is logged, because the input is a secret.
    return undefined
  }
}

/**
 * The catalogue answer for a test-vendor code, made without a request.
 *
 * @param code a QR payload (`MT:…`) or a manual pairing code, as the lookup would send it
 * @param now when the answer is made; becomes `fetchedAt`
 * @returns the `test-vendor` answer the backend would give, or `undefined` when the code is
 *   not from a test vendor, carries no ids, or cannot be decoded, and so is the server's to answer
 */
export function testVendorAnswer(code: string, now: Date): CatalogLookup | undefined {
  const ids = idsOf(code)
  if (ids === undefined) return undefined
  if (ids.vendorId < TEST_VENDOR_FIRST || ids.vendorId > TEST_VENDOR_LAST) return undefined
  return {
    vendorId: ids.vendorId,
    productId: ids.productId,
    source: 'test-vendor',
    vendor: { name: TEST_VENDOR_NAME, preferredName: null, legalName: null, landingPageUrl: null },
    product: null,
    fetchedAt: now.toISOString(),
    stale: false,
  }
}
