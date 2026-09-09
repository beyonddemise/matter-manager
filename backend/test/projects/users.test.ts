import { beforeEach, describe, expect, it } from 'vitest'
import {
  BY_EMAIL_DESIGN,
  BY_EMAIL_VIEW,
  ensureUserIndex,
  findUser,
  forgetUserIndex,
  USERS_DATABASE,
} from '../../src/projects/users.js'
import { fakeCouch, operations } from '../support/couch.js'

const ADA = 'google|ada'

/** A CouchDB with one account in `_users`. */
function withAccount() {
  return fakeCouch({
    seed: {
      [`${USERS_DATABASE}/org.couchdb.user:${ADA}`]: {
        _id: `org.couchdb.user:${ADA}`,
        name: ADA,
        type: 'user',
        email: 'Ada@Example.test',
      },
    },
  })
}

/**
 * Runs the map function this module installs, against one document.
 *
 * The view is what makes the lookup case-insensitive, and it ships as a string — so the only
 * way to test what it does is to execute it.
 */
async function runView(doc: Record<string, unknown>) {
  forgetUserIndex()
  const fake = fakeCouch()
  await ensureUserIndex(fake.couch)
  const design = fake.documents.get(`${USERS_DATABASE}/_design/${BY_EMAIL_DESIGN}`) as {
    views: Record<string, { map: string }>
  }

  const rows: Array<{ key: unknown; value: { sub: string; email: string } }> = []
  const emit = (key: unknown, value: { sub: string; email: string }) => rows.push({ key, value })
  // `new Function` on a constant this repository authors, never on input: the source is the
  // module's own `map` string, which is what CouchDB is handed verbatim. Executing it is the
  // only way to test what it emits rather than what it contains — asserting on the text is how
  // a view that emits `undefined` passes a test named for the value it should emit.
  const map = new Function('emit', `return (${design.views[BY_EMAIL_VIEW]?.map ?? ''})`)(emit) as (
    doc: unknown,
  ) => void
  map(doc)

  return rows
}

beforeEach(forgetUserIndex)

describe('finding somebody by subject', () => {
  it('reads their account directly', async () => {
    // No view needed: the document id is derived from the subject, so this is one keyed read.
    const fake = withAccount()

    expect(await findUser(fake.couch, ADA)).toEqual({ sub: ADA, email: 'Ada@Example.test' })
  })

  it('does not build an index to do it', async () => {
    const fake = withAccount()
    await findUser(fake.couch, ADA)

    expect(operations(fake)).toEqual(['getDoc'])
  })

  it('is nothing for a subject with no account', async () => {
    const fake = withAccount()

    expect(await findUser(fake.couch, 'google|nobody')).toBeUndefined()
  })
})

describe('finding somebody by address', () => {
  it('asks the index', async () => {
    const fake = withAccount()
    fake.rows = [{ value: { sub: ADA, email: 'Ada@Example.test' } }]

    expect(await findUser(fake.couch, 'ada@example.test')).toEqual({
      sub: ADA,
      email: 'Ada@Example.test',
    })
  })

  it('folds the address it looks for', async () => {
    // **The one that decides whether sharing works.** The local part of an address is
    // case-sensitive by the letter of RFC 5321 and case-insensitive at every provider anybody
    // uses. Somebody typing `Ada@Example.test` to share their house means the person they know
    // as `ada@example.test`, and telling them that person has no account would be wrong in the
    // only way that matters.
    const fake = withAccount()
    await findUser(fake.couch, '  Ada@Example.TEST  ')

    expect(fake.calls.at(-1)).toMatchObject({
      detail: { params: { key: 'ada@example.test' } },
    })
  })

  it('is nothing for an address nobody has', async () => {
    // Not an error: "nobody has that address yet" is an ordinary answer, and M5-4 turns it into
    // an invitation.
    const fake = withAccount()

    expect(await findUser(fake.couch, 'nobody@example.test')).toBeUndefined()
  })

  it('takes the first when two accounts somehow share an address', async () => {
    // That should not happen. But a deployment is not a proof, and throwing here would make
    // sharing impossible rather than merely ambiguous.
    const fake = withAccount()
    fake.rows = [
      { value: { sub: 'google|first', email: 'shared@example.test' } },
      { value: { sub: 'google|second', email: 'shared@example.test' } },
    ]

    expect(await findUser(fake.couch, 'shared@example.test')).toMatchObject({
      sub: 'google|first',
    })
  })

  it('is nothing for an empty value', async () => {
    const fake = withAccount()

    expect(await findUser(fake.couch, '   ')).toBeUndefined()
    expect(operations(fake)).toEqual([])
  })
})

describe('the index itself', () => {
  it('folds the addresses it stores', async () => {
    // Folding the index rather than only the query: a folded query against an unfolded index
    // matches nothing, which is the same failure as not folding at all.
    const rows = await runView({ type: 'user', name: ADA, email: 'Ada@Example.test' })

    expect(rows[0]?.key).toBe('ada@example.test')
  })

  it('keeps the address as the user gave it', async () => {
    // What is shown back to somebody is what they typed. `ADA@EXAMPLE.TEST` rendered as
    // `ada@example.test` is a small thing that reads as the application having changed it.
    const rows = await runView({ type: 'user', name: ADA, email: 'Ada@Example.test' })

    expect(rows[0]?.value.email).toBe('Ada@Example.test')
  })

  it('emits nothing for an account with no address', async () => {
    // An account created without one would otherwise be emitted under `undefined`, and a
    // lookup for an address that failed to fold would find it.
    expect(await runView({ type: 'user', name: ADA })).toEqual([])
  })

  it('emits nothing for a document that is not an account', async () => {
    expect(await runView({ type: 'projectPointer', email: 'ada@example.test' })).toEqual([])
  })

  it('is built once per process', async () => {
    const fake = fakeCouch()
    await ensureUserIndex(fake.couch)
    await ensureUserIndex(fake.couch)

    expect(operations(fake).filter((operation) => operation === 'putDoc')).toHaveLength(1)
  })

  it('is tried again after a failure', async () => {
    const failing = fakeCouch({ fails: { putDoc: true } })
    await expect(ensureUserIndex(failing.couch)).rejects.toThrow()

    const working = fakeCouch()
    await ensureUserIndex(working.couch)

    expect(working.documents.has(`${USERS_DATABASE}/_design/${BY_EMAIL_DESIGN}`)).toBe(true)
  })
})
