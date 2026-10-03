import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  accessToken,
  EXPIRY_MARGIN_SECONDS,
  forgetTokens,
  pouchRefreshTokenStore,
  rememberAccessToken,
} from '../../src/ui/tokens.js'

/** A clock that starts at a round number and can be moved forward. */
function clock(start = 1_800_000_000) {
  let seconds = start
  return {
    now: () => seconds,
    advance: (by: number) => {
      seconds += by
    },
  }
}

/** Records every write, so a test can assert that none happened. */
function watchStorage() {
  const written: string[] = []
  const fake = {
    length: 0,
    getItem: () => null,
    setItem: (key: string) => written.push(key),
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
  }
  return { written, fake }
}

afterEach(() => {
  forgetTokens()
})

describe('holding the access token', () => {
  it('has nothing before a sign-in', () => {
    expect(accessToken()).toBeUndefined()
  })

  it('hands back what it was given', () => {
    const time = clock()
    rememberAccessToken({ accessToken: 'header.payload.signature', expiresIn: 3600 }, time.now)

    expect(accessToken(time.now)).toBe('header.payload.signature')
  })

  it('forgets on request', () => {
    const time = clock()
    rememberAccessToken({ accessToken: 'token', expiresIn: 3600 }, time.now)

    forgetTokens()

    expect(accessToken(time.now)).toBeUndefined()
  })

  it('is empty again after forgetting, not merely unreadable', () => {
    // `forgetTokens` is what sign-out and expiry both call. If it left the value behind under
    // another name, both would be reporting something they had not done.
    const time = clock()
    rememberAccessToken({ accessToken: 'token', expiresIn: 3600 }, time.now)
    forgetTokens()

    rememberAccessToken({ accessToken: 'second', expiresIn: 3600 }, time.now)
    expect(accessToken(time.now)).toBe('second')
  })
})

describe('the clock it uses when nobody supplies one', () => {
  /** The current time on the scale the contract and JWTs both use. */
  const nowInSeconds = () => Math.floor(Date.now() / 1000)

  // Writing *and* reading through the default clock proves nothing: a clock that answers
  // milliseconds, or one frozen at zero, is perfectly self-consistent and every assertion
  // still passes. Both mutations survived a test written that way. So the write goes through
  // the default clock and the read through an explicit one on the scale it is supposed to be.

  it('measures seconds, so a token stays usable for the hour it was granted', () => {
    rememberAccessToken({ accessToken: 'token', expiresIn: 3600 })

    expect(accessToken(nowInSeconds)).toBe('token')
  })

  it('measures seconds, so that hour actually ends', () => {
    // `Date.now()` without the division puts the expiry roughly forty thousand years out.
    rememberAccessToken({ accessToken: 'token', expiresIn: 3600 })

    expect(accessToken(() => nowInSeconds() + 3601)).toBeUndefined()
  })
})

describe('a token that has run out', () => {
  it('is not handed back', () => {
    // Sending it would spend a round trip to be told 401 — and on a slow connection, from a
    // basement, that round trip is the expensive part.
    const time = clock()
    rememberAccessToken({ accessToken: 'token', expiresIn: 3600 }, time.now)

    time.advance(3601)

    expect(accessToken(time.now)).toBeUndefined()
  })

  it('is not handed back shortly before it runs out either', () => {
    // A token with two seconds left is not worth sending: the request may well arrive after it
    // has died, and the failure then looks like a server problem rather than an expiry.
    const time = clock()
    rememberAccessToken({ accessToken: 'token', expiresIn: 3600 }, time.now)

    time.advance(3600 - Math.floor(EXPIRY_MARGIN_SECONDS / 2))

    expect(accessToken(time.now)).toBeUndefined()
  })

  it('is still handed back well within its life', () => {
    // The margin has to be a margin, not a policy of never using the token.
    const time = clock()
    rememberAccessToken({ accessToken: 'token', expiresIn: 3600 }, time.now)

    time.advance(3600 - EXPIRY_MARGIN_SECONDS - 60)

    expect(accessToken(time.now)).toBe('token')
  })

  it('is treated as absent rather than as a reason to throw', () => {
    // The caller's job is to fetch a new one, which is ordinary, not exceptional.
    const time = clock()
    rememberAccessToken({ accessToken: 'token', expiresIn: 1 }, time.now)
    time.advance(600)

    expect(() => accessToken(time.now)).not.toThrow()
  })
})

describe('where the token is not kept', () => {
  let storage: ReturnType<typeof watchStorage>

  beforeEach(() => {
    storage = watchStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage.fake, configurable: true })
    Object.defineProperty(globalThis, 'sessionStorage', { value: storage.fake, configurable: true })
  })

  it('writes to no web storage at all', () => {
    // In memory it dies with the tab. In `localStorage` it survives, is readable by any script
    // that ever runs on this origin, and grants direct access to that user's CouchDB database
    // (todo-41: "where the tokens live, and why each is different").
    //
    // This test exists because the change that breaks it is a *reasonable-sounding* one —
    // "keep people signed in across a reload" — made in the wrong place.
    rememberAccessToken({ accessToken: 'token', expiresIn: 3600 }, () => 0)

    expect(storage.written).toEqual([])
  })

  it('would notice if it did', () => {
    // The positive control. Without it, the assertion above passes just as happily when the
    // spy is not attached to anything.
    globalThis.localStorage.setItem('proof', 'the spy is wired up')

    expect(storage.written).toEqual(['proof'])
  })
})

describe('the refresh token store', () => {
  /** The slice of PouchDB the store uses, backed by a map. */
  function fakeDb() {
    const docs = new Map<string, { _id: string; _rev: string; token?: string | undefined }>()
    const db = {
      get: async (id: string) => {
        const doc = docs.get(id)
        if (doc === undefined) throw new Error('missing')
        return doc
      },
      put: async (doc: { _id: string; _rev?: string; token?: string }) => {
        const current = docs.get(doc._id)
        if (current !== undefined && current._rev !== doc._rev) throw new Error('conflict')
        docs.set(doc._id, {
          _id: doc._id,
          _rev: `${Number(current?._rev ?? 0) + 1}`,
          token: doc.token,
        })
      },
      remove: async (doc: { _id: string }) => {
        docs.delete(doc._id)
      },
    }
    return { db: db as unknown as PouchDB.Database, docs }
  }

  it('reads nothing before a first write', async () => {
    expect(await pouchRefreshTokenStore(fakeDb().db).read()).toBeUndefined()
  })

  it('keeps the token in a _local document, so it is never replicated', async () => {
    const { db, docs } = fakeDb()
    await pouchRefreshTokenStore(db).write('r1')
    expect([...docs.keys()]).toEqual(['_local/refresh-token'])
  })

  it('replaces the token on rotation', async () => {
    const store = pouchRefreshTokenStore(fakeDb().db)
    await store.write('r1')
    await store.write('r2')
    expect(await store.read()).toBe('r2')
  })

  it('clears the token, and clearing nothing is not an error', async () => {
    const store = pouchRefreshTokenStore(fakeDb().db)
    await store.write('r1')
    await store.clear()
    expect(await store.read()).toBeUndefined()
    await expect(store.clear()).resolves.toBeUndefined()
  })
})
