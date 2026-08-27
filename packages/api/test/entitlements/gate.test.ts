import { generateKeyPairSync } from 'node:crypto'
import { ACTIONS, type Action, type Principal } from '@matter-manager/core'
import { afterEach, describe, expect, it } from 'vitest'
import { mintToken, type SigningKey } from '../../src/auth/jwt.js'
import { ENFORCEMENT, gate, gatedRoutes, NotEntitledError } from '../../src/entitlements/gate.js'
import { forgetRegistry } from '../../src/projects/registry.js'
import { buildServer, type Server } from '../../src/server.js'
import { fakeCouch } from '../support/couch.js'

const ADA: Principal = { sub: 'google|1234', plan: 'free' }

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('the seam itself', () => {
  it('permits everything today', () => {
    // ADR 0009: the seam exists so that billing at M8 is a policy table change rather than an
    // audit of every handler. Until then every answer is yes, and that has to be *asserted* —
    // a seam nobody has watched permit anything is a seam nobody knows is wired up.
    for (const action of ACTIONS) {
      expect(() => gate(ADA, action, { id: 'project-1' })).not.toThrow()
    }
  })

  it('refuses by throwing rather than by returning false', () => {
    // A handler that forgets to check a returned boolean compiles, runs, and is ungated.
    const refuse = () => {
      throw new NotEntitledError('pdf.export')
    }

    expect(refuse).toThrow(NotEntitledError)
    expect(refuse).toThrow(/pdf\.export/)
  })

  it('names the action it refused', () => {
    // So a support conversation can start with "which feature" rather than "which endpoint".
    try {
      throw new NotEntitledError('project.create')
    } catch (error) {
      expect((error as NotEntitledError).action).toBe('project.create')
    }
  })
})

/**
 * How to reach each gated route, so this file can watch the gate being called.
 *
 * The enumeration is only worth anything if it *drives* the routes. A gated route with no entry
 * here fails loudly below — which is the point: the next one to be implemented (M5-3's
 * membership endpoint) cannot be added without somebody arriving at this file.
 */
const DRIVERS: Readonly<Record<string, (built: Server, key: SigningKey) => Promise<unknown>>> = {
  'POST /projects': (built, key) =>
    built.inject({
      method: 'POST',
      url: '/projects',
      headers: {
        authorization: `Bearer ${mintToken(key, {
          purpose: 'access',
          sub: ADA.sub,
          exp: Math.floor(Date.now() / 1000) + 3600,
        })}`,
      },
      payload: { name: 'Musterstraße 12' },
    }),
  'PUT /projects/:projectId/members': (built, key) =>
    built.inject({
      method: 'PUT',
      url: '/projects/8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60/members',
      headers: {
        authorization: `Bearer ${mintToken(key, {
          purpose: 'access',
          sub: ADA.sub,
          exp: Math.floor(Date.now() / 1000) + 3600,
        })}`,
      },
      payload: { email: 'grace@example.test', role: 'read' },
    }),
}

/** A server with every gated route wired, and a gate that records what it was asked. */
function serverWithGatedRoutes() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const key: SigningKey = { kid: 'test', privateKey, publicKey }
  const calls: Action[] = []

  forgetRegistry()
  app = buildServer({
    logger: false,
    projects: {
      couch: fakeCouch().couch,
      key,
      validator: () => 'function (doc) { return doc }',
      gate: (_principal, action) => {
        calls.push(action)
      },
    },
  })

  return { built: app, key, calls }
}

describe('the enumeration that makes the seam real', () => {
  // The issue: "a test enumerates gated actions and asserts each route calls the seam. That
  // enumeration test is what makes the seam real rather than decorative."

  it('accounts for every action', () => {
    // `Record<Action, …>` makes this a compile error too, but the runtime check is what catches
    // an entry added with a typo'd key, which the type would accept as excess.
    expect(Object.keys(ENFORCEMENT).sort()).toEqual([...ACTIONS].sort())
  })

  it('says why an action has no route, rather than omitting it', () => {
    // An action silently absent from the map looks identical to one somebody forgot, and the
    // whole value of the map is that those two cannot be confused.
    for (const action of ACTIONS) {
      const where = ENFORCEMENT[action]
      if (where.kind === 'client') expect(where.because.length).toBeGreaterThan(20)
    }
  })

  it('knows which routes are gated', () => {
    expect(gatedRoutes().map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      'POST /projects',
      'PUT /projects/:projectId/members',
    ])
  })

  it('has exactly the gated routes that are implemented, and no others', () => {
    // The list that shrinks on purpose, and has now shrunk to nothing: `POST /projects` arrived
    // with M5-1 and the membership endpoint with M5-3. Both are gated, both are driven below.
    // A new gated action added to `ENFORCEMENT` puts an entry back here.
    const { built } = serverWithGatedRoutes()
    const registered = new Set(
      built.registeredRoutes().map((route) => `${route.method} ${route.url}`),
    )

    const implemented = gatedRoutes()
      .map((entry) => `${entry.method} ${entry.path}`)
      .filter((route) => registered.has(route))

    expect(implemented).toEqual(['POST /projects', 'PUT /projects/:projectId/members'])
  })

  it('watches the gate being called by every gated route that exists', async () => {
    // Not "a gate is available" — that a request through this route reaches it. A handler that
    // forgot the call would answer 201 and provision a database, which is indistinguishable
    // from correct behaviour in every other test.
    const { built, key, calls } = serverWithGatedRoutes()
    const registered = new Set(
      built.registeredRoutes().map((route) => `${route.method} ${route.url}`),
    )

    for (const entry of gatedRoutes()) {
      const route = `${entry.method} ${entry.path}`
      if (!registered.has(route)) continue

      const drive = DRIVERS[route]
      if (drive === undefined) {
        // Loud, and deliberately not a skip. A gated route this file cannot drive is a gated
        // route nobody is watching.
        throw new Error(
          `${route} is implemented and gated by ${entry.action}, but DRIVERS has no entry for ` +
            'it, so this test cannot watch the gate being called. Add one.',
        )
      }

      calls.length = 0
      await drive(built, key)
      expect(calls, `${route} did not call the gate`).toContain(entry.action)
    }
  })

  it('would notice a route that stopped calling the gate', async () => {
    // The positive control. Without it, the assertion above passes just as happily when
    // `calls` is never written to — and a suite of "the gate was called" assertions that all
    // pass against a gate nobody wired up reads exactly like a suite that works.
    const { built, key, calls } = serverWithGatedRoutes()
    await DRIVERS['POST /projects']?.(built, key)
    expect(calls).toContain('project.create')

    calls.length = 0
    expect(calls).not.toContain('project.create')
  })
})

describe('what the seam is not', () => {
  it('is not an authentication check', () => {
    // 403, never 401. "We do not know who you are" invites signing in again, which for an
    // entitlement failure sends the user round a loop that cannot help them.
    expect(new NotEntitledError('pdf.export').message).not.toMatch(/sign in|credential/i)
  })

  it('does not decide what CouchDB allows', () => {
    // Entitlement is about plans; `_security` is about access. A project a user may not reach
    // is refused by CouchDB whatever their plan says, and nothing here changes that.
    expect(Object.keys(ENFORCEMENT)).not.toContain('project.read')
  })
})
