import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { denyList } from '../../src/auth/deny-list.js'
import { mintToken, signingKeyFromPem, verifyToken } from '../../src/auth/jwt.js'
import type { Identity } from '../../src/auth/oidc.js'
import { refreshStore } from '../../src/auth/refresh-store.js'
import type { CouchClient, Revision } from '../../src/couch/client.js'
import {
  isLocale,
  type Profile,
  profileStore,
  type UnknownPlanReporter,
  UnknownSubjectError,
  userDocumentId,
} from '../../src/profile/store.js'
import { buildServer, type Server } from '../../src/server.js'
import { forgetUsersDatabase, USERS_DB } from '../../src/users/database.js'
import { recordEnsurer } from '../../src/users/ensure.js'
import { userDocId } from '../../src/users/key.js'
import { planOf, userRecords } from '../../src/users/records.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'
import { fakeCouch as supportCouch } from '../support/couch.js'
import { accessTokenFor } from '../support/tokens.js'

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

/**
 * A `profileStore` over the fake CouchDB, seeded with zero or one `_users` document at the id
 * CouchDB itself would use. Kept separate from `storedAda`/`fakeCouch` above because the plan
 * tests below care only about one document's fields, not Ada's full fixture shape.
 */
function storeWith(
  document?: { name: string; roles: string[]; type: 'user'; plan?: string },
  // A no-op by default, so the suite is not narrated by the unknown-plan warning. The real
  // default — a line on stderr — is asserted directly in `the unknown-plan warning` below,
  // because a reporter nobody ever calls is the failure this parameter exists to make visible.
  reportUnknownPlan: UnknownPlanReporter = () => undefined,
) {
  const seed =
    document === undefined
      ? {}
      : {
          [`_users/${userDocumentId(document.name)}`]: {
            _id: userDocumentId(document.name),
            _rev: '1-a',
            ...document,
          },
        }
  const { couch } = fakeCouch(seed)
  return profileStore(couch, reportUnknownPlan)
}

const ADA_DOC = `_users/${userDocumentId('google|1234')}`

const storedAda = (extra: Record<string, unknown> = {}) => ({
  [ADA_DOC]: {
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

const ADA = { sub: 'google|1234', email: 'ada@example.com', name: 'Ada' }

/**
 * The service with only `/profile` wired, over a fake CouchDB holding `matter_manager`.
 *
 * Returns the parts a test seeds or inspects, because the interesting assertions are about what
 * the record store ended up holding. `edit` is the Fauxton equivalent: roles and plans are
 * granted by editing the document, never through the API.
 */
function profileServer() {
  forgetUsersDatabase()
  const now = () => Math.floor(Date.now() / 1000)
  const fake = supportCouch()
  const records = userRecords(fake.couch)
  const refresh = refreshStore(records, now)
  const deny = denyList(now)
  const key = newKey()
  app = buildServer({
    logger: false,
    profile: { records, ensureRecord: recordEnsurer(records, refresh), key, deny },
  })
  return {
    app,
    key,
    records,
    refresh,
    deny,
    fake,
    edit: (email: string, fields: Record<string, unknown>) => {
      const id = `${USERS_DB}/${userDocId(email)}`
      const document = fake.documents.get(id)
      if (document === undefined) throw new Error(`no record to edit for ${email}`)
      fake.documents.set(id, { ...document, ...fields })
    },
  }
}

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

    // Exhaustive rather than `toMatchObject`, which is why adding `projectLimit` to the profile
    // had to be admitted here. A field the store reports and nothing asserts is a field that can
    // change shape without a test noticing.
    expect(await profileStore(couch).read('google|1234')).toEqual({
      sub: 'google|1234',
      email: 'ada@example.com',
      displayName: 'Ada',
      locale: 'de',
      plan: 'free',
      projectLimit: 1,
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
  const authorization = (server: ReturnType<typeof profileServer>, who = ADA) => ({
    authorization: `Bearer ${accessTokenFor(server.key, who)}`,
  })

  it('answers GET with what the contract declares', async () => {
    const server = profileServer()
    await server.records.ensure({ email: ADA.email, sub: ADA.sub, name: 'Ada' })
    const response = await server.app.inject({
      method: 'GET',
      url: '/profile',
      headers: authorization(server),
    })

    expect(response.statusCode).toBe(200)

    // Against the contract's own schema rather than a hand-written shape, so this endpoint and
    // `openapi.yaml` cannot drift apart quietly.
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'GET' && operation.path === '/profile',
    )?.responses['200']
    // Asserted before it is used: `validate` against an undefined schema finds nothing wrong.
    expect(schema).toBeDefined()
    expect(validate(response.json(), schema)).toEqual([])
  })

  it('answers GET /profile from the token for a user with no record, and creates none', async () => {
    // Signing in alone must not create a record (records are created on demand), so a
    // read of the profile has to be answerable from the token's claims.
    const { app, key, fake } = profileServer()
    const res = await app.inject({
      method: 'GET',
      url: '/profile',
      headers: { authorization: `Bearer ${accessTokenFor(key, ADA)}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ email: ADA.email, plan: 'free', projectLimit: 1 })
    expect([...fake.documents.keys()].some((k) => k.includes('/user:'))).toBe(false)
  })

  it.each([
    ['member', 5],
    ['pro', -1],
  ])('reports the %s plan and the capacity that goes with it (%i)', async (plan, limit) => {
    // The page renders "3 of 5 used" before it has tried to create anything, so the limit
    // arrives with the profile. -1 is the sentinel for unlimited: `toBe` is `Object.is`, so this
    // one assertion refuses `null`, `undefined` and an absent key.
    const server = profileServer()
    await server.records.ensure({ email: ADA.email, sub: ADA.sub })
    server.edit(ADA.email, { plan })
    const body = (
      await server.app.inject({ method: 'GET', url: '/profile', headers: authorization(server) })
    ).json() as Profile

    expect(body.plan).toBe(plan)
    expect(body.projectLimit).toBe(limit)
  })

  it('would notice a contract that stopped describing the plan and the limit', async () => {
    // The negative control for the contract test above: `validate` tolerates properties the
    // contract does not declare, so what pins `plan` and `projectLimit` is that they are
    // **required**.
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'GET' && operation.path === '/profile',
    )?.responses['200']
    expect(schema).toBeDefined()

    expect(
      validate({ sub: 'a', email: 'a@b.test', displayName: 'A', locale: 'auto' }, schema),
    ).toEqual([
      { at: '$.plan', says: 'is required and missing' },
      { at: '$.projectLimit', says: 'is required and missing' },
    ])
  })

  it('answers PATCH with what the contract declares', async () => {
    const server = profileServer()
    const response = await server.app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: authorization(server),
      payload: { locale: 'en' },
    })

    expect(response.statusCode).toBe(200)
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'PATCH' && operation.path === '/profile',
    )?.responses['200']
    expect(schema).toBeDefined()
    expect(validate(response.json(), schema)).toEqual([])
    expect((response.json() as Profile).locale).toBe('en')
  })

  it('creates the record on PATCH /profile and keeps the refresh session alive', async () => {
    const { app, key, records, refresh } = profileServer()
    await refresh.remember(ADA.email, { hash: 'h', exp: 9_999_999_999, createdAt: 0 })
    const res = await app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { authorization: `Bearer ${accessTokenFor(key, ADA)}` },
      payload: { locale: 'de' },
    })
    expect(res.statusCode).toBe(200)
    expect((await records.read(ADA.email))?.locale).toBe('de')
    expect(await records.hasRefresh(ADA.email, 'h', 0)).toBe(true)
  })

  it('refuses the session-era cookie: only a bearer authenticates', async () => {
    const { app } = profileServer()
    const res = await app.inject({
      method: 'GET',
      url: '/profile',
      headers: { cookie: 'mm_session=anything' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses without a bearer', async () => {
    const { app } = profileServer()

    expect((await app.inject({ method: 'GET', url: '/profile' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'PATCH', url: '/profile', payload: { locale: 'en' } }))
        .statusCode,
    ).toBe(401)
  })

  it('refuses a token that carries no email, because every record lookup needs one', async () => {
    const server = profileServer()
    const token = mintToken(server.key, {
      purpose: 'access',
      sub: ADA.sub,
      jti: 'no-email',
      exp: Math.floor(Date.now() / 1000) + 300,
    })
    const res = await server.app.inject({
      method: 'GET',
      url: '/profile',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses a denied access token', async () => {
    const { app, key, deny } = profileServer()
    const token = accessTokenFor(key, ADA)
    const { jti, exp } = verifyToken(token, key.publicKey, 'access')
    deny.deny(String(jti), exp)
    for (const method of ['GET', 'PATCH'] as const) {
      expect(
        (
          await app.inject({
            method,
            url: '/profile',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(401)
    }
  })

  it('takes the identity from the token, never from the body', async () => {
    // A profile endpoint that accepted an arbitrary subject or address would be an
    // account-takeover primitive: send somebody else's, change their settings.
    const server = profileServer()
    await server.app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: authorization(server),
      payload: { locale: 'en', sub: 'google|victim', email: 'victim@example.test' },
    })

    expect((await server.records.read(ADA.email))?.sub).toBe(ADA.sub)
    expect(await server.records.read('victim@example.test')).toBeUndefined()
  })

  it.each([
    ['a locale the interface does not have', { locale: 'fr' }],
    ['a locale that is not a string', { locale: 42 }],
    ['a locale explicitly set to nothing', { locale: null }],
  ])('refuses %s, naming the field, and stores nothing', async (_case, payload) => {
    const server = profileServer()
    const response = await server.app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: authorization(server),
      payload,
    })

    expect(response.statusCode).toBe(400)
    expect(JSON.stringify(response.json())).toContain('locale')
    expect(await server.records.read(ADA.email)).toBeUndefined()
  })

  it('keeps the stored locale when the request does not mention one', async () => {
    // Under PATCH an absent field is one the caller is not changing; defaulting to `auto` would
    // return a German speaker to their browser's language the first time they edited a name.
    const server = profileServer()
    await server.records.ensure({ email: ADA.email, sub: ADA.sub, name: 'Ada' })
    await server.records.update(ADA.email, { locale: 'de' })
    const response = await server.app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: authorization(server),
      payload: { displayName: 'Ada Lovelace' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.json() as Profile).locale).toBe('de')
    expect((response.json() as Profile).displayName).toBe('Ada Lovelace')
  })

  it('leaves a display name alone when the request does not mention one', async () => {
    const server = profileServer()
    await server.records.ensure({ email: ADA.email, sub: ADA.sub, name: 'Ada' })
    await server.app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: authorization(server),
      payload: { locale: 'en', displayName: '   ' },
    })

    expect((await server.records.read(ADA.email))?.displayName).toBe('Ada')
  })

  it('is never stored in a shared cache', async () => {
    const server = profileServer()
    const response = await server.app.inject({
      method: 'GET',
      url: '/profile',
      headers: authorization(server),
    })

    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers['cache-control']).toContain('private')
  })
})

describe('the plan a PATCH may carry', () => {
  /** A server whose one user holds exactly `roles` on their record, with a stored locale of `de`. */
  async function serveWithRoles(roles: readonly string[]) {
    const server = profileServer()
    await server.records.ensure({ email: ADA.email, sub: ADA.sub, name: 'Ada' })
    await server.records.update(ADA.email, { locale: 'de' })
    // Fauxton's equivalent: no API can grant a role, so the test edits the document directly.
    server.edit(ADA.email, { roles })
    return {
      ...server,
      headers: authorization(server),
      storedPlan: async () => planOf(await server.records.read(ADA.email)),
    }
  }

  const authorization = (server: ReturnType<typeof profileServer>) => ({
    authorization: `Bearer ${accessTokenFor(server.key, ADA)}`,
  })

  /** One PATCH, since every test below is the same request with a different body. */
  const patch = (
    server: Awaited<ReturnType<typeof serveWithRoles>>,
    payload: Record<string, unknown>,
  ) => server.app.inject({ method: 'PATCH', url: '/profile', headers: server.headers, payload })

  it('changes the locale without requiring anything else', async () => {
    const server = await serveWithRoles([])
    const response = await patch(server, { locale: 'en' })

    expect(response.statusCode).toBe(200)
    expect((response.json() as Profile).locale).toBe('en')
  })

  it('answers 200 to a body that changes nothing, and reports the profile as it stands', async () => {
    // Every field is optional, so an empty body is a request, not a mistake. A handler that
    // treated an absent locale as `auto` would reset a German speaker on a no-op save.
    const server = await serveWithRoles([])
    const response = await patch(server, {})

    expect(response.statusCode).toBe(200)
    expect((response.json() as Profile).locale).toBe('de')
  })

  it('refuses plan from a caller without customerservice, and stores nothing', async () => {
    const { app, key, records } = profileServer()
    const res = await app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { authorization: `Bearer ${accessTokenFor(key, ADA)}` },
      payload: { plan: 'pro', locale: 'de' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ reason: 'not-an-operator' })
    expect(await records.read(ADA.email)).toBeUndefined()
  })

  it('refuses a plan from an ordinary user with a record, and does not quietly ignore it', async () => {
    const server = await serveWithRoles([])
    const response = await patch(server, { plan: 'pro' })

    expect(response.statusCode).toBe(403)
    expect(JSON.stringify(response.json())).toContain('not-an-operator')
    expect(await server.storedPlan()).toBe('free')
  })

  it('answers the refusal the contract declares, reason and all', async () => {
    const server = await serveWithRoles([])
    const response = await patch(server, { plan: 'pro' })

    expect(response.statusCode).toBe(403)
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'PATCH' && operation.path === '/profile',
    )?.responses['403']
    expect(schema, 'the contract declares no 403 for PATCH /profile').toBeDefined()
    expect(validate(response.json(), schema)).toEqual([])
  })

  it('would notice a refusal that stopped naming itself', async () => {
    // The negative control for the test above: `validate` ignores undeclared properties, so
    // dropping `reason` from the 403 schema would leave the real answer validating. This asserts
    // the two ways the contract can stop pinning it.
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'PATCH' && operation.path === '/profile',
    )?.responses['403']
    expect(schema).toBeDefined()

    expect(validate({ title: 'No', status: 403 }, schema)).toEqual([
      { at: '$.reason', says: 'is required and missing' },
    ])
    expect(validate({ title: 'No', status: 403, reason: 'project-limit-reached' }, schema)).toEqual(
      [{ at: '$.reason', says: 'must be "not-an-operator", got "project-limit-reached"' }],
    )
  })

  it('accepts a plan from a role holder', async () => {
    const server = await serveWithRoles(['customerservice'])
    const response = await patch(server, { plan: 'pro' })

    expect(response.statusCode).toBe(200)
    expect(await server.storedPlan()).toBe('pro')
    // The body must agree with the store: a second write built on a stale record would answer
    // `free` to a request that had just succeeded.
    expect((response.json() as Profile).plan).toBe('pro')
  })

  it('refuses a plan from a caller holding CouchDB’s `_admin` role', async () => {
    // `_admin` is deliberately not in OPERATOR_ROLES. A record carrying it would be granted every
    // project database by `access.js`, and a real CouchDB server admin has no record at all, so
    // listing it never admitted the administrator it looked like it was for.
    const server = await serveWithRoles(['_admin'])
    const response = await patch(server, { plan: 'member' })

    expect(response.statusCode).toBe(403)
    expect(JSON.stringify(response.json())).toContain('not-an-operator')
    expect(await server.storedPlan()).toBe('free')
  })

  it.each([['customerservices'], ['Customerservice'], ['customer'], ['CUSTOMERSERVICE']])(
    'refuses a plan from somebody whose only role is %s',
    async (role) => {
      // Exact membership: a substring test lets the plural through, a case fold the typo.
      const server = await serveWithRoles([role])
      const response = await patch(server, { plan: 'pro' })

      expect(response.statusCode).toBe(403)
      expect(await server.storedPlan()).toBe('free')
    },
  )

  it('refuses a plan string it does not know', async () => {
    const server = await serveWithRoles(['customerservice'])
    const response = await patch(server, { plan: 'enterprise' })

    expect(response.statusCode).toBe(400)
    expect(JSON.stringify(response.json())).toContain('plan')
    expect(await server.storedPlan()).toBe('free')
  })

  it('applies a locale and a plan from one request', async () => {
    // Two writes (`setPlan`, then `update`); the second must not undo the first.
    const server = await serveWithRoles(['customerservice'])
    const response = await patch(server, { locale: 'en', plan: 'pro' })

    expect(response.statusCode).toBe(200)
    expect((response.json() as Profile).locale).toBe('en')
    expect(await server.storedPlan()).toBe('pro')
  })

  it('applies nothing at all when the plan is refused', async () => {
    // All or nothing: a 403 that had in fact changed the locale leaves the caller unable to know
    // which half landed.
    const server = await serveWithRoles([])
    const response = await patch(server, { locale: 'en', plan: 'pro' })

    expect(response.statusCode).toBe(403)
    expect(await server.storedPlan()).toBe('free')
    const after = await server.app.inject({
      method: 'GET',
      url: '/profile',
      headers: server.headers,
    })
    expect((after.json() as Profile).locale).toBe('de')
  })

  it('writes no plan at all when the request does not mention one', async () => {
    // An ordinary locale change from a user with no roles must not be refused: the regression a
    // role check placed above the `plan !== undefined` guard would cause.
    const server = await serveWithRoles([])

    expect((await patch(server, { locale: 'en' })).statusCode).toBe(200)
    expect(await server.storedPlan()).toBe('free')
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

describe('the plan on a user document', () => {
  it('reads free when the document has never been given one', async () => {
    // Nothing is migrated. A user who predates capacity, or whom no operator has touched,
    // reads correctly rather than reading undefined.
    const store = storeWith({ name: 'user-1', roles: [], type: 'user' })
    expect((await store.read('user-1'))?.plan).toBe('free')
  })

  it('reads the plan an operator wrote', async () => {
    const store = storeWith({ name: 'user-1', roles: [], type: 'user', plan: 'pro' })
    expect((await store.read('user-1'))?.plan).toBe('pro')
  })

  it('falls back to free for a plan string the code does not know', async () => {
    // `plan` is hand-edited into CouchDB by an operator, so "Pro", "premium" and typos will
    // happen. An unknown string must not become a lookup miss: PROJECT_LIMITS[plan] would be
    // undefined, every comparison against it false, and the account either crashes a request
    // or is silently granted something. Free is the safe reading of "I do not know".
    const store = storeWith({ name: 'user-1', roles: [], type: 'user', plan: 'Pro' })
    expect((await store.read('user-1'))?.plan).toBe('free')
  })

  it('reports the roles CouchDB holds', async () => {
    const store = storeWith({ name: 'user-1', roles: ['customerservice'], type: 'user' })
    expect(await store.rolesOf('user-1')).toEqual(['customerservice'])
  })

  it('reports no roles for a subject with no document', async () => {
    // The gate asks this before it knows whether the subject exists, and an absent user has no
    // roles rather than an error - the 404 belongs to the route, not to a role check.
    const store = storeWith()
    expect(await store.rolesOf('nobody')).toEqual([])
  })

  it('does not take roles or type from an ordinary update', async () => {
    // This is the property the whole role gate rests on: a user cannot grant themselves the
    // role that would let them set their plan. It is true today by construction - `update`
    // spreads the existing document and applies named fields - and this test is about the
    // tidying refactor that replaces those named fields with a spread of the request body.
    const store = storeWith({ name: 'user-1', roles: ['customerservice'], type: 'user' })
    await store.update('user-1', {
      locale: 'de',
      ...({ roles: ['_admin'], type: 'evil', plan: 'pro' } as object),
    })
    const stored = await store.read('user-1')
    expect(await store.rolesOf('user-1')).toEqual(['customerservice'])
    expect(stored?.plan).toBe('free')
  })

  it('sets a plan through the path meant for it', async () => {
    const store = storeWith({ name: 'user-1', roles: [], type: 'user' })
    expect((await store.setPlan('user-1', 'member')).plan).toBe('member')
    expect((await store.read('user-1'))?.plan).toBe('member')
  })

  it('names the failure when the subject has no document at all', async () => {
    // `PUT /customer` answers 404 rather than 500 for a subject who has never signed in, and it
    // decides that by the *class* of this error — `update` throws a bare `Error` for the same
    // condition, which a route cannot tell from a bug. So the class is the contract between the
    // store and the route, and nothing else asserted it: a `setPlan` that threw a plain Error
    // would leave the route's catch falling through to a 500 with every route test still green
    // except the one 404, and the reason would not be visible from there.
    const store = storeWith()

    await expect(store.setPlan('nobody', 'pro')).rejects.toBeInstanceOf(UnknownSubjectError)
    await expect(store.setPlan('nobody', 'pro')).rejects.toThrow('nobody')
  })
})

describe('the unknown-plan warning', () => {
  // The headline failure this whole field is guarded against: an operator hand-edits a `_users`
  // document, writes `Pro`, and the account goes on behaving as `free`. The narrowing is
  // correct and was silent, which made the one mistake the guard anticipates the one mistake
  // nothing could diagnose.

  it('names the account and the value when the plan is not one it knows', async () => {
    const seen: Array<{ sub: string; plan: string }> = []
    const store = storeWith({ name: 'user-1', roles: [], type: 'user', plan: 'Pro' }, (event) =>
      seen.push(event),
    )

    expect((await store.read('user-1'))?.plan).toBe('free')
    // Both fields, not merely that something was reported. A warning that said "unknown plan"
    // and named neither the account nor the value would send an operator to grep `_users`.
    expect(seen).toEqual([{ sub: 'user-1', plan: 'Pro' }])
  })

  it('says nothing when the document has no plan at all', async () => {
    // The reason the check is `plan !== undefined && !isPlan(plan)` rather than `!isPlan(plan)`.
    // Every account that has never been upgraded has no such field, so warning on an absent one
    // would emit a line per profile read — and a warning that fires constantly is a warning an
    // operator filters out, which leaves the real one unread.
    const seen: unknown[] = []
    const store = storeWith({ name: 'user-1', roles: [], type: 'user' }, (event) =>
      seen.push(event),
    )

    expect((await store.read('user-1'))?.plan).toBe('free')
    expect(seen).toEqual([])
  })

  it('says nothing about a plan it does know', async () => {
    const seen: unknown[] = []
    const store = storeWith({ name: 'user-1', roles: [], type: 'user', plan: 'pro' }, (event) =>
      seen.push(event),
    )

    expect((await store.read('user-1'))?.plan).toBe('pro')
    expect(seen).toEqual([])
  })

  it('warns from a plan read back after a write, not only from a fresh read', async () => {
    // `setPlan` returns `toProfile(document)` on the document it just wrote, and `update`
    // returns one too. Three paths produce a `Profile`, and a warning wired into one of them is
    // a warning that is absent from the other two — which is the shape of the bug the store's
    // own comment warns about for `projectLimit`.
    const seen: Array<{ sub: string; plan: string }> = []
    const store = storeWith({ name: 'user-1', roles: [], type: 'user', plan: 'premium' }, (event) =>
      seen.push(event),
    )

    await store.update('user-1', { locale: 'de' })
    expect(seen).toEqual([{ sub: 'user-1', plan: 'premium' }])
  })

  it('reports to stderr when nobody wires it anywhere else', async () => {
    // The default, asserted rather than assumed. A no-op default would mean the deployment that
    // forgot to wire a reporter has exactly the silence this exists to end — and the store is
    // built by `serverOptions` before `buildServer` exists, so the default is what production
    // actually runs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { couch } = fakeCouch({
        [`_users/${userDocumentId('user-1')}`]: {
          _id: userDocumentId('user-1'),
          _rev: '1-a',
          name: 'user-1',
          roles: [],
          type: 'user',
          plan: 'Pro',
        },
      })

      await profileStore(couch).read('user-1')

      expect(warn).toHaveBeenCalledTimes(1)
      // Parsed, not matched as text. The line is consumed by whatever collects stderr, so it
      // has to be one JSON object with the fields named — `toContain('Pro')` would pass for a
      // line that had the value in a message and nothing machine-readable in it.
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        level: 'warn',
        sub: 'user-1',
        plan: 'Pro',
      })
    } finally {
      warn.mockRestore()
    }
  })
})
