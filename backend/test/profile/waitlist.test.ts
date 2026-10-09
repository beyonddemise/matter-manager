import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { denyList } from '../../src/auth/deny-list.js'
import { signingKeyFromPem } from '../../src/auth/jwt.js'
import { refreshStore } from '../../src/auth/refresh-store.js'
import { buildServer, type Server } from '../../src/server.js'
import { forgetUsersDatabase, USERS_DB } from '../../src/users/database.js'
import { recordEnsurer } from '../../src/users/ensure.js'
import { userDocId } from '../../src/users/key.js'
import { type Profile, userRecords } from '../../src/users/records.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'
import { fakeCouch } from '../support/couch.js'
import { accessTokenFor } from '../support/tokens.js'

const ADA = { sub: 'google|1234', email: 'ada@example.com', name: 'Ada' }

function newKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(
    'ec-test',
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  )
}

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

/**
 * The service with `/profile` and `/waitlist` wired over a fake CouchDB, logging into `lines`
 * so a test can read what the service really writes, through its own redaction.
 */
function waitlistServer() {
  forgetUsersDatabase()
  const now = () => Math.floor(Date.now() / 1000)
  const fake = fakeCouch()
  const records = userRecords(fake.couch)
  const refresh = refreshStore(records, now)
  const key = newKey()
  const lines: string[] = []
  app = buildServer({
    logStream: { write: (line) => lines.push(line) },
    profile: { records, ensureRecord: recordEnsurer(records, refresh), key, deny: denyList(now) },
  })
  const id = (email: string) => `${USERS_DB}/${userDocId(email)}`
  return {
    app,
    key,
    records,
    refresh,
    fake,
    lines,
    stored: (email = ADA.email) => fake.documents.get(id(email)),
    /** The Fauxton equivalent: a record as an operator left it. */
    seed: (fields: Record<string, unknown>, email = ADA.email) =>
      fake.documents.set(id(email), {
        _id: userDocId(email),
        _rev: '1-a',
        type: 'user',
        sub: ADA.sub,
        email,
        ...fields,
      }),
  }
}

type Fixture = ReturnType<typeof waitlistServer>

const bearer = (server: Fixture) => ({
  authorization: `Bearer ${accessTokenFor(server.key, ADA)}`,
})
const join = (
  server: Fixture,
  payload: unknown,
  headers: Record<string, string> = bearer(server),
) => server.app.inject({ method: 'PUT', url: '/waitlist', headers, payload: payload as object })
// No payload and no content type: what a browser's `fetch` sends for a DELETE without a body.
const leave = (server: Fixture, headers: Record<string, string> = bearer(server)) =>
  server.app.inject({ method: 'DELETE', url: '/waitlist', headers })

/** The contract's schema for one answer, asserted to exist before it is used. */
const schemaOf = (method: string, status: string): unknown => {
  const schema = operationsOf(loadContract()).find(
    (operation) => operation.method === method && operation.path === '/waitlist',
  )?.responses[status]
  expect(schema, `the contract has no ${method} /waitlist ${status}`).toBeDefined()
  return schema
}

describe('joining the waitlist', () => {
  it('refuses without a bearer', async () => {
    const server = waitlistServer()
    const response = await join(server, { plan: 'pro' }, {})

    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json(;|$)/)
    expect(server.stored()).toBeUndefined()
  })

  it.each([
    ['free', { plan: 'free' }],
    ['an unknown plan', { plan: 'gold' }],
    ['no plan', {}],
    ['a number', { plan: 2 }],
  ])('refuses %s with 400, and creates no record', async (_case, payload) => {
    const server = waitlistServer()
    const response = await join(server, payload)

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ title: 'Not a plan to wait for', status: 400 })
    expect(server.stored()).toBeUndefined()
  })

  it.each([
    ['the plan it has', 'member', 'member'],
    ['a lower plan', 'pro', 'member'],
  ])('refuses %s with 409, and writes nothing', async (_case, held, wanted) => {
    const server = waitlistServer()
    server.seed({ plan: held })
    const response = await join(server, { plan: wanted })

    expect(response.statusCode).toBe(409)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json(;|$)/)
    expect(response.json()).toMatchObject({
      title: 'Already on this plan',
      reason: 'already-on-plan',
    })
    expect(validate(response.json(), schemaOf('PUT', '409'))).toEqual([])
    expect(response.body).not.toContain(ADA.email)
    expect(server.stored()).not.toHaveProperty('planRequested')
  })

  it('creates the record, stores the request and answers the profile the contract declares', async () => {
    const server = waitlistServer()
    const before = Math.floor(Date.now() / 1000) * 1000
    const response = await join(server, { plan: 'member' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(validate(response.json(), schemaOf('PUT', '200'))).toEqual([])
    const body = response.json() as Profile
    expect(body).toMatchObject({ email: ADA.email, plan: 'free', planRequested: 'member' })
    const stored = server.stored() as { sub: string; planRequested: string; requestedAt: string }
    expect(stored).toMatchObject({ sub: ADA.sub, planRequested: 'member' })
    expect(Date.parse(stored.requestedAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(stored.requestedAt)).toBeLessThanOrEqual(Date.now())
    expect(body.requestedAt).toBe(stored.requestedAt)
  })

  it('keeps the refresh session alive when it creates the record', async () => {
    // Through `ensureRecord`, which moves the in-memory refresh entries onto the new record.
    const server = waitlistServer()
    await server.refresh.remember(ADA.email, { hash: 'h', exp: 9_999_999_999, createdAt: 0 })

    await join(server, { plan: 'pro' })

    expect(await server.records.hasRefresh(ADA.email, 'h', 0)).toBe(true)
  })

  it('changes the plan waited for, and its date', async () => {
    const server = waitlistServer()
    await join(server, { plan: 'member' })
    const first = (server.stored() as { requestedAt: string }).requestedAt

    const response = await join(server, { plan: 'pro' })

    expect(response.statusCode).toBe(200)
    const stored = server.stored() as { planRequested: string; requestedAt: string }
    expect(stored.planRequested).toBe('pro')
    expect(Date.parse(stored.requestedAt)).toBeGreaterThanOrEqual(Date.parse(first))
  })

  it('lets a member wait for pro', async () => {
    const server = waitlistServer()
    server.seed({ plan: 'member' })

    expect((await join(server, { plan: 'pro' })).statusCode).toBe(200)
    expect(server.stored()).toMatchObject({ plan: 'member', planRequested: 'pro' })
  })

  it('takes the identity from the token, never from the body', async () => {
    const server = waitlistServer()
    await join(server, { plan: 'pro', email: 'mallory@example.com' })

    expect(server.stored('mallory@example.com')).toBeUndefined()
    expect(server.stored()).toMatchObject({ planRequested: 'pro' })
  })

  it('logs one line with the subject and the plan, and never the address', async () => {
    const server = waitlistServer()
    await join(server, { plan: 'member' })

    const entries = server.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    const joined = entries.filter((entry) => entry.msg === 'waitlist: joined member')
    expect(joined).toHaveLength(1)
    expect(joined[0]).toMatchObject({ sub: ADA.sub })
    expect(server.lines.join('\n')).not.toContain(ADA.email)
    // The record id is the address in base64url, so it is the address too.
    expect(server.lines.join('\n')).not.toContain(userDocId(ADA.email))
  })
})

describe('leaving the waitlist', () => {
  it('refuses without a bearer', async () => {
    const server = waitlistServer()
    expect((await leave(server, {})).statusCode).toBe(401)
  })

  it('clears both fields and answers the profile the contract declares', async () => {
    const server = waitlistServer()
    await join(server, { plan: 'pro' })

    const response = await leave(server)

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(validate(response.json(), schemaOf('DELETE', '200'))).toEqual([])
    expect(response.json()).not.toHaveProperty('planRequested')
    expect(server.stored()).not.toHaveProperty('planRequested')
    expect(server.stored()).not.toHaveProperty('requestedAt')
  })

  it('creates no record, and answers what GET /profile answers', async () => {
    const server = waitlistServer()
    const response = await leave(server)
    const read = await server.app.inject({
      method: 'GET',
      url: '/profile',
      headers: bearer(server),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(read.json())
    expect(server.stored()).toBeUndefined()
  })

  it('is idempotent: a second leave writes nothing', async () => {
    const server = waitlistServer()
    await join(server, { plan: 'pro' })
    await leave(server)
    const writes = () => server.fake.calls.filter((call) => call.operation === 'putDoc').length
    const before = writes()

    expect((await leave(server)).statusCode).toBe(200)
    expect(writes()).toBe(before)
  })
})
