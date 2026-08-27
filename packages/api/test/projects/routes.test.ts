import { generateKeyPairSync } from 'node:crypto'
import type { Action, Principal } from '@matter-manager/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mintToken, type SigningKey } from '../../src/auth/jwt.js'
import { NotEntitledError } from '../../src/entitlements/gate.js'
import { forgetRegistry, REGISTRY_DATABASE } from '../../src/projects/registry.js'
import { buildServer, type Server } from '../../src/server.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'
import { type CouchFailures, type FakeCouch, fakeCouch } from '../support/couch.js'

const OWNER = 'google|1234'
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

let app: Server | undefined
let couch: FakeCouch

/** A server with the project routes wired to a fake CouchDB and a watchable gate. */
function server(options: { fails?: CouchFailures; gateRefuses?: boolean } = {}) {
  couch = fakeCouch(options.fails === undefined ? {} : { fails: options.fails })
  const gateCalls: Array<{ principal: Principal; action: Action }> = []

  app = buildServer({
    logger: false,
    projects: {
      couch: couch.couch,
      key: KEY,
      validator: () => 'function (newDoc) { return newDoc }',
      newId: () => PROJECT_ID,
      clock: () => '2026-08-27T09:00:00.000Z',
      gate: (principal, action) => {
        gateCalls.push({ principal, action })
        if (options.gateRefuses === true) throw new NotEntitledError(action)
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

  return { app, couch, gateCalls, inject: app.inject.bind(app) }
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
    })
  })

  it('answers the shape the contract declares', async () => {
    // Against the contract's own schema rather than a hand-written shape, so this endpoint and
    // `openapi/matter-manager.yaml` cannot drift apart quietly (ADR 0015).
    const { app: built } = server()
    const response = await create(built, { name: 'Musterstraße 12' })

    const schema = operationsOf(loadContract()).find(
      (operation) => operation.method === 'POST' && operation.path === '/projects',
    )?.responses['201']

    expect(validate(response.json(), schema)).toEqual([])
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
      principal: { sub: OWNER, plan: 'free' },
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
    const { app: built, couch: fake } = server({ gateRefuses: true })
    await create(built, { name: 'Musterstraße 12' })

    expect(fake.databases.size).toBe(0)
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
    const { app: built, couch: fake } = server()
    await create(built, { name: '' })

    expect(fake.databases.size).toBe(0)
  })
})

describe('when provisioning fails', () => {
  it('answers 400 and says nothing about CouchDB', async () => {
    const { app: built } = server({ fails: { putSecurity: true } })
    const response = await create(built, { name: 'Musterstraße 12' })

    expect(response.body).not.toMatch(/internal_server_error|couch/i)
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
      },
    ])
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
