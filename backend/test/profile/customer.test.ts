import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mintToken, signingKeyFromPem } from '../../src/auth/jwt.js'
import type { CouchClient, Revision } from '../../src/couch/client.js'
import { type Profile, profileStore, userDocumentId } from '../../src/profile/store.js'
import { buildServer, type Server } from '../../src/server.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'

/**
 * `PUT /customer` — the only route that can reach an account other than the caller's.
 *
 * Everything else authenticated by the session cookie takes its subject from that cookie, so the
 * worst a broken check can do is let somebody change their own record. This route takes the
 * subject from the request body, which means a hole in the gate is one user rewriting another
 * user's entitlements. Hence a test per refusal, and hence every test asserting what reached the
 * store rather than only the status code: a handler that answers 403 *after* writing is a
 * handler that reads as correct from the outside.
 */

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

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
  } as unknown as CouchClient

  return { couch, documents, writes }
}

/** One `_users` document, at the id CouchDB itself would use. */
const userDoc = (sub: string, roles: readonly string[] = []) => ({
  [`_users/${userDocumentId(sub)}`]: {
    _id: userDocumentId(sub),
    _rev: '1-a',
    name: sub,
    roles,
    type: 'user',
    email: `${sub}@example.test`,
    displayName: sub,
    locale: 'de',
  },
})

/** The caller. Named rather than reused from the subjects, so "not myself" stays visible. */
const CALLER = 'operator'

/**
 * A server whose caller holds exactly `callerRoles`, plus a `_users` document for each name in
 * `subjects` — and none for any other name, which is how the 404 case is arranged.
 */
function customerServer({
  callerRoles,
  subjects,
}: {
  callerRoles: readonly string[]
  subjects: readonly string[]
}) {
  const key = newKey()
  const { couch, writes } = fakeCouch(
    Object.assign({}, userDoc(CALLER, callerRoles), ...subjects.map((subject) => userDoc(subject))),
  )
  const store = profileStore(couch)
  app = buildServer({ logger: false, profile: { store, sessionKey: key } })

  const token = mintToken(key, {
    purpose: 'session',
    sub: CALLER,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })

  return {
    app,
    cookie: `mm_session=${encodeURIComponent(token)}`,
    // Read back through the store rather than out of the raw document, so a document with no
    // `plan` at all reads as `free` here the same way it reads as `free` everywhere else.
    storedPlan: async (sub: string) => (await store.read(sub))?.plan,
    /** Every document handed to CouchDB. A refused request must add nothing to this. */
    writes,
  }
}

/** One PUT, since every test below is the same request with a different body or credential. */
const put = (server: Server, payload: Record<string, unknown>, cookie?: string) =>
  server.inject({
    method: 'PUT',
    url: '/customer',
    headers: cookie === undefined ? {} : { cookie, 'content-type': 'application/json' },
    payload,
  })

describe('PUT /customer', () => {
  it("sets another account's plan for a role holder", async () => {
    // The reason this route exists: PATCH /profile can only ever reach the caller, so without
    // it an operator can upgrade themselves and nobody else.
    const {
      app: server,
      cookie,
      storedPlan,
    } = customerServer({
      callerRoles: ['customerservice'],
      subjects: ['other'],
    })
    const response = await put(server, { sub: 'other', plan: 'user' }, cookie)

    expect(response.statusCode).toBe(200)
    expect(await storedPlan('other')).toBe('user')
    // The body has to agree with the store, and it has to describe the *named* account rather
    // than the caller — which is the whole difference between this route and PATCH /profile.
    expect((response.json() as Profile).sub).toBe('other')
    expect((response.json() as Profile).plan).toBe('user')
  })

  it("leaves the caller's own plan alone", async () => {
    // The mutation this pins: a handler that read `sub` from the session instead of the body
    // would pass the test above only if the caller and the subject were the same account, and
    // would otherwise upgrade the operator and nobody else — silently, with a 200.
    const {
      app: server,
      cookie,
      storedPlan,
    } = customerServer({
      callerRoles: ['_admin'],
      subjects: ['other'],
    })

    expect((await put(server, { sub: 'other', plan: 'pro' }, cookie)).statusCode).toBe(200)
    expect(await storedPlan('other')).toBe('pro')
    expect(await storedPlan(CALLER)).toBe('free')
  })

  it('refuses a caller without the role', async () => {
    const {
      app: server,
      cookie,
      storedPlan,
    } = customerServer({
      callerRoles: [],
      subjects: ['other'],
    })
    const response = await put(server, { sub: 'other', plan: 'pro' }, cookie)

    expect(response.statusCode).toBe(403)
    expect(JSON.stringify(response.json())).toContain('not-an-operator')
    expect(await storedPlan('other')).toBe('free')
  })

  it.each([
    ['customerservices'],
    ['Customerservice'],
    ['customer'],
    ['CUSTOMERSERVICE'],
    ['admin'],
  ])('refuses a caller whose only role is %s', async (role) => {
    // `customerservices` is somebody else's role and `Customerservice` is a typo; `admin` is
    // not `_admin`. A substring test lets the plural and the prefix through and a case fold
    // lets the typo through, and on *this* route that is one account rewriting another's
    // entitlements rather than a self-grant.
    const {
      app: server,
      cookie,
      storedPlan,
    } = customerServer({
      callerRoles: [role],
      subjects: ['other'],
    })
    const response = await put(server, { sub: 'other', plan: 'pro' }, cookie)

    expect(response.statusCode).toBe(403)
    expect(await storedPlan('other')).toBe('free')
  })

  it('answers 404 for a subject that has never signed in', async () => {
    // Distinct from 403 on purpose: "you may not" and "there is no such account" send an
    // operator to different places, and `store.setPlan` throws a nameable error for exactly
    // this so the route does not have to guess from a bare Error.
    const { app: server, cookie } = customerServer({ callerRoles: ['_admin'], subjects: [] })
    const response = await put(server, { sub: 'ghost', plan: 'user' }, cookie)

    expect(response.statusCode).toBe(404)
    // The body, not only the code. Fastify answers an *unregistered* route 404 as well, so a
    // status-only assertion here passed before this route existed at all and would go on
    // passing if somebody removed its registration - which is the one thing this test is for.
    expect(response.json()).toMatchObject({ title: 'No such account.', status: 404 })
  })

  it('refuses an unsigned caller before it looks at anything', async () => {
    const {
      app: server,
      storedPlan,
      writes,
    } = customerServer({
      callerRoles: ['_admin'],
      subjects: ['other'],
    })
    const response = await put(server, { sub: 'other', plan: 'pro' })

    expect(response.statusCode).toBe(401)
    expect(await storedPlan('other')).toBe('free')
    expect(writes).toEqual([])
  })
})

describe('the order the checks run in', () => {
  // The order is load-bearing, not tidiness. Answering about the *subject* before deciding
  // about the *caller* turns this route into an oracle: any signed-in user could ask about a
  // name and learn from the status code whether that account exists.

  it('answers 403 rather than 404 when a non-operator names an account that does not exist', async () => {
    const { app: server, cookie } = customerServer({ callerRoles: [], subjects: [] })
    const response = await put(server, { sub: 'ghost', plan: 'pro' }, cookie)

    expect(response.statusCode).toBe(403)
  })

  it('tells a non-operator nothing by the difference between two names', async () => {
    // The property stated directly: an account that exists and one that does not must be
    // indistinguishable to a caller who may not do this. A 404 for the ghost and a 403 for the
    // real account would let anyone enumerate the user base one name at a time.
    const { app: server, cookie } = customerServer({ callerRoles: [], subjects: ['other'] })
    const exists = await put(server, { sub: 'other', plan: 'pro' }, cookie)
    const ghost = await put(server, { sub: 'ghost', plan: 'pro' }, cookie)

    // Which status they agree *on*, asserted first. "The two answers are equal" is true of two
    // Fastify route-not-found 404s as well, so equality alone passed before this route existed.
    expect(exists.statusCode).toBe(403)
    expect(ghost.statusCode).toBe(exists.statusCode)
    expect(ghost.json()).toEqual(exists.json())
  })

  it('answers 403 rather than 400 when a non-operator sends a body it cannot use', async () => {
    // Same leak, one step earlier. Validating first would let an unauthorised caller tell 400
    // from 404 and so enumerate accounts without ever holding a role.
    const { app: server, cookie } = customerServer({ callerRoles: [], subjects: ['other'] })
    const response = await put(server, { sub: 'other', plan: 'enterprise' }, cookie)

    expect(response.statusCode).toBe(403)
  })
})

describe('the body PUT /customer accepts', () => {
  it('refuses a plan string it does not know', async () => {
    const {
      app: server,
      cookie,
      storedPlan,
    } = customerServer({
      callerRoles: ['customerservice'],
      subjects: ['other'],
    })
    const response = await put(server, { sub: 'other', plan: 'enterprise' }, cookie)

    expect(response.statusCode).toBe(400)
    expect(JSON.stringify(response.json())).toContain('plan')
    expect(await storedPlan('other')).toBe('free')
  })

  it.each([[undefined], [''], [42], [null]])('refuses a sub of %s', async (sub) => {
    const {
      app: server,
      cookie,
      writes,
    } = customerServer({
      callerRoles: ['customerservice'],
      subjects: ['other'],
    })
    const before = writes.length
    const response = await put(server, { sub, plan: 'pro' }, cookie)

    expect(response.statusCode).toBe(400)
    expect(JSON.stringify(response.json())).toContain('sub')
    expect(writes.length).toBe(before)
  })

  it('refuses a body that is not there at all', async () => {
    const { app: server, cookie } = customerServer({
      callerRoles: ['customerservice'],
      subjects: ['other'],
    })
    const response = await server.inject({
      method: 'PUT',
      url: '/customer',
      headers: { cookie },
    })

    // 400 either way — Fastify's own body check or the handler's. What matters is that a
    // missing body is not a crash and not a write.
    expect(response.statusCode).toBe(400)
  })

  it('never writes a plan for an account the request did not name', async () => {
    // `setPlan` spreads the stored document, so `roles` and `type` cannot come from a body -
    // and this asserts that the route does not hand them over either. An operator who could
    // set `roles` could mint more operators, and then the role gate above means nothing.
    const {
      app: server,
      cookie,
      writes,
    } = customerServer({
      callerRoles: ['customerservice'],
      subjects: ['other'],
    })
    const response = await put(
      server,
      { sub: 'other', plan: 'pro', roles: ['_admin'], type: 'evil', displayName: 'pwned' },
      cookie,
    )

    expect(response.statusCode).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ name: 'other', roles: [], type: 'user', plan: 'pro' })
    expect(writes[0]?.displayName).toBe('other')
  })
})

describe('what the contract says about PUT /customer', () => {
  const operations = operationsOf(loadContract())

  it('describes the operation', () => {
    // The positive control. Task 5 found that `validate(x, undefined)` reports nothing wrong,
    // so a contract assertion that looked a schema up by a method the contract did not describe
    // passed while checking nothing. Asserting the operation was found comes first.
    expect(operations.map((operation) => `${operation.method} ${operation.path}`)).toContain(
      'PUT /customer',
    )
  })

  it('declares the answers the handler actually gives', async () => {
    const declared = operations.find(
      (operation) => operation.method === 'PUT' && operation.path === '/customer',
    )
    expect(declared, 'the contract describes no PUT /customer').toBeDefined()

    const { app: server, cookie } = customerServer({
      callerRoles: ['customerservice'],
      subjects: ['other'],
    })
    const response = await put(server, { sub: 'other', plan: 'user' }, cookie)

    const schema = declared?.responses[String(response.statusCode)]
    expect(
      schema,
      `the contract declares no ${response.statusCode} for PUT /customer`,
    ).toBeDefined()
    expect(validate(response.json(), schema)).toEqual([])
  })
})
