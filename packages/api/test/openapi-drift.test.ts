import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, type Server } from '../src/server.js'
import {
  loadContract,
  operationsOf,
  toFastifyPath,
  unsupportedKeywords,
  validate,
} from './support/contract.js'

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

const server = (): Server => {
  app = buildServer({ logger: false })
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

  it.each(
    operationsOf(contract)
      .filter((operation) => operation.path === '/healthz')
      .map((operation) => [operation.method, operation.path] as const),
  )('%s %s matches its declared response', async (method, path) => {
    const instance = server()
    const response = await instance.inject({ method: method as 'GET', url: path })

    const schema = operations.find(
      (operation) => operation.method === method && operation.path === path,
    )?.responses[String(response.statusCode)]

    expect(
      schema,
      `the contract declares no ${response.statusCode} for ${method} ${path}`,
    ).toBeDefined()
    expect(validate(response.json(), schema)).toEqual([])
  })
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

    expect(pending).toEqual([
      'GET /auth/google',
      'GET /auth/google/callback',
      'GET /profile',
      'GET /projects',
      'GET /projects/:projectId/members',
      'POST /auth/token',
      'POST /projects',
      'POST /projects/:projectId/transfer',
      'PUT /profile',
      'PUT /projects/:projectId/members',
    ])
  })
})

describe('the check catches drift it was built to catch', () => {
  // #39: "verify the check by breaking it on purpose before trusting it. A drift check that has
  // never caught drift has not been shown to catch drift."
  //
  // Broken here rather than by hand, so the proof is kept rather than described. Each case is
  // the exact drift the corresponding assertion above is supposed to notice, applied to a
  // server built for the purpose.

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
    const schema = operations.find((operation) => operation.path === '/healthz')?.responses['200']

    expect(validate({}, schema)).toEqual([{ at: '$.status', says: 'is required and missing' }])
  })

  it('notices a response whose field has the wrong value', () => {
    // `/healthz` declares `status` as `const: ok`. A handler returning `degraded` is a handler
    // the contract does not describe, however sensible the value looks.
    const schema = operations.find((operation) => operation.path === '/healthz')?.responses['200']

    expect(validate({ status: 'degraded' }, schema)).toEqual([
      { at: '$.status', says: 'must be "ok", got "degraded"' },
    ])
  })

  it('notices a response whose field has the wrong type', () => {
    const schema = operations.find((operation) => operation.path === '/healthz')?.responses['200']

    expect(validate({ status: 200 }, schema)).toContainEqual({
      at: '$.status',
      says: 'must be string, got number',
    })
  })

  it('notices a response that is not an object at all', () => {
    const schema = operations.find((operation) => operation.path === '/healthz')?.responses['200']

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
