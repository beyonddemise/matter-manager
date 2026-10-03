import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mintToken, type SigningKey } from '../../src/auth/jwt.js'
import { refreshStore } from '../../src/auth/refresh-store.js'
import { ACTIONS, type Action, PROJECT_LIMITS, type Principal } from '../../src/domain/index.js'
import { ENFORCEMENT, gate, gatedRoutes, NotEntitledError } from '../../src/entitlements/gate.js'
import { forgetRegistry, pointerId, REGISTRY_DATABASE } from '../../src/projects/registry.js'
import { transferId } from '../../src/projects/transfers.js'
import { buildServer, type Server } from '../../src/server.js'
import { forgetUsersDatabase } from '../../src/users/database.js'
import { recordEnsurer } from '../../src/users/ensure.js'
import { userRecords } from '../../src/users/records.js'
import { type FakeCouch, fakeCouch } from '../support/couch.js'
import { accessTokenFor } from '../support/tokens.js'

/**
 * Somebody who has used nothing yet.
 *
 * `ownedProjects: 0` is a statement about Ada, not an arrangement to stay under a limit: an
 * account that owns nothing is below every entry in {@link PROJECT_LIMITS}, because a tier
 * whose limit were zero would be a tier that cannot create a project at all.
 *
 * A `member`, because the free plan owns no server projects and `project.sync` refuses it by
 * design; the free refusal is asserted in `can.test.ts` and `projects/routes.test.ts`.
 */
const ADA: Principal = { sub: 'google|1234', plan: 'member', ownedProjects: 0 }

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('the seam itself', () => {
  it('permits every action for an account that has used nothing', () => {
    // ADR 0009: the seam exists so that billing at M8 is a policy table change rather than an
    // audit of every handler — and that has to be *asserted*, because a seam nobody has watched
    // permit anything is a seam nobody knows is wired up.
    //
    // Named for what it checks rather than "permits everything today", which stopped being true
    // when `project.create` gained a capacity policy. A test whose name overstates its
    // assertion is worse than no test: the next reader trusts the name.
    for (const action of ACTIONS) {
      expect(() => gate(ADA, action, { id: 'project-1' })).not.toThrow()
    }
  })

  it('refuses the one action a plan now limits', () => {
    // The other half, and the reason the name above had to change. Without this the file would
    // describe a seam that only ever says yes, while `POLICIES` already contains one that says
    // no — and a reader would believe the file.
    //
    // The count is *derived* from the table rather than written as a number, so raising or
    // lowering a tier's capacity leaves this test meaning what it means today. A literal `1`
    // would fail for the wrong reason the day `free` changed.
    const atCapacity: Principal = { ...ADA, ownedProjects: PROJECT_LIMITS[ADA.plan] }

    expect(() => gate(atCapacity, 'project.create')).toThrow(NotEntitledError)
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

/** Who the transfer driver accepts as: the recipient, whose plan the route asks about. */
const GRACE = { sub: 'google|grace', email: 'grace@example.test' }

/** The active project offered to {@link GRACE}; seeded by {@link serverWithGatedRoutes}. */
const TRANSFERRED_PROJECT = '5d7f1a2e-7c41-4a52-9b38-0e6f1d2c3a4b'

/** The project the PATCH driver unarchives; seeded by {@link serverWithGatedRoutes}. */
const ARCHIVED_PROJECT = '3b241101-e2bb-4255-8caf-4136c566a962'

/**
 * How to reach each gated route, so this file can watch the gate being called.
 *
 * The enumeration is only worth anything if it *drives* the routes. A gated route with no entry
 * here fails loudly below — which is the point: the next one to be implemented (M5-3's
 * membership endpoint) cannot be added without somebody arriving at this file.
 */
const DRIVERS: Readonly<
  Record<string, (built: Server, key: SigningKey, couch: FakeCouch) => Promise<unknown>>
> = {
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
  // Archives, then unarchives, so the request that matters is an unarchive every time it is
  // driven: the enumeration visits this route once per action it is gated by, and a second
  // visit to an already-active project would never reach the gate. Archiving is not gated.
  'PATCH /projects/:projectId': async (built, key) => {
    const patch = (archived: boolean) =>
      built.inject({
        method: 'PATCH',
        url: `/projects/${ARCHIVED_PROJECT}`,
        headers: {
          authorization: `Bearer ${mintToken(key, {
            purpose: 'access',
            sub: ADA.sub,
            exp: Math.floor(Date.now() / 1000) + 3600,
          })}`,
        },
        payload: { archived },
      })
    await patch(true)
    return patch(false)
  },
  // Accepts an offer of an active project to a recipient the gate is called for. The offer is
  // seeded in the registry below, for the same address the token carries.
  'POST /transfers/:projectId': (built, key, couch) => {
    for (const [id, document] of Object.entries(offeredProject())) couch.documents.set(id, document)
    return built.inject({
      method: 'POST',
      url: `/transfers/${TRANSFERRED_PROJECT}`,
      headers: {
        authorization: `Bearer ${accessTokenFor(key, { sub: GRACE.sub, email: GRACE.email })}`,
      },
    })
  },
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

/**
 * The registry documents for {@link TRANSFERRED_PROJECT} and its pending offer to {@link GRACE}.
 *
 * A function, because accepting consumes both: the enumeration drives this route once per action
 * it is gated by, so the driver puts them back each time rather than let the second visit meet
 * an offer that no longer exists and never reach the gate.
 */
function offeredProject(): Record<string, Record<string, unknown>> {
  return {
    [`${REGISTRY_DATABASE}/${pointerId(TRANSFERRED_PROJECT)}`]: {
      _id: pointerId(TRANSFERRED_PROJECT),
      _rev: '1-a',
      type: 'projectPointer',
      projectId: TRANSFERRED_PROJECT,
      dbName: `project_${TRANSFERRED_PROJECT}`,
      projectName: 'Offered',
      participants: [{ role: 'owner', userid: ADA.sub }],
      addedAt: '2026-08-27T09:00:00.000Z',
    },
    [`${REGISTRY_DATABASE}/${transferId(TRANSFERRED_PROJECT)}`]: {
      _id: transferId(TRANSFERRED_PROJECT),
      _rev: '1-a',
      type: 'transfer',
      projectId: TRANSFERRED_PROJECT,
      toEmail: GRACE.email,
      fromSub: ADA.sub,
      retainAccess: 'none',
      createdAt: '2026-08-27T09:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
  }
}

/** A server with every gated route wired, and a gate that records what it was asked. */
function serverWithGatedRoutes() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const key: SigningKey = { kid: 'test', privateKey, publicKey }
  const calls: Action[] = []

  forgetRegistry()
  forgetUsersDatabase()
  // **One** CouchDB behind both the routes and the user records, where there were two.
  //
  // Inert today, because nothing here seeds anything. It stops being inert the moment a test
  // states a plan the way `projects/routes.test.ts` does — by seeding the user record an
  // operator would have edited. Seeded through another instance, that document
  // would be invisible to the routes' instance: `principalFor` would read no user record, fall back
  // to `free`, and the test would pass or fail for a reason unrelated to what it asserted. One
  // instance means the server behaves like a deployment, where there is one database.
  const fake = fakeCouch({
    seed: {
      [`${REGISTRY_DATABASE}/${pointerId(ARCHIVED_PROJECT)}`]: {
        _id: pointerId(ARCHIVED_PROJECT),
        _rev: '1-a',
        type: 'projectPointer',
        projectId: ARCHIVED_PROJECT,
        dbName: `project_${ARCHIVED_PROJECT}`,
        projectName: 'Archived',
        participants: [{ role: 'owner', userid: ADA.sub }],
        addedAt: '2026-08-27T09:00:00.000Z',
        archived: true,
        archivedAt: 1_700_000_000,
      },
      ...offeredProject(),
    },
  })
  const couch = fake.couch
  const records = userRecords(couch)
  app = buildServer({
    logger: false,
    projects: {
      couch,
      key,
      records,
      ensureRecord: recordEnsurer(
        records,
        refreshStore(records, () => Math.floor(Date.now() / 1000)),
      ),
      validator: () => 'function (doc) { return doc }',
      gate: (_principal, action) => {
        calls.push(action)
      },
    },
  })

  return { built: app, key, calls, fake }
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
      'PATCH /projects/:projectId',
      'POST /transfers/:projectId',
      'POST /projects',
      'PATCH /projects/:projectId',
      'POST /transfers/:projectId',
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

    // `POST /projects`, `PATCH /projects/:projectId` and `POST /transfers/:projectId` each twice: they ask `project.sync` and
    // then `project.create`.
    expect(implemented).toEqual([
      'POST /projects',
      'PATCH /projects/:projectId',
      'POST /transfers/:projectId',
      'POST /projects',
      'PATCH /projects/:projectId',
      'POST /transfers/:projectId',
      'PUT /projects/:projectId/members',
    ])
  })

  it('watches the gate being called by every gated route that exists', async () => {
    // Not "a gate is available" — that a request through this route reaches it. A handler that
    // forgot the call would answer 201 and provision a database, which is indistinguishable
    // from correct behaviour in every other test.
    const { built, key, calls, fake } = serverWithGatedRoutes()
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
      await drive(built, key, fake)
      expect(calls, `${route} did not call the gate`).toContain(entry.action)
    }
  })

  it('asks whether the plan syncs before asking whether it has room', async () => {
    // Order is behaviour: a free account over its (zero) server allowance must hear
    // `plan-no-sync`, not `project-limit-reached`, because only one of those is fixed by
    // upgrading to a plan that syncs at all.
    const { built, key, calls, fake } = serverWithGatedRoutes()
    await DRIVERS['POST /projects']?.(built, key, fake)
    expect(calls).toEqual(['project.sync', 'project.create'])
  })

  it('asks the same way when unarchiving, with the owner as the principal', async () => {
    const { built, key, calls, fake } = serverWithGatedRoutes()
    await DRIVERS['PATCH /projects/:projectId']?.(built, key, fake)
    expect(calls).toEqual(['project.sync', 'project.create'])
  })

  it('asks the same way when accepting a transfer, with the recipient as the principal', async () => {
    const { built, key, calls, fake } = serverWithGatedRoutes()
    await DRIVERS['POST /transfers/:projectId']?.(built, key, fake)
    expect(calls).toEqual(['project.sync', 'project.create'])
  })

  it('would notice a route that stopped calling the gate', async () => {
    // The positive control. Without it, the assertion above passes just as happily when
    // `calls` is never written to — and a suite of "the gate was called" assertions that all
    // pass against a gate nobody wired up reads exactly like a suite that works.
    const { built, key, calls, fake } = serverWithGatedRoutes()
    await DRIVERS['POST /projects']?.(built, key, fake)
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
