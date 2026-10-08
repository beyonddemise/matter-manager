/**
 * What the catalogue answers, decided without I/O: when a cached entry is still good, which
 * vendor IDs never reach the DCL, and how a DCL record becomes the API's response.
 *
 * Pure, so the rules the spec states in days and in "empty means null" are tested as rules
 * rather than through a fake HTTP round trip.
 *
 * @module
 */

import type { ModelEntry, VendorEntry } from './store.js'

/** A found entry is refreshed after 90 days: product records change rarely, and slowly. */
export const FOUND_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** A miss is retried after a day: a product is often certified after it ships. */
export const MISSING_TTL_MS = 24 * 60 * 60 * 1000

/** The test vendor IDs, 0xFFF1–0xFFF4. Verified absent from MainNet and TestNet. */
const TEST_VENDOR_FIRST = 0xfff1
const TEST_VENDOR_LAST = 0xfff4

/** What the API answers, field for field the contract's `CatalogLookup` schema. */
export interface CatalogLookup {
  readonly vendorId: number
  readonly productId: number
  readonly source: 'dcl' | 'test-vendor' | 'missing'
  readonly vendor: {
    readonly name: string
    readonly preferredName: string | null
    readonly legalName: string | null
    readonly landingPageUrl: string | null
  } | null
  readonly product: {
    readonly name: string
    readonly label: string | null
    readonly partNumber: string | null
    readonly deviceTypeId: number | null
    readonly productUrl: string | null
    readonly supportUrl: string | null
    readonly userManualUrl: string | null
    readonly commissioningCustomFlow: number
    readonly commissioningCustomFlowUrl: string | null
    readonly commissioningInstructions: string | null
    readonly factoryResetInstructions: string | null
  } | null
  readonly fetchedAt: string
  readonly stale: boolean
}

/** Whether a vendor ID is one of the four the specification reserves for testing. */
export function isTestVendor(vendorId: number): boolean {
  return vendorId >= TEST_VENDOR_FIRST && vendorId <= TEST_VENDOR_LAST
}

/**
 * Whether a cached entry may be served without asking the DCL again.
 *
 * Fresh **up to and including** the boundary: an entry is stale from one millisecond past it.
 * An unparseable `fetchedAt` is stale, so a damaged entry is replaced rather than kept forever.
 */
export function isFresh(
  entry: { readonly status: 'found' | 'missing'; readonly fetchedAt: string },
  now: Date,
): boolean {
  const fetched = Date.parse(entry.fetchedAt)
  if (Number.isNaN(fetched)) return false
  const ttl = entry.status === 'found' ? FOUND_TTL_MS : MISSING_TTL_MS
  return now.getTime() - fetched <= ttl
}

/** The DCL's "not set" for text — `""`, or no value at all — as `null`. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The DCL's "not set" for a number — `0`, or no value at all — as `null`. */
export function count(value: unknown): number | null {
  return typeof value === 'number' && value !== 0 ? value : null
}

/** The answer for a test vendor, which touches neither CouchDB nor the DCL. */
export function testVendorLookup(vendorId: number, productId: number, now: Date): CatalogLookup {
  return {
    vendorId,
    productId,
    source: 'test-vendor',
    vendor: { name: 'Test vendor', preferredName: null, legalName: null, landingPageUrl: null },
    product: null,
    fetchedAt: now.toISOString(),
    stale: false,
  }
}

/**
 * The response for two entries, however they were obtained.
 *
 * `source` is `dcl` only when **both** were found; a missing vendor or a missing model is
 * `missing`, with whichever half was found still filled in. `fetchedAt` is the older of the two,
 * so a client never believes a combined answer is fresher than its oldest part.
 */
export function toLookup(input: {
  readonly vendor: VendorEntry
  readonly model: ModelEntry
  readonly stale: boolean
}): CatalogLookup {
  const { vendor, model } = input
  const vendorRecord = vendor.status === 'found' ? vendor.dcl : undefined
  const modelRecord = model.status === 'found' ? model.dcl : undefined

  return {
    vendorId: vendor.vid,
    productId: model.pid,
    source: vendorRecord !== undefined && modelRecord !== undefined ? 'dcl' : 'missing',
    vendor:
      vendorRecord === undefined
        ? null
        : {
            name: vendorRecord.vendorName,
            preferredName: text(vendorRecord.companyPreferredName),
            legalName: text(vendorRecord.companyLegalName),
            landingPageUrl: text(vendorRecord.vendorLandingPageURL),
          },
    product:
      modelRecord === undefined
        ? null
        : {
            name: modelRecord.productName,
            label: text(modelRecord.productLabel),
            partNumber: text(modelRecord.partNumber),
            deviceTypeId: count(modelRecord.deviceTypeId),
            productUrl: text(modelRecord.productUrl),
            supportUrl: text(modelRecord.supportUrl),
            userManualUrl: text(modelRecord.userManualUrl),
            // Not `count`: 0 is a real value here — the standard flow — not "not set".
            commissioningCustomFlow:
              typeof modelRecord.commissioningCustomFlow === 'number'
                ? modelRecord.commissioningCustomFlow
                : 0,
            commissioningCustomFlowUrl: text(modelRecord.commissioningCustomFlowUrl),
            commissioningInstructions: text(modelRecord.commissioningModeInitialStepsInstruction),
            factoryResetInstructions: text(modelRecord.factoryResetStepsInstruction),
          },
    fetchedAt: vendor.fetchedAt < model.fetchedAt ? vendor.fetchedAt : model.fetchedAt,
    stale: input.stale,
  }
}
