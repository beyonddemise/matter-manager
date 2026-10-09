import { beforeEach, describe, expect, it } from 'vitest'
import { dclClient, MAINNET_URL } from '../../src/catalog/dcl.js'
import { type LookupDependencies, lookupEntries } from '../../src/catalog/lookup.js'
import { CATALOG_DB, catalogStore, forgetCatalogDatabase } from '../../src/catalog/store.js'
import { type CouchFailures, fakeCouch } from '../support/couch.js'
import { AQARA_ROUTES, AQARA_VENDOR, fakeDcl, type Recorded } from '../support/dcl.js'

beforeEach(() => forgetCatalogDatabase())

const NOW = new Date('2026-10-05T16:20:00.000Z')
const AQARA = { vendorId: 4447, productId: 8194 }
const DAY_MS = 86_400_000

/** A lookup over a fake CouchDB and a fake DCL, with the warnings it logged. */
function setup(
  options: {
    routes?: Readonly<Record<string, Recorded | Error>>
    seed?: Record<string, Record<string, unknown>>
    couchFails?: CouchFailures
    now?: Date
  } = {},
) {
  const couch = fakeCouch({
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.couchFails === undefined ? {} : { fails: options.couchFails }),
  })
  const dcl = fakeDcl(options.routes ?? AQARA_ROUTES)
  const warnings: string[] = []
  const deps: LookupDependencies = {
    store: catalogStore(couch.couch),
    dcl: dclClient(MAINNET_URL, dcl.fetch),
    now: () => options.now ?? NOW,
    warn: (_context, message) => {
      warnings.push(message)
    },
  }
  return { couch, dcl, deps, warnings }
}

/** A stored entry, `ageMs` old at {@link NOW}. */
const stored = (id: string, status: 'found' | 'missing', ageMs: number, extra = {}) => ({
  [`${CATALOG_DB}/${id}`]: {
    _id: id,
    _rev: '1-a',
    status,
    fetchedAt: new Date(NOW.getTime() - ageMs).toISOString(),
    network: 'mainnet',
    ...extra,
  },
})
const cachedAqara = (ageMs: number) => ({
  ...stored('vendor:4447', 'found', ageMs, {
    type: 'vendor',
    vid: 4447,
    dcl: { vendorID: 4447, vendorName: 'Aqara (cached)' },
  }),
  ...stored('model:4447:8194', 'found', ageMs, {
    type: 'model',
    vid: 4447,
    pid: 8194,
    dcl: { vid: 4447, pid: 8194, productName: 'P2 (cached)' },
  }),
})

describe('lookupEntries with nothing cached', () => {
  it('asks the DCL for both, stores both, and answers fresh', async () => {
    const { couch, dcl, deps } = setup()
    const result = await lookupEntries(AQARA, deps)

    expect(dcl.requests.sort()).toEqual(['/model/models/4447/8194', '/vendorinfo/vendors/4447'])
    expect(result?.stale).toBe(false)
    expect(result?.vendor).toMatchObject({ status: 'found', fetchedAt: NOW.toISOString() })
    expect(couch.documents.get(`${CATALOG_DB}/vendor:4447`)).toMatchObject({ status: 'found' })
    expect(couch.documents.get(`${CATALOG_DB}/model:4447:8194`)).toMatchObject({
      status: 'found',
      network: 'mainnet',
    })
    expect(couch.documents.get(`${CATALOG_DB}/model:4447:8194`)).not.toHaveProperty('dcl.creator')
  })

  it('does not store the vendor record creator either', async () => {
    const { couch, deps } = setup()
    await lookupEntries(AQARA, deps)

    // The positive control: the DCL did send a creator, so its absence is the store's doing.
    expect(AQARA_VENDOR.vendorInfo.creator).toBeTruthy()
    expect(couch.documents.get(`${CATALOG_DB}/vendor:4447`)).toMatchObject({ status: 'found' })
    expect(couch.documents.get(`${CATALOG_DB}/vendor:4447`)).not.toHaveProperty('dcl.creator')
  })

  it('stores a miss for a model the DCL does not have, with the vendor still found', async () => {
    const { couch, deps } = setup()
    const result = await lookupEntries({ vendorId: 4447, productId: 9999 }, deps)

    expect(result?.vendor.status).toBe('found')
    expect(result?.model.status).toBe('missing')
    expect(couch.documents.get(`${CATALOG_DB}/model:4447:9999`)).toMatchObject({
      status: 'missing',
    })
  })

  it('answers undefined when the DCL is down, so the route can say 503', async () => {
    const { deps, warnings } = setup({
      routes: { '/vendorinfo/vendors/4447': new TypeError('fetch failed') },
    })
    expect(await lookupEntries(AQARA, deps)).toBeUndefined()
    expect(warnings).toContain('DCL unavailable')
  })

  it('handles two first lookups racing for the same product', async () => {
    // Both read "absent", both fetch, both write; the second write is a 409 and is ignored.
    const { couch, dcl, deps, warnings } = setup()
    const [first, second] = await Promise.all([
      lookupEntries(AQARA, deps),
      lookupEntries(AQARA, deps),
    ])
    expect(first?.vendor.status).toBe('found')
    expect(second?.vendor.status).toBe('found')
    expect(dcl.requests).toHaveLength(4)
    // A lost race is normal, not a degraded step: nothing is logged for it.
    expect(warnings).toEqual([])
    expect(couch.documents.get(`${CATALOG_DB}/vendor:4447`)).toMatchObject({ _rev: '1-a' })
  })
})

describe('lookupEntries with a cache', () => {
  it('answers a fresh cache hit without asking the DCL', async () => {
    const { dcl, deps } = setup({ seed: cachedAqara(DAY_MS) })
    const result = await lookupEntries(AQARA, deps)

    expect(dcl.requests).toEqual([])
    expect(result?.vendor.dcl?.vendorName).toBe('Aqara (cached)')
  })

  it('refreshes an entry past 90 days, replacing it with its revision', async () => {
    const { couch, dcl, deps } = setup({ seed: cachedAqara(91 * DAY_MS) })
    const result = await lookupEntries(AQARA, deps)

    expect(dcl.requests).toHaveLength(2)
    expect(result?.vendor.dcl?.vendorName).toBe('Aqara')
    expect(couch.documents.get(`${CATALOG_DB}/vendor:4447`)).toMatchObject({
      _rev: '2-a',
      fetchedAt: NOW.toISOString(),
    })
  })

  it('serves an old entry as stale when the DCL is down', async () => {
    const { dcl, deps } = setup({
      seed: cachedAqara(91 * DAY_MS),
      routes: {
        '/vendorinfo/vendors/4447': new TypeError('fetch failed'),
        '/model/models/4447/8194': { status: 502, body: 'Bad gateway' },
      },
    })
    const result = await lookupEntries(AQARA, deps)

    expect(dcl.requests).toHaveLength(2)
    expect(result?.stale).toBe(true)
    expect(result?.model.dcl?.productName).toBe('P2 (cached)')
  })

  it('retries a miss after a day', async () => {
    const seed = {
      ...cachedAqara(DAY_MS),
      ...stored('model:4447:8194', 'missing', DAY_MS + 1000, {
        type: 'model',
        vid: 4447,
        pid: 8194,
      }),
    }
    const { dcl, deps } = setup({ seed })
    const result = await lookupEntries(AQARA, deps)

    expect(dcl.requests).toEqual(['/model/models/4447/8194'])
    expect(result?.model.status).toBe('found')
  })
})

describe('lookupEntries when CouchDB misbehaves', () => {
  it('answers from the DCL when the cache cannot be read', async () => {
    const { deps, warnings } = setup({ couchFails: { getDoc: CATALOG_DB } })
    const result = await lookupEntries(AQARA, deps)

    expect(result?.vendor.status).toBe('found')
    expect(warnings).toContain('catalogue cache unreadable; asking the DCL')
  })

  it('answers from the DCL when the cache cannot be written', async () => {
    const { deps, warnings } = setup({ couchFails: { putDoc: CATALOG_DB } })
    const result = await lookupEntries(AQARA, deps)

    expect(result?.model.status).toBe('found')
    // A failing put also fails the database setup every read starts with, so each entry reports
    // its unreadable cache first and then its unwritable one: the exact words an operator greps.
    expect([...warnings].sort()).toEqual([
      'catalogue cache unreadable; asking the DCL',
      'catalogue cache unreadable; asking the DCL',
      'catalogue cache unwritable; answering anyway',
      'catalogue cache unwritable; answering anyway',
    ])
  })
})
