import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { denyList } from '../../src/auth/deny-list.js'
import { signingKeyFromPem, verifyToken } from '../../src/auth/jwt.js'
import { refreshStore } from '../../src/auth/refresh-store.js'
import { buildServer, type Server } from '../../src/server.js'
import { forgetUsersDatabase, USERS_DB } from '../../src/users/database.js'
import { recordEnsurer } from '../../src/users/ensure.js'
import { userDocId } from '../../src/users/key.js'
import { userRecords } from '../../src/users/records.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'
import { fakeCouch } from '../support/couch.js'
import { accessTokenFor } from '../support/tokens.js'

/**
 * `PUT /customer` — the only route that can reach an account other than the caller's.
 *
 * Everything else authenticated by the access token takes its subject from that token, so the
 * worst a broken check can do is let somebody change their own record. This route takes the
 * target from the request body, which means a hole in the gate is one user rewriting another
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

/** The operator, holding the role in their record. */
const OPERATOR = { sub: 'op|1', email: 'operator@example.test', name: 'Op' }
/** An ordinary signed-in user whose record carries no role. */
const ADA = { sub: 'google|1234', email: 'ada@example.com', name: 'Ada' }

/**
 * A server with only the profile routes wired (which is what registers `/customer`), over a
 * fake CouchDB holding `matter_manager`. `callerRoles` is written into the operator's record
 * directly in `fake.documents`, which is the Fauxton equivalent: roles are granted by editing a
 * document, never through the API.
 */
function customerServer({
  callerRoles = ['customerservice'],
}: {
  callerRoles?: readonly string[]
} = {}) {
  forgetUsersDatabase()
  const now = () => Math.floor(Date.now() / 1000)
  const fake = fakeCouch()
  fake.documents.set(`${USERS_DB}/${userDocId(OPERATOR.email)}`, {
    _id: userDocId(OPERATOR.email),
    _rev: '1-a',
    type: 'user',
    sub: OPERATOR.sub,
    email: OPERATOR.email,
    roles: callerRoles,
  })
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
    deny,
    fake,
    /** Every document handed to CouchDB for writing. A refused request must add none. */
    writes: () =>
      fake.calls.filter(
        (call) =>
          call.operation === 'putDoc' &&
          String((call.detail as { _id?: string } | undefined)?._id).startsWith('user:'),
      ),
    asOperator: { authorization: `Bearer ${accessTokenFor(key, OPERATOR)}` },
    asAda: { authorization: `Bearer ${accessTokenFor(key, ADA)}` },
  }
}

/** One PUT, since every test below is the same request with a different body or credential. */
const put = (
  server: Server,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) => server.inject({ method: 'PUT', url: '/customer', headers, payload })

describe('PUT /customer', () => {
  it('creates the record of somebody who has only ever signed in, and their next refresh carries the plan', async () => {
    const { app: server, records, asOperator } = customerServer()
    const res = await put(server, { email: 'New@Example.com', plan: 'member' }, asOperator)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ email: 'New@Example.com', plan: 'member', projectLimit: 5 })
    expect((await records.read('new@example.com'))?.plan).toBe('member')
  })

  it("sets an existing account's plan and leaves the caller's own alone", async () => {
    // The mutation this pins: a handler that read the target from the session instead of the
    // body would upgrade the operator and nobody else, silently, with a 200.
    const { app: server, records, asOperator } = customerServer()
    await records.setPlan('other@example.test', 'free')

    expect(
      (await put(server, { email: 'other@example.test', plan: 'pro' }, asOperator)).statusCode,
    ).toBe(200)
    expect((await records.read('other@example.test'))?.plan).toBe('pro')
    expect((await records.read(OPERATOR.email))?.plan).toBeUndefined()
  })

  it('refuses a caller without the role, and writes nothing', async () => {
    const { app: server, asAda, writes, records } = customerServer()
    const res = await put(server, { email: 'other@example.test', plan: 'pro' }, asAda)

    expect(res.statusCode).toBe(403)
    expect(JSON.stringify(res.json())).toContain('not-an-operator')
    expect(writes()).toEqual([])
    expect(await records.read('other@example.test')).toBeUndefined()
  })

  it.each([
    ['customerservices'],
    ['Customerservice'],
    ['customer'],
    ['CUSTOMERSERVICE'],
    ['admin'],
    ['_admin'],
  ])('refuses a caller whose only role is %s', async (role) => {
    // Exact membership only: a substring test lets the plural and the prefix through, a case
    // fold lets the typo through, and `_admin` was deliberately removed from the operator
    // roles (it already means "may write anything"). On this route that is a stranger
    // rewriting an account, not a self-grant.
    const { app: server, asOperator, writes, records } = customerServer({ callerRoles: [role] })
    const res = await put(server, { email: 'other@example.test', plan: 'pro' }, asOperator)

    expect(res.statusCode).toBe(403)
    expect(writes()).toEqual([])
    expect(await records.read('other@example.test')).toBeUndefined()
  })

  it('refuses an unsigned caller before it looks at anything', async () => {
    const { app: server, writes } = customerServer()
    const res = await put(server, { email: 'other@example.test', plan: 'pro' })

    expect(res.statusCode).toBe(401)
    expect(writes()).toEqual([])
  })

  it('refuses a deny-listed access token', async () => {
    // A signed-out operator's access token is still cryptographically valid until it expires;
    // only the deny list says otherwise, and on this route honouring it matters most.
    const { app: server, key, deny, writes } = customerServer()
    const token = accessTokenFor(key, OPERATOR)
    const { jti, exp } = verifyToken(token, key.publicKey, 'access')
    deny.deny(String(jti), exp)

    const res = await put(
      server,
      { email: 'other@example.test', plan: 'pro' },
      { authorization: `Bearer ${token}` },
    )

    expect(res.statusCode).toBe(401)
    expect(writes()).toEqual([])
  })
})

describe('the order the checks run in', () => {
  // The order is load-bearing, not tidiness. Answering about the *body* before deciding about
  // the *caller* turns this route into an oracle for signed-in users.

  it('answers 403 before validating the body, identically whether or not the account exists', async () => {
    const { app: server, asAda } = customerServer()
    const a = await put(server, { email: 'nobody@x.y', plan: 'pro' }, asAda)
    const b = await put(server, {}, asAda)

    expect(a.statusCode).toBe(403)
    expect(b.body).toBe(a.body)
  })

  it('tells a non-operator nothing by the difference between two names', async () => {
    const { app: server, asAda, records } = customerServer()
    await records.setPlan('other@example.test', 'free')
    const exists = await put(server, { email: 'other@example.test', plan: 'pro' }, asAda)
    const ghost = await put(server, { email: 'ghost@example.test', plan: 'pro' }, asAda)

    expect(exists.statusCode).toBe(403)
    expect(ghost.statusCode).toBe(exists.statusCode)
    expect(ghost.json()).toEqual(exists.json())
  })
})

describe('the body PUT /customer accepts', () => {
  it('rejects a missing address and an unknown plan with 400', async () => {
    const { app: server, asOperator } = customerServer()

    expect((await put(server, { plan: 'pro' }, asOperator)).statusCode).toBe(400)
    expect((await put(server, { email: 'a@b.c', plan: 'user' }, asOperator)).statusCode).toBe(400)
  })

  it.each([[undefined], [''], ['no-at-sign'], [42], [null]])(
    'refuses an email of %s',
    async (email) => {
      const { app: server, asOperator, writes } = customerServer()
      const res = await put(server, { email, plan: 'pro' }, asOperator)

      expect(res.statusCode).toBe(400)
      expect(JSON.stringify(res.json())).toContain('email')
      expect(writes()).toEqual([])
    },
  )

  it('refuses a body that is not there at all', async () => {
    const { app: server, asOperator } = customerServer()
    const res = await server.inject({ method: 'PUT', url: '/customer', headers: asOperator })

    // 400 either way — Fastify's own body check or the handler's. What matters is that a
    // missing body is not a crash and not a write.
    expect(res.statusCode).toBe(400)
  })

  it('takes only the address and the plan, never roles, type or a display name', async () => {
    // An operator who could set `roles` could mint more operators, and then the gate means
    // nothing. `setPlan` spreads the stored document and names `plan`, so nothing else the body
    // offers can land.
    const { app: server, asOperator, fake } = customerServer()
    const res = await put(
      server,
      {
        email: 'other@example.test',
        plan: 'pro',
        roles: ['customerservice'],
        type: 'evil',
        displayName: 'pwned',
      },
      asOperator,
    )

    expect(res.statusCode).toBe(200)
    const stored = fake.documents.get(`${USERS_DB}/${userDocId('other@example.test')}`)
    expect(stored).toMatchObject({ type: 'user', plan: 'pro', email: 'other@example.test' })
    expect(stored?.roles).toBeUndefined()
    expect(stored?.displayName).toBeUndefined()
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

    const { app: server, asOperator } = customerServer()
    const response = await put(server, { email: 'other@example.test', plan: 'member' }, asOperator)

    const schema = declared?.responses[String(response.statusCode)]
    expect(
      schema,
      `the contract declares no ${response.statusCode} for PUT /customer`,
    ).toBeDefined()
    expect(validate(response.json(), schema)).toEqual([])
  })

  /** The schema the contract declares for one status, asserted to exist before it is used. */
  const declaredFor = (status: number): unknown => {
    const schema = operations.find(
      (operation) => operation.method === 'PUT' && operation.path === '/customer',
    )?.responses[String(status)]
    expect(schema, `the contract declares no ${status} for PUT /customer`).toBeDefined()
    return schema
  }

  it('declares the refusal a non-operator gets, reason and all', async () => {
    // Checkable for the first time here. `operationsOf` collected only `application/json`, and
    // every refusal in the contract is `application/problem+json` - so this operation's 403 was
    // invisible to every contract assertion ever written, and a test that looked one up got
    // `undefined`, which `validate` finds nothing wrong with.
    const { app: server, asAda } = customerServer()
    const response = await put(server, { email: 'other@example.test', plan: 'pro' }, asAda)

    expect(response.statusCode).toBe(403)
    expect(validate(response.json(), declaredFor(403))).toEqual([])
  })

  it('declares no 404, because the operation creates the record', () => {
    const declared = operations.find(
      (operation) => operation.method === 'PUT' && operation.path === '/customer',
    )
    expect(declared?.responses['404']).toBeUndefined()
  })

  it('would notice a refusal that stopped naming itself', async () => {
    // The negative control, and the positive tests above cannot stand in for it: `validate`
    // ignores properties the contract does not declare, so dropping `reason` from the 403
    // schema would leave the handler's real answer validating perfectly against a contract that
    // had gone silent about the field a client branches on. This asserts the two ways the
    // contract can stop pinning it - the field leaving `required`, and the `const` naming a
    // different refusal.
    const forbidden = declaredFor(403)

    expect(validate({ title: 'No', status: 403 }, forbidden)).toEqual([
      { at: '$.reason', says: 'is required and missing' },
    ])
    expect(
      validate({ title: 'No', status: 403, reason: 'project-limit-reached' }, forbidden),
    ).toEqual([{ at: '$.reason', says: 'must be "not-an-operator", got "project-limit-reached"' }])
  })
})
