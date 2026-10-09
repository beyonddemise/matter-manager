import { describe, expect, it } from 'vitest'
import {
  count,
  FOUND_TTL_MS,
  isFresh,
  isTestVendor,
  MISSING_TTL_MS,
  testVendorLookup,
  text,
  toLookup,
} from '../../src/catalog/policy.js'
import { type ModelEntry, type VendorEntry, withoutCreator } from '../../src/catalog/store.js'
import { AQARA_MODEL, AQARA_VENDOR } from '../support/dcl.js'

const FETCHED = '2026-10-05T16:20:00.000Z'
const at = (offsetMs: number): Date => new Date(Date.parse(FETCHED) + offsetMs)

const vendorFound: VendorEntry = {
  _id: 'vendor:4447',
  type: 'vendor',
  vid: 4447,
  status: 'found',
  fetchedAt: FETCHED,
  network: 'mainnet',
  dcl: withoutCreator(AQARA_VENDOR.vendorInfo),
}
const modelFound: ModelEntry = {
  _id: 'model:4447:8194',
  type: 'model',
  vid: 4447,
  pid: 8194,
  status: 'found',
  fetchedAt: FETCHED,
  network: 'mainnet',
  dcl: withoutCreator(AQARA_MODEL.model),
}
const vendorMissing: VendorEntry = {
  _id: 'vendor:4447',
  type: 'vendor',
  vid: 4447,
  status: 'missing',
  fetchedAt: FETCHED,
  network: 'mainnet',
}
const modelMissing: ModelEntry = {
  _id: 'model:4447:8194',
  type: 'model',
  vid: 4447,
  pid: 8194,
  status: 'missing',
  fetchedAt: FETCHED,
  network: 'mainnet',
}

describe('isFresh', () => {
  const found = { status: 'found', fetchedAt: FETCHED } as const
  const missing = { status: 'missing', fetchedAt: FETCHED } as const

  it('keeps a found entry for 90 days', () => {
    expect(FOUND_TTL_MS).toBe(90 * 86_400_000)
    expect(isFresh(found, at(FOUND_TTL_MS))).toBe(true)
  })

  it('refreshes a found entry at 90 days and one second', () => {
    expect(isFresh(found, at(FOUND_TTL_MS + 1000))).toBe(false)
  })

  it('retries a miss after one day', () => {
    expect(MISSING_TTL_MS).toBe(86_400_000)
    expect(isFresh(missing, at(MISSING_TTL_MS))).toBe(true)
    expect(isFresh(missing, at(MISSING_TTL_MS + 1000))).toBe(false)
  })

  it('treats an unreadable fetchedAt as stale, so a damaged entry is replaced', () => {
    expect(isFresh({ status: 'found', fetchedAt: 'yesterday' }, at(0))).toBe(false)
  })
})

describe('isTestVendor', () => {
  it.each([
    [0xfff0, false],
    [0xfff1, true],
    [0xfff2, true],
    [0xfff3, true],
    [0xfff4, true],
    [0xfff5, false],
    [4447, false],
  ])('vendor %i is a test vendor: %s', (vendorId, expected) => {
    expect(isTestVendor(vendorId)).toBe(expected)
  })
})

describe("the DCL's 'not set'", () => {
  it.each([
    ['', null],
    [undefined, null],
    [42, null],
    ['AS056', 'AS056'],
  ])('reads text %j as %j', (value, expected) => {
    expect(text(value)).toBe(expected)
  })

  it.each([
    [0, null],
    [undefined, null],
    ['21', null],
    [21, 21],
  ])('reads a number %j as %j', (value, expected) => {
    expect(count(value)).toBe(expected)
  })
})

describe('toLookup', () => {
  it('maps the recorded Aqara answer, turning every empty value into null', () => {
    expect(toLookup({ vendor: vendorFound, model: modelFound, stale: false })).toEqual({
      vendorId: 4447,
      productId: 8194,
      source: 'dcl',
      vendor: {
        name: 'Aqara',
        preferredName: null,
        legalName: 'Lumi United Technology Co., Ltd.',
        landingPageUrl: 'https://www.aqara.com/',
      },
      product: {
        name: 'Aqara Door and Window Sensor P2',
        label: 'Aqara Door and Window Sensor P2',
        partNumber: 'AS056',
        deviceTypeId: 21,
        productUrl: 'https://www.aqara.com/en/products.html',
        supportUrl: null,
        userManualUrl: null,
        commissioningCustomFlow: 0,
        commissioningCustomFlowUrl: null,
        commissioningInstructions: '1. Please make sure you have the Matter-compatible app',
        factoryResetInstructions: null,
      },
      fetchedAt: FETCHED,
      stale: false,
    })
  })

  it('answers missing with the vendor kept when only the model is missing', () => {
    const lookup = toLookup({ vendor: vendorFound, model: modelMissing, stale: false })
    expect(lookup.source).toBe('missing')
    expect(lookup.vendor?.name).toBe('Aqara')
    expect(lookup.product).toBeNull()
  })

  it('answers missing with both halves null when neither is in the ledger', () => {
    const lookup = toLookup({ vendor: vendorMissing, model: modelMissing, stale: false })
    expect(lookup).toMatchObject({ source: 'missing', vendor: null, product: null })
  })

  it('reports the older fetchedAt of the two, and passes stale through', () => {
    const older = { ...modelFound, fetchedAt: '2026-07-01T00:00:00.000Z' }
    const lookup = toLookup({ vendor: vendorFound, model: older, stale: true })
    expect(lookup.fetchedAt).toBe('2026-07-01T00:00:00.000Z')
    expect(lookup.stale).toBe(true)
  })
})

describe('testVendorLookup', () => {
  it('names the test vendor and no product', () => {
    expect(testVendorLookup(0xfff1, 0x8000, at(0))).toEqual({
      vendorId: 0xfff1,
      productId: 0x8000,
      source: 'test-vendor',
      vendor: { name: 'Test vendor', preferredName: null, legalName: null, landingPageUrl: null },
      product: null,
      fetchedAt: FETCHED,
      stale: false,
    })
  })
})
