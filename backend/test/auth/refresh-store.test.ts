import { beforeEach, describe, expect, it } from 'vitest'
import { hashJti, refreshStore } from '../../src/auth/refresh-store.js'
import { forgetUsersDatabase } from '../../src/users/database.js'
import { userRecords } from '../../src/users/records.js'
import { fakeCouch } from '../support/couch.js'

const ADA = { email: 'ada@example.com', sub: 'google|1' }
const entry = (hash: string, exp = 1000) => ({ hash, exp, createdAt: 0 })

beforeEach(() => forgetUsersDatabase())

describe('refreshStore', () => {
  it('hashes a jti as lowercase sha256 hex', () => {
    expect(hashJti('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('keeps a record-less user’s entry in memory', async () => {
    const { couch } = fakeCouch()
    const store = refreshStore(userRecords(couch), () => 0)
    await store.remember(ADA.email, entry('h'))
    expect(await store.isLive(ADA.email, 'h')).toBe(true)
  })

  it('puts the entry on the record when there is one', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    await records.ensure(ADA)
    await refreshStore(records, () => 0).remember(ADA.email, entry('h'))
    expect(await records.hasRefresh(ADA.email, 'h', 0)).toBe(true)
  })

  it('forgets every in-memory entry when the process restarts', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    await refreshStore(records, () => 0).remember(ADA.email, entry('h'))
    // A new store is what a restart produces.
    expect(await refreshStore(records, () => 0).isLive(ADA.email, 'h')).toBe(false)
  })

  it('refuses an expired in-memory entry', async () => {
    let t = 0
    const { couch } = fakeCouch()
    const store = refreshStore(userRecords(couch), () => t)
    await store.remember(ADA.email, entry('h', 10))
    t = 10
    expect(await store.isLive(ADA.email, 'h')).toBe(false)
  })

  it('revokes from wherever the entry lives', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    const store = refreshStore(records, () => 0)
    await store.remember(ADA.email, entry('mem'))
    await store.revoke(ADA.email, 'mem')
    expect(await store.isLive(ADA.email, 'mem')).toBe(false)

    await records.ensure(ADA, [entry('rec')])
    await store.revoke(ADA.email, 'rec')
    expect(await store.isLive(ADA.email, 'rec')).toBe(false)
  })

  it('drains the memory entries for one address', async () => {
    const { couch } = fakeCouch()
    const store = refreshStore(userRecords(couch), () => 0)
    await store.remember(ADA.email, entry('a'))
    await store.remember('bob@example.com', entry('b'))
    expect(store.drain(' ADA@example.com').map((e) => e.hash)).toEqual(['a'])
    expect(await store.isLive(ADA.email, 'a')).toBe(false)
    expect(await store.isLive('bob@example.com', 'b')).toBe(true)
  })
})
