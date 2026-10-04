import { beforeEach, describe, expect, it } from 'vitest'
import { findUser } from '../../src/projects/users.js'
import { forgetUsersDatabase, USERS_DB } from '../../src/users/database.js'
import { userDocId } from '../../src/users/key.js'
import { userRecords } from '../../src/users/records.js'
import { fakeCouch } from '../support/couch.js'

const ADA = 'google|ada'

beforeEach(() => forgetUsersDatabase())

/** A CouchDB holding Ada's record, and the `by_sub` row that finds it by subject. */
function withAccount(record: Record<string, unknown> = { sub: ADA }) {
  const id = userDocId('ada@example.test')
  const fake = fakeCouch({
    seed: {
      [`${USERS_DB}/${id}`]: { _id: id, type: 'user', email: 'Ada@Example.test', ...record },
    },
  })
  fake.rowsByDesign.by_sub = [{ id, key: ADA, value: null }]
  return { fake, records: userRecords(fake.couch) }
}

describe('finding somebody by subject', () => {
  it('resolves it through the by_sub view', async () => {
    const { records } = withAccount()

    expect(await findUser(records, ADA)).toEqual({ sub: ADA, email: 'Ada@Example.test' })
  })

  it('is nothing for a subject with no record', async () => {
    const { fake, records } = withAccount()
    fake.rowsByDesign.by_sub = []

    expect(await findUser(records, 'google|nobody')).toBeUndefined()
  })
})

describe('finding somebody by address', () => {
  it('reads the record directly, however the address was typed', async () => {
    // The record is keyed by the folded address, so folding is the key's job and a lookup is one
    // keyed read. Somebody typing `Ada@Example.TEST` means the person they know as
    // `ada@example.test`.
    const { records } = withAccount()

    expect(await findUser(records, '  Ada@Example.TEST  ')).toEqual({
      sub: ADA,
      email: 'Ada@Example.test',
    })
  })

  it('keeps the address as the user gave it', async () => {
    const { records } = withAccount()

    expect((await findUser(records, 'ada@example.test'))?.email).toBe('Ada@Example.test')
  })

  it('is nothing for an address nobody has', async () => {
    // Not an error: "nobody has that address yet" is an ordinary answer, and M5-4 turns it into
    // an invitation.
    const { records } = withAccount()

    expect(await findUser(records, 'nobody@example.test')).toBeUndefined()
  })

  it('is nothing for a record an operator created and nobody has signed in to', async () => {
    // It names somebody with no account to add to a project yet.
    const { records } = withAccount({ sub: undefined })

    expect(await findUser(records, 'ada@example.test')).toBeUndefined()
  })
})

describe('an empty value', () => {
  it('is nothing, and asks nothing', async () => {
    const { fake, records } = withAccount()

    expect(await findUser(records, '   ')).toBeUndefined()
    expect(fake.calls).toEqual([])
  })
})
