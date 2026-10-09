import { beforeEach, describe, expect, it } from 'vitest'
import {
  BY_FETCHED_VIEW,
  CATALOG_DB,
  CATALOG_DESIGN,
  catalogStore,
  ensureCatalogDatabase,
  forgetCatalogDatabase,
  type VendorEntry,
  withoutCreator,
} from '../../src/catalog/store.js'
import { fakeCouch, operations } from '../support/couch.js'
import { AQARA_VENDOR } from '../support/dcl.js'

beforeEach(() => forgetCatalogDatabase())

/** A found Aqara vendor entry, as the lookup writes one. */
const aqara = (fields: Partial<VendorEntry> = {}): VendorEntry => ({
  _id: 'vendor:4447',
  type: 'vendor',
  vid: 4447,
  status: 'found',
  fetchedAt: '2026-10-05T16:20:00.000Z',
  network: 'mainnet',
  dcl: withoutCreator(AQARA_VENDOR.vendorInfo),
  ...fields,
})

describe('ensureCatalogDatabase', () => {
  it('creates the database and makes it admin-only before installing anything', async () => {
    const fake = fakeCouch()
    await ensureCatalogDatabase(fake.couch)

    expect(operations(fake).slice(0, 2)).toEqual(['createDb', 'putSecurity'])
    expect(fake.security.get(CATALOG_DB)).toEqual({
      admins: { names: [], roles: ['_admin'] },
      members: { names: [], roles: ['_admin'] },
    })
  })

  it('installs the by_fetched view', async () => {
    const fake = fakeCouch()
    await ensureCatalogDatabase(fake.couch)

    const design = fake.documents.get(`${CATALOG_DB}/_design/${CATALOG_DESIGN}`) as
      | { views: Record<string, { map: string }> }
      | undefined
    expect(design?.views[BY_FETCHED_VIEW]?.map).toContain('emit(doc.fetchedAt')
  })

  it('does the work once per process, even when two lookups arrive together', async () => {
    const fake = fakeCouch()
    await Promise.all([ensureCatalogDatabase(fake.couch), ensureCatalogDatabase(fake.couch)])
    const after = fake.calls.length
    await ensureCatalogDatabase(fake.couch)

    expect(operations(fake).filter((operation) => operation === 'createDb')).toHaveLength(1)
    expect(fake.calls.length).toBe(after)
  })

  it('is not bothered by a database another process already created', async () => {
    const fake = fakeCouch({ databases: [CATALOG_DB] })
    await expect(ensureCatalogDatabase(fake.couch)).resolves.toBeUndefined()
  })
})

describe('catalogStore', () => {
  it('writes an entry under its decimal ID and reads it back', async () => {
    const fake = fakeCouch()
    const store = catalogStore(fake.couch)
    await store.write(aqara())

    expect(await store.readVendor(4447)).toMatchObject({ _id: 'vendor:4447', status: 'found' })
    expect(await store.readVendor(4448)).toBeUndefined()
  })

  it('reads model entries by vendor and product', async () => {
    const fake = fakeCouch({
      seed: {
        [`${CATALOG_DB}/model:4447:8194`]: { _id: 'model:4447:8194', _rev: '1-a', type: 'model' },
      },
    })
    expect(await catalogStore(fake.couch).readModel(4447, 8194)).toMatchObject({ type: 'model' })
  })

  it('ignores a conflict: another request stored the same answer first', async () => {
    const fake = fakeCouch({
      seed: { [`${CATALOG_DB}/vendor:4447`]: { ...aqara(), _rev: '1-a' } },
    })
    // No `_rev`: this writer read before the other one wrote.
    await expect(catalogStore(fake.couch).write(aqara())).resolves.toBeUndefined()
  })

  it('throws any other write failure', async () => {
    // Setup is remembered per process, so running it against a healthy CouchDB first means the
    // failure below is the entry's write and not the design document's.
    await ensureCatalogDatabase(fakeCouch().couch)
    const fake = fakeCouch({ fails: { putDoc: CATALOG_DB } })
    await expect(catalogStore(fake.couch).write(aqara())).rejects.toThrow('write vendor:4447')
  })

  it('drops the ledger account from the stored record', () => {
    expect(withoutCreator(AQARA_VENDOR.vendorInfo)).not.toHaveProperty('creator')
    expect(withoutCreator(AQARA_VENDOR.vendorInfo)).toHaveProperty('vendorName', 'Aqara')
  })
})
