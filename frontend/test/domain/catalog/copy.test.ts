import { describe, expect, it } from 'vitest'
import {
  CATALOG_FIELD_KEYS,
  CATALOG_MISS_RETRY_MS,
  catalogFields,
  catalogNames,
  isHttpsUrl,
  manufacturerName,
  needsCatalogLookup,
  withCatalogBlock,
} from '../../../src/domain/catalog/copy.js'
import type { CatalogLookup } from '../../../src/domain/catalog/types.js'

const CHECKED = '2026-10-05T16:20:00.000Z'

/** The recorded Aqara answer the backend plan also uses: vendor 4447, model 4447/8194. */
const AQARA: CatalogLookup = {
  vendorId: 4447,
  productId: 8194,
  source: 'dcl',
  vendor: {
    name: 'Aqara',
    preferredName: 'Aqara Home',
    legalName: 'Lumi United Technology Co., Ltd.',
    landingPageUrl: 'https://www.aqara.com/',
  },
  product: {
    name: 'Aqara Door and Window Sensor P2',
    label: 'Aqara Door and Window Sensor P2',
    partNumber: 'AS056',
    deviceTypeId: 21,
    productUrl: 'https://www.aqara.com/en/products.html',
    supportUrl: 'https://www.aqara.com/support',
    userManualUrl: 'https://www.aqara.com/manual.pdf',
    commissioningCustomFlow: 0,
    commissioningCustomFlowUrl: 'https://www.aqara.com/pairing',
    commissioningInstructions: '1. Please make sure the sensor is powered.',
    factoryResetInstructions: 'Hold the button for 10 seconds.',
  },
  fetchedAt: CHECKED,
  stale: false,
}

describe('catalogFields', () => {
  it('copies every catalogue field and maps dcl to found', () => {
    expect(catalogFields(AQARA, CHECKED)).toEqual({
      vendorName: 'Aqara',
      vendorPreferredName: 'Aqara Home',
      productName: 'Aqara Door and Window Sensor P2',
      deviceTypeId: 21,
      partNumber: 'AS056',
      productUrl: 'https://www.aqara.com/en/products.html',
      supportUrl: 'https://www.aqara.com/support',
      userManualUrl: 'https://www.aqara.com/manual.pdf',
      commissioningFlowUrl: 'https://www.aqara.com/pairing',
      commissioningInstructions: '1. Please make sure the sensor is powered.',
      factoryResetInstructions: 'Hold the button for 10 seconds.',
      catalogCheckedAt: CHECKED,
      catalogSource: 'found',
    })
  })

  it('omits null and blank values rather than storing them', () => {
    // An empty string is a value somebody wrote; an absent field is "the DCL does not say".
    const sparse: CatalogLookup = {
      ...AQARA,
      vendor: { name: 'Aqara', preferredName: null, legalName: null, landingPageUrl: null },
      product: {
        name: 'P2',
        label: null,
        partNumber: '   ',
        deviceTypeId: null,
        productUrl: null,
        supportUrl: '',
        userManualUrl: null,
        commissioningCustomFlow: 0,
        commissioningCustomFlowUrl: null,
        commissioningInstructions: '',
        factoryResetInstructions: null,
      },
    }
    expect(catalogFields(sparse, CHECKED)).toEqual({
      vendorName: 'Aqara',
      productName: 'P2',
      catalogCheckedAt: CHECKED,
      catalogSource: 'found',
    })
  })

  it('trims what it keeps', () => {
    const padded: CatalogLookup = {
      ...AQARA,
      vendor: { name: '  Aqara ', preferredName: null, legalName: null, landingPageUrl: null },
    }
    expect(catalogFields(padded, CHECKED).vendorName).toBe('Aqara')
  })

  it('keeps a URL only when it is https', () => {
    // DCL content is untrusted. A `javascript:` URL rendered as a link runs script on click.
    const hostile: CatalogLookup = {
      ...AQARA,
      product: {
        ...(AQARA.product as NonNullable<CatalogLookup['product']>),
        productUrl: 'javascript:alert(1)',
        supportUrl: 'http://www.aqara.com/support',
        userManualUrl: 'https:/missing-slash',
        commissioningCustomFlowUrl: 'HTTPS://WWW.AQARA.COM/PAIRING',
      },
    }
    const fields = catalogFields(hostile, CHECKED)
    expect(fields).not.toHaveProperty('productUrl')
    expect(fields).not.toHaveProperty('supportUrl')
    expect(fields).not.toHaveProperty('userManualUrl')
    expect(fields.commissioningFlowUrl).toBe('HTTPS://WWW.AQARA.COM/PAIRING')
  })

  it('keeps a found vendor whose model is missing', () => {
    // The shape the API really sends: the vendor is known, the model is not.
    const vendorOnly: CatalogLookup = { ...AQARA, source: 'missing', product: null }
    expect(catalogFields(vendorOnly, CHECKED)).toEqual({
      vendorName: 'Aqara',
      vendorPreferredName: 'Aqara Home',
      catalogCheckedAt: CHECKED,
      catalogSource: 'missing',
    })
  })

  it('records a miss with no names', () => {
    const missing: CatalogLookup = { ...AQARA, source: 'missing', vendor: null, product: null }
    expect(catalogFields(missing, CHECKED)).toEqual({
      catalogCheckedAt: CHECKED,
      catalogSource: 'missing',
    })
  })

  it('names a test vendor "Test vendor", whatever the answer says', () => {
    const test: CatalogLookup = {
      ...AQARA,
      vendorId: 0xfff1,
      source: 'test-vendor',
      vendor: null,
      product: null,
    }
    expect(catalogFields(test, CHECKED)).toEqual({
      vendorName: 'Test vendor',
      catalogCheckedAt: CHECKED,
      catalogSource: 'test-vendor',
    })
  })

  it('drops a device type of zero, which the DCL uses for "not set"', () => {
    const zero: CatalogLookup = {
      ...AQARA,
      product: { ...(AQARA.product as NonNullable<CatalogLookup['product']>), deviceTypeId: 0 },
    }
    expect(catalogFields(zero, CHECKED)).not.toHaveProperty('deviceTypeId')
  })

  it('produces only keys listed in CATALOG_FIELD_KEYS', () => {
    // The list is how merge and backfill replace the block whole; a key missing from it would
    // survive a replacement and outlive the answer it came from.
    for (const key of Object.keys(catalogFields(AQARA, CHECKED))) {
      expect(CATALOG_FIELD_KEYS).toContain(key)
    }
  })
})

describe('isHttpsUrl', () => {
  it.each([
    ['https://example.com', true],
    ['https://example.com/a b', false],
    ['https://', false],
    ['http://example.com', false],
    ['javascript:alert(1)', false],
    ['https://exa\u0001mple.com', false],
    [null, false],
    [undefined, false],
  ])('%s → %s', (value, expected) => {
    expect(isHttpsUrl(value)).toBe(expected)
  })
})

describe('manufacturerName', () => {
  it('prefers the preferred name, then the vendor name', () => {
    expect(manufacturerName({ vendorPreferredName: 'Aqara Home', vendorName: 'Aqara' })).toBe(
      'Aqara Home',
    )
    expect(manufacturerName({ vendorName: 'Aqara' })).toBe('Aqara')
    expect(manufacturerName({})).toBeUndefined()
  })

  // Ruling R27: a synced document may carry an empty name (an older client, or another
  // replica). It must fall back, not hide the field.
  it('treats a blank or whitespace-only name as absent', () => {
    expect(manufacturerName({ vendorPreferredName: '', vendorName: 'Aqara' })).toBe('Aqara')
    expect(manufacturerName({ vendorPreferredName: ' \t ', vendorName: 'Aqara' })).toBe('Aqara')
    expect(manufacturerName({ vendorPreferredName: '', vendorName: '  ' })).toBeUndefined()
    expect(manufacturerName({ vendorName: '' })).toBeUndefined()
  })

  it('leaves the hex fallback to the caller when both names are blank', () => {
    const fallback = '0xFFF1'
    expect(manufacturerName({ vendorPreferredName: ' ', vendorName: '' }) ?? fallback).toBe(
      fallback,
    )
  })
})

describe('needsCatalogLookup', () => {
  const now = new Date('2026-10-07T12:00:00.000Z')
  const LONG_CODE = '749701123365521327687'
  const SHORT_CODE = '34970112332'

  it('asks for a device with a payload that was never checked', () => {
    expect(
      needsCatalogLookup({ payload: 'MT:Y.K9042C00KA0648G00', manualCode: LONG_CODE }, now),
    ).toBe(true)
  })

  it('asks for a device filed from a 21-digit code, which carries the ids', () => {
    expect(needsCatalogLookup({ manualCode: LONG_CODE }, now)).toBe(true)
  })

  it('never asks for an 11-digit code, which carries no ids', () => {
    expect(needsCatalogLookup({ manualCode: SHORT_CODE }, now)).toBe(false)
  })

  it('does not ask again once found', () => {
    expect(
      needsCatalogLookup(
        {
          manualCode: LONG_CODE,
          catalogCheckedAt: '2020-01-01T00:00:00.000Z',
          catalogSource: 'found',
        },
        now,
      ),
    ).toBe(false)
  })

  it('retries a miss after one day, and not before', () => {
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString()
    const miss = (checked: string) =>
      needsCatalogLookup(
        { manualCode: LONG_CODE, catalogCheckedAt: checked, catalogSource: 'missing' },
        now,
      )
    expect(miss(at(CATALOG_MISS_RETRY_MS + 1000))).toBe(true)
    expect(miss(at(CATALOG_MISS_RETRY_MS - 1000))).toBe(false)
  })

  it('treats an unreadable check time on a miss as due', () => {
    expect(
      needsCatalogLookup(
        { manualCode: LONG_CODE, catalogCheckedAt: 'yesterday', catalogSource: 'missing' },
        now,
      ),
    ).toBe(true)
  })

  it('never asks again for a code the API refused', () => {
    expect(
      needsCatalogLookup(
        {
          manualCode: LONG_CODE,
          catalogCheckedAt: '2020-01-01T00:00:00.000Z',
          catalogSource: 'unusable',
        },
        now,
      ),
    ).toBe(false)
  })

  it('does not retry a test vendor', () => {
    expect(
      needsCatalogLookup(
        {
          manualCode: LONG_CODE,
          catalogCheckedAt: '2020-01-01T00:00:00.000Z',
          catalogSource: 'test-vendor',
        },
        now,
      ),
    ).toBe(false)
  })
})

describe('withCatalogBlock', () => {
  it('replaces the whole block and leaves everything else alone', () => {
    const device = {
      name: 'Hall sensor',
      spot: 'door frame',
      vendorName: 'Old',
      supportUrl: 'https://old.example',
      catalogCheckedAt: '2026-01-01T00:00:00.000Z',
      catalogSource: 'missing' as const,
    }
    const result = withCatalogBlock(device, catalogFields(AQARA, CHECKED))
    expect(result.name).toBe('Hall sensor')
    expect(result.spot).toBe('door frame')
    expect(result.vendorName).toBe('Aqara')
    expect(result.supportUrl).toBe('https://www.aqara.com/support')
    expect(result.catalogSource).toBe('found')
  })

  it('removes a field the new block does not have', () => {
    const device = { name: 'Hall sensor', supportUrl: 'https://old.example' }
    const result = withCatalogBlock(device, { catalogCheckedAt: CHECKED, catalogSource: 'missing' })
    expect(result).not.toHaveProperty('supportUrl')
  })

  it('ignores keys of the source that are not catalogue keys', () => {
    const result = withCatalogBlock({ name: 'Mine' }, { name: 'Theirs', catalogSource: 'found' })
    expect(result.name).toBe('Mine')
  })

  it('does not mutate its inputs', () => {
    const device = { name: 'Hall sensor', vendorName: 'Old' }
    withCatalogBlock(device, catalogFields(AQARA, CHECKED))
    expect(device).toEqual({ name: 'Hall sensor', vendorName: 'Old' })
  })
})

describe('catalogNames', () => {
  const PRODUCT_ONLY = {
    name: 'x',
    label: null,
    partNumber: null,
    deviceTypeId: null,
    productUrl: null,
    supportUrl: null,
    userManualUrl: null,
    commissioningCustomFlow: 0,
    commissioningCustomFlowUrl: null,
    commissioningInstructions: null,
    factoryResetInstructions: null,
  }

  it('gives the preferred manufacturer name and the product name', () => {
    expect(catalogNames(AQARA)).toEqual({
      manufacturer: 'Aqara Home',
      product: 'Aqara Door and Window Sensor P2',
    })
  })

  it('falls back to the vendor name when there is no preferred one', () => {
    const lookup = {
      ...AQARA,
      vendor: { name: 'Aqara', preferredName: '  ', legalName: null, landingPageUrl: null },
    }
    expect(catalogNames(lookup).manufacturer).toBe('Aqara')
  })

  it('omits blank names instead of returning empty strings', () => {
    const lookup = {
      ...AQARA,
      vendor: { name: '', preferredName: '', legalName: null, landingPageUrl: null },
      product: { ...PRODUCT_ONLY, name: ' ' },
    }
    expect(catalogNames(lookup)).toEqual({})
  })

  it('is empty for a miss', () => {
    expect(
      catalogNames({
        vendorId: 1,
        productId: 2,
        source: 'missing',
        vendor: null,
        product: null,
        fetchedAt: CHECKED,
        stale: false,
      }),
    ).toEqual({})
  })

  it('names a test vendor the way the saved device will', () => {
    const lookup: CatalogLookup = {
      vendorId: 0xfff1,
      productId: 1,
      source: 'test-vendor',
      vendor: {
        name: 'Server spelling',
        preferredName: null,
        legalName: null,
        landingPageUrl: null,
      },
      product: null,
      fetchedAt: CHECKED,
      stale: false,
    }
    expect(catalogNames(lookup)).toEqual({ manufacturer: 'Test vendor' })
  })

  it('agrees with catalogFields for the same answer', () => {
    const fields = catalogFields(AQARA, CHECKED)
    expect(catalogNames(AQARA)).toEqual({
      manufacturer: manufacturerName(fields),
      product: fields.productName,
    })
  })
})
