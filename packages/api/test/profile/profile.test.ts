import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mintToken, signingKeyFromPem } from '../../src/auth/jwt.js'
import type { Identity } from '../../src/auth/oidc.js'
import type { CouchClient, Revision } from '../../src/couch/client.js'
import { isLocale, type Profile, profileStore, userDocumentId } from '../../src/profile/store.js'
import { buildServer, type Server } from '../../src/server.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'

function newKey(kid = 'ec-test') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(kid, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

/** A CouchDB holding documents in a Map. Enough for `_users`, which is one document per user. */
function fakeCouch(seed: Record<string, Record<string, unknown>> = {}) {
  const documents = new Map<string, Record<string, unknown>>(Object.entries(seed))
  const writes: Array<Record<string, unknown>> = []

  const couch = {
    async getDoc<T extends Revision>(database: string, id: string) {
      return documents.get(`${database}/${id}`) as T | undefined
    },
    async putDoc<T extends Revision>(database: string, document: T) {
      writes.push(document as unknown as Record<string, unknown>)
      documents.set(`${database}/${document._id}`, {
        ...(document as unknown as Record<string, unknown>),
        _rev: '2-b',
      })
      return { id: document._id, rev: '2-b' }
    },
    async createDb() {
      return true
    },
    async putSecurity() {},
    async getSecurity() {
      return {}
    },
    async view() {
      return { rows: [] }
    },
  } as unknown as CouchClient

  return { couch, documents, writes }
}

const ADA = `_users/${userDocumentId('google|1234')}`

const storedAda = (extra: Record<string, unknown> = {}) => ({
  [ADA]: {
    _id: userDocumentId('google|1234'),
    _rev: '1-a',
    name: 'google|1234',
    roles: ['project_x_reader'],
    type: 'user',
    email: 'ada@example.com',
    displayName: 'Ada',
    ...extra,
  },
})

describe('what a locale may be', () => {
  it.each([['auto'], ['en'], ['de']])('accepts %s', (value) => {
    expect(isLocale(value)).toBe(true)
  })

  it.each([['fr'], ['EN'], [''], [null], [42]])('refuses %s', (value) => {
    // A locale the interface does not have is a preference nothing can honour, so it is
    // refused rather than stored and silently ignored later.
    expect(isLocale(value)).toBe(false)
  })
})

describe('reading a profile', () => {
  it('reads what CouchDB holds', async () => {
    const { couch } = fakeCouch(storedAda({ locale: 'de' }))

    expect(await profileStore(couch).read('google|1234')).toEqual({
      sub: 'google|1234',
      email: 'ada@example.com',
      displayName: 'Ada',
      locale: 'de',
    })
  })

  it('reports a user who has never signed in', async () => {
    const { couch } = fakeCouch()
    expect(await profileStore(couch).read('google|nobody')).toBeUndefined()
  })

  it('reads a stored locale of nothing as auto', async () => {
    // A profile that has never chosen and one that chose `auto` are the same thing to the
    // interface. Writing `en` in for a new user would give a German-speaking visitor an English
    // interface they never asked for.
    const { couch } = fakeCouch(storedAda())

    expect((await profileStore(couch).read('google|1234'))?.locale).toBe('auto')
  })

  it('reads a locale the interface no longer has as auto', async () => {
    // A build that dropped a language leaves preferences pointing at it. Following the browser
    // is the honest fallback; refusing to load the profile is not.
    const { couch } = fakeCouch(storedAda({ locale: 'fr' }))

    expect((await profileStore(couch).read('google|1234'))?.locale).toBe('auto')
  })
})

describe('remembering a user who signed in', () => {
  const identity: Identity = { sub: 'google|1234', email: 'ada@example.com', name: 'Ada' }

  it('creates a CouchDB user for a new one', async () => {
    const { couch, writes } = fakeCouch()
    await profileStore(couch).remember(identity)

    expect(writes[0]).toMatchObject({
      _id: 'org.couchdb.user:google|1234',
      name: 'google|1234',
      type: 'user',
      email: 'ada@example.com',
      displayName: 'Ada',
    })
  })

  it('grants no roles', async () => {
    // Roles are how CouchDB decides what a user may reach. A sign-in is not the moment to grant
    // any; M5 adds project roles deliberately.
    const { couch, writes } = fakeCouch()
    await profileStore(couch).remember(identity)

    expect(writes[0]?.roles).toEqual([])
  })

  it('keeps a returning user’s settings', async () => {
    // M4-3's second scenario. The identity provider is authoritative about who somebody is and
    // says nothing about what they prefer.
    const { couch, writes } = fakeCouch(storedAda({ locale: 'de' }))
    await profileStore(couch).remember(identity)

    expect(writes[0]?.locale).toBe('de')
  })

  it('keeps a returning user’s roles', async () => {
    // Losing these on every sign-in would mean losing every project on every sign-in.
    const { couch, writes } = fakeCouch(storedAda())
    await profileStore(couch).remember(identity)

    expect(writes[0]?.roles).toEqual(['project_x_reader'])
  })

  it('does not overwrite a display name the user chose', async () => {
    // The provider's name is a default, not an override. Somebody who set their own should not
    // have it replaced every time they sign in.
    const { couch, writes } = fakeCouch(storedAda({ displayName: 'Ada Lovelace' }))
    await profileStore(couch).remember(identity)

    expect(writes[0]?.displayName).toBe('Ada Lovelace')
  })

  it('writes against the revision it read', async () => {
    const { couch, writes } = fakeCouch(storedAda())
    await profileStore(couch).remember(identity)

    expect(writes[0]?._rev).toBe('1-a')
  })
})

describe('updating a profile', () => {
  it('stores the chosen locale', async () => {
    const { couch } = fakeCouch(storedAda())
    const updated = await profileStore(couch).update('google|1234', { locale: 'de' })

    expect(updated.locale).toBe('de')
  })

  it('keeps CouchDB’s own fields', async () => {
    // A `_users` document that loses its `type` stops being a user and the account cannot
    // authenticate afterwards; one that loses its roles loses every project.
    const { couch, writes } = fakeCouch(storedAda())
    await profileStore(couch).update('google|1234', { locale: 'de' })

    expect(writes[0]).toMatchObject({
      name: 'google|1234',
      type: 'user',
      roles: ['project_x_reader'],
    })
  })

  it('refuses to invent a profile for somebody who has none', async () => {
    const { couch } = fakeCouch()

    await expect(profileStore(couch).update('google|nobody', { locale: 'de' })).rejects.toThrow(
      /No profile/,
    )
  })
})

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('the profile endpoints', () => {
  function serve(seed = storedAda({ locale: 'de' })) {
    const key = newKey()
    const { couch, writes } = fakeCouch(seed)
    app = buildServer({ logger: false, profile: { store: profileStore(couch), key } })
    const session = mintToken(key, {
      purpose: 'session',
      sub: 'google|1234',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    return { app, key, writes, cookie: `mm_session=${encodeURIComponent(session)}` }
  }

  it('answers GET with what the contract declares', async () => {
    const { app: server, cookie } = serve()
    const response = await server.inject({ method: 'GET', url: '/profile', headers: { cookie } })

    expect(response.statusCode).toBe(200)

    // Against the contract's own schema rather than a hand-written shape, so this endpoint and
    // `openapi/matter-manager.yaml` cannot drift apart quietly.
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'GET' && operation.path === '/profile',
    )?.responses['200']
    expect(validate(response.json(), schema)).toEqual([])
  })

  it('answers PUT with what the contract declares', async () => {
    const { app: server, cookie } = serve()
    const response = await server.inject({
      method: 'PUT',
      url: '/profile',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { locale: 'en' },
    })

    expect(response.statusCode).toBe(200)
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'PUT' && operation.path === '/profile',
    )?.responses['200']
    expect(validate(response.json(), schema)).toEqual([])
    expect((response.json() as Profile).locale).toBe('en')
  })

  it('refuses without a session', async () => {
    const { app: server } = serve()

    expect((await server.inject({ method: 'GET', url: '/profile' })).statusCode).toBe(401)
    expect(
      (
        await server.inject({
          method: 'PUT',
          url: '/profile',
          headers: { 'content-type': 'application/json' },
          payload: { locale: 'en' },
        })
      ).statusCode,
    ).toBe(401)
  })

  it('takes the subject from the session, never from the body', async () => {
    // A profile endpoint that accepted an arbitrary subject would be an account-takeover
    // primitive: send somebody else's id, change their settings.
    const { app: server, cookie, writes } = serve()
    await server.inject({
      method: 'PUT',
      url: '/profile',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { locale: 'en', sub: 'google|victim', name: 'attacker' },
    })

    expect(writes[0]?.name).toBe('google|1234')
    expect(writes[0]?._id).toBe('org.couchdb.user:google|1234')
  })

  it.each([
    ['a locale the interface does not have', { locale: 'fr' }],
    ['no locale at all', {}],
    ['a locale that is not a string', { locale: 42 }],
  ])('refuses %s, naming the field', async (_case, payload) => {
    const { app: server, cookie } = serve()
    const response = await server.inject({
      method: 'PUT',
      url: '/profile',
      headers: { cookie, 'content-type': 'application/json' },
      payload,
    })

    expect(response.statusCode).toBe(400)
    expect(JSON.stringify(response.json())).toContain('locale')
  })

  it('leaves a display name alone when the request does not mention one', async () => {
    // What a form that only changed the language sends. An empty display name is a name nobody
    // has, so it is treated the same way.
    const { app: server, cookie, writes } = serve()
    await server.inject({
      method: 'PUT',
      url: '/profile',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { locale: 'en', displayName: '   ' },
    })

    expect(writes[0]?.displayName).toBe('Ada')
  })

  it('is never stored in a shared cache', async () => {
    // A profile is per-user. A cache holding one can hand somebody else's name and email to the
    // next request.
    const { app: server, cookie } = serve()
    const response = await server.inject({ method: 'GET', url: '/profile', headers: { cookie } })

    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers['cache-control']).toContain('private')
  })

  it('treats a session outliving its account as not signed in', async () => {
    // Rather than a 404 or a 500. The honest statement is that this credential no longer
    // identifies anybody.
    const { app: server, cookie } = serve({})
    const response = await server.inject({ method: 'GET', url: '/profile', headers: { cookie } })

    expect(response.statusCode).toBe(401)
  })
})

describe('an address that was already stored', () => {
  const stored = {
    [`_users/${userDocumentId('google|1234')}`]: {
      _id: userDocumentId('google|1234'),
      _rev: '1-a',
      name: 'google|1234',
      roles: [],
      type: 'user',
      email: 'ada@example.test',
      displayName: 'Ada',
    },
  }

  it('survives a sign-in whose token carried no email claim', async () => {
    // The address in `_users` is what `users.ts` indexes for `findUser`, so losing it does not
    // merely blank a profile field — it makes the account unfindable by address, and sharing a
    // project with that person answers "nobody with that address has an account yet". The claim
    // is optional in OIDC, and `identityFrom` already drops an empty one, so an identity with
    // no email is an ordinary thing rather than a malformed one.
    const { couch, documents } = fakeCouch(stored)

    await profileStore(couch as unknown as CouchClient).remember({
      sub: 'google|1234',
      name: 'Ada',
    })

    expect(documents.get(`_users/${userDocumentId('google|1234')}`)?.email).toBe('ada@example.test')
  })

  it('is replaced when the provider does send one', async () => {
    // The positive control. Carrying the stored value forward *unconditionally* would pass the
    // test above while ignoring somebody who changed their address with their provider.
    const { couch, documents } = fakeCouch(stored)

    await profileStore(couch as unknown as CouchClient).remember({
      sub: 'google|1234',
      email: 'ada@new.test',
    })

    expect(documents.get(`_users/${userDocumentId('google|1234')}`)?.email).toBe('ada@new.test')
  })
})
