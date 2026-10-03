import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { denyList } from '../../src/auth/deny-list.js'
import { mintToken, signingKeyFromPem, verifyToken } from '../../src/auth/jwt.js'
import { refreshStore } from '../../src/auth/refresh-store.js'
import { buildServer, type Server } from '../../src/server.js'
import { forgetUsersDatabase, USERS_DB } from '../../src/users/database.js'
import { recordEnsurer } from '../../src/users/ensure.js'
import { userDocId } from '../../src/users/key.js'
import { isLocale, type Profile, planOf, userRecords } from '../../src/users/records.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'
import { fakeCouch as supportCouch } from '../support/couch.js'
import { accessTokenFor } from '../support/tokens.js'

function newKey(kid = 'ec-test') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(kid, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

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
