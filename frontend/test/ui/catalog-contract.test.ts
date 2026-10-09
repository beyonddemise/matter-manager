/**
 * The hand-written `CatalogLookup` against `openapi.yaml`.
 *
 * The frontend has no generated API types, so nothing else notices when the contract gains,
 * drops or renames a field the type and its guard know about. ADR 0017: the two halves share
 * `openapi.yaml` and nothing else, so reading that file is how this half checks its side of it;
 * the backend's drift test checks the other.
 *
 * Three things are tied together:
 *
 * - the **contract**: each schema's `required` list and its `properties`;
 * - the **type**: {@link FULL} is annotated `CatalogLookup`, so the compiler refuses a key the
 *   type lacks and insists on every key it has. Its keys are the type's keys;
 * - the **guard**: `isCatalogLookup` refuses the answer once any one required key is gone.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { CatalogLookup } from '../../src/domain/index.js'
import { isCatalogLookup } from '../../src/ui/catalog.js'

/** One object schema, as far as this test reads it. */
interface ObjectSchema {
  readonly required: readonly string[]
  readonly properties: Readonly<Record<string, unknown>>
}

const contract = parse(
  readFileSync(fileURLToPath(new URL('../../../openapi.yaml', import.meta.url)), 'utf8'),
) as { components: { schemas: Record<string, ObjectSchema> } }

const schema = (name: string): ObjectSchema => {
  const found = contract.components.schemas[name]
  if (found === undefined) throw new Error(`openapi.yaml has no schema ${name}`)
  return found
}

const VENDOR = {
  name: 'Aqara',
  preferredName: null,
  legalName: 'Lumi United Technology Co., Ltd.',
  landingPageUrl: 'https://www.aqara.com/',
}

const PRODUCT = {
  name: 'Aqara Door and Window Sensor P2',
  label: null,
  partNumber: 'AS056',
  deviceTypeId: 21,
  productUrl: null,
  supportUrl: null,
  userManualUrl: null,
  commissioningCustomFlow: 0,
  commissioningCustomFlowUrl: null,
  commissioningInstructions: '1. Please make sure you have the Matter-compatible app',
  factoryResetInstructions: null,
}

/** Every field of the type, vendor and product included. See the module note. */
const FULL: CatalogLookup = {
  vendorId: 4447,
  productId: 8194,
  source: 'dcl',
  vendor: VENDOR,
  product: PRODUCT,
  fetchedAt: '2026-10-05T16:20:00.000Z',
  stale: false,
}

/** Each schema, the frontend object holding its fields, and how to rebuild an answer around it. */
const CASES: ReadonlyArray<
  readonly [string, Record<string, unknown>, (part: Record<string, unknown>) => unknown]
> = [
  ['CatalogLookup', FULL as unknown as Record<string, unknown>, (part) => part],
  ['CatalogVendor', VENDOR, (part) => ({ ...FULL, vendor: part })],
  ['CatalogProduct', PRODUCT, (part) => ({ ...FULL, product: part })],
]

const sorted = (keys: Iterable<string>): string[] => [...keys].sort()

describe('the frontend CatalogLookup and openapi.yaml', () => {
  it('accepts the full answer, so the cases below test one missing key each', () => {
    expect(isCatalogLookup(FULL)).toBe(true)
  })

  it.each(CASES)('%s: the type has exactly the required keys', (name, fields) => {
    expect(sorted(Object.keys(fields))).toEqual(sorted(schema(name).required))
  })

  it.each(CASES)('%s: the contract declares nothing the type lacks', (name) => {
    // An optional field added to the contract is not a broken client, but it is a field this
    // half silently drops. Make the decision visible: add it to the type, or say why not here.
    expect(sorted(Object.keys(schema(name).properties))).toEqual(sorted(schema(name).required))
  })

  it.each(CASES)(
    '%s: the guard refuses the answer without any one required key',
    (name, fields, rebuild) => {
      for (const key of schema(name).required) {
        const { [key]: _dropped, ...without } = fields
        expect(isCatalogLookup(rebuild(without)), `${name} without ${key}`).toBe(false)
      }
    },
  )
})
