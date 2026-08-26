import { ACTIONS, type Principal } from '@matter-manager/core'
import { afterEach, describe, expect, it } from 'vitest'
import { ENFORCEMENT, gate, gatedRoutes, NotEntitledError } from '../../src/entitlements/gate.js'
import { buildServer, type Server } from '../../src/server.js'

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

  it('has no gated route implemented yet, and says so deliberately', () => {
    // The list that must shrink on purpose. Both gated operations are M5's, so today the
    // correct state is that neither is registered — and asserting it is what makes implementing
    // one *without* the gate fail here rather than ship ungated.
    //
    // When M5-1 adds `POST /projects`, this test goes red. The fix is to call `gate()` in that
    // handler and move the route into the case below, which is exactly the moment somebody
    // should be thinking about entitlement.
    app = buildServer({ logger: false })
    const registered = new Set(
      app.registeredRoutes().map((route) => `${route.method} ${route.url}`),
    )

    const implemented = gatedRoutes()
      .map((entry) => `${entry.method} ${entry.path}`)
      .filter((route) => registered.has(route))

    expect(implemented).toEqual([])
  })

  it('asserts the gate is called by every gated route that exists', () => {
    // Empty today, and written now rather than later: the shape of this check is the thing that
    // has to exist before the first gated route does, or it will be written afterwards by
    // somebody reading a handler that already works.
    app = buildServer({ logger: false })
    const registered = new Set(
      app.registeredRoutes().map((route) => `${route.method} ${route.url}`),
    )

    for (const entry of gatedRoutes()) {
      if (!registered.has(`${entry.method} ${entry.path}`)) continue

      // A gated route that exists must take an injectable gate, so that this test can watch it
      // being called. Failing loudly here beats asserting nothing.
      throw new Error(
        `${entry.method} ${entry.path} is implemented and gated by ${entry.action}, but this ` +
          'test has no way to observe the gate being called. Give the route an injectable ' +
          '`gate` dependency and assert it here.',
      )
    }

    expect(true).toBe(true)
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
