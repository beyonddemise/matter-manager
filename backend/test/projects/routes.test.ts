import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DenyList } from '../../src/auth/deny-list.js'
import { denyList } from '../../src/auth/deny-list.js'
import { mintToken, type SigningKey, verifyToken } from '../../src/auth/jwt.js'
import { refreshStore } from '../../src/auth/refresh-store.js'
import { type CouchClient, CouchError } from '../../src/couch/client.js'
import type { Action, Plan, Principal } from '../../src/domain/index.js'
import { NotEntitledError, gate as realGate } from '../../src/entitlements/gate.js'
import { PROBLEM_JSON } from '../../src/problem.js'
import { forgetRegistry, pointerId, REGISTRY_DATABASE } from '../../src/projects/registry.js'
import { transferId } from '../../src/projects/transfers.js'
import { buildServer, type Server } from '../../src/server.js'
import { forgetUsersDatabase, USERS_DB } from '../../src/users/database.js'
import { recordEnsurer } from '../../src/users/ensure.js'
import { userDocId } from '../../src/users/key.js'
import { userRecords } from '../../src/users/records.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'
import { type CouchFailures, type FakeCouch, fakeCouch } from '../support/couch.js'
import { accessTokenFor } from '../support/tokens.js'

const OWNER = 'google|1234'
/** The caller in the capacity tests. Distinct from {@link OWNER}, which owns nothing here. */
const SUBJECT = 'user-1'
const SUBJECT_EMAIL = 'user1@example.test'
const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'
const DATABASE = `project_${PROJECT_ID}`

function signingKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { kid: 'test', privateKey, publicKey }
}

const KEY = signingKey()

/** The address each subject in this file signed in with, so a token carries it as production's do. */
const EMAILS: Readonly<Record<string, string>> = {
  [OWNER]: 'ada@example.test',
  [SUBJECT]: SUBJECT_EMAIL,
  'google|grace': 'grace@example.test',
}

/**
 * A valid access token for `sub`, with the claims `/auth/token` mints — the address included,
 * because the routes read the caller's own record and offers by it. A subject not listed above
 * gets an address of its own, so it can never be mistaken for somebody else's.
 */
const tokenFor = (sub: string) =>
  accessTokenFor(KEY, { sub, email: EMAILS[sub] ?? `${sub.replace(/\W/g, '-')}@example.test` })

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
  options: {
    fails?: CouchFailures
    gateRefuses?: boolean
    registryConflicts?: boolean
    /** Signed-out access tokens, as the auth routes would write them. */
    deny?: DenyList
    /** Leave `findUser` to its default, the real user records, instead of the stub below. */
    realLookups?: boolean
    /**
     * The plan on {@link OWNER}'s user record. `member` unless stated, because the free plan
     * owns no server projects and most of what this file drives is a project that exists. Pass
     * `null` for a caller with no record at all, which is answered as `free`.
     */
    plan?: Plan | null
    /** The seconds clock the routes use, for tests that pin what a route stamps. */
    now?: () => number
  } = {},
) {
  forgetUsersDatabase()
  couch = fakeCouch(options.fails === undefined ? {} : { fails: options.fails })
  const plan = options.plan === undefined ? 'member' : options.plan
  if (plan !== null) {
    // Seeded as an operator would have edited it, by the address on the owner's token.
    const email = EMAILS[OWNER] as string
    couch.documents.set(`${USERS_DB}/${userDocId(email)}`, {
      _id: userDocId(email),
      type: 'user',
      sub: OWNER,
      email,
      plan,
    })
  }
  const refused: string[] = []
  const client =
    options.registryConflicts === true ? conflictingRegistry(couch.couch, refused) : couch.couch
  const gateCalls: Array<{ principal: Principal; action: Action }> = []
  const records = userRecords(client)

  app = buildServer({
    logger: false,
    projects: {
      couch: client,
      key: KEY,
      validator: () => 'function (newDoc) { return newDoc }',
      // The real records against the fake CouchDB, so a test states a plan by seeding the
      // record an operator would have edited - rather than by stubbing the read and proving
      // only that a stub returns what it was given.
      records,
      // The real ensurer over the same records, as composition wires it, so a test sees the
      // record acceptance creates rather than a stub's account of it.
      ensureRecord: recordEnsurer(
        records,
        refreshStore(records, () => Math.floor(Date.now() / 1000)),
      ),
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
      ...(options.realLookups === true
        ? {}
        : {
            findUser: async (value: string) =>
              value.includes('grace')
                ? { sub: 'google|grace', email: 'grace@example.test' }
                : value === OWNER
                  ? { sub: OWNER, email: 'ada@example.test' }
                  : undefined,
          }),
      ...(options.deny === undefined ? {} : { deny: options.deny }),
      millis: () => Date.parse('2026-08-27T09:00:00.000Z'),
      ...(options.now === undefined ? {} : { now: options.now }),
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

  it('echoes a client given at creation, and refuses one over 200 characters', async () => {
    const { app: built } = server()

    const created = await create(built, { name: 'Musterstraße 12', client: '  Acme  ' })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ client: 'Acme' })

    const refused = await create(built, { name: 'Musterstraße 12', client: 'x'.repeat(201) })
    expect(refused.statusCode).toBe(400)
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
      owners: { names: [OWNER] },
    })
  })
})

describe('the entitlement seam', () => {
  // What `test/entitlements/gate.test.ts` requires of every gated route that exists: not that a
  // gate is available, but that this handler is watched calling it.

  it('is called before anything is created', async () => {
    const { app: built, gateCalls } = server()
    await create(built, { name: 'Musterstraße 12' })

    expect(gateCalls).toHaveLength(2)
  })

  it('is called with project.sync, then project.create, and the caller', async () => {
    const { app: built, gateCalls } = server()
    await create(built, { name: 'Musterstraße 12' })

    const principal = { sub: OWNER, plan: 'member', ownedProjects: 0 }
    expect(gateCalls).toEqual([
      { principal, action: 'project.sync' },
      { principal, action: 'project.create' },
    ])
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
  // owned-projects view, and the user-record read — and any of them can raise `CouchError`. The
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

describe('a signed-out access token', () => {
  it('is refused by the project routes with 401', async () => {
    // The deny list protects this API, not CouchDB. A route that forgot to hand it to
    // `bearerSubject` would go on honouring a token the user had signed out.
    const deny = denyList(() => Math.floor(Date.now() / 1000))
    const { app: built } = server({ deny })
    const token = mintToken(KEY, {
      purpose: 'access',
      sub: OWNER,
      jti: 'signed-out-jti',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const request = () =>
      built.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${token}` },
      })

    expect((await request()).statusCode).toBe(200)

    const { exp } = verifyToken(token, KEY.publicKey, 'access')
    deny.deny('signed-out-jti', exp)

    expect((await request()).statusCode).toBe(401)
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

  it('carries the client and the archive time, and drops the nulls the view emits', async () => {
    const { app: built, couch: fake } = server()
    const row = {
      projectId: PROJECT_ID,
      dbName: DATABASE,
      projectName: 'Musterstraße 12',
      address: null,
      role: 'owner',
      ownerId: OWNER,
    }
    fake.rows = [
      { value: { ...row, client: 'Acme', archived: true, archivedAt: 1_700_000_000 } },
      { value: { ...row, client: null, archived: false, archivedAt: null } },
    ]

    const response = await built.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${tokenFor(OWNER)}` },
    })

    expect(response.json()[0]).toMatchObject({ client: 'Acme', archivedAt: 1_700_000_000 })
    expect(response.json()[1]).not.toHaveProperty('client')
    expect(response.json()[1]).not.toHaveProperty('archivedAt')
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

  it('sets, trims and clears the client', async () => {
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })

    expect((await patch(built, { client: '  Acme  ' })).json()).toMatchObject({ client: 'Acme' })
    expect((await patch(built, { client: null })).json()).not.toHaveProperty('client')
    await patch(built, { client: 'Acme' })
    expect((await patch(built, { client: '   ' })).json()).not.toHaveProperty('client')
  })

  it('refuses a client that is neither text nor null, or is too long', async () => {
    const { app: built } = server()
    await create(built, { name: 'Musterstraße 12' })

    expect((await patch(built, { client: 5 })).statusCode).toBe(400)
    expect((await patch(built, { client: 'x'.repeat(201) })).statusCode).toBe(400)
  })

  it('stamps archivedAt on archive and removes it on unarchive', async () => {
    // The injected seconds clock, so the stamp is asserted rather than merely "a number".
    const stamp = Math.floor(Date.now() / 1000)
    const { app: built } = server({ now: () => stamp })
    await create(built, { name: 'Musterstraße 12' })

    const archived = await patch(built, { archived: true })
    expect(archived.json().archivedAt).toBe(stamp)

    expect((await patch(built, { archived: false })).json()).not.toHaveProperty('archivedAt')
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

  for (const [status, drive] of [
    ['400', (built: Server) => patch(built, {})],
    ['404', (built: Server) => patch(built, { name: 'x' }, 'google|stranger')],
  ] as const) {
    it(`answers the ${status} the contract declares`, async () => {
      // `400` was a bare `description:` with no `content:`, which reads as complete and is not:
      // `operationsOf` keys `responses` only by the statuses that declare a body, so the drift
      // check could not tell it from a 204 and silently validated neither its schema nor its
      // media type. The handler had been sending RFC 9457 through `problem()` all along, so a
      // client generated from the file got no body for it. `404` was already a proper `$ref` to
      // `NotFound` and needed no fix; it is driven through the same loop so both refusals this
      // operation can answer get the same schema check.
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
    // Reaching this needs a *second* subject in the pointer - a reader is a participant, so
    // they are not told 404, and `canManageMembers` refuses them instead - which is why every
    // other refusal test here is a 404: a stranger never gets this far.
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
    expect(response.json()).toMatchObject({ reason: 'not-a-manager' })
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
      plan: 'member',
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

  describe('when CouchDB cannot say what the caller already has', () => {
    // `principalFor` is the same function `POST /projects` wraps, shared rather than
    // duplicated — and until this fix, this route called it outside every `try`. `ensureRegistry`,
    // the owned-projects view and the user-record read can each raise `CouchError`, and unwrapped
    // that escaped as a raw Fastify 500 carrying CouchDB's own message, on a route whose every
    // other failure is deliberately mapped and scrubbed.

    it('answers the same shaped 500 the creation route answers for the identical failure', async () => {
      const built = seedProject(server({ fails: { view: true } }))
      const response = await share(built.app, { email: 'grace@example.test', role: 'read' })

      expect(response.statusCode).toBe(500)
      expect(JSON.parse(response.body)).toEqual({
        title: 'That membership could not be changed.',
        status: 500,
      })
    })

    it('says nothing about CouchDB', async () => {
      // The property, stated as `POST /projects`'s sibling test states it. Unwrapped, the body
      // was Fastify's own `{"statusCode":500,"error":"Internal Server Error","message":"<CouchError>"}`
      // — which names the database, the operation and the status CouchDB gave.
      const built = seedProject(server({ fails: { view: true } }))
      const response = await share(built.app, { email: 'grace@example.test', role: 'read' })

      expect(response.body).not.toMatch(/internal server error|couch|_design/i)
    })

    it('changes nothing', async () => {
      // It refuses before the gate, so certainly before `changeMembership`. Asserted rather
      // than assumed: a handler that logged the failure and carried on with a default
      // principal would pass the two tests above and still grant access on a plan it could
      // not verify.
      const built = seedProject(server({ fails: { view: true } }))
      await share(built.app, { email: 'grace@example.test', role: 'read' })

      expect(
        (built.couch.documents.get(`projects/project:${PROJECT_ID}`) as { participants: unknown[] })
          .participants,
      ).toEqual([{ role: 'owner', userid: OWNER }])
    })

    it('answers what the contract declares for it', async () => {
      const built = seedProject(server({ fails: { view: true } }))
      const response = await share(built.app, { email: 'grace@example.test', role: 'read' })

      expect(
        validate(response.json(), contractSchema('PUT', '/projects/{projectId}/members', '500')),
      ).toEqual([])
    })
  })
})

describe('handing a project to somebody else', () => {
  /**
   * Grace, who is to accept, on the `member` plan. Accepting an active project is judged by the
   * recipient's plan, and a recipient with no record is `free`: every acceptance below that is
   * about something else than the plan has to start from somebody whose plan allows it.
   */
  const asMember = (built: ReturnType<typeof server>) => {
    built.couch.documents.set(`${USERS_DB}/${userDocId('grace@example.test')}`, {
      _id: userDocId('grace@example.test'),
      type: 'user',
      sub: 'google|grace',
      email: 'grace@example.test',
      plan: 'member',
    })
    return built
  }

  const seedProject = (built: ReturnType<typeof server>, archived = false) => {
    built.couch.documents.set(`projects/project:${PROJECT_ID}`, {
      _id: `project:${PROJECT_ID}`,
      _rev: '1-a',
      type: 'projectPointer',
      projectId: PROJECT_ID,
      dbName: DATABASE,
      projectName: 'Musterstraße 12',
      participants: [{ role: 'owner', userid: OWNER }],
      addedAt: '2026-08-27T09:00:00.000Z',
      ...(archived ? { archived: true } : {}),
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
    const built = asMember(seedProject(server()))
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

  describe("whatever the recipient's record says", () => {
    /** Grace's record, with or without the subject sign-in would have written. */
    const withGraceRecord = (built: ReturnType<typeof server>, sub?: string) => {
      built.couch.documents.set(`${USERS_DB}/${userDocId('grace@example.test')}`, {
        _id: userDocId('grace@example.test'),
        type: 'user',
        email: 'grace@example.test',
        plan: 'member',
        ...(sub === undefined ? {} : { sub }),
      })
      return built
    }

    const accept = (built: ReturnType<typeof server>) =>
      built.app.inject({
        method: 'POST',
        url: `/transfers/${PROJECT_ID}`,
        headers: { authorization: `Bearer ${tokenFor('google|grace')}` },
      })

    it('accepts for a record that carries a subject', async () => {
      const built = withGraceRecord(seedProject(server({ realLookups: true })), 'google|grace')
      await transfer(built.app, { toEmail: 'grace@example.test' })

      expect((await accept(built)).statusCode).toBe(204)
    })

    it('fills in the subject on a record an operator created by address', async () => {
      const built = withGraceRecord(seedProject(server({ realLookups: true })))
      await transfer(built.app, { toEmail: 'grace@example.test' })
      await accept(built)

      expect((await userRecords(built.couch.couch).read('grace@example.test'))?.sub).toBe(
        'google|grace',
      )
    })

    it('accepts for a record an operator created by address, before it has a subject', async () => {
      // `PUT /customer` creates a record with no `sub`. The recipient is identified by the
      // verified address on their token, so what the record lacks does not matter: the offer
      // was made to that address, and the token proves they hold it.
      const built = withGraceRecord(seedProject(server({ realLookups: true })))
      await transfer(built.app, { toEmail: 'grace@example.test' })

      expect((await accept(built)).statusCode).toBe(204)
      expect(
        (built.couch.documents.get(`projects/project:${PROJECT_ID}`) as { participants: unknown[] })
          .participants,
      ).toEqual([{ role: 'owner', userid: 'google|grace' }])
    })
  })

  describe('for somebody who has only signed in', () => {
    // No record, and no stubbed lookups: the recipient exists only as the verified address and
    // subject on their access token, which is what signing in alone leaves behind. Under
    // `_users` such a person had a document; under user records they have none, so the caller's
    // identity has to come from the token or they cannot see an offer made to them at all.
    const grace = () =>
      `Bearer ${accessTokenFor(KEY, { sub: 'google|grace', email: 'grace@example.test' })}`

    // An archived project: a person with no record is `free`, and an active project is refused
    // to a free recipient (see "accepting a transfer against the recipient's plan"). An archived
    // one is not asked about, so these still reach the record-less acceptance they are about.
    const offered = async () => {
      const built = seedProject(server({ realLookups: true }), true)
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
      return built
    }

    it('lists the offer', async () => {
      const built = await offered()
      const response = await built.app.inject({
        method: 'GET',
        url: '/transfers',
        headers: { authorization: grace() },
      })

      expect(response.json()).toEqual([
        {
          projectId: PROJECT_ID,
          projectName: 'Musterstraße 12',
          retainAccess: 'none',
          expiresAt: '2026-09-10T09:00:00.000Z',
        },
      ])
    })

    it('accepts it', async () => {
      const built = await offered()
      const response = await built.app.inject({
        method: 'POST',
        url: `/transfers/${PROJECT_ID}`,
        headers: { authorization: grace() },
      })

      expect(response.statusCode).toBe(204)
      expect(
        (built.couch.documents.get(`projects/project:${PROJECT_ID}`) as { participants: unknown[] })
          .participants,
      ).toEqual([{ role: 'owner', userid: 'google|grace' }])
    })

    /** The members of the project as the new owner sees them. */
    const membersAsGrace = (built: Awaited<ReturnType<typeof offered>>) => {
      // What CouchDB's `by_sub` view emits for a record carrying Grace's subject (the map itself
      // is executed in `users/database.test.ts`). The fake does not compute views, and the
      // document it points at exists only if acceptance created it.
      built.couch.rowsByDesign.by_sub = [
        { id: userDocId('grace@example.test'), key: 'google|grace', value: null },
      ]
      return built.app.inject({
        method: 'GET',
        url: `/projects/${PROJECT_ID}/members`,
        headers: { authorization: grace() },
      })
    }

    it('creates their record on acceptance, so the new owner has an address', async () => {
      // An owner nobody can resolve is listed with an empty address. Acceptance is the moment
      // this person starts to own something, so it is the moment the server keeps a record,
      // exactly as accepting an invitation at sign-in does.
      const built = await offered()
      await built.app.inject({
        method: 'POST',
        url: `/transfers/${PROJECT_ID}`,
        headers: { authorization: grace() },
      })

      expect(await userRecords(built.couch.couch).read('grace@example.test')).toMatchObject({
        sub: 'google|grace',
        email: 'grace@example.test',
      })
      expect((await membersAsGrace(built)).json()).toEqual([
        { sub: 'google|grace', email: 'grace@example.test', role: 'owner' },
      ])
    })

    it('creates no record when the acceptance is refused', async () => {
      // Somebody the offer was not made to must not get a record by asking.
      const built = await offered()
      await built.app.inject({
        method: 'POST',
        url: `/transfers/${PROJECT_ID}`,
        headers: {
          authorization: `Bearer ${accessTokenFor(KEY, { sub: 'google|eve', email: 'eve@example.test' })}`,
        },
      })

      expect(await userRecords(built.couch.couch).read('eve@example.test')).toBeUndefined()
    })

    it('declines it', async () => {
      const built = await offered()
      const response = await built.app.inject({
        method: 'DELETE',
        url: `/transfers/${PROJECT_ID}`,
        headers: { authorization: grace() },
      })

      expect(response.statusCode).toBe(204)
    })

    it('still refuses somebody the offer was not made to', async () => {
      const built = await offered()
      const response = await built.app.inject({
        method: 'POST',
        url: `/transfers/${PROJECT_ID}`,
        headers: {
          authorization: `Bearer ${accessTokenFor(KEY, { sub: OWNER, email: 'ada@example.test' })}`,
        },
      })

      expect(response.statusCode).toBe(404)
    })
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
    const built = seedOffer(asMember(seedProject(server({ registryConflicts: true }))))

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
    const built = seedOffer(asMember(seedProject(server({ registryConflicts: true }))))

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

describe("unarchiving against the owner's plan", () => {
  // Archived projects stop counting toward the limit, so without this an owner could archive N,
  // create N more and unarchive the old ones. The plan that pays is the OWNER's, whoever asks.
  const GRACE = 'google|grace'
  const POINTER = `${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`

  const seedRecord = (built: ReturnType<typeof server>, sub: string, plan: Plan) => {
    const email = EMAILS[sub] as string
    built.couch.documents.set(`${USERS_DB}/${userDocId(email)}`, {
      _id: userDocId(email),
      type: 'user',
      sub,
      email,
      plan,
    })
  }

  /**
   * A registry where {@link OWNER} owns `active` live projects plus the one under test, which is
   * archived or not as stated, and {@link GRACE} manages it.
   */
  function scenario(options: {
    ownerPlan: Plan | null
    active: number
    archived?: boolean
    managerPlan?: Plan
  }) {
    const built = server({ plan: options.ownerPlan })
    if (options.managerPlan !== undefined) seedRecord(built, GRACE, options.managerPlan)
    built.couch.documents.set(POINTER, {
      _id: pointerId(PROJECT_ID),
      _rev: '1-a',
      type: 'projectPointer',
      projectId: PROJECT_ID,
      dbName: DATABASE,
      projectName: 'Musterstraße 12',
      participants: [
        { role: 'owner', userid: OWNER },
        { role: 'manage', userid: GRACE },
      ],
      addedAt: '2026-08-27T09:00:00.000Z',
      archived: options.archived ?? true,
      archivedAt: 1_700_000_000,
    })
    built.couch.rowsByDesign.by_sub = [
      { id: userDocId(EMAILS[OWNER] as string), key: OWNER, value: null },
    ]
    const row = (projectId: string, archived: boolean) => ({
      value: {
        projectId,
        dbName: `project_${projectId}`,
        projectName: projectId,
        address: null,
        role: 'owner',
        archived,
        ownerId: OWNER,
      },
    })
    built.couch.rows = [
      ...Array.from({ length: options.active }, (_unused, index) => row(`live-${index}`, false)),
      row(PROJECT_ID, options.archived ?? true),
    ]
    return built
  }

  const unarchive = (built: ReturnType<typeof server>, sub: string = OWNER) =>
    built.inject({
      method: 'PATCH',
      url: `/projects/${PROJECT_ID}`,
      headers: { authorization: bearer(sub) },
      payload: { archived: false },
    })

  const stored = (built: ReturnType<typeof server>) =>
    built.couch.documents.get(POINTER) as { archived: boolean; _rev: string }

  it('refuses a member owner at the limit, naming project-limit-reached, and writes nothing', async () => {
    const built = scenario({ ownerPlan: 'member', active: 5 })

    const response = await unarchive(built)

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ reason: 'project-limit-reached' })
    expect(
      validate(response.json(), contractSchema('PATCH', '/projects/{projectId}', '403')),
    ).toEqual([])
    expect(stored(built)).toMatchObject({ archived: true, _rev: '1-a' })
  })

  it('lets a member owner with room unarchive', async () => {
    const built = scenario({ ownerPlan: 'member', active: 4 })

    const response = await unarchive(built)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ archived: false })
    expect(stored(built).archived).toBe(false)
  })

  it('refuses an owner whose plan no longer syncs, naming plan-no-sync', async () => {
    const built = scenario({ ownerPlan: 'free', active: 0 })

    const response = await unarchive(built)

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ reason: 'plan-no-sync' })
    expect(
      validate(response.json(), contractSchema('PATCH', '/projects/{projectId}', '403')),
    ).toEqual([])
    expect(stored(built).archived).toBe(true)
  })

  it('treats an owner with no record as free', async () => {
    const built = scenario({ ownerPlan: null, active: 0 })
    built.couch.rowsByDesign.by_sub = []

    expect((await unarchive(built)).json()).toMatchObject({ reason: 'plan-no-sync' })
  })

  it("judges a manager's unarchive by the owner's plan, not the manager's", async () => {
    const built = scenario({ ownerPlan: 'free', active: 0, managerPlan: 'pro' })

    const response = await unarchive(built, GRACE)

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ reason: 'plan-no-sync' })
    expect(stored(built).archived).toBe(true)
  })

  it('lets a manager unarchive when the owner has room', async () => {
    const built = scenario({ ownerPlan: 'member', active: 2, managerPlan: 'free' })

    expect((await unarchive(built, GRACE)).statusCode).toBe(200)
  })

  it('asks sync before capacity, with the owner as the principal', async () => {
    const built = scenario({ ownerPlan: 'member', active: 4 })
    built.gateCalls.length = 0

    await unarchive(built)

    expect(built.gateCalls.map((call) => call.action)).toEqual(['project.sync', 'project.create'])
    expect(built.gateCalls[0]?.principal).toMatchObject({
      sub: OWNER,
      plan: 'member',
      ownedProjects: 4,
    })
  })

  it('never refuses archiving, whatever the plan', async () => {
    const built = scenario({ ownerPlan: 'free', active: 9, archived: false })

    const response = await built.inject({
      method: 'PATCH',
      url: `/projects/${PROJECT_ID}`,
      headers: { authorization: bearer(OWNER) },
      payload: { archived: true },
    })

    expect(response.statusCode).toBe(200)
    expect(built.gateCalls).toEqual([])
  })

  it('does not gate an edit that leaves an archived project archived', async () => {
    const built = scenario({ ownerPlan: 'free', active: 0 })

    const response = await built.inject({
      method: 'PATCH',
      url: `/projects/${PROJECT_ID}`,
      headers: { authorization: bearer(OWNER) },
      payload: { name: 'Renamed' },
    })

    expect(response.statusCode).toBe(200)
    expect(built.gateCalls).toEqual([])
  })

  it('does not gate unarchiving a project that is not archived', async () => {
    const built = scenario({ ownerPlan: 'free', active: 0, archived: false })

    expect((await unarchive(built)).statusCode).toBe(200)
    expect(built.gateCalls).toEqual([])
  })
})

describe("accepting a transfer against the recipient's plan", () => {
  // Acceptance makes the caller the OWNER, so an active project moved to a free account would
  // be a server project nobody entitled to one owns. The recipient's plan is asked, as a
  // creation's is; an archived project is not, because unarchiving it is gated instead.
  const GRACE = 'google|grace'
  const POINTER = `${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`
  const OFFER = `${REGISTRY_DATABASE}/${transferId(PROJECT_ID)}`

  /**
   * An offer from {@link OWNER} to Grace, who holds `gracePlan` and already owns `active`
   * projects that are not archived.
   */
  function scenario(options: {
    gracePlan: Plan | null
    active: number
    archived?: boolean
    fails?: CouchFailures
  }) {
    const built = server(options.fails === undefined ? {} : { fails: options.fails })
    if (options.gracePlan !== null) {
      built.couch.documents.set(`${USERS_DB}/${userDocId('grace@example.test')}`, {
        _id: userDocId('grace@example.test'),
        type: 'user',
        sub: GRACE,
        email: 'grace@example.test',
        plan: options.gracePlan,
      })
    }
    built.couch.documents.set(POINTER, {
      _id: pointerId(PROJECT_ID),
      _rev: '1-a',
      type: 'projectPointer',
      projectId: PROJECT_ID,
      dbName: DATABASE,
      projectName: 'Musterstraße 12',
      participants: [{ role: 'owner', userid: OWNER }],
      addedAt: '2026-08-27T09:00:00.000Z',
      ...(options.archived === true ? { archived: true, archivedAt: 1_700_000_000 } : {}),
    })
    built.couch.documents.set(OFFER, {
      _id: transferId(PROJECT_ID),
      _rev: '1-a',
      type: 'transfer',
      projectId: PROJECT_ID,
      toEmail: 'grace@example.test',
      fromSub: OWNER,
      retainAccess: 'none',
      createdAt: '2026-08-27T09:00:00.000Z',
      expiresAt: '2026-09-10T09:00:00.000Z',
    })
    // What Grace already owns: one row per project, as the view emits them.
    built.couch.rows = Array.from({ length: options.active }, (_unused, index) => ({
      value: {
        projectId: `live-${index}`,
        dbName: `project_live-${index}`,
        projectName: `live-${index}`,
        address: null,
        role: 'owner',
        archived: false,
        ownerId: GRACE,
      },
    }))
    return built
  }

  const accept = (built: ReturnType<typeof server>) =>
    built.inject({
      method: 'POST',
      url: `/transfers/${PROJECT_ID}`,
      headers: { authorization: bearer(GRACE) },
    })

  const ownersAfter = (built: ReturnType<typeof server>) =>
    (built.couch.documents.get(POINTER) as { participants: unknown[] }).participants

  const offerIsPending = (built: ReturnType<typeof server>) =>
    (built.couch.documents.get(OFFER) as { _deleted?: boolean })._deleted !== true

  /**
   * The projects `GET /transfers` offers Grace, which is what the client sees. The fake's offer
   * view returns what it is given, so it is pointed at the stored offer unless that is deleted.
   */
  const offerListedFor = async (built: ReturnType<typeof server>): Promise<string[]> => {
    const stored = built.couch.documents.get(OFFER) as { _deleted?: boolean }
    built.couch.rowsByDesign.by_recipient = stored._deleted === true ? [] : [{ value: stored }]
    const response = await built.inject({
      method: 'GET',
      url: '/transfers',
      headers: { authorization: bearer(GRACE) },
    })
    return (response.json() as Array<{ projectId: string }>).map((entry) => entry.projectId)
  }

  it('refuses a free recipient, naming plan-no-sync, and leaves ownership and the offer alone', async () => {
    const built = scenario({ gracePlan: 'free', active: 0 })

    const response = await accept(built)

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ reason: 'plan-no-sync' })
    expect(
      validate(response.json(), contractSchema('POST', '/transfers/{projectId}', '403')),
    ).toEqual([])
    expect(ownersAfter(built)).toEqual([{ role: 'owner', userid: OWNER }])
    expect(offerIsPending(built)).toBe(true)
    expect(built.couch.security.has(DATABASE)).toBe(false)
    expect(await offerListedFor(built)).toEqual([PROJECT_ID])
  })

  it('creates no record for a recipient it refuses', async () => {
    const built = scenario({ gracePlan: null, active: 0 })

    expect((await accept(built)).json()).toMatchObject({ reason: 'plan-no-sync' })
    expect(built.couch.documents.has(`${USERS_DB}/${userDocId('grace@example.test')}`)).toBe(false)
  })

  it('refuses a member recipient at the limit, naming project-limit-reached', async () => {
    const built = scenario({ gracePlan: 'member', active: 5 })

    const response = await accept(built)

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ reason: 'project-limit-reached' })
    expect(
      validate(response.json(), contractSchema('POST', '/transfers/{projectId}', '403')),
    ).toEqual([])
    expect(ownersAfter(built)).toEqual([{ role: 'owner', userid: OWNER }])
    expect(offerIsPending(built)).toBe(true)
  })

  it('lets a member recipient with room accept', async () => {
    const built = scenario({ gracePlan: 'member', active: 4 })

    expect((await accept(built)).statusCode).toBe(204)
    expect(ownersAfter(built)).toEqual([{ role: 'owner', userid: GRACE }])
  })

  it('asks sync before capacity, with the recipient as the principal', async () => {
    const built = scenario({ gracePlan: 'member', active: 4 })
    built.gateCalls.length = 0

    await accept(built)

    expect(built.gateCalls.map((call) => call.action)).toEqual(['project.sync', 'project.create'])
    expect(built.gateCalls[0]?.principal).toMatchObject({
      sub: GRACE,
      plan: 'member',
      ownedProjects: 4,
    })
  })

  it('accepts an archived project for a free recipient: unarchiving is where it is gated', async () => {
    const built = scenario({ gracePlan: 'free', active: 0, archived: true })

    expect((await accept(built)).statusCode).toBe(204)
    expect(ownersAfter(built)).toEqual([{ role: 'owner', userid: GRACE }])
    expect(built.gateCalls).toEqual([])
  })

  describe('when CouchDB cannot say what the recipient already has', () => {
    it('answers a problem+json 500 when the registry view cannot be read, and changes nothing', async () => {
      // `ownedActive` reads the registry's view; the users database answers fine.
      const built = scenario({ gracePlan: 'member', active: 0, fails: { view: REGISTRY_DATABASE } })

      const response = await accept(built)

      expect(response.statusCode).toBe(500)
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/)
      expect(response.json()).toEqual({
        title: 'That transfer could not be accepted.',
        status: 500,
      })
      expect(response.body).not.toMatch(/internal server error|couch|_design/i)
      expect(ownersAfter(built)).toEqual([{ role: 'owner', userid: OWNER }])
      expect(offerIsPending(built)).toBe(true)
    })

    it('answers a problem+json 500 that says nothing about CouchDB, and changes nothing', async () => {
      const built = scenario({ gracePlan: 'member', active: 0, fails: { getDoc: USERS_DB } })

      const response = await accept(built)

      expect(response.statusCode).toBe(500)
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/)
      expect(response.json()).toEqual({
        title: 'That transfer could not be accepted.',
        status: 500,
      })
      expect(response.body).not.toMatch(/internal server error|couch|_design/i)
      expect(
        validate(response.json(), contractSchema('POST', '/transfers/{projectId}', '500')),
      ).toEqual([])
      expect(ownersAfter(built)).toEqual([{ role: 'owner', userid: OWNER }])
      expect(offerIsPending(built)).toBe(true)
    })
  })
})

describe('unarchiving when CouchDB cannot say what the owner already has', () => {
  const POINTER = `${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`

  /** An archived project of Ada's, whose owner lookup (`readBySub`) is the thing that fails. */
  const unarchiveWithFailing = (fails: CouchFailures) => {
    const built = server({ fails })
    built.couch.documents.set(POINTER, {
      _id: pointerId(PROJECT_ID),
      _rev: '1-a',
      type: 'projectPointer',
      projectId: PROJECT_ID,
      dbName: DATABASE,
      projectName: 'Musterstraße 12',
      participants: [{ role: 'owner', userid: OWNER }],
      addedAt: '2026-08-27T09:00:00.000Z',
      archived: true,
      archivedAt: 1_700_000_000,
    })
    return built
  }

  it.each([
    ['the owner lookup', { view: USERS_DB }],
    ['the registry view', { view: REGISTRY_DATABASE }],
  ])('answers a problem+json 500 when %s fails, and writes nothing', async (_name, fails) => {
    const built = unarchiveWithFailing(fails)

    const response = await built.inject({
      method: 'PATCH',
      url: `/projects/${PROJECT_ID}`,
      headers: { authorization: bearer(OWNER) },
      payload: { archived: false },
    })

    expect(response.statusCode).toBe(500)
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/)
    expect(response.json()).toEqual({ title: 'That project could not be changed.', status: 500 })
    expect(response.body).not.toMatch(/internal server error|couch|_design/i)
    expect(
      validate(response.json(), contractSchema('PATCH', '/projects/{projectId}', '500')),
    ).toEqual([])
    expect(built.couch.documents.get(POINTER)).toMatchObject({ archived: true, _rev: '1-a' })
  })
})

/**
 * A server whose registry already holds what this caller owns, and whose user record
 * carries their plan.
 *
 * Separate from {@link server} because these tests are about a *precondition*: what matters is
 * how many projects exist before the request, and reaching that state by creating them would
 * mean driving the very route under test through the very limit under test.
 *
 * @param options.plan what the user record holds, as an operator would have typed it
 * @param options.owned how many projects this subject owns
 * @param options.archivedCount how many of those owned projects are archived - they do not count
 * @param options.memberOf how many further projects this subject can see but does not own
 */
function serverWithProjects(options: {
  plan: Plan
  owned: number
  archivedCount?: number
  memberOf?: number
}): Server {
  const built = server()

  // The record, keyed by the address the caller's token carries — which is how the route finds
  // it. The `by_sub` row is there as it would be in CouchDB, and the route must not need it.
  built.couch.documents.set(`${USERS_DB}/${userDocId(SUBJECT_EMAIL)}`, {
    _id: userDocId(SUBJECT_EMAIL),
    type: 'user',
    sub: SUBJECT,
    email: SUBJECT_EMAIL,
    plan: options.plan,
  })
  built.couch.rowsByDesign.by_sub = [{ id: userDocId(SUBJECT_EMAIL), key: SUBJECT, value: null }]

  // One row per participation, which is what the view emits: a project somebody shared with
  // this subject is a row of theirs carrying somebody else's `ownerId`. `read` rather than the
  // `member` a reader might expect - `ProjectRole` has four values and that is not one of them.
  const rows = (count: number, role: string, archivedCount: number, prefix: string) =>
    Array.from({ length: count }, (_unused, index) => ({
      value: {
        projectId: `${prefix}-${index}`,
        dbName: `project_${prefix}_${index}`,
        projectName: `Project ${index}`,
        address: null,
        role,
        archived: index < archivedCount,
        ownerId: role === 'owner' ? SUBJECT : 'google|somebody-else',
      },
    }))

  built.couch.rows = [
    ...rows(options.owned, 'owner', options.archivedCount ?? 0, 'owned'),
    ...rows(options.memberOf ?? 0, 'read', 0, 'shared'),
  ]

  return built.app
}

describe("the caller's own record, found by the address on their token", () => {
  it('reads a plan an operator set by address before the caller signed in again', async () => {
    // `PUT /customer` creates a record by address alone, with no `sub`, so the `by_sub` view
    // cannot find it. `/auth/token` and `/profile` read by address and already say `member`;
    // this route must agree rather than answer `free` until the next sign-in.
    const { app: built, couch: fake } = server()
    await userRecords(fake.couch).setPlan(SUBJECT_EMAIL, 'member')
    fake.rows = [
      {
        value: {
          projectId: 'owned-0',
          dbName: 'project_owned_0',
          projectName: 'Project 0',
          address: null,
          role: 'owner',
          archived: false,
          ownerId: SUBJECT,
        },
      },
    ]

    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: {
        authorization: `Bearer ${accessTokenFor(KEY, { sub: SUBJECT, email: SUBJECT_EMAIL })}`,
      },
      payload: { name: 'Second' },
    })

    expect(response.statusCode).toBe(201)
  })
})

describe('creating a project against the plan', () => {
  it('refuses a free plan its first server project, naming plan-no-sync', async () => {
    // The free plan keeps its projects on the device. A server project is what sync is, so
    // there is nothing to count: the refusal is about the plan, not about capacity.
    const built = serverWithProjects({ plan: 'free', owned: 0 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Home' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ reason: 'plan-no-sync' })
    expect(validate(response.json(), contractSchema('POST', '/projects', '403'))).toEqual([])
  })

  it('provisions nothing for a free plan', async () => {
    const built = serverWithProjects({ plan: 'free', owned: 0 })
    await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Home' },
    })
    // The registry is created before the caller can be counted, so only a project database
    // is evidence of provisioning.
    expect(
      couch.calls.filter(
        (call) => call.operation === 'createDb' && call.database.startsWith('project_'),
      ),
    ).toEqual([])
    expect(couch.databases.has(`project_${PROJECT_ID}`)).toBe(false)
  })

  it('refuses a member at the limit, and says why in a way a client can branch on', async () => {
    // An empty 403 leaves the page unable to tell "you have used all your slots" from "you may
    // not do this", and those deserve different sentences.
    const built = serverWithProjects({ plan: 'member', owned: 5 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Second' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ reason: 'project-limit-reached' })
  })

  it('answers the capacity refusal the contract declares, reason and all', async () => {
    // The contract declared this 403 with a bare description and no schema at all until this
    // task, so `reason` - which the handler had been sending since the limit was enforced - was
    // documented nowhere and checked by nothing. Two separate gaps made that invisible: no
    // schema to look up, and an `operationsOf` that collected only `application/json` while
    // every refusal here is `application/problem+json`.
    const built = serverWithProjects({ plan: 'member', owned: 5 })
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
    // on a field the contract no longer promised. The 403 is now one of two refusals, so this
    // asserts both ways the pin can come loose: the field going missing, and a reason that
    // names neither refusal.
    const schema = contractSchema('POST', '/projects', '403')

    expect(validate({ title: 'No', status: 403 }, schema)).not.toEqual([])
    // The other refusal's reason, which is what a copy-paste produces. A capacity 403 that said
    // `not-an-operator` would tell a page to explain a permission problem to somebody whose
    // only problem is that they have run out of slots - and only one of those is fixed by
    // upgrading, which is the whole reason the field exists.
    expect(validate({ title: 'No', status: 403, reason: 'not-an-operator' }, schema)).not.toEqual(
      [],
    )
    // And both real reasons pass, so the check is not simply refusing everything.
    expect(validate({ title: 'No', status: 403, reason: 'plan-no-sync' }, schema)).toEqual([])
    expect(validate({ title: 'No', status: 403, reason: 'project-limit-reached' }, schema)).toEqual(
      [],
    )
  })

  it('does not count an archived project against the limit', async () => {
    // Reverses #55. Archiving is how a project is put away, and a plan's allowance is for the
    // projects somebody is working on; the database of an archived one stays, but it no longer
    // takes a slot. Five owned with two archived leaves a member with room.
    const built = serverWithProjects({ plan: 'member', owned: 5, archivedCount: 2 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Sixth' },
    })
    expect(response.statusCode).toBe(201)
  })

  it('still counts every project that is not archived', async () => {
    const built = serverWithProjects({ plan: 'member', owned: 5, archivedCount: 0 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Sixth' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ reason: 'project-limit-reached' })
  })

  it('does not count a project somebody else owns', async () => {
    // Membership is not ownership. A free user invited to a colleague's project keeps their
    // own slot, which is the point of counting ownership rather than visibility.
    const built = serverWithProjects({ plan: 'member', owned: 0, memberOf: 3 })
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
    const built = serverWithProjects({ plan: 'member', owned: 5 })
    await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Second' },
    })
    expect(couch.databases.has(`project_${PROJECT_ID}`)).toBe(false)
  })

  it('reads the plan from the account rather than assuming one', async () => {
    // The positive control for the refusal above: a handler that ignored the record entirely and
    // hard-coded `free` would pass every test in this block but this one.
    const built = serverWithProjects({ plan: 'member', owned: 1 })
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Second' },
    })
    expect(response.statusCode).toBe(201)
  })

  it('finds the record by the address on the token, not through the by_sub view', async () => {
    // The record is keyed by address and the token carries the verified one, so the plan is one
    // keyed read. The view is for *other* participants: a record an operator created by address
    // has no `sub` and is invisible to it, which kept an upgraded user `free` here until their
    // next sign-in. With the view emptied, the pro record must still lift the limit.
    const built = serverWithProjects({ plan: 'pro', owned: 1 })
    couch.rowsByDesign.by_sub = []
    const response = await built.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(SUBJECT) },
      payload: { name: 'Second' },
    })
    expect(response.statusCode).toBe(201)
    expect(
      couch.calls.some(
        (call) =>
          call.operation === 'view' &&
          (call.detail as { design?: string } | undefined)?.design === 'by_sub',
      ),
    ).toBe(false)
  })
})
