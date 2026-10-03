import { beforeEach, describe, expect, it } from 'vitest'
import {
  BY_SUB_DESIGN,
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

  it('does the work once per process', async () => {
    const { couch, calls } = fakeCouch()
    await ensureUsersDatabase(couch)
    const after = calls.length
    await ensureUsersDatabase(couch)
    expect(calls.length).toBe(after)
  })
})
