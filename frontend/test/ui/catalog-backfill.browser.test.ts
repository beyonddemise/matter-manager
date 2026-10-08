import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repository } from '../../src/data/index.js'
import type { DeviceDocument, Unsaved } from '../../src/domain/index.js'
import type { LookupOutcome } from '../../src/ui/catalog.js'
import {
  abortableDelay,
  BACKFILL_GAP_MS,
  type BackfillDependencies,
  catalogBackfill,
} from '../../src/ui/catalog-backfill.js'
import { browserDatabase, type TestDatabase } from './support/browser-database.js'
import { AQARA_LOOKUP, deferred, fakeCatalog } from './support/catalog.js'

const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const LONG_CODE = '749701123365521327687'
const SHORT_CODE = '34970112332'
const NOW = new Date('2026-10-07T12:00:00.000Z')

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
})

afterEach(async () => {
  await database.destroy()
})

const device = (id: string, extra: Partial<DeviceDocument> = {}): Unsaved<DeviceDocument> => ({
  _id: `device:${id}`,
  type: 'device',
  name: `Device ${id}`,
  roomId: 'room:hall',
  manualCode: LONG_CODE,
  payload: PAYLOAD,
  spot: 'door frame',
  serial: 'SN-1',
  installedAt: '2026-10-01',
  addedAt: '2026-10-01T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

/** The runner with a fake API, the test database, and a wait that only records. */
function runner(
  answer: (code: string) => Promise<LookupOutcome>,
  overrides: Partial<BackfillDependencies> = {},
) {
  const { api, calls } = fakeCatalog(answer)
  const waits: number[] = []
  const backfill = catalogBackfill({
    lookup: api.lookup,
    devices: () => database.repositories.devices,
    editable: () => true,
    now: () => NOW,
    wait: async (ms) => {
      waits.push(ms)
    },
    ...overrides,
  })
  return { backfill, calls, waits }
}

const found = (): Promise<LookupOutcome> => Promise.resolve({ kind: 'found', lookup: AQARA_LOOKUP })

describe('catalogue backfill', () => {
  it('writes the block once, then skips the device', async () => {
    await database.repositories.devices.save(device('a'))
    const { backfill, calls } = runner(found)

    backfill.trigger()
    await backfill.idle()
    backfill.trigger()
    await backfill.idle()

    expect(calls).toHaveLength(1)
    const stored = await database.repositories.devices.get('device:a')
    expect(stored?.vendorName).toBe('Aqara')
    expect(stored?.catalogCheckedAt).toBe(NOW.toISOString())
  })

  it('never touches what the user entered', async () => {
    await database.repositories.devices.save(
      device('a', {
        remarks: [
          {
            id: 'r1',
            text: 'Battery replaced',
            authorSub: 's',
            authorName: 'S',
            createdAt: '2026-10-02T00:00:00.000Z',
          },
        ],
      }),
    )
    const before = await database.repositories.devices.get('device:a')
    const { backfill } = runner(found)

    backfill.trigger()
    await backfill.idle()

    const after = await database.repositories.devices.get('device:a')
    for (const key of [
      'name',
      'roomId',
      'spot',
      'serial',
      'installedAt',
      'addedAt',
      'disabled',
      'remarks',
      'manualCode',
      'payload',
    ] as const) {
      expect(after?.[key]).toEqual(before?.[key])
    }
  })

  it('asks for a 21-digit code by its digits, and never for an 11-digit one', async () => {
    const { payload: _payload, ...manualOnly } = device('long')
    await database.repositories.devices.save(manualOnly)
    const { payload: _p, ...short } = device('short', { manualCode: SHORT_CODE })
    await database.repositories.devices.save(short)
    const { backfill, calls } = runner(found)

    backfill.trigger()
    await backfill.idle()

    expect(calls.map((call) => call.code)).toEqual([LONG_CODE])
  })

  it('does nothing in a project that cannot be edited', async () => {
    await database.repositories.devices.save(device('a'))
    const { backfill, calls } = runner(found, { editable: () => false })

    backfill.trigger()
    await backfill.idle()

    expect(calls).toHaveLength(0)
    expect((await database.repositories.devices.get('device:a'))?.catalogCheckedAt).toBeUndefined()
  })

  it('stops at the first network failure and writes nothing', async () => {
    await database.repositories.devices.save(device('a'))
    await database.repositories.devices.save(device('b'))
    const { backfill, calls } = runner(() => Promise.resolve({ kind: 'unavailable' }))

    backfill.trigger()
    await backfill.idle()

    expect(calls).toHaveLength(1)
    const all = await database.repositories.devices.list()
    expect(all.every((d) => d.catalogCheckedAt === undefined)).toBe(true)
  })

  it('stops when signed out', async () => {
    await database.repositories.devices.save(device('a'))
    await database.repositories.devices.save(device('b'))
    const { backfill, calls } = runner(() => Promise.resolve({ kind: 'signed-out' }))
    backfill.trigger()
    await backfill.idle()
    expect(calls).toHaveLength(1)
  })

  it('leaves one second between requests', async () => {
    for (const id of ['a', 'b', 'c']) await database.repositories.devices.save(device(id))
    const { backfill, waits } = runner(found)
    backfill.trigger()
    await backfill.idle()
    expect(waits).toEqual([BACKFILL_GAP_MS, BACKFILL_GAP_MS])
  })

  it('waits for retry-after on 429, then asks the same device again', async () => {
    await database.repositories.devices.save(device('a'))
    let first = true
    const { backfill, calls, waits } = runner(() => {
      if (first) {
        first = false
        return Promise.resolve({ kind: 'rate-limited', retryAfterSeconds: 17 })
      }
      return found()
    })

    backfill.trigger()
    await backfill.idle()

    expect(waits).toEqual([17_000])
    expect(calls.map((call) => call.code)).toEqual([PAYLOAD, PAYLOAD])
    expect((await database.repositories.devices.get('device:a'))?.catalogSource).toBe('found')
  })

  it('retries a miss after a day, and not before', async () => {
    const day = 24 * 60 * 60 * 1000
    await database.repositories.devices.save(
      device('old', {
        catalogSource: 'missing',
        catalogCheckedAt: new Date(NOW.getTime() - day - 60_000).toISOString(),
      }),
    )
    await database.repositories.devices.save(
      device('fresh', {
        catalogSource: 'missing',
        catalogCheckedAt: new Date(NOW.getTime() - day + 60_000).toISOString(),
      }),
    )
    const { backfill, calls } = runner(found)
    backfill.trigger()
    await backfill.idle()
    expect(calls).toHaveLength(1)
    expect((await database.repositories.devices.get('device:old'))?.catalogSource).toBe('found')
  })

  it('writes nothing after stop, even when the answer was already on its way', async () => {
    // A project switch or a sign-out mid-run: the answer belongs to a project nobody is in.
    await database.repositories.devices.save(device('a'))
    const answer = deferred<LookupOutcome>()
    const { backfill, calls } = runner(() => answer.promise)

    backfill.trigger()
    while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    backfill.stop()
    answer.resolve({ kind: 'found', lookup: AQARA_LOOKUP })
    await backfill.idle()

    expect(calls[0]?.signal?.aborted).toBe(true)
    expect((await database.repositories.devices.get('device:a'))?.catalogCheckedAt).toBeUndefined()
  })

  it('keeps a concurrent user edit, and fills the block on the next run', async () => {
    await database.repositories.devices.save(device('a'))
    const real = database.repositories.devices
    let raced = false
    // The user renames the device between backfill reading it and writing it: the write is
    // refused (409), and must neither throw nor overwrite the rename.
    const racing: Repository<DeviceDocument> = {
      ...real,
      get: async (id) => {
        const read = await real.get(id)
        if (!raced && read !== undefined) {
          raced = true
          const { updatedAt: _stamp, ...unsaved } = read
          await real.save({ ...unsaved, name: 'Renamed by hand' })
        }
        return read
      },
    }
    const { backfill } = runner(found, { devices: () => racing })

    backfill.trigger()
    await backfill.idle()
    expect((await real.get('device:a'))?.name).toBe('Renamed by hand')
    expect((await real.get('device:a'))?.catalogCheckedAt).toBeUndefined()

    backfill.trigger()
    await backfill.idle()
    const after = await real.get('device:a')
    expect(after?.name).toBe('Renamed by hand')
    expect(after?.vendorName).toBe('Aqara')
  })

  it('marks a code the API cannot read once, and never sends it again', async () => {
    await database.repositories.devices.save(device('a'))
    const { backfill, calls } = runner(() => Promise.resolve({ kind: 'unusable' }))

    backfill.trigger()
    await backfill.idle()
    const marked = await database.repositories.devices.get('device:a')
    expect(marked?.catalogSource).toBe('unusable')
    expect(marked?.catalogCheckedAt).toBe(NOW.toISOString())
    expect(marked?.vendorName).toBeUndefined()
    expect(marked?.name).toBe('Device a')

    backfill.trigger()
    await backfill.idle()
    expect(calls).toHaveLength(1)
  })

  it('ends the pass on a save error that is not a conflict, and leaves later devices alone', async () => {
    await database.repositories.devices.save(device('a'))
    await database.repositories.devices.save(device('b'))
    const real = database.repositories.devices
    const failing: Repository<DeviceDocument> = {
      ...real,
      save: () => Promise.reject(Object.assign(new Error('quota'), { status: 500 })),
    }
    const { backfill, calls } = runner(found, { devices: () => failing })

    backfill.trigger()
    await backfill.idle()

    expect(calls).toHaveLength(1)
    const all = await real.list()
    expect(all.every((d) => d.catalogCheckedAt === undefined)).toBe(true)
  })

  it('runs again once when triggered while running, never twice at once', async () => {
    await database.repositories.devices.save(device('a'))
    const answer = deferred<LookupOutcome>()
    let active = 0
    let most = 0
    const { backfill, calls } = runner(async () => {
      active += 1
      most = Math.max(most, active)
      const outcome = await answer.promise
      active -= 1
      return outcome
    })

    backfill.trigger()
    backfill.trigger()
    backfill.trigger()
    answer.resolve({ kind: 'unavailable' })
    await backfill.idle()

    expect(most).toBe(1)
    expect(calls).toHaveLength(2)
  })
})

describe('abortableDelay', () => {
  it('resolves early when aborted', async () => {
    const controller = new AbortController()
    const started = performance.now()
    const waiting = abortableDelay(10_000, controller.signal)
    controller.abort()
    await waiting
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('resolves at once for a signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const started = performance.now()
    await expect(abortableDelay(10_000, controller.signal)).resolves.toBeUndefined()
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
