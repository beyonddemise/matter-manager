/**
 * Turning a catalogue answer into device fields, and deciding when to ask.
 *
 * The catalogue values are **copied onto the device** rather than joined at display time, so a
 * record stays complete offline, in a PDF and after hand-over. Copying has one rule that makes
 * it safe: the block is a unit. It is written whole, replaced whole and merged whole
 * ({@link CATALOG_FIELD_KEYS}), so a document never pairs one answer's product name with an
 * older answer's manual link.
 *
 * Everything from the DCL is untrusted text: empty values are dropped, and a URL survives only
 * if it is `https:`. `URL` is not available here (`tsconfig.domain.json` has no DOM), so the
 * check is a strict pattern rather than a parse; it errs towards dropping a link.
 *
 * @module
 */

import type { CatalogSource, DeviceDocument } from '../documents/types.js'
import type { CatalogLookup } from './types.js'

/** The catalogue block of a device: everything a lookup writes, and nothing else. */
export type CatalogFields = Pick<
  DeviceDocument,
  | 'vendorName'
  | 'vendorPreferredName'
  | 'productName'
  | 'deviceTypeId'
  | 'partNumber'
  | 'productUrl'
  | 'supportUrl'
  | 'userManualUrl'
  | 'commissioningFlowUrl'
  | 'commissioningInstructions'
  | 'factoryResetInstructions'
> & {
  readonly catalogCheckedAt: string
  readonly catalogSource: CatalogSource
}

/**
 * Every key of the block, so it can be replaced whole.
 *
 * A key missing here would survive a replacement and outlive the answer it came from; the
 * copy test asserts that {@link catalogFields} produces no key outside this list.
 */
export const CATALOG_FIELD_KEYS: readonly (keyof CatalogFields)[] = [
  'vendorName',
  'vendorPreferredName',
  'productName',
  'deviceTypeId',
  'partNumber',
  'productUrl',
  'supportUrl',
  'userManualUrl',
  'commissioningFlowUrl',
  'commissioningInstructions',
  'factoryResetInstructions',
  'catalogCheckedAt',
  'catalogSource',
]

/** The name a test vendor (0xFFF1–0xFFF4) gets. The DCL never lists them. */
export const TEST_VENDOR_NAME = 'Test vendor'

/** How long a miss stands before the catalogue is asked again: one day. */
export const CATALOG_MISS_RETRY_MS = 24 * 60 * 60 * 1000

/** The API's `source`, as the document records it. */
const SOURCE: Readonly<Record<CatalogLookup['source'], CatalogSource>> = {
  dcl: 'found',
  missing: 'missing',
  'test-vendor': 'test-vendor',
}

/** `https://`, then a host with no whitespace, slash, query or fragment, then anything unbroken. */
const HTTPS_URL = /^https:\/\/[^\s/?#\\]+\S*$/i

/** Twenty-one digits: the manual code that carries vendor and product ids. */
const LONG_MANUAL_CODE = /^\d{21}$/

const CATALOG_KEYS: ReadonlySet<string> = new Set(CATALOG_FIELD_KEYS)

/**
 * Whether a value is an `https:` URL safe to render as a link.
 *
 * Control characters are refused separately: they are invisible in an address bar and a
 * pattern written to exclude them trips Biome's `noControlCharactersInRegex`.
 */
export function isHttpsUrl(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !HTTPS_URL.test(value)) return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** Trimmed text, or `undefined` for `null`, `undefined` and blank. */
function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** A trimmed `https:` URL, or `undefined`. */
function link(value: string | null | undefined): string | undefined {
  const trimmed = text(value)
  return isHttpsUrl(trimmed) ? trimmed : undefined
}

/**
 * `{ [key]: value }`, or `{}` when there is no value.
 *
 * A spread of this is how an optional field is *omitted* under `exactOptionalPropertyTypes`:
 * assigning `undefined` to it would not compile, and that is the setting doing its job.
 */
function present<K extends keyof CatalogFields, V>(
  key: K,
  value: V | undefined,
): { readonly [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { readonly [P in K]?: V })
}

/**
 * The vendor name a device gets from this answer.
 *
 * Forced for a test vendor rather than trusted: the backend says the same today, and the name
 * a test vendor shows must not depend on a server that may say something else tomorrow.
 */
function vendorNameOf(lookup: CatalogLookup): string | undefined {
  return lookup.source === 'test-vendor' ? TEST_VENDOR_NAME : text(lookup.vendor?.name)
}

/**
 * The catalogue block for one answer.
 *
 * @param lookup what the API answered
 * @param checkedAt when the catalogue was consulted, ISO 8601; becomes `catalogCheckedAt`
 * @returns the block, with every empty value and every non-`https:` URL left out
 */
export function catalogFields(lookup: CatalogLookup, checkedAt: string): CatalogFields {
  const { vendor, product } = lookup
  const vendorName = vendorNameOf(lookup)
  const deviceTypeId = product?.deviceTypeId
  return {
    ...present('vendorName', vendorName),
    ...present('vendorPreferredName', text(vendor?.preferredName)),
    ...present('productName', text(product?.name)),
    // 0 is the DCL's "not set", like an empty string.
    ...present(
      'deviceTypeId',
      typeof deviceTypeId === 'number' && deviceTypeId > 0 ? deviceTypeId : undefined,
    ),
    ...present('partNumber', text(product?.partNumber)),
    ...present('productUrl', link(product?.productUrl)),
    ...present('supportUrl', link(product?.supportUrl)),
    ...present('userManualUrl', link(product?.userManualUrl)),
    ...present('commissioningFlowUrl', link(product?.commissioningCustomFlowUrl)),
    ...present('commissioningInstructions', text(product?.commissioningInstructions)),
    ...present('factoryResetInstructions', text(product?.factoryResetInstructions)),
    catalogCheckedAt: checkedAt,
    catalogSource: SOURCE[lookup.source],
  }
}

/**
 * Whether the catalogue should be asked about this device.
 *
 * Only a device whose code carries vendor and product ids (a payload, or a 21-digit manual
 * code) can be looked up. A device asked once is not asked again, except a miss, which is
 * retried a day later because the DCL gains products every week.
 */
export function needsCatalogLookup(
  device: Pick<DeviceDocument, 'payload' | 'manualCode' | 'catalogCheckedAt' | 'catalogSource'>,
  now: Date,
): boolean {
  const carriesIds = device.payload !== undefined || LONG_MANUAL_CODE.test(device.manualCode)
  if (!carriesIds) return false
  if (device.catalogCheckedAt === undefined) return true
  if (device.catalogSource !== 'missing') return false
  const checked = Date.parse(device.catalogCheckedAt)
  // An unreadable stamp is treated as due: asking once more costs one request, while trusting
  // it would leave the device unnamed for good.
  return Number.isNaN(checked) || now.getTime() - checked > CATALOG_MISS_RETRY_MS
}

/**
 * `document` with its catalogue block replaced by the one in `source`.
 *
 * Every catalogue key is removed from `document` first, so a field the new block lacks is
 * removed rather than kept from the old one. Keys of `source` that are not catalogue keys are
 * ignored, so a whole revision can be passed as the source.
 */
export function withCatalogBlock<T extends object>(document: T, source: object): T {
  const kept = Object.entries(document).filter(([key]) => !CATALOG_KEYS.has(key))
  const block = Object.entries(source).filter(([key]) => CATALOG_KEYS.has(key))
  return Object.fromEntries([...kept, ...block]) as T
}

/** The manufacturer as people say it: the preferred name, then the vendor name. */
export function manufacturerName(
  fields: Pick<CatalogFields, 'vendorPreferredName' | 'vendorName'>,
): string | undefined {
  return fields.vendorPreferredName ?? fields.vendorName
}

/** The two names a form shows from the catalogue, each omitted when unknown. */
export interface CatalogNames {
  readonly manufacturer?: string
  readonly product?: string
}

/**
 * The names a catalogue answer gives, by the same rules the saved device will get them.
 *
 * Shares {@link vendorNameOf} and {@link manufacturerName} with {@link catalogFields} so a form
 * never shows a name the device would not have (a blank one, or a test vendor's server-side
 * spelling), and without {@link catalogFields}' timestamp, which a display has no business
 * inventing.
 */
export function catalogNames(lookup: CatalogLookup): CatalogNames {
  const manufacturer = manufacturerName({
    ...present('vendorPreferredName', text(lookup.vendor?.preferredName)),
    ...present('vendorName', vendorNameOf(lookup)),
  })
  const product = text(lookup.product?.name)
  return {
    ...(manufacturer === undefined ? {} : { manufacturer }),
    ...(product === undefined ? {} : { product }),
  }
}
