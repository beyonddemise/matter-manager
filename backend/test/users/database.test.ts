import { beforeEach, describe, expect, it } from 'vitest'
import {
  BY_PLAN_REQUESTED_DESIGN,
  BY_PLAN_REQUESTED_VIEW,
  BY_SUB_DESIGN,
  BY_SUB_VIEW,
  ensureUsersDatabase,
  forgetUsersDatabase,
  USERS_DB,
} from '../../src/users/database.js'
import { fakeCouch } from '../support/couch.js'

beforeEach(() => forgetUsersDatabase())

describe('ensureUsersDatabase', () => {
  it('creates the database and makes it admin-only before installing anything', async () => {
    const { couch, calls, security } = fakeCouch()
    await ensureUsersDatabase(couch)

    expect(calls.map((c) => c.operation).slice(0, 2)).toEqual(['createDb', 'putSecurity'])
    expect(security.get(USERS_DB)).toEqual({
      admins: { names: [], roles: ['_admin'] },
      members: { names: [], roles: ['_admin'] },
    })
  })

  it('installs the by_sub view', async () => {
    const { couch, documents } = fakeCouch()
    await ensureUsersDatabase(couch)
    expect(documents.get(`${USERS_DB}/_design/${BY_SUB_DESIGN}`)).toBeDefined()
  })

  it('installs the by_plan_requested view in the same setup', async () => {
    const { couch, documents } = fakeCouch()
    await ensureUsersDatabase(couch)
    expect(documents.get(`${USERS_DB}/_design/${BY_PLAN_REQUESTED_DESIGN}`)).toBeDefined()
  })

  it('does the work once per process', async () => {
    const { couch, calls } = fakeCouch()
    await ensureUsersDatabase(couch)
    const after = calls.length
    await ensureUsersDatabase(couch)
    expect(calls.length).toBe(after)
  })
})

/**
 * What the installed `by_sub` map emits for one document.
 *
 * `new Function` on a constant this repository authors, never on input: the source is the
 * module's own `map` string, which is what CouchDB is handed verbatim. Executing it is the only
 * way to test what it emits rather than what its text contains.
 */
async function rowsOf(
  design: string,
  view: string,
  doc: Record<string, unknown>,
): Promise<Array<{ key: unknown; value: unknown }>> {
  forgetUsersDatabase()
  const { couch, documents } = fakeCouch()
  await ensureUsersDatabase(couch)
  const stored = documents.get(`${USERS_DB}/_design/${design}`) as {
    views: Record<string, { map: string }>
  }
  const rows: Array<{ key: unknown; value: unknown }> = []
  const emit = (key: unknown, value: unknown) => rows.push({ key, value })
  const map = new Function('emit', `return (${stored.views[view]?.map ?? ''})`)(emit) as (
    doc: unknown,
  ) => void
  map(doc)
  return rows
}

/** What `by_sub` emits for one document, as keys: its value is always `null`. */
async function emitted(doc: Record<string, unknown>): Promise<Array<{ key: unknown }>> {
  return (await rowsOf(BY_SUB_DESIGN, BY_SUB_VIEW, doc)).map(({ key }) => ({ key }))
}

describe('the by_sub view', () => {
  it('emits a record by its subject', async () => {
    expect(await emitted({ type: 'user', sub: 'google|1234', email: 'ada@example.test' })).toEqual([
      { key: 'google|1234' },
    ])
  })

  it('skips a record with no subject', async () => {
    // An operator creates a record by address before its owner ever signs in. Without the
    // guard every such record would collect under one `null` key, and a lookup by subject could
    // land on somebody else's.
    expect(await emitted({ type: 'user', email: 'grace@example.test' })).toEqual([])
    expect(await emitted({ type: 'user', sub: '', email: 'grace@example.test' })).toEqual([])
  })

  it('skips documents that are not user records', async () => {
    expect(await emitted({ type: 'other', sub: 'google|1234' })).toEqual([])
  })
})

describe('the by_plan_requested view', () => {
  const AT = '2026-10-09T08:00:00.000Z'
  const rows = (doc: Record<string, unknown>) =>
    rowsOf(BY_PLAN_REQUESTED_DESIGN, BY_PLAN_REQUESTED_VIEW, doc)

  it('emits a waiting record by plan and date, with the address to contact', async () => {
    expect(
      await rows({
        type: 'user',
        email: 'ada@example.test',
        planRequested: 'pro',
        requestedAt: AT,
      }),
    ).toEqual([{ key: ['pro', AT], value: 'ada@example.test' }])
  })

  it('skips a record that is not waiting', async () => {
    expect(await rows({ type: 'user', email: 'ada@example.test', plan: 'member' })).toEqual([])
  })

  it('skips documents that are not user records', async () => {
    expect(await rows({ type: 'other', planRequested: 'pro', requestedAt: AT })).toEqual([])
  })
})
