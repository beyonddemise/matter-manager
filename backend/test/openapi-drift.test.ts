import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { denyList } from '../src/auth/deny-list.js'
import { mintToken, type SigningKey } from '../src/auth/jwt.js'
import { refreshStore } from '../src/auth/refresh-store.js'
import { profileStore } from '../src/profile/store.js'
import { buildServer, type Server } from '../src/server.js'
import { forgetUsersDatabase } from '../src/users/database.js'
import { userRecords } from '../src/users/records.js'
import {
  loadContract,
  operationsOf,
  toFastifyPath,
  unsupportedKeywords,
  validate,
} from './support/contract.js'
import { fakeCouch } from './support/couch.js'

/**
 * The contract-drift check.
 *
 * **This is the whole value of ADR 0004**, and ADR 0015 is explicit that it is the other half of
 * the decision to *check* the specification rather than *execute* it. Without it, "the Quarkus
 * option is still open" quietly becomes false within a month and nobody finds out until they try
 * to use it.
 *
 * It is a test rather than a separate CI script because CI already runs the tests, and because a
 * check that lives beside the code it checks is one people run before pushing.
 *
 * @see docs/adr/0015-openapi-checked-not-executed.md
 */

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

/**
 * The one key every server in this file signs and verifies with.
 *
 * Module scope rather than per server, and that is load-bearing for the credentialed pass
 * below: it mints a token and hands it back to the same instance, so the two have to agree
 * about the key. They did not, in the first version — the test generated a keypair of its own
 * and every credentialed request was answered 401 by a server that had never seen it. It looked
 * like coverage and was a second copy of the anonymous pass.
 */
const SIGNING: SigningKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { kid: 'drift', privateKey, publicKey }
})()

/**
 * A server with **everything wired**.
 *
 * Not `buildServer({ logger: false })`. Routes are registered only when their dependencies are
 * supplied, so a dependency-less server registers almost nothing — and the "not implemented
 * yet" list below would then be a list of things this test forgot to configure rather than a
 * list of things nobody has written. The two are indistinguishable from the outside, which is
 * exactly the kind of check that reads as thorough and is not.
 */
const server = (): Server => {
  // **One** CouchDB, wired to both the profile store and the project routes.
  //
  // They were two separate `fakeCouch()` instances, which is inert only for as long as no test
  // writes anything: the two stores share no documents, so a later test that seeded a `_users`
  // document through the profile side and then asked `POST /projects` for the subject's plan
  // would read an empty store, get `free`, and pass for a reason that has nothing to do with
  // what it was asserting. One instance means the server behaves like a deployment, where there
  // is one database behind both.
  forgetUsersDatabase()
  const couch = fakeCouch().couch
  const store = profileStore(couch)
  const records = userRecords(couch)
  const clock = () => Math.floor(Date.now() / 1000)
  const key = SIGNING

  app = buildServer({
    logger: false,
    auth: {
      provider: {
        name: 'drift',
        jwksUri: 'https://provider.test/jwks',
        authorizationEndpoint: 'https://provider.test/authorize',
        tokenEndpoint: 'https://provider.test/token',
        clientId: 'drift',
        clientSecret: 'drift',
        redirectUri: 'https://api.test/auth/google/callback',
        scopes: ['openid', 'email', 'profile'],
      },
      key,
      sessionKey: key,
      verifyIdToken: async () => ({ sub: 'google|1234', email: 'ada@example.test', name: 'Ada' }),
      appOrigin: 'https://app.test',
      records,
      refresh: refreshStore(records, clock),
      deny: denyList(clock),
      signIn: async () => ({ hasRecord: false }),
      logSignIn: () => undefined,
    },
    profile: {
      // The **real** store over the fake CouchDB, and deliberately not a hand-written stub.
      //
      // It was `{ read, write, rememberUser } as unknown as ProfileDependencies['store']` — three
      // methods, one of which (`write`) the interface does not even have, and missing `rolesOf`
      // and `setPlan`. The cast is what allowed that: it told the compiler to stop checking the
      // one thing it was in a position to check. `registerCustomerRoutes` is wired to this
      // store, so the first request that reached `PUT /customer` past the session check would
      // have called `rolesOf` on `undefined` and thrown a TypeError — a 500 from the test
      // harness, on a route whose refusals this file now validates.
      //
      // Using `profileStore` instead means there is no interface to keep in step by hand: a
      // method added to `ProfileStore` is implemented once, in the real implementation, and this
      // server gets it. That is the compile-time guarantee the rest of the branch leans on, and
      // a cast here is exactly the hole in it.
      store,
      key,
    },
    projects: {
      couch,
      key,
      profiles: store,
      validator: () => 'function (doc) { return doc }',
      identityOf: async (sub: string) => ({
        sub,
        email: 'drift@example.test',
        emailVerified: true,
      }),
    },
  })
  return app
}

const contract = loadContract()
const operations = operationsOf(contract)

/** `GET /healthz`, in the form both sides are compared in. */
const key = (method: string, path: string) => `${method} ${toFastifyPath(path)}`

describe('the contract itself', () => {
  it('describes some operations', () => {
    // The positive control. Every assertion below compares two sets, and two empty sets agree
    // perfectly — so a contract that failed to parse, or a path to it that was wrong after a
    // file moved, would make this whole file pass while checking nothing at all.
    expect(operations.length).toBeGreaterThan(5)
    expect(operations.map((operation) => key(operation.method, operation.path))).toContain(
      'GET /healthz',
    )
  })

  it('resolves the references the contract uses', () => {
    // `$ref` was on the supported-keyword list, which meant a response declared as
    // `{ $ref: '#/components/responses/Unauthorized' }` reached the validator as an object with
    // no `type` and no `properties` — checked perfectly, and found perfectly fine. Every
    // `$ref`-shaped response was waved through, and the unsupported-keyword guard could not see
    // it *because the keyword was listed as supported*. This asserts the resolution happened.
    const referenced = operations
      .flatMap((operation) => Object.values(operation.responses))
      .filter((schema) => typeof schema === 'object' && schema !== null && '$ref' in schema)

    expect(referenced).toEqual([])
  })

  it('uses only schema keywords the checker understands', () => {
    // The second way this file could quietly stop checking: a partial validator that ignores
    // what it does not know reports success for a `oneOf` it never looked at. Adding one to the
    // contract fails here, loudly, rather than weakening the check in silence.
    const unsupported = new Set<string>()
    for (const operation of operations) {
      for (const schema of Object.values(operation.responses)) {
        for (const keyword of unsupportedKeywords(schema)) unsupported.add(keyword)
      }
    }

    expect([...unsupported]).toEqual([])
  })
})

describe('no undocumented routes', () => {
  it('registers nothing the contract does not describe', () => {
    // The issue's second scenario. A route that exists only in the code is precisely how the
    // "reimplementable in Quarkus" claim stops being true — the new implementation would be
    // correct against the contract and wrong against the frontend.
    const documented = new Set(operations.map((operation) => key(operation.method, operation.path)))
    const undocumented = server()
      .registeredRoutes()
      .map((route) => `${route.method} ${route.url}`)
      .filter((route) => !documented.has(route))

    expect(undocumented).toEqual([])
  })
})

describe('every implemented route answers what the contract declares', () => {
  /** The operations built so far. The rest of the contract is M4-3 onwards. */
  const implemented = () => {
    const registered = new Set(
      server()
        .registeredRoutes()
        .map((route) => `${route.method} ${route.url}`),
    )
    return operations.filter((operation) => registered.has(key(operation.method, operation.path)))
  }

  it('has implemented at least one', () => {
    // Same reasoning as the control above: an empty list of implemented operations would make
    // the response check below pass without checking a response.
    expect(implemented().length).toBeGreaterThan(0)
  })

  /**
   * A concrete URL for an operation, with any path parameter filled in.
   *
   * The value does not have to exist. Every route resolves the parameter against CouchDB and
   * answers 404 for a project nobody has, which is a declared answer and therefore a real
   * response to validate — the parameter only has to be *syntactically* a segment so Fastify
   * routes the request to the handler rather than to its own 404.
   */
  const urlFor = (path: string) => toFastifyPath(path).replace(/:[^/]+/g, 'drift-no-such-thing')

  /**
   * The two ways this check drives a request, and why there are two.
   *
   * Unauthenticated reaches the 401 on every guarded operation — which turned out to be the
   * half that mattered, because three operations were answering a 401 the contract did not
   * declare at all and nothing could see it.
   *
   * Credentialed reaches past that, to the 200s, 400s, 403s and 404s a route answers when it
   * has a subject and an empty body to complain about. The credentials are minted from this
   * server's own key, so they are genuine rather than mocked: `bearerSubject` and the handoff
   * verifier do their real work, and a route that stopped accepting a valid token would show up
   * here as a 401 where the contract declares a 200.
   *
   * Both passes send `{}`. A body with nothing in it is the shortest route to each operation's
   * own validation, and every operation here reports a missing field rather than crashing on
   * one — which is itself worth pinning.
   */
  const credentials = () => {
    const claims = { sub: 'drift-user', exp: Math.floor(Date.now() / 1000) + 3600 }
    const access = mintToken(SIGNING, { purpose: 'access', ...claims })
    // A fresh `jti` per request, because a handoff is single use and each operation's pass
    // should reach `POST /auth/token`'s 200 rather than a 401 for a handoff already spent.
    const handoff = mintToken(SIGNING, {
      purpose: 'handoff',
      ...claims,
      email: 'drift@example.test',
      jti: randomUUID(),
    })
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${access}`,
      cookie: `mm_handoff=${encodeURIComponent(handoff)}`,
    }
  }

  /**
   * **Every** implemented operation, in both passes.
   *
   * This drove `operationsOf(contract).filter((operation) => operation.path === '/healthz')`.
   * It computed `implemented()` two assertions above, asserted it was non-empty, and then threw
   * it away — so one of twenty-five operations had its responses validated and twenty-four did
   * not, while the plan's Global Constraints said this check "walks every operation and
   * validates real responses against it". Every task on this branch had to rediscover for
   * itself that its refusals were unvalidated, because the file that claimed to validate them
   * was looking at `/healthz`.
   *
   * **No exclusion list.** One was expected to be necessary — an operation needing a request
   * body or a real project id has nothing this check can supply — and it turned out not to be:
   * every operation answers *something the contract declares* to an empty body and a
   * nonexistent id, because that is what a well-behaved API does. If that ever stops being
   * true, the exclusion belongs here, named, with the reason. Not as a filter that quietly
   * narrows what `%s %s` claims to cover.
   */
  it.each(implemented().map((operation) => [operation.method, operation.path] as const))(
    '%s %s answers what the contract declares',
    async (method, path) => {
      const instance = server()
      const operation = operations.find(
        (candidate) => candidate.method === method && candidate.path === path,
      )
      // Before the loop, not inside it. A lookup that missed would make every assertion below
      // read `undefined`, and `validate(value, undefined)` reports nothing wrong — the exact
      // way this file's predecessor passed while checking nothing.
      expect(operation, `the contract lost ${method} ${path} between two reads`).toBeDefined()

      for (const headers of [{}, credentials()]) {
        const response = await instance.inject({
          method: method as 'GET',
          url: urlFor(path),
          payload: {},
          headers: { 'content-type': 'application/json', ...headers },
        })
        const status = String(response.statusCode)
        const where = `${method} ${path} answered ${status}`

        // First: is this status described at all? `responses` is keyed only by the statuses
        // that declare a body, so asking it alone cannot tell an undeclared 401 from a
        // declared 204 — and three operations were answering the former.
        expect(operation?.declared, `${where}, which the contract does not declare`).toContain(
          status,
        )

        const schema = operation?.responses[status]
        // A declared status with no body — 204, 302 — is complete as it stands, and there is
        // nothing to parse. Distinguished from a missing declaration by the assertion above,
        // which has already passed by the time this is read.
        if (schema === undefined) continue

        // The media type, which no assertion in this repository had ever looked at. Every
        // refusal in the contract is `application/problem+json` and every handler was sending
        // `application/json`: the schemas matched, so the bodies validated, and the label was
        // wrong on every error response in the service.
        expect(response.headers['content-type'], `${where} with the wrong media type`).toMatch(
          new RegExp(`^${operation?.mediaTypes[status]?.replace('+', '\\+')}(;|$)`),
        )
        expect(validate(response.json(), schema), where).toEqual([])
      }
    },
  )
})

describe('what the contract describes and the code does not yet', () => {
  it('is reported rather than failed', () => {
    // Not a failure: mid-milestone, most of the contract is unimplemented by design, and a
    // check that failed on it would be a check nobody could keep green. It is asserted as a
    // known list so that *finishing* one is a deliberate edit here rather than a silent change
    // in what the drift check covers.
    const registered = new Set(
      server()
        .registeredRoutes()
        .map((route) => `${route.method} ${route.url}`),
    )
    const pending = operations
      .map((operation) => key(operation.method, operation.path))
      .filter((operation) => !registered.has(operation))
      .sort()

    // **Empty.** Every operation the contract describes is implemented, which is what this
    // check was built to be able to say — and from here it goes red when the contract grows an
    // operation, rather than when somebody forgets to update a list.
    expect(pending).toEqual([])
  })
})

describe('the check catches drift it was built to catch', () => {
  // #39: "verify the check by breaking it on purpose before trusting it. A drift check that has
  // never caught drift has not been shown to catch drift."
  //
  // Broken here rather than by hand, so the proof is kept rather than described. Each case is
  // the exact drift the corresponding assertion above is supposed to notice, applied to a
  // server built for the purpose.

  /**
   * `/healthz`'s 200 schema, **asserted to exist** before it is handed to `validate`.
   *
   * Four cases below looked it up with `?.responses['200']` and passed the result straight to
   * `validate`, unguarded. `validate(value, undefined)` reports nothing wrong, so a lookup that
   * missed — a path renamed, `operationsOf` changed, the contract moved — turns a test that
   * proves the validator catches drift into a test that proves nothing, and it does so while
   * staying green in three of the four.
   *
   * One function rather than four `expect(schema).toBeDefined()` lines, because the guard has
   * to be at *every* lookup to be worth anything and a fifth case added later would not have
   * one. Here it cannot be forgotten: there is no way to get the schema without it.
   */
  const healthzSchema = (): unknown => {
    const schema = operations.find((operation) => operation.path === '/healthz')?.responses['200']
    expect(schema, 'the contract no longer declares a 200 body for GET /healthz').toBeDefined()
    return schema
  }

  it('notices a route the contract does not describe', () => {
    const instance = server()
    instance.get('/undocumented', async () => ({ ok: true }))

    const documented = new Set(operations.map((operation) => key(operation.method, operation.path)))
    const undocumented = instance
      .registeredRoutes()
      .map((route) => `${route.method} ${route.url}`)
      .filter((route) => !documented.has(route))

    expect(undocumented).toEqual(['GET /undocumented'])
  })

  it('notices a response missing a declared field', () => {
    const schema = healthzSchema()

    expect(validate({}, schema)).toEqual([{ at: '$.status', says: 'is required and missing' }])
  })

  it('notices a response whose field has the wrong value', () => {
    // `/healthz` declares `status` as `const: ok`. A handler returning `degraded` is a handler
    // the contract does not describe, however sensible the value looks.
    const schema = healthzSchema()

    expect(validate({ status: 'degraded' }, schema)).toEqual([
      { at: '$.status', says: 'must be "ok", got "degraded"' },
    ])
  })

  it('notices a response whose field has the wrong type', () => {
    const schema = healthzSchema()

    expect(validate({ status: 200 }, schema)).toContainEqual({
      at: '$.status',
      says: 'must be string, got number',
    })
  })

  it('notices a response that is not an object at all', () => {
    const schema = healthzSchema()

    expect(validate('ok', schema)).toEqual([{ at: '$', says: 'must be object, got string' }])
  })

  it('reports every problem rather than stopping at the first', () => {
    // A response with three wrong fields should take one run to fix, not three.
    const schema = {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'integer' } },
    }

    expect(validate({ c: 1.5 }, schema)).toHaveLength(3)
  })
})
