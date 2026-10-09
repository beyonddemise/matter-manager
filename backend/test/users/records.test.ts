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
    expect(await userRecords(couch, () => 0).read('nobody@example.com')).toBeUndefined()
  })

  it('creates a record on ensure, with sub, address and display name', async () => {
    const { couch, documents } = fakeCouch()
    await userRecords(couch, () => 0).ensure(ADA)
    expect(documents.get(at(ADA.email))).toMatchObject({
      type: 'user',
      sub: 'google|1',
      email: 'ada@example.com',
      displayName: 'Ada',
    })
  })

  it('finds the record however the address was typed', async () => {
    const { couch } = fakeCouch()
    await userRecords(couch, () => 0).ensure(ADA)
    expect(await userRecords(couch, () => 0).read(' ADA@example.com ')).toBeDefined()
  })

  it('fills in the subject of a record an operator created by address', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch, () => 0)
    await records.setPlan(ADA.email, 'pro')
    const filled = await records.ensure(ADA)
    expect(filled).toMatchObject({ sub: 'google|1', plan: 'pro' })
  })

  it('never takes roles, plan or refresh tokens from an update', async () => {
    const { couch, documents } = fakeCouch()
    const records = userRecords(couch, () => 0)
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
    const records = userRecords(couch, () => 0)
    await records.ensure(ADA, [{ hash: 'h1', exp: 100, createdAt: 1 }])
    expect(await records.hasRefresh(ADA.email, 'h1', 50)).toBe(true)
  })

  it('answers undefined, not false, for refresh checks without a record', async () => {
    const { couch } = fakeCouch()
    expect(await userRecords(couch, () => 0).hasRefresh(ADA.email, 'h', 0)).toBeUndefined()
    expect(
      await userRecords(couch, () => 0).addRefresh(ADA.email, { hash: 'h', exp: 1, createdAt: 0 }),
    ).toBe(false)
  })

  it('treats an expired refresh entry as absent', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch, () => 0)
    await records.ensure(ADA, [{ hash: 'h1', exp: 100, createdAt: 1 }])
    expect(await records.hasRefresh(ADA.email, 'h1', 100)).toBe(false)
  })

  it('removes one refresh entry and keeps the others', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch, () => 0)
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
    const records = userRecords(fake.couch, () => 0)
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

  it('prunes expired refresh entries in the write that appends one', async () => {
    let t = 100
    const { couch, documents } = fakeCouch()
    const records = userRecords(couch, () => t)
    await records.ensure(ADA)
    await records.addRefresh(ADA.email, { hash: 'old', exp: 150, createdAt: 100 })
    await records.addRefresh(ADA.email, { hash: 'keep', exp: 900, createdAt: 100 })
    t = 150
    await records.addRefresh(ADA.email, { hash: 'new', exp: 1000, createdAt: 150 })
    const stored = documents.get(at(ADA.email)) as { refreshTokens: { hash: string }[] }
    expect(stored.refreshTokens.map((e) => e.hash)).toEqual(['keep', 'new'])
  })

  it('prunes expired entries, stored and adopted, when ensure writes', async () => {
    let t = 100
    const { couch, documents } = fakeCouch()
    const records = userRecords(couch, () => t)
    await records.ensure(ADA, [{ hash: 'old', exp: 150, createdAt: 100 }])
    t = 150
    await records.ensure(ADA, [
      { hash: 'dead', exp: 120, createdAt: 100 },
      { hash: 'live', exp: 500, createdAt: 150 },
    ])
    const stored = documents.get(at(ADA.email)) as { refreshTokens: { hash: string }[] }
    expect(stored.refreshTokens.map((e) => e.hash)).toEqual(['live'])
  })

  it('reads a record by subject through the view', async () => {
    const fake = fakeCouch()
    const records = userRecords(fake.couch, () => 0)
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
    const record = { _id: 'u', type: 'user', sub: 's|1', email: 'a@b.c', plan: 'Pro' } as const
    expect(planOf(record, report)).toBe('free')
    // The subject, not the address: this reaches the log, and the address must not.
    expect(report).toHaveBeenCalledWith({ sub: 's|1', plan: 'Pro' })
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
      planOf({ _id: 'user:YUBiLmM', type: 'user', sub: 's|1', email: 'a@b.c', plan: 'Pro' })

      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0]?.[0])
      expect(JSON.parse(line)).toMatchObject({ level: 'warn', sub: 's|1', plan: 'Pro' })
      // Neither the address nor the id, which is the address in base64url.
      expect(line).not.toContain('@')
      expect(line).not.toContain('a@b.c')
      expect(line).not.toContain('YUBiLmM')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the waitlist fields', () => {
  const AT = '2026-10-09T08:00:00.000Z'
  const LATER = '2026-10-10T09:30:00.000Z'
  const writesTo = (fake: ReturnType<typeof fakeCouch>) =>
    fake.calls.filter((call) => call.operation === 'putDoc' && call.database === USERS_DB).length

  it('records the plan requested and when', async () => {
    const { couch, documents } = fakeCouch()
    const records = userRecords(couch, () => 0)
    await records.ensure(ADA)

    const written = await records.requestPlan(ADA.email, 'member', AT)

    expect(written).toMatchObject({ planRequested: 'member', requestedAt: AT })
    expect(documents.get(at(ADA.email))).toMatchObject({
      sub: 'google|1',
      planRequested: 'member',
      requestedAt: AT,
    })
  })

  it('overwrites an earlier request rather than keeping both', async () => {
    const { couch, documents } = fakeCouch()
    const records = userRecords(couch, () => 0)
    await records.ensure(ADA)
    await records.requestPlan(ADA.email, 'member', AT)

    await records.requestPlan(ADA.email, 'pro', LATER)

    expect(documents.get(at(ADA.email))).toMatchObject({ planRequested: 'pro', requestedAt: LATER })
  })

  it('never touches the plan or the refresh tokens', async () => {
    const { couch, documents } = fakeCouch()
    const records = userRecords(couch, () => 0)
    await records.setPlan(ADA.email, 'member')
    await records.ensure(ADA, [{ hash: 'h', exp: 100, createdAt: 1 }])

    await records.requestPlan(ADA.email, 'pro', AT)

    const stored = documents.get(at(ADA.email)) as { plan: string; refreshTokens: unknown[] }
    expect(stored.plan).toBe('member')
    expect(stored.refreshTokens).toHaveLength(1)
  })

  it('refuses a request without a record, and the error does not name the address', async () => {
    const { couch } = fakeCouch()
    const error = await userRecords(couch, () => 0)
      .requestPlan(ADA.email, 'pro', AT)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/ensure one first/)
    // Errors reach the log, and the address must not.
    expect((error as Error).message).not.toContain(ADA.email)
  })

  it('clears both fields and keeps everything else', async () => {
    const { couch, documents } = fakeCouch()
    const records = userRecords(couch, () => 0)
    await records.ensure(ADA)
    await records.requestPlan(ADA.email, 'pro', AT)

    const cleared = await records.clearRequest(ADA.email)

    const stored = documents.get(at(ADA.email))
    expect(stored).not.toHaveProperty('planRequested')
    expect(stored).not.toHaveProperty('requestedAt')
    expect(stored).toMatchObject({ sub: 'google|1', email: 'ada@example.com' })
    expect(cleared).not.toHaveProperty('planRequested')
  })

  it('writes nothing when the user is not waiting', async () => {
    const fake = fakeCouch()
    const records = userRecords(fake.couch, () => 0)
    await records.ensure(ADA)
    const before = writesTo(fake)

    const answer = await records.clearRequest(ADA.email)

    expect(writesTo(fake)).toBe(before)
    expect(answer?.email).toBe(ADA.email)
  })

  it('creates no record when clearing for an address that has none', async () => {
    const { couch, documents } = fakeCouch()

    expect(await userRecords(couch, () => 0).clearRequest(ADA.email)).toBeUndefined()
    expect(documents.has(at(ADA.email))).toBe(false)
  })

  it('retries a request that lost a race', async () => {
    const fake = fakeCouch()
    const records = userRecords(fake.couch, () => 0)
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

    await records.requestPlan(ADA.email, 'pro', AT)

    expect(fake.documents.get(at(ADA.email))).toMatchObject({ planRequested: 'pro' })
  })
})

describe('the waitlist fields in the profile', () => {
  const AT = '2026-10-09T08:00:00.000Z'
  const claims = { sub: 's', email: 'a@b.c' }
  const record = (fields: Record<string, unknown>) =>
    ({ _id: 'u', type: 'user', email: 'a@b.c', ...fields }) as never

  it('reports the plan requested and when, while the user is waiting', () => {
    expect(profileOf(record({ planRequested: 'pro', requestedAt: AT }), claims)).toMatchObject({
      planRequested: 'pro',
      requestedAt: AT,
    })
  })

  it.each([
    ['not waiting', {}],
    ['a request without a date', { planRequested: 'pro' }],
    ['a date without a request', { requestedAt: AT }],
    ['free, which nobody waits for', { planRequested: 'free', requestedAt: AT }],
    ['a tier this build does not know', { planRequested: 'gold', requestedAt: AT }],
  ])('reports neither for %s', (_case, fields) => {
    const profile = profileOf(record(fields), claims)

    expect(profile).not.toHaveProperty('planRequested')
    expect(profile).not.toHaveProperty('requestedAt')
  })
})
