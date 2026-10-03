import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshStore } from '../../src/auth/refresh-store.js'
import { CouchError } from '../../src/couch/client.js'
import { forgetUsersDatabase, USERS_DB } from '../../src/users/database.js'
import { recordEnsurer } from '../../src/users/ensure.js'
import { userDocId } from '../../src/users/key.js'
import { userRecords } from '../../src/users/records.js'
import { fakeCouch } from '../support/couch.js'

const ADA = { email: 'ada@example.com', sub: 'google|1' }

beforeEach(() => forgetUsersDatabase())

describe('recordEnsurer', () => {
  it('moves in-memory refresh entries onto the new record, so creating it signs nobody out', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    const refresh = refreshStore(records, () => 0)
    await refresh.remember(ADA.email, { hash: 'h', exp: 99, createdAt: 0 })

    await recordEnsurer(records, refresh)(ADA)

    expect(await records.hasRefresh(ADA.email, 'h', 0)).toBe(true)
    expect(await refresh.isLive(ADA.email, 'h')).toBe(true)
  })

  it('keeps the entries in memory, and surfaces the original error, when CouchDB is down', async () => {
    // Not a mock of `records.ensure`: the real store fails on the real `matter_manager` reads, as
    // an outage does. The old drain-then-restore code failed a second time while restoring (the
    // restore writes to CouchDB too), lost every entry after the first and replaced this error.
    const fails: { getDoc?: string } = {}
    const { couch } = fakeCouch({ fails })
    const records = userRecords(couch)
    const refresh = refreshStore(records, () => 0)
    await refresh.remember(ADA.email, { hash: 'a', exp: 99, createdAt: 0 })
    await refresh.remember(ADA.email, { hash: 'b', exp: 99, createdAt: 0 })
    fails.getDoc = USERS_DB

    await expect(recordEnsurer(records, refresh)(ADA)).rejects.toMatchObject({
      message: `read ${userDocId(ADA.email)}`,
    })

    delete fails.getDoc
    expect(await refresh.isLive(ADA.email, 'a')).toBe(true)
    expect(await refresh.isLive(ADA.email, 'b')).toBe(true)
  })

  it('keeps the entries when only the write fails', async () => {
    const fails: { putDoc?: string } = {}
    const { couch } = fakeCouch({ fails })
    const records = userRecords(couch)
    const refresh = refreshStore(records, () => 0)
    await refresh.remember(ADA.email, { hash: 'a', exp: 99, createdAt: 0 })
    fails.putDoc = USERS_DB

    await expect(recordEnsurer(records, refresh)(ADA)).rejects.toBeInstanceOf(CouchError)
    expect(await refresh.isLive(ADA.email, 'a')).toBe(true)
  })

  it('never lets a hash look revoked while the record is being written', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    const refresh = refreshStore(records, () => 0)
    await refresh.remember(ADA.email, { hash: 'h', exp: 99, createdAt: 0 })
    const original = couch.putDoc.bind(couch)
    const during: boolean[] = []
    vi.spyOn(couch, 'putDoc').mockImplementation(async (db, doc) => {
      // Mid-write: memory must still hold the hash, because the record does not yet.
      during.push(await refresh.isLive(ADA.email, 'h'))
      return original(db, doc)
    })

    await recordEnsurer(records, refresh)(ADA)

    expect(during).toEqual([true])
    expect(await refresh.isLive(ADA.email, 'h')).toBe(true)
  })
})
