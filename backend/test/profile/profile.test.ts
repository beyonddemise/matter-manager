import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mintToken, signingKeyFromPem } from '../../src/auth/jwt.js'
import type { Identity } from '../../src/auth/oidc.js'
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
  function serve(seed = storedAda({ locale: 'de' })) {
    const key = newKey()
    const { couch, writes } = fakeCouch(seed)
    app = buildServer({ logger: false, profile: { store: profileStore(couch), sessionKey: key } })
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
    // `openapi.yaml` cannot drift apart quietly.
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'GET' && operation.path === '/profile',
    )?.responses['200']
    // Asserted before it is used, for the same reason the PATCH test below gives: `validate`
    // against an undefined schema finds nothing wrong, so a contract that no longer described
    // this method and path would make the line after this one pass while checking nothing.
    expect(schema).toBeDefined()
    expect(validate(response.json(), schema)).toEqual([])
  })

  it('reports the plan and the capacity that goes with it', async () => {
    // The page has to render "3 of 5 used" before it has tried to create anything, so the limit
    // arrives with the profile. The alternative is a copy of PROJECT_LIMITS in the browser -
    // the duplication ADR 0009 exists to prevent - and the copy is the one that would be wrong
    // the first time a tier changed.
    const { app: server, cookie } = serve(storedAda({ locale: 'de', plan: 'member' }))
    const body = (
      await server.inject({ method: 'GET', url: '/profile', headers: { cookie } })
    ).json() as Profile

    expect(body.plan).toBe('member')
    expect(body.projectLimit).toBe(5)
  })

  it('reports -1 rather than null or an absence for an unlimited plan', async () => {
    // The page interprets this through the same rule the policy does, so it has to arrive in
    // one shape. A null or a missing key would make a client handle two shapes to learn one
    // fact - and `null` is exactly what a limit computed as `Infinity` would serialise to, so
    // this is the assertion that keeps the sentinel a sentinel.
    //
    // `toBe` is `Object.is`, so this one line already refuses `null`, `undefined` and an absent
    // key; it does not need three assertions to say so.
    const { app: server, cookie } = serve(storedAda({ locale: 'de', plan: 'pro' }))
    const body = (
      await server.inject({ method: 'GET', url: '/profile', headers: { cookie } })
    ).json() as Profile

    expect(body.projectLimit).toBe(-1)
  })

  it('would notice a contract that stopped describing the plan and the limit', async () => {
    // The negative control for the two tests above, and it is not decoration: `validate`
    // tolerates properties the contract does not declare, so removing `plan` and `projectLimit`
    // from the `Profile` schema would leave every other assertion in this file green while the
    // contract went silent about two fields that three operations return. What pins them is that
    // they are **required** - so this asserts what the contract does to a profile without them.
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
    const { app: server, cookie } = serve()
    const response = await server.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { locale: 'en' },
    })

    expect(response.statusCode).toBe(200)
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'PATCH' && operation.path === '/profile',
    )?.responses['200']
    // Asserted before it is used: `validate` against an undefined schema finds nothing wrong, so
    // a contract that no longer describes this method and path would make the check below pass
    // while checking nothing — which is exactly what renaming `put` to `patch` would have done.
    expect(schema).toBeDefined()
    expect(validate(response.json(), schema)).toEqual([])
    expect((response.json() as Profile).locale).toBe('en')
  })

  it('refuses without a session', async () => {
    const { app: server } = serve()

    expect((await server.inject({ method: 'GET', url: '/profile' })).statusCode).toBe(401)
    expect(
      (
        await server.inject({
          method: 'PATCH',
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
      method: 'PATCH',
      url: '/profile',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { locale: 'en', sub: 'google|victim', name: 'attacker' },
    })

    expect(writes[0]?.name).toBe('google|1234')
    expect(writes[0]?._id).toBe('org.couchdb.user:google|1234')
  })

  it.each([
    ['a locale the interface does not have', { locale: 'fr' }],
    ['a locale that is not a string', { locale: 42 }],
    ['a locale explicitly set to nothing', { locale: null }],
  ])('refuses %s, naming the field', async (_case, payload) => {
    const { app: server, cookie } = serve()
    const response = await server.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { cookie, 'content-type': 'application/json' },
      payload,
    })

    expect(response.statusCode).toBe(400)
    expect(JSON.stringify(response.json())).toContain('locale')
  })

  it('keeps the stored locale when the request does not mention one', async () => {
    // What "no locale at all" became. Under PUT that was a 400; under PATCH it is a request
    // that changes something else, and the stored preference has to survive it. Defaulting to
    // `auto` here instead would silently return a German speaker to whatever their browser
    // says the first time they edited their display name.
    const { app: server, cookie, writes } = serve()
    const response = await server.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { displayName: 'Ada Lovelace' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.json() as Profile).locale).toBe('de')
    expect(writes[0]?.locale).toBe('de')
    expect(writes[0]?.displayName).toBe('Ada Lovelace')
  })

  it('leaves a display name alone when the request does not mention one', async () => {
    // What a form that only changed the language sends. An empty display name is a name nobody
    // has, so it is treated the same way.
    const { app: server, cookie, writes } = serve()
    await server.inject({
      method: 'PATCH',
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

describe('the plan a PATCH may carry', () => {
  /**
   * A server whose one user holds exactly `roles`, has a stored locale and has never been given
   * a plan.
   *
   * Separate from `serve` above because these tests are about *whose* roles the gate reads, so
   * the roles have to be the parameter rather than Ada's fixed `project_x_reader`.
   */
  function serveWithRoles(roles: readonly string[]) {
    const key = newKey()
    const { couch } = fakeCouch({
      [`_users/${userDocumentId('user-1')}`]: {
        _id: userDocumentId('user-1'),
        _rev: '1-a',
        name: 'user-1',
        roles,
        type: 'user',
        email: 'user-1@example.test',
        displayName: 'User One',
        locale: 'de',
      },
    })
    const store = profileStore(couch)
    app = buildServer({ logger: false, profile: { store, sessionKey: key } })
    const token = mintToken(key, {
      purpose: 'session',
      sub: 'user-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    return {
      app,
      cookie: `mm_session=${encodeURIComponent(token)}`,
      // Read back through the store rather than out of the raw document, so a document with no
      // `plan` at all reads as `free` here the same way it reads as `free` everywhere else.
      storedPlan: async () => (await store.read('user-1'))?.plan,
    }
  }

  /** One PATCH, since every test below is the same request with a different body. */
  const patch = (server: Server, cookie: string, payload: Record<string, unknown>) =>
    server.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { cookie, 'content-type': 'application/json' },
      payload,
    })

  it('changes the locale without requiring anything else', async () => {
    // PATCH because the semantics were already partial: the old handler treated an absent
    // displayName as "leave it alone" while requiring locale on every request.
    const { app: server, cookie } = serveWithRoles([])
    const response = await patch(server, cookie, { locale: 'en' })

    expect(response.statusCode).toBe(200)
    expect((response.json() as Profile).locale).toBe('en')
  })

  it('answers 200 to a body that changes nothing', async () => {
    // Every field is optional, so an empty body is a PATCH that changes nothing — which is a
    // request, not a mistake. The contract declared `requestBody: required: true` against this
    // behaviour until now, and a client generated from it would have refused to send a request
    // this service accepts. Asserted here so the contract cannot drift back.
    const { app: server, cookie } = serveWithRoles([])
    const response = await patch(server, cookie, {})

    expect(response.statusCode).toBe(200)
    // The profile as it stands, not a default. A handler that treated an absent locale as
    // `auto` would return a German speaker to whatever their browser says the first time they
    // saved a form that changed nothing.
    expect((response.json() as Profile).locale).toBe('de')
  })

  it('refuses a plan from an ordinary user, and does not quietly ignore it', async () => {
    // Silently dropping the field would be the wrong refusal: a caller that asked for something
    // and was not told it was refused concludes the field does not exist.
    const { app: server, cookie, storedPlan } = serveWithRoles([])
    const response = await patch(server, cookie, { plan: 'pro' })

    expect(response.statusCode).toBe(403)
    expect(JSON.stringify(response.json())).toContain('not-an-operator')
    expect(await storedPlan()).toBe('free')
  })

  it('answers the refusal the contract declares, reason and all', async () => {
    // The 403 validated against the contract rather than against a hand-written shape. Until
    // this task no error response in the contract had ever been checked by anything:
    // `operationsOf` collected only `application/json`, and every refusal here is declared
    // `application/problem+json`, so the lookup returned `undefined` and `validate` found
    // nothing wrong with it.
    const { app: server, cookie } = serveWithRoles([])
    const response = await patch(server, cookie, { plan: 'pro' })

    expect(response.statusCode).toBe(403)
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'PATCH' && operation.path === '/profile',
    )?.responses['403']
    expect(schema, 'the contract declares no 403 for PATCH /profile').toBeDefined()
    expect(validate(response.json(), schema)).toEqual([])
  })

  it('would notice a refusal that stopped naming itself', async () => {
    // The negative control for the test above, and the reason it exists is that the positive
    // one cannot fail for the thing that matters: `validate` ignores properties the contract
    // does not declare, so dropping `reason` from the 403 schema would leave the handler's real
    // answer validating perfectly against a contract that no longer described the field phase
    // 2's projects page branches on.
    //
    // So this asserts the two ways the contract can stop pinning it: the field leaving
    // `required`, and the `const` naming a different refusal.
    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'PATCH' && operation.path === '/profile',
    )?.responses['403']
    expect(schema).toBeDefined()

    expect(validate({ title: 'No', status: 403 }, schema)).toEqual([
      { at: '$.reason', says: 'is required and missing' },
    ])
    // The other operation's reason, which is the mistake a copy-paste makes. A 403 that says
    // `project-limit-reached` would send a page to offer an upgrade for a permission problem.
    expect(validate({ title: 'No', status: 403, reason: 'project-limit-reached' }, schema)).toEqual(
      [{ at: '$.reason', says: 'must be "not-an-operator", got "project-limit-reached"' }],
    )
  })

  it('accepts a plan from a role holder', async () => {
    const { app: server, cookie, storedPlan } = serveWithRoles(['customerservice'])
    const response = await patch(server, cookie, { plan: 'pro' })

    expect(response.statusCode).toBe(200)
    expect(await storedPlan()).toBe('pro')
    // The body has to agree with the store. The handler writes the plan and *then* updates the
    // profile, so a second write built on a stale document would answer `free` to a request
    // that had just succeeded.
    expect((response.json() as Profile).plan).toBe('pro')
  })

  it('refuses a plan from a caller holding CouchDB’s `_admin` role', async () => {
    // `_admin` was on OPERATOR_ROLES and has been deliberately removed, so this pins the
    // decision rather than merely dropping the coverage that asserted the opposite.
    //
    // Two facts make putting it back a mistake. `rolesOf` reads the caller's `_users` document
    // and nothing else, and a CouchDB *server* admin is configured in `local.ini [admins]` with
    // no `_users` document at all — so listing the role never admitted the administrator it
    // looked like it was for. The only account it could match is one with `roles: ["_admin"]`
    // written into its document, and `infra/couchdb/design-docs/access.js` gives that role an
    // unconditional bypass of `validate_doc_update` on every project database in the
    // deployment. So the entry admitted nobody who needed it and, if it ever did fire, only an
    // account that could already write any document belonging to anybody.
    const { app: server, cookie, storedPlan } = serveWithRoles(['_admin'])
    const response = await patch(server, cookie, { plan: 'member' })

    expect(response.statusCode).toBe(403)
    expect(JSON.stringify(response.json())).toContain('not-an-operator')
    // The store, not only the status. A handler that refused *after* writing would read as
    // correct from the outside, which is the failure every test in this file guards against.
    expect(await storedPlan()).toBe('free')
  })

  it.each([['customerservices'], ['Customerservice'], ['customer'], ['CUSTOMERSERVICE']])(
    'refuses a plan from somebody whose only role is %s',
    async (role) => {
      // `customerservices` is somebody else's role and `Customerservice` is a typo. Either
      // passing would make the gate an approximation of itself: a substring test lets the
      // plural and the prefix through, and a case fold lets the typo through.
      const { app: server, cookie, storedPlan } = serveWithRoles([role])
      const response = await patch(server, cookie, { plan: 'pro' })

      expect(response.statusCode).toBe(403)
      expect(await storedPlan()).toBe('free')
    },
  )

  it('refuses a plan string it does not know', async () => {
    const { app: server, cookie, storedPlan } = serveWithRoles(['customerservice'])
    const response = await patch(server, cookie, { plan: 'enterprise' })

    expect(response.statusCode).toBe(400)
    expect(JSON.stringify(response.json())).toContain('plan')
    expect(await storedPlan()).toBe('free')
  })

  it('applies a locale and a plan from one request', async () => {
    // Both fields in one body, because the plan is written by `setPlan` and the locale by
    // `update` — two writes, and the second must not undo the first.
    const { app: server, cookie, storedPlan } = serveWithRoles(['customerservice'])
    const response = await patch(server, cookie, { locale: 'en', plan: 'pro' })

    expect(response.statusCode).toBe(200)
    expect((response.json() as Profile).locale).toBe('en')
    expect(await storedPlan()).toBe('pro')
  })

  it('applies nothing at all when the plan is refused', async () => {
    // All or nothing. Applying the locale and refusing the plan would answer 403 to a request
    // that had in fact changed something, and the caller would have no way to know which half
    // landed.
    const { app: server, cookie, storedPlan } = serveWithRoles([])
    const response = await patch(server, cookie, { locale: 'en', plan: 'pro' })

    expect(response.statusCode).toBe(403)
    expect(await storedPlan()).toBe('free')
    const after = await server.inject({ method: 'GET', url: '/profile', headers: { cookie } })
    expect((after.json() as Profile).locale).toBe('de')
  })

  it('writes no plan at all when the request does not mention one', async () => {
    // The gate is only reached by a request that asked for a plan. An ordinary locale change
    // from a user with no roles must not be refused, which is the regression a role check
    // placed above the `plan !== undefined` guard would cause.
    const { app: server, cookie, storedPlan } = serveWithRoles([])

    expect((await patch(server, cookie, { locale: 'en' })).statusCode).toBe(200)
    expect(await storedPlan()).toBe('free')
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
