import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mintToken, type SigningKey } from '../../src/auth/jwt.js'
import { type CouchClient, CouchError } from '../../src/couch/client.js'
import type { Action, Plan, Principal } from '../../src/domain/index.js'
import { NotEntitledError, gate as realGate } from '../../src/entitlements/gate.js'
import { PROBLEM_JSON } from '../../src/problem.js'
import { profileStore, userDocumentId } from '../../src/profile/store.js'
import { forgetRegistry, REGISTRY_DATABASE } from '../../src/projects/registry.js'
import { buildServer, type Server } from '../../src/server.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'
import { type CouchFailures, type FakeCouch, fakeCouch } from '../support/couch.js'

const OWNER = 'google|1234'
/** The caller in the capacity tests. Distinct from {@link OWNER}, which owns nothing here. */
const SUBJECT = 'user-1'
const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'
const DATABASE = `project_${PROJECT_ID}`

function signingKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { kid: 'test', privateKey, publicKey }
}

const KEY = signingKey()

/** A valid access token for `sub`. */
const tokenFor = (sub: string) =>
  mintToken(KEY, { purpose: 'access', sub, exp: Math.floor(Date.now() / 1000) + 3600 })

/** The whole header value, for the requests that are written out rather than built by `create`. */
const bearer = (sub: string) => `Bearer ${tokenFor(sub)}`

/**
 * The contract's schema for one response, **asserted to exist** before it is handed back.
 *
 * `validate(value, undefined)` reports nothing wrong, so a lookup that misses — a path renamed,
 * a status removed from `openapi.yaml`, `operationsOf` changed — turns an assertion that checks
 * a response against the contract into an assertion that checks nothing, and does it while
 * staying green. This file had four unguarded lookups; `openapi-drift.test.ts` had four more,
 * and that is where the same helper and the same reasoning came from.
 *
 * A function rather than an `expect` line per lookup, because the guard has to be at *every*
 * lookup to be worth anything: here there is no way to get a schema without it.
 */
const contractSchema = (method: string, path: string, status: string): unknown => {
  const operation = operationsOf(loadContract()).find(
    (candidate) => candidate.method === method && candidate.path === path,
  )
  const schema = operation?.responses[status]
  expect(schema, `the contract declares no ${status} for ${method} ${path}`).toBeDefined()
  return schema
}

/**
 * A CouchDB whose registry writes always conflict.
 *
 * `fakeCouch` raises 409 on a stale `_rev`, which is correct and unreachable from here: every
 * retry loop in `members.ts` and `transfers.ts` re-reads the pointer at the top of each attempt,
 * so the `_rev` it writes back is always the current one. A **persistent** conflict is a
 * different thing — somebody else winning the race on all three attempts — and it is the only
 * way to reach the 409 those loops answer when they give up.
 *
 * Without it that branch is code no test can enter, and a status the contract cannot honestly
 * declare. Scoped to the registry so `_security` writes still land, and **design documents are
 * exempt**: `ensureRegistry` installs `_design/by_participant` through this same client, on the
 * way in, and conflicting that write made every request fail before it reached the handler - a
 * raw 500 from the bootstrap rather than the refusal under test. A design document is written
 * once at bootstrap and is not what two managers editing one project contend over.
 *
 * @param refused every registry write it turned down, in order. The count is the substance of
 *   the positive control: a handler that gave up on the first conflict would answer the same 409
 *   as one that retried, and only one of those is the behaviour `CONFLICT_ATTEMPTS` promises.
 *   Recorded here rather than read off `FakeCouch.calls`, because this wrapper refuses *before*
 *   delegating, so the fake underneath never sees the write and never records it.
 */
const conflictingRegistry = (couch: CouchClient, refused: string[]): CouchClient => ({
  ...couch,
  putDoc: async (database, document) => {
    if (database !== REGISTRY_DATABASE || document._id.startsWith('_design/')) {
      return couch.putDoc(database, document)
    }
    refused.push(document._id)
    throw new CouchError(409, 'conflict', `Document update conflict: ${document._id}`)
  },
})

let app: Server | undefined
let couch: FakeCouch

/** A server with the project routes wired to a fake CouchDB and a watchable gate. */
function server(
  options: { fails?: CouchFailures; gateRefuses?: boolean; registryConflicts?: boolean } = {},
) {
  couch = fakeCouch(options.fails === undefined ? {} : { fails: options.fails })
  const refused: string[] = []
  const client =
    options.registryConflicts === true ? conflictingRegistry(couch.couch, refused) : couch.couch
  const gateCalls: Array<{ principal: Principal; action: Action }> = []

  app = buildServer({
    logger: false,
    projects: {
      couch: client,
      key: KEY,
      validator: () => 'function (newDoc) { return newDoc }',
      // The real store against the fake CouchDB, so a test states a plan by seeding the
      // `_users` document an operator would have edited - rather than by stubbing the read
      // and proving only that a stub returns what it was given.
      profiles: profileStore(client),
      newId: () => PROJECT_ID,
      clock: () => '2026-08-27T09:00:00.000Z',
      // A spy *over* the real gate, not a stand-in for it. A recording gate that always
      // returned would let a capacity limit be absent from the policy table and leave every
      // test in this file green - which is the one failure ADR 0009's seam exists to prevent.
      gate: (principal, action, project) => {
        gateCalls.push({ principal, action })
        if (options.gateRefuses === true) throw new NotEntitledError(action)
        realGate(principal, action, project)
      },
      findUser: async (value: string) =>
        value.includes('grace')
          ? { sub: 'google|grace', email: 'grace@example.test' }
          : value === OWNER
            ? { sub: OWNER, email: 'ada@example.test' }
            : undefined,
      identityOf: async (sub: string) =>
        sub === 'google|grace'
          ? { sub, email: 'grace@example.test', emailVerified: true }
          : { sub, email: 'ada@example.test', emailVerified: true },
      millis: () => Date.parse('2026-08-27T09:00:00.000Z'),
    },
  })

  return { app, couch, gateCalls, refused, inject: app.inject.bind(app) }
}

/**
 * `POST /projects` as a signed-in caller. Pass `null` for nobody.
 *
 * `null` rather than `undefined`, because a default parameter treats an explicit `undefined` as
 * absent — so the "no token" cases sent one, and passed by creating a project.
 */
const create = (built: Server, body: unknown, sub: string | null = OWNER) =>
  built.inject({
    method: 'POST',
    url: '/projects',
    headers: sub === null ? {} : { authorization: `Bearer ${tokenFor(sub)}` },
    payload: body as Record<string, unknown>,
  })

beforeEach(() => {
  forgetRegistry()
})

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('creating a project', () => {
  it('answers 201 with the project', async () => {
    const { app: built } = server()
    const response = await create(built, { name: 'Musterstraße 12' })

    expect(response.statusCode).toBe(201)
    expect(JSON.parse(response.body)).toEqual({
      projectId: PROJECT_ID,
      dbName: DATABASE,
      name: 'Musterstraße 12',
      role: 'owner',
      owner: { ownerType: 'user', ownerId: OWNER },
      archived: false,
    })
  })

  it('answers the shape the contract declares', async () => {
    // Against the contract's own schema rather than a hand-written shape, so this endpoint and
    // `openapi.yaml` cannot drift apart quietly (ADR 0015).
    const { app: built } = server()
    const response = await create(built, { name: 'Musterstraße 12' })

    // Looked up through `contractSchema`, which asserts the schema exists before returning it.
    // `validate` against an undefined schema reports nothing wrong - correct for a validator,
    // and fatal here: a contract that no longer described this method and path would make the
    // line below pass while checking nothing at all.
    expect(validate(response.json(), contractSchema('POST', '/projects', '201'))).toEqual([])
  })

  it('provisions the database for the caller, not for whoever the body names', async () => {
    // The owner comes from the token. A body that could name an owner would let anyone create
    // a project belonging to somebody else — and then read it, because they wrote the
    // `_security` too.
    const { app: built, couch: fake } = server()
    await create(built, { name: 'Musterstraße 12', owner: 'google|9999' })

    expect(fake.security.get(DATABASE)).toEqual({
      members: { names: [OWNER], roles: [] },
      writers: { names: [OWNER] },
    })
  })
})

describe('the entitlement seam', () => {
  // What `test/entitlements/gate.test.ts` requires of every gated route that exists: not that a
  // gate is available, but that this handler is watched calling it.

  it('is called before anything is created', async () => {
    const { app: built, gateCalls } = server()
    await create(built, { name: 'Musterstraße 12' })

    expect(gateCalls).toHaveLength(1)
  })

  it('is called with project.create and the caller', async () => {
    const { app: built, gateCalls } = server()
    await create(built, { name: 'Musterstraße 12' })

    expect(gateCalls[0]).toEqual({
      principal: { sub: OWNER, plan: 'free', ownedProjects: 0 },
      action: 'project.create',
    })
  })

  it('refusing means 403, not 401', async () => {
    // 401 says "we do not know who you are" and invites signing in again, which for an
    // entitlement failure sends the user round a loop that cannot help them.
    const { app: built } = server({ gateRefuses: true })
    const response = await create(built, { name: 'Musterstraße 12' })

    expect(response.statusCode).toBe(403)
  })

  it('refusing creates nothing', async () => {
    // A gate called after the database exists is a gate that does not gate anything.
    //
    // Named, rather than `databases.size`. The registry is established before the caller's
    // projects can be counted, so the deployment legitimately holds one database by the time
    // the gate answers - and a count of all of them would report that as the project this test
    // says was never made.
    const { app: built, couch: fake } = server({ gateRefuses: true })
    await create(built, { name: 'Musterstraße 12' })

    expect(fake.databases.has(DATABASE)).toBe(false)
  })
})

describe('who may create a project', () => {
  it('nobody without a token', async () => {
    const { app: built } = server()
    const response = await create(built, { name: 'Musterstraße 12' }, null)

    expect(response.statusCode).toBe(401)
  })

  it('nobody with a token this service did not sign', async () => {
    const other = signingKey()
    const { app: built } = server()
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: {
        authorization: `Bearer ${mintToken(other, { purpose: 'access', sub: OWNER, exp: 2 ** 31 })}`,
      },
      payload: { name: 'Musterstraße 12' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('nobody with an expired token', async () => {
    const { app: built } = server()
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: {
        authorization: `Bearer ${mintToken(KEY, { purpose: 'access', sub: OWNER, exp: Math.floor(Date.now() / 1000) - 60 })}`,
      },
      payload: { name: 'Musterstraße 12' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('says nothing about which of those it was', async () => {
    // Which token was wrong, and how, is a fact about a credential somebody presented. Telling
    // them narrows the search.
    const { app: built } = server()
    const missing = await create(built, { name: 'x' }, null)
    const expired = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: {
        authorization: `Bearer ${mintToken(KEY, { purpose: 'access', sub: OWNER, exp: 1 })}`,
      },
      payload: { name: 'x' },
    })

    expect(missing.body).toBe(expired.body)
  })
})

describe('a request that will not do', () => {
  it('is 400 without a name', async () => {
    const { app: built } = server()
    expect((await create(built, {})).statusCode).toBe(400)
  })

  it('is 400 with an empty name', async () => {
    const { app: built } = server()
    expect((await create(built, { name: '   ' })).statusCode).toBe(400)
  })

  it('is 400 with a name that is not a string', async () => {
    const { app: built } = server()
    expect((await create(built, { name: 42 })).statusCode).toBe(400)
  })

  it('says what was wrong with it', async () => {
    // Safe to repeat, because it describes the request rather than the deployment.
    const { app: built } = server()
    const response = await create(built, { name: '' })

    expect(JSON.parse(response.body).title).toMatch(/name/i)
  })

  it('creates nothing', async () => {
    // The project database by name, for the reason 'refusing creates nothing' gives above.
    const { app: built, couch: fake } = server()
    await create(built, { name: '' })

    expect(fake.databases.has(DATABASE)).toBe(false)
  })
})

describe('when CouchDB cannot say what the caller already has', () => {
  // `principalFor` does three pieces of I/O before the gate is asked — `ensureRegistry`, the
  // owned-projects view, and the profile read — and any of them can raise `CouchError`. The
  // call sat outside every try in the handler, so a CouchDB failure there escaped as a raw
  // Fastify 500 carrying CouchDB's own message, on the one route that has a test named "says
  // nothing about CouchDB". The failure walked past it because it happened before the code that
  // test covers.

  it('answers the same shaped 500 a failed cleanup gets', async () => {
    const { app: built } = server({ fails: { view: true } })
    const response = await create(built, { name: 'Musterstraße 12' })

    expect(response.statusCode).toBe(500)
    expect(JSON.parse(response.body)).toEqual({
      title: 'That project could not be created.',
      status: 500,
    })
  })

  it('says nothing about CouchDB', async () => {
    // The property, stated as the sibling test above states it. Unwrapped, the body was
    // Fastify's own `{"statusCode":500,"error":"Internal Server Error","message":"<CouchError>"}`
    // — which names the database, the operation and the status CouchDB gave.
    const { app: built } = server({ fails: { view: true } })
    const response = await create(built, { name: 'Musterstraße 12' })

    // `internal server error` with spaces, which is how Fastify spells it in a raw error body
    // (`{"statusCode":500,"error":"Internal Server Error","message":"<CouchError>"}`). The
    // sibling assertion below was written `internal_server_error`, with underscores, and so
    // could never have matched the thing it was guarding against.
    expect(response.body).not.toMatch(/internal server error|couch|_design/i)
  })

  it('creates nothing', async () => {
    // It refuses before the gate, so certainly before provisioning. Asserted rather than
    // assumed: a handler that logged the failure and carried on with a default principal would
    // pass both tests above and create a project for an account whose capacity is unknown.
    const { app: built, couch: fake } = server({ fails: { view: true } })
    await create(built, { name: 'Musterstraße 12' })

    expect(fake.databases.has(DATABASE)).toBe(false)
  })

  it('answers what the contract declares for it', async () => {
    const { app: built } = server({ fails: { view: true } })
    const response = await create(built, { name: 'Musterstraße 12' })

    expect(validate(response.json(), contractSchema('POST', '/projects', '500'))).toEqual([])
  })
})

describe('when provisioning fails', () => {
  it('answers 400 and says nothing about CouchDB', async () => {
    const { app: built } = server({ fails: { putSecurity: true } })
    const response = await create(built, { name: 'Musterstraße 12' })

    // `internal server error`, spaced. It was `internal_server_error` — underscores, which is
    // not how Fastify spells a raw error body, so this assertion could not have failed for the
    // leak it names. It passes for the right reason now: provisioning failures are mapped.
    expect(response.body).not.toMatch(/internal server error|couch/i)
  })

  it('leaves no database behind', async () => {
    const { app: built, couch: fake } = server({ fails: { putSecurity: true } })
    await create(built, { name: 'Musterstraße 12' })

    expect(fake.databases.has(DATABASE)).toBe(false)
  })

  it('answers 500 when it could not clean up', async () => {
    // Distinct from the ordinary failure, because the deployment now has a database that must
    // be removed by hand — and 4xx would tell the caller it was their fault.
    const { app: built } = server({ fails: { putSecurity: true, deleteDb: true } })
    const response = await create(built, { name: 'Musterstraße 12' })

    expect(response.statusCode).toBe(500)
  })

  it('does not name the orphaned database in the response', async () => {
    // It goes in the log. A database name in a response body is a fact about the deployment.
    const { app: built } = server({ fails: { putSecurity: true, deleteDb: true } })
    const response = await create(built, { name: 'Musterstraße 12' })

    expect(response.body).not.toContain(DATABASE)
  })
})

describe('listing projects', () => {
  it('returns what the registry holds for the caller', async () => {
    const { app: built, couch: fake } = server()
    fake.rows = [
      {
        value: {
          projectId: PROJECT_ID,
          dbName: DATABASE,
          projectName: 'Musterstraße 12',
          role: 'owner',
          ownerId: OWNER,
        },
      },
    ]

    const response = await built.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(JSON.parse(response.body)).toEqual([
      {
        projectId: PROJECT_ID,
        dbName: DATABASE,
        name: 'Musterstraße 12',
        role: 'owner',
        owner: { ownerType: 'user', ownerId: OWNER },
        archived: false,
      },
    ])
  })

  it('lists an archived project, so a client can bring it back', async () => {
    // Not filtered here. A client that could not see what it had put away would have no way to
    // unarchive it, which would make archiving a deletion - and #55 says explicitly that it is
    // not one. Hiding it is the client's job, and it needs the flag to do it.
    const { app: built, couch: fake } = server()
    fake.rows = [
      {
        value: {
          projectId: PROJECT_ID,
          dbName: DATABASE,
          projectName: 'Musterstraße 12',
          address: null,
          role: 'owner',
          ownerId: OWNER,
          archived: true,
        },
      },
    ]

    const response = await built.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(JSON.parse(response.body)).toEqual([
      expect.objectContaining({ projectId: PROJECT_ID, archived: true }),
    ])
  })

  it('reports a pointer written before archiving existed as not archived', async () => {
    // The absence of the field is the state of every project created before #55. The map
    // function emits `doc.archived === true`, so it arrives as a real `false` rather than as a
    // null the client would have to interpret - which is what makes this change need no
    // migration over the registry.
    const { app: built, couch: fake } = server()
    fake.rows = [
      {
        value: {
          projectId: PROJECT_ID,
          dbName: DATABASE,
          projectName: 'Musterstraße 12',
          address: null,
          role: 'owner',
          ownerId: OWNER,
        },
      },
    ]

    const response = await built.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(JSON.parse(response.body)[0]).toMatchObject({ archived: false })
  })

  it('carries an address when the project has one', async () => {
    const { app: built, couch: fake } = server()
    fake.rows = [
      {
        value: {
          projectId: PROJECT_ID,
          dbName: DATABASE,
          projectName: 'Musterstraße 12',
          address: 'Musterstraße 12, 10115 Berlin',
          role: 'owner',
          ownerId: OWNER,
        },
      },
    ]

    const response = await built.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(response.json()[0]).toMatchObject({ address: 'Musterstraße 12, 10115 Berlin' })
  })

  it('leaves the address out when the project has none', async () => {
    // `address: null`, because that is what the view emits — the map function names the field
    // whatever the pointer holds, and CouchDB renders a missing one as null rather than
    // omitting it. Seeding `undefined` here would prove nothing: `JSON.stringify` drops an
    // undefined value, so the response is identical whether this boundary guards it or not.
    const { app: built, couch: fake } = server()
    fake.rows = [
      {
        value: {
          projectId: PROJECT_ID,
          dbName: DATABASE,
          projectName: 'Musterstraße 12',
          address: null,
          role: 'owner',
          ownerId: OWNER,
        },
      },
    ]

    const response = await built.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(response.json()[0]).not.toHaveProperty('address')
  })

  it('asks for the caller alone', async () => {
    // The registry holds every project in the deployment. The key is the caller's subject, and
    // it comes from the token — never from a query parameter, which is the shape of this bug
    // that ships.
    const { app: built, couch: fake } = server()
    await built.inject({
      method: 'GET',
      url: '/projects?userid=google|9999',
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(fake.calls.at(-1)).toMatchObject({
      database: REGISTRY_DATABASE,
      detail: { params: { key: OWNER } },
    })
  })

  it('is empty for somebody with no projects', async () => {
    const { app: built } = server()
    const response = await built.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${tokenFor('google|nobody')}` },
    })

    expect(JSON.parse(response.body)).toEqual([])
  })

  it('is 401 without a token', async () => {
    const { app: built } = server()
    expect((await built.inject({ method: 'GET', url: '/projects' })).statusCode).toBe(401)
  })

  it('leaves out a pointer with no owner rather than guessing one', async () => {
    // Broken data this API cannot produce. `owner` decides which controls a project offers —
    // transfer, remove a member — so a summary naming the wrong owner is worse than a missing
    // one. It is logged, which is how somebody finds out.
    const { app: built, couch: fake } = server()
    fake.rows = [
      {
        value: {
          projectId: PROJECT_ID,
          dbName: DATABASE,
          projectName: 'Musterstraße 12',
          role: 'read',
          ownerId: null,
        },
      },
    ]

    const response = await built.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(JSON.parse(response.body)).toEqual([])
  })
})

describe('changing a project settings', () => {
  const patch = (built: Server, body: unknown, sub: string | null = OWNER) =>
    built.inject({
      method: 'PATCH',
      url: `/projects/${PROJECT_ID}`,
      headers: sub === null ? {} : { authorization: `Bearer ${tokenFor(sub)}` },
      payload: body as Record<string, unknown>,
    })

  it('renames it and answers with the project', async () => {
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })

    const response = await patch(built, { name: 'Lindenstraße 4' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ projectId: PROJECT_ID, name: 'Lindenstraße 4' })
  })

  it('answers creation with the address, which used to be discarded', async () => {
    // The reason #128 is a story and not a chore: the field was in the contract, the route read
    // it, and provisioning checked its length and dropped it. A 201 said everything worked.
    const { app: built } = server()

    const created = await create(built, {
      name: 'Musterstraße 12',
      address: 'Musterstraße 12, 10115 Berlin',
    })

    expect(created.json()).toMatchObject({ address: 'Musterstraße 12, 10115 Berlin' })
  })

  it('records an address on a project that had none', async () => {
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })

    const response = await patch(built, { address: 'Lindenstraße 4, 20095 Hamburg' })

    expect(response.json()).toMatchObject({ address: 'Lindenstraße 4, 20095 Hamburg' })
  })

  it('removes one when the address is explicitly null', async () => {
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12', address: 'Musterstraße 12' })

    const response = await patch(built, { address: null })

    expect(response.json()).not.toHaveProperty('address')
  })

  it('refuses a name that is not text', async () => {
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })

    expect((await patch(built, { name: 42 })).statusCode).toBe(400)
  })

  it('refuses an address that is neither text nor null', async () => {
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })

    expect((await patch(built, { address: 42 })).statusCode).toBe(400)
  })

  it('refuses a body that changes nothing', async () => {
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })

    expect((await patch(built, {})).statusCode).toBe(400)
  })

  it('needs somebody to be signed in', async () => {
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })

    expect((await patch(built, { name: 'x' }, null)).statusCode).toBe(401)
  })

  it('tells a stranger there is no such project', async () => {
    // 404 rather than 403, so that holding a uuid does not confirm a project behind it.
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })

    expect((await patch(built, { name: 'x' }, 'google|stranger')).statusCode).toBe(404)
  })

  it('refuses a participant who may not change settings', async () => {
    // The 403 this operation has always been able to answer, and which no test had driven: a
    // reader is a participant, so they are not told 404, and `canManageMembers` refuses them.
    // Reaching it needs a *second* subject in the pointer, which is why every earlier refusal
    // test here is a 404 - a stranger never gets this far.
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })
    const pointer = couch.documents.get(`${REGISTRY_DATABASE}/project:${PROJECT_ID}`) as {
      participants: unknown[]
    }
    couch.documents.set(`${REGISTRY_DATABASE}/project:${PROJECT_ID}`, {
      ...pointer,
      participants: [...pointer.participants, { role: 'read', userid: 'google|grace' }],
    })

    expect((await patch(built, { name: 'x' }, 'google|grace')).statusCode).toBe(403)
  })

  for (const [status, drive] of [
    ['400', (built: Server) => patch(built, {})],
    ['404', (built: Server) => patch(built, { name: 'x' }, 'google|stranger')],
  ] as const) {
    it(`answers the ${status} the contract declares`, async () => {
      // The contract declared both of these as a bare `description:` with no `content:` at all,
      // which reads as complete and is not: `operationsOf` keys `responses` only by the statuses
      // that declare a body, so the drift check could not tell them from a 204 and silently
      // validated neither the schema nor the media type. A client generated from the file got no
      // body for either, while the handler had been sending RFC 9457 through `problem()` all
      // along. Driven here so the declaration is checked against the real response.
      const { app: built } = server()
      await create(built, { name: 'Musterstraße 12' })

      const response = await drive(built)

      expect(response.statusCode).toBe(Number(status))
      expect(response.headers['content-type']).toMatch(PROBLEM_JSON)
      expect(
        validate(response.json(), contractSchema('PATCH', '/projects/{projectId}', status)),
      ).toEqual([])
    })
  }

  it('answers the 403 the contract declares', async () => {
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })
    const pointer = couch.documents.get(`${REGISTRY_DATABASE}/project:${PROJECT_ID}`) as {
      participants: unknown[]
    }
    couch.documents.set(`${REGISTRY_DATABASE}/project:${PROJECT_ID}`, {
      ...pointer,
      participants: [...pointer.participants, { role: 'read', userid: 'google|grace' }],
    })

    const response = await patch(built, { name: 'x' }, 'google|grace')

    expect(response.statusCode).toBe(403)
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON)
    expect(
      validate(response.json(), contractSchema('PATCH', '/projects/{projectId}', '403')),
    ).toEqual([])
  })
})

describe('sharing a project', () => {
  /** A registry holding one project owned by the caller. */
  const seedProject = (built: ReturnType<typeof server>) => {
    built.couch.documents.set(`projects/project:${PROJECT_ID}`, {
      _id: `project:${PROJECT_ID}`,
      _rev: '1-a',
      type: 'projectPointer',
      projectId: PROJECT_ID,
      dbName: DATABASE,
      projectName: 'Musterstraße 12',
      participants: [{ role: 'owner', userid: OWNER }],
      addedAt: '2026-08-27T09:00:00.000Z',
    })
    return built
  }

  const share = (built: Server, body: unknown, sub: string | null = OWNER) =>
    built.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/members`,
      headers: sub === null ? {} : { authorization: `Bearer ${tokenFor(sub)}` },
      payload: body as Record<string, unknown>,
    })

  it('answers 204 when access is granted', async () => {
    const built = seedProject(server())
    const response = await share(built.app, { email: 'grace@example.test', role: 'read' })

    expect(response.statusCode).toBe(204)
  })

  it('refuses to grant ownership through this route', async () => {
    // Sharing requires `manage`, and `grantRole` accepts `owner` — so without this, a manager
    // could promote anybody, themselves included, to owner. That is the whole of the M5-5
    // transfer flow bypassed: no offer, no acceptance by the recipient, no owner's decision.
    // Ownership moves through `POST /projects/:id/transfer` or it does not move.
    const built = seedProject(server())
    const response = await share(built.app, { email: 'grace@example.test', role: 'owner' })

    expect(response.statusCode).toBe(400)
  })

  it('still grants the roles this route is for', async () => {
    // The positive control for the refusal above: refusing every role would also pass it.
    const built = seedProject(server())

    for (const role of ['manage', 'write', 'read']) {
      const response = await share(built.app, { email: 'grace@example.test', role })
      expect(response.statusCode, role).toBe(204)
    }
  })

  it('calls the gate with project.invite and the project', async () => {
    // The second gated action. `project.create` takes no project because it creates one;
    // this one names the project being shared, which is what a per-project plan would read.
    const built = seedProject(server())
    await share(built.app, { email: 'grace@example.test', role: 'read' })

    expect(built.gateCalls.map((call) => call.action)).toContain('project.invite')
  })

  it('hands the gate the real owned count of the caller, not a literal', async () => {
    // `project.invite` is `ALLOW` today and reads nothing from the principal, so a hard-coded
    // `0` here would be invisible - and silently wrong on the day a policy starts reading the
    // count, which is exactly the failure the seam exists to prevent. Nothing else in the suite
    // can see this, so it is asserted directly.
    const built = seedProject(server())
    built.couch.rows = [
      { value: { projectId: 'a', dbName: 'p_a', projectName: 'A', role: 'owner', ownerId: OWNER } },
      { value: { projectId: 'b', dbName: 'p_b', projectName: 'B', role: 'owner', ownerId: OWNER } },
    ]

    await share(built.app, { email: 'grace@example.test', role: 'read' })

    expect(built.gateCalls.find((call) => call.action === 'project.invite')?.principal).toEqual({
      sub: OWNER,
      plan: 'free',
      ownedProjects: 2,
    })
  })

  it('is 401 without a token', async () => {
    const built = seedProject(server())

    expect(
      (await share(built.app, { email: 'grace@example.test', role: 'read' }, null)).statusCode,
    ).toBe(401)
  })

  it('is 400 without an email', async () => {
    const built = seedProject(server())

    expect((await share(built.app, { role: 'read' })).statusCode).toBe(400)
  })

  it('is 400 for a role that is not one', async () => {
    // The contract enumerates four. Anything else reaching `securityFor` would be a role that
    // is not a writer and not a reader, which is a member with no access at all.
    const built = seedProject(server())

    expect(
      (await share(built.app, { email: 'grace@example.test', role: 'admin' })).statusCode,
    ).toBe(400)
  })

  it('is 400 when the role is missing rather than revoking', async () => {
    // Revocation is spelled `null`, as a value. A body that forgot `role` is a mistake, and
    // treating it as "remove this person" would make the most destructive operation the one
    // that happens by accident.
    const built = seedProject(server())

    expect((await share(built.app, { email: 'grace@example.test' })).statusCode).toBe(400)
  })

  it('revokes when the role is null', async () => {
    const built = seedProject(server())
    await share(built.app, { email: 'grace@example.test', role: 'read' })

    const response = await share(built.app, { email: 'grace@example.test', role: null })

    expect(response.statusCode).toBe(204)
    expect(
      (built.couch.documents.get(`projects/project:${PROJECT_ID}`) as { participants: unknown[] })
        .participants,
    ).toEqual([{ role: 'owner', userid: OWNER }])
  })

  it('is 404 for a project the caller is not part of', async () => {
    const built = seedProject(server())
    const response = await built.inject({
      method: 'PUT',
      url: `/projects/${PROJECT_ID}/members`,
      headers: { authorization: `Bearer ${tokenFor('google|stranger')}` },
      payload: { email: 'grace@example.test', role: 'read' },
    })

    expect(response.statusCode).toBe(404)
  })

  it('answers the 404 the contract declares', async () => {
    // `MembershipRefused` carries 404 from three places this route can reach - no pointer, a
    // caller who is not a participant, and an address with no account - and the contract declared
    // only 204, 400, 401 and 403. The widened drift check could not find it: it drives one
    // request per operation with an empty body, so this route answers 400 for the missing email
    // long before it looks a project up.
    const built = seedProject(server())
    const response = await share(
      built.app,
      { email: 'grace@example.test', role: 'read' },
      'google|stranger',
    )

    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON)
    expect(
      validate(response.json(), contractSchema('PUT', '/projects/{projectId}/members', '404')),
    ).toEqual([])
  })

  it('gives up with a 409 when the registry keeps conflicting', async () => {
    // `changeMembership` re-reads and retries a conflicting pointer three times and then refuses,
    // because a conflict that keeps happening is something the caller should hear about rather
    // than wait through. Undeclared until now, and unreachable through the drift check for the
    // same reason as the 404 above.
    const built = seedProject(server({ registryConflicts: true }))
    const response = await share(built.app, { email: 'grace@example.test', role: 'read' })

    expect(response.statusCode).toBe(409)
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON)
    expect(
      validate(response.json(), contractSchema('PUT', '/projects/{projectId}/members', '409')),
    ).toEqual([])
  })

  it('retried before giving up, rather than refusing the first conflict', async () => {
    // The positive control for the 409 above. A handler that answered 409 on the first conflict
    // would pass that test exactly, and would turn an ordinary simultaneous edit - two managers
    // on the same project, which the single-document registry makes routine - into a failure the
    // caller has to retry by hand. Three attempts is what `CONFLICT_ATTEMPTS` promises.
    const built = seedProject(server({ registryConflicts: true }))
    await share(built.app, { email: 'grace@example.test', role: 'read' })

    expect(built.refused).toEqual([
      `project:${PROJECT_ID}`,
      `project:${PROJECT_ID}`,
      `project:${PROJECT_ID}`,
    ])
  })

  it('lists the members', async () => {
    const built = seedProject(server())
    const response = await built.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/members`,
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual([
      { sub: OWNER, email: 'ada@example.test', role: 'owner' },
    ])
  })
})

describe('handing a project to somebody else', () => {
  const seedProject = (built: ReturnType<typeof server>) => {
    built.couch.documents.set(`projects/project:${PROJECT_ID}`, {
      _id: `project:${PROJECT_ID}`,
      _rev: '1-a',
      type: 'projectPointer',
      projectId: PROJECT_ID,
      dbName: DATABASE,
      projectName: 'Musterstraße 12',
      participants: [{ role: 'owner', userid: OWNER }],
      addedAt: '2026-08-27T09:00:00.000Z',
    })
    return built
  }

  const transfer = (built: Server, body: unknown, sub: string | null = OWNER) =>
    built.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/transfer`,
      headers: sub === null ? {} : { authorization: `Bearer ${tokenFor(sub)}` },
      payload: body as Record<string, unknown>,
    })

  it('answers 204 when the offer is made', async () => {
    const built = seedProject(server())

    expect((await transfer(built.app, { toEmail: 'grace@example.test' })).statusCode).toBe(204)
  })

  it('does not move ownership yet', async () => {
    // **The second scenario.** An offer is not a transfer: an unaccepted one would let anybody
    // push responsibility for data — and eventually a bill — onto somebody who never agreed.
    const built = seedProject(server())
    await transfer(built.app, { toEmail: 'grace@example.test' })

    expect(
      (built.couch.documents.get(`projects/project:${PROJECT_ID}`) as { participants: unknown[] })
        .participants,
    ).toEqual([{ role: 'owner', userid: OWNER }])
  })

  it('is 400 without an address', async () => {
    const built = seedProject(server())

    expect((await transfer(built.app, {})).statusCode).toBe(400)
  })

  it('refuses to retain anything but read', async () => {
    // The contract's enum is `[read]` and deliberately not a reference to `Role`: a departing
    // owner who could keep `manage` could remove the new owner afterwards, which is not a
    // transfer.
    const built = seedProject(server())

    expect(
      (await transfer(built.app, { toEmail: 'grace@example.test', retainAccess: 'manage' }))
        .statusCode,
    ).toBe(400)
  })

  it('is 404 for somebody who does not own the project', async () => {
    const built = seedProject(server())

    expect(
      (await transfer(built.app, { toEmail: 'grace@example.test' }, 'google|stranger')).statusCode,
    ).toBe(404)
  })

  it('answers the 404 the contract declares', async () => {
    // Two 404s on this route - a project with no pointer, and a caller who is not its owner -
    // against a contract declaring 204, 400, 401 and 403. Undeclared since the route was
    // written. The drift check drives it with an empty body, so it reports the missing `toEmail`
    // as a 400 and never reaches the pointer read.
    const built = seedProject(server())
    const response = await transfer(built.app, { toEmail: 'grace@example.test' }, 'google|stranger')

    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON)
    expect(
      validate(response.json(), contractSchema('POST', '/projects/{projectId}/transfer', '404')),
    ).toEqual([])
  })

  it('is 401 without a token', async () => {
    const built = seedProject(server())

    expect((await transfer(built.app, { toEmail: 'grace@example.test' }, null)).statusCode).toBe(
      401,
    )
  })

  it('lists the offer for the person it was made to', async () => {
    const built = seedProject(server())
    await transfer(built.app, { toEmail: 'grace@example.test' })
    built.couch.rows = [
      {
        value: {
          _id: `transfer:${PROJECT_ID}`,
          type: 'transfer',
          projectId: PROJECT_ID,
          toEmail: 'grace@example.test',
          fromSub: OWNER,
          retainAccess: 'none',
          createdAt: '2026-08-27T09:00:00.000Z',
          expiresAt: '2026-09-10T09:00:00.000Z',
        },
      },
    ]

    const response = await built.app.inject({
      method: 'GET',
      url: '/transfers',
      headers: { authorization: `Bearer ${tokenFor('google|grace')}` },
    })

    expect(JSON.parse(response.body)).toEqual([
      {
        projectId: PROJECT_ID,
        projectName: 'Musterstraße 12',
        retainAccess: 'none',
        expiresAt: '2026-09-10T09:00:00.000Z',
      },
    ])
  })

  it('moves ownership when the recipient accepts', async () => {
    const built = seedProject(server())
    await transfer(built.app, { toEmail: 'grace@example.test', retainAccess: 'read' })

    const response = await built.app.inject({
      method: 'POST',
      url: `/transfers/${PROJECT_ID}`,
      headers: { authorization: `Bearer ${tokenFor('google|grace')}` },
    })

    expect(response.statusCode).toBe(204)
    expect(
      (built.couch.documents.get(`projects/project:${PROJECT_ID}`) as { participants: unknown[] })
        .participants,
    ).toEqual([
      { role: 'read', userid: OWNER },
      { role: 'owner', userid: 'google|grace' },
    ])
  })

  it('is 404 when somebody else tries to accept', async () => {
    const built = seedProject(server())
    await transfer(built.app, { toEmail: 'grace@example.test' })

    const response = await built.app.inject({
      method: 'POST',
      url: `/transfers/${PROJECT_ID}`,
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * An offer written straight into the registry, because the route that would write one cannot.
   *
   * The 409 below needs a registry whose writes always conflict, and `POST .../transfer` stores
   * the offer with exactly such a write - so making the offer through the API and then breaking
   * the API's writes is not a state this test can reach in that order. Seeded instead, in the
   * shape `storeTransfer` produces.
   */
  const seedOffer = (built: ReturnType<typeof server>) => {
    built.couch.documents.set(`${REGISTRY_DATABASE}/transfer:${PROJECT_ID}`, {
      _id: `transfer:${PROJECT_ID}`,
      _rev: '1-a',
      type: 'transfer',
      projectId: PROJECT_ID,
      toEmail: 'grace@example.test',
      fromSub: OWNER,
      retainAccess: 'none',
      createdAt: '2026-08-27T09:00:00.000Z',
      expiresAt: '2026-09-10T09:00:00.000Z',
    })
    return built
  }

  it('gives up with a 409 when accepting keeps conflicting', async () => {
    // `acceptTransfer` retries a conflicting registry three times and then throws
    // `MembershipRefused(409)`. The contract declared 204, 400, 401 and 404, so this was the one
    // status of the four the error type can carry that the file did not mention.
    const built = seedOffer(seedProject(server({ registryConflicts: true })))

    const response = await built.app.inject({
      method: 'POST',
      url: `/transfers/${PROJECT_ID}`,
      headers: { authorization: `Bearer ${tokenFor('google|grace')}` },
    })

    expect(response.statusCode).toBe(409)
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON)
    expect(
      validate(response.json(), contractSchema('POST', '/transfers/{projectId}', '409')),
    ).toEqual([])
  })

  it('retried the acceptance before giving up', async () => {
    // The positive control, as on the sharing route: refusing the first conflict answers the
    // same 409, and would turn an ordinary simultaneous edit into a failure the recipient has to
    // resolve by hand.
    const built = seedOffer(seedProject(server({ registryConflicts: true })))

    await built.app.inject({
      method: 'POST',
      url: `/transfers/${PROJECT_ID}`,
      headers: { authorization: `Bearer ${tokenFor('google|grace')}` },
    })

    expect(built.refused).toEqual([
      `project:${PROJECT_ID}`,
      `project:${PROJECT_ID}`,
      `project:${PROJECT_ID}`,
    ])
  })

  it('withdraws the offer when the recipient declines', async () => {
    const built = seedProject(server())
    await transfer(built.app, { toEmail: 'grace@example.test' })

    const response = await built.app.inject({
      method: 'DELETE',
      url: `/transfers/${PROJECT_ID}`,
      headers: { authorization: `Bearer ${tokenFor('google|grace')}` },
    })

    expect(response.statusCode).toBe(204)
    expect(built.couch.documents.get(`projects/transfer:${PROJECT_ID}`)).toMatchObject({
      _deleted: true,
    })
  })

  it('does not let anybody else decline an offer', async () => {
    // Withdrawing somebody else's offer is the owner's act, not a bystander's.
    const built = seedProject(server())
    await transfer(built.app, { toEmail: 'grace@example.test' })

    const response = await built.app.inject({
      method: 'DELETE',
      url: `/transfers/${PROJECT_ID}`,
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(response.statusCode).toBe(404)
  })
})

/**
 * A server whose registry already holds what this caller owns, and whose `_users` document
 * carries their plan.
 *
 * Separate from {@link server} because these tests are about a *precondition*: what matters is
 * how many projects exist before the request, and reaching that state by creating them would
 * mean driving the very route under test through the very limit under test.
 *
 * @param options.plan what the `_users` document holds, as an operator would have typed it
 * @param options.owned how many projects this subject owns
 * @param options.archived whether those owned projects are archived - they count either way (#55)
 * @param options.memberOf how many further projects this subject can see but does not own
 */
function serverWithProjects(options: {
  plan: Plan
  owned: number
  archived?: boolean
  memberOf?: number
}): Server {
  const built = server()

  built.couch.documents.set(`_users/${userDocumentId(SUBJECT)}`, {
    _id: userDocumentId(SUBJECT),
    name: SUBJECT,
    roles: [],
    type: 'user',
    plan: options.plan,
  })

  // One row per participation, which is what the view emits: a project somebody shared with
  // this subject is a row of theirs carrying somebody else's `ownerId`. `read` rather than the
  // `member` a reader might expect - `ProjectRole` has four values and that is not one of them.
  const rows = (count: number, role: string, archived: boolean, prefix: string) =>
    Array.from({ length: count }, (_unused, index) => ({
      value: {
        projectId: `${prefix}-${index}`,
        dbName: `project_${prefix}_${index}`,
        projectName: `Project ${index}`,
        address: null,
        role,
        archived,
        ownerId: role === 'owner' ? SUBJECT : 'google|somebody-else',
      },
    }))

  built.couch.rows = [
    ...rows(options.owned, 'owner', options.archived === true, 'owned'),
    ...rows(options.memberOf ?? 0, 'read', false, 'shared'),
  ]

  return built.app
}

describe('creating a project against the plan', () => {
  it('creates the first project on a free plan', async () => {
    const built = serverWithProjects({ plan: 'free', owned: 0 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Home' },
    })
    expect(response.statusCode).toBe(201)
  })

  it('refuses the second, and says why in a way a client can branch on', async () => {
    // An empty 403 leaves the page unable to tell "you have used all your slots" from "you may
    // not do this", and those deserve different sentences.
    const built = serverWithProjects({ plan: 'free', owned: 1 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Second' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ reason: 'project-limit-reached' })
  })

  it('answers the refusal the contract declares, reason and all', async () => {
    // The contract declared this 403 with a bare description and no schema at all until this
    // task, so `reason` - which the handler had been sending since the limit was enforced - was
    // documented nowhere and checked by nothing. Two separate gaps made that invisible: no
    // schema to look up, and an `operationsOf` that collected only `application/json` while
    // every refusal here is `application/problem+json`.
    const built = serverWithProjects({ plan: 'free', owned: 1 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Second' },
    })

    expect(response.statusCode).toBe(403)
    expect(validate(response.json(), contractSchema('POST', '/projects', '403'))).toEqual([])
  })

  it('would notice a refusal that stopped naming itself', async () => {
    // The negative control. `validate` ignores properties the contract does not declare, so the
    // test above would go on passing if `reason` left the 403 schema - and the page would branch
    // on a field the contract no longer promised. This asserts both ways the pin can come
    // loose: the field leaving `required`, and the `const` naming a different refusal.
    const schema = contractSchema('POST', '/projects', '403')

    expect(validate({ title: 'No', status: 403 }, schema)).toEqual([
      { at: '$.reason', says: 'is required and missing' },
    ])
    // The other refusal's reason, which is what a copy-paste produces. A capacity 403 that said
    // `not-an-operator` would tell a page to explain a permission problem to somebody whose
    // only problem is that they have run out of slots - and only one of those is fixed by
    // upgrading, which is the whole reason the field exists.
    expect(validate({ title: 'No', status: 403, reason: 'not-an-operator' }, schema)).toEqual([
      { at: '$.reason', says: 'must be "project-limit-reached", got "not-an-operator"' },
    ])
  })

  it('counts an archived project against the limit', async () => {
    // Archiving is not deletion (#55) - the database still exists and still costs - so an
    // archived project occupies its slot. The alternative would let a free account accumulate
    // databases without limit by archiving each one.
    const built = serverWithProjects({ plan: 'free', owned: 1, archived: true })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Second' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('does not count a project somebody else owns', async () => {
    // Membership is not ownership. A free user invited to a colleague's project keeps their
    // own slot, which is the point of counting ownership rather than visibility.
    const built = serverWithProjects({ plan: 'free', owned: 0, memberOf: 3 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Mine' },
    })
    expect(response.statusCode).toBe(201)
  })

  it('never refuses a pro account', async () => {
    const built = serverWithProjects({ plan: 'pro', owned: 50 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Another' },
    })
    expect(response.statusCode).toBe(201)
  })

  it('creates nothing when it refuses', async () => {
    // The refusal has to happen before provisioning, not alongside it. A limit enforced after
    // the database exists is a limit that costs exactly as much as no limit at all.
    const built = serverWithProjects({ plan: 'free', owned: 1 })
    await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Second' },
    })
    expect(couch.databases.has(`project_${PROJECT_ID}`)).toBe(false)
  })

  it('reads the plan from the account rather than assuming one', async () => {
    // The positive control for the refusal above: a handler that ignored `_users` entirely and
    // hard-coded `free` would pass every test in this block but this one.
    const built = serverWithProjects({ plan: 'user', owned: 1 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Second' },
    })
    expect(response.statusCode).toBe(201)
  })
})
