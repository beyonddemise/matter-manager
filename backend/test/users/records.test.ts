import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CouchError } from '../../src/couch/client.js'
import { forgetUsersDatabase, USERS_DB } from '../../src/users/database.js'
import { userDocId } from '../../src/users/key.js'
import { planOf, profileOf, userRecords } from '../../src/users/records.js'
import { fakeCouch } from '../support/couch.js'

const ADA = { email: 'ada@example.com', sub: 'google|1', name: 'Ada' }
const at = (email: string) => `${USERS_DB}/${userDocId(email)}`

beforeEach(() => forgetUsersDatabase())

describe('userRecords', () => {
  it('reads nothing for an address that has no record', async () => {
    const { couch } = fakeCouch()
    expect(await userRecords(couch).read('nobody@example.com')).toBeUndefined()
  })

  it('creates a record on ensure, with sub, address and display name', async () => {
    const { couch, documents } = fakeCouch()
    await userRecords(couch).ensure(ADA)
    expect(documents.get(at(ADA.email))).toMatchObject({
      type: 'user',
      sub: 'google|1',
      email: 'ada@example.com',
      displayName: 'Ada',
    })
  })

  it('finds the record however the address was typed', async () => {
    const { couch } = fakeCouch()
    await userRecords(couch).ensure(ADA)
    expect(await userRecords(couch).read(' ADA@example.com ')).toBeDefined()
  })

  it('fills in the subject of a record an operator created by address', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    await records.setPlan(ADA.email, 'pro')
    const filled = await records.ensure(ADA)
    expect(filled).toMatchObject({ sub: 'google|1', plan: 'pro' })
  })

  it('never takes roles, plan or refresh tokens from an update', async () => {
    const { couch, documents } = fakeCouch()
    const records = userRecords(couch)
    await records.ensure(ADA)
    await records.update(ADA.email, {
      locale: 'de',
      roles: ['customerservice'],
      plan: 'pro',
      refreshTokens: [{ hash: 'x', exp: 9, createdAt: 1 }],
    } as never)
    const stored = documents.get(at(ADA.email))
    expect(stored).toMatchObject({ locale: 'de' })
    expect(stored).not.toHaveProperty('roles')
    expect(stored).not.toHaveProperty('plan')
    expect(stored).not.toHaveProperty('refreshTokens')
  })

  it('adopts refresh entries handed to ensure', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    await records.ensure(ADA, [{ hash: 'h1', exp: 100, createdAt: 1 }])
    expect(await records.hasRefresh(ADA.email, 'h1', 50)).toBe(true)
  })

  it('answers undefined, not false, for refresh checks without a record', async () => {
    const { couch } = fakeCouch()
    expect(await userRecords(couch).hasRefresh(ADA.email, 'h', 0)).toBeUndefined()
    expect(
      await userRecords(couch).addRefresh(ADA.email, { hash: 'h', exp: 1, createdAt: 0 }),
    ).toBe(false)
  })

  it('treats an expired refresh entry as absent', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    await records.ensure(ADA, [{ hash: 'h1', exp: 100, createdAt: 1 }])
    expect(await records.hasRefresh(ADA.email, 'h1', 100)).toBe(false)
  })

  it('removes one refresh entry and keeps the others', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    await records.ensure(ADA, [
      { hash: 'phone', exp: 100, createdAt: 1 },
      { hash: 'laptop', exp: 100, createdAt: 1 },
    ])
    await records.removeRefresh(ADA.email, 'phone')
    expect(await records.hasRefresh(ADA.email, 'phone', 0)).toBe(false)
    expect(await records.hasRefresh(ADA.email, 'laptop', 0)).toBe(true)
  })

  it('retries a write that lost a race, so two devices refreshing at once both stay signed in', async () => {
    const fake = fakeCouch()
    const records = userRecords(fake.couch)
    await records.ensure(ADA)
    const original = fake.couch.putDoc.bind(fake.couch)
    let first = true
    vi.spyOn(fake.couch, 'putDoc').mockImplementation(async (db, doc) => {
      if (first && db === USERS_DB) {
        first = false
        throw new CouchError(409, 'conflict', 'raced')
      }
      return original(db, doc)
    })
    expect(await records.addRefresh(ADA.email, { hash: 'h', exp: 9, createdAt: 1 })).toBe(true)
    expect(await records.hasRefresh(ADA.email, 'h', 0)).toBe(true)
  })

  it('reads a record by subject through the view', async () => {
    const fake = fakeCouch()
    const records = userRecords(fake.couch)
    await records.ensure(ADA)
    // The fake ignores view parameters, so the key is asserted on the call: the real client
    // JSON-encodes it, and a pre-encoded key would arrive double-quoted.
    const view = vi.spyOn(fake.couch, 'view')
    fake.rows = [{ id: userDocId(ADA.email), key: ADA.sub, value: null }]
    expect((await records.readBySub(ADA.sub))?.email).toBe(ADA.email)
    expect(view).toHaveBeenCalledWith(USERS_DB, 'by_sub', 'by_sub', { key: 'google|1' })
  })
})

describe('planOf and profileOf', () => {
  it('reads free without a record', () => {
    expect(planOf(undefined)).toBe('free')
  })

  it('reads free for an unknown plan, and reports it', () => {
    const report = vi.fn()
    const record = { _id: 'u', type: 'user', email: 'a@b.c', plan: 'Pro' } as const
    expect(planOf(record, report)).toBe('free')
    expect(report).toHaveBeenCalledWith({ email: 'a@b.c', plan: 'Pro' })
  })

  it('does not report an absent plan, which is the ordinary case', () => {
    const report = vi.fn()
    planOf({ _id: 'u', type: 'user', email: 'a@b.c' }, report)
    expect(report).not.toHaveBeenCalled()
  })

  it('builds a profile from the token claims when there is no record', () => {
    expect(profileOf(undefined, { sub: 's', email: 'a@b.c', name: 'A' })).toEqual({
      sub: 's',
      email: 'a@b.c',
      displayName: 'A',
      locale: 'auto',
      plan: 'free',
      projectLimit: 1,
    })
  })

  it('reports an unknown plan to stderr when nobody wires another reporter', () => {
    // The default, asserted rather than assumed: a no-op default is the silence the warning
    // exists to end, and production runs the default.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      planOf({ _id: 'u', type: 'user', email: 'a@b.c', plan: 'Pro' })

      expect(warn).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        level: 'warn',
        email: 'a@b.c',
        plan: 'Pro',
      })
    } finally {
      warn.mockRestore()
    }
  })
})
