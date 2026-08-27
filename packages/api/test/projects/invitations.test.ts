import { planInvitation } from '@matter-manager/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  acceptInvitationsOnSignIn,
  BY_INVITEE_DESIGN,
  BY_INVITEE_VIEW,
  forgetInvitationIndex,
  type InvitationDocument,
  invitationId,
  invitationsFor,
  invitationsForProject,
  redeemInvitations,
  storeInvitation,
} from '../../src/projects/invitations.js'
import { forgetRegistry, pointerId, REGISTRY_DATABASE } from '../../src/projects/registry.js'
import { type FakeCouch, fakeCouch } from '../support/couch.js'

const ADA = 'google|ada'
const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'
const DATABASE = `project_${PROJECT_ID}`
const NOW = Date.parse('2026-08-27T09:00:00.000Z')
const clock =
  (at = NOW) =>
  () =>
    at

const invited = (overrides: Partial<InvitationDocument> = {}): InvitationDocument => ({
  _id: invitationId(PROJECT_ID, 'grace@example.test'),
  type: 'invitation',
  projectId: PROJECT_ID,
  email: 'grace@example.test',
  role: 'read',
  invitedBy: ADA,
  createdAt: '2026-08-27T09:00:00.000Z',
  expiresAt: '2026-09-10T09:00:00.000Z',
  ...overrides,
})

/** A registry with one project owned by Ada. */
function registry(): FakeCouch {
  return fakeCouch({
    seed: {
      [`${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`]: {
        _id: pointerId(PROJECT_ID),
        _rev: '1-a',
        type: 'projectPointer',
        projectId: PROJECT_ID,
        dbName: DATABASE,
        projectName: 'Musterstraße 12',
        participants: [{ role: 'owner', userid: ADA }],
        addedAt: '2026-08-27T09:00:00.000Z',
      },
    },
  })
}

beforeEach(() => {
  forgetRegistry()
  forgetInvitationIndex()
})

describe('where an invitation is kept', () => {
  it('goes into the registry, not the project', async () => {
    // **The only place it can go.** A project database replicates to every member, and an
    // invitation carries the address of somebody who is not one yet. The registry is admin-only
    // and never replicated (ADR 0012), which is exactly the property this needs.
    const fake = registry()
    await storeInvitation(fake.couch, invited())

    expect(fake.calls.every((call) => call.database === REGISTRY_DATABASE)).toBe(true)
  })

  it('is keyed by project and address, so a second invitation replaces the first', async () => {
    // Two invitations for one person would be two roles to apply in an order nobody chose. The
    // most recent decision is the decision.
    const fake = registry()
    await storeInvitation(fake.couch, invited())
    await storeInvitation(fake.couch, invited({ role: 'write' }))

    const stored = [...fake.documents.keys()].filter((key) => key.includes('invitation:'))
    expect(stored).toHaveLength(1)
    expect(fake.documents.get(stored[0] as string)).toMatchObject({ role: 'write' })
  })

  it('stores the address folded', async () => {
    const fake = registry()
    await storeInvitation(fake.couch, invited({ email: 'GRACE@Example.test' }))

    expect(invitationId(PROJECT_ID, 'GRACE@Example.test')).toContain('grace@example.test')
  })
})

describe('finding invitations', () => {
  it('asks the index for one address', async () => {
    const fake = registry()
    await invitationsFor(fake.couch, 'grace@example.test', clock())

    expect(fake.calls.at(-1)).toMatchObject({
      detail: {
        design: BY_INVITEE_DESIGN,
        name: BY_INVITEE_VIEW,
        params: { key: 'grace@example.test' },
      },
    })
  })

  it('folds the address it looks for', async () => {
    const fake = registry()
    await invitationsFor(fake.couch, '  GRACE@Example.TEST ', clock())

    expect(fake.calls.at(-1)).toMatchObject({ detail: { params: { key: 'grace@example.test' } } })
  })

  it('leaves out one that has expired', async () => {
    // An expired invitation is not an offer any more, so it is not shown as one either.
    const fake = registry()
    fake.rows = [{ value: invited() }]

    expect(
      await invitationsFor(
        fake.couch,
        'grace@example.test',
        clock(Date.parse('2026-10-01T00:00:00Z')),
      ),
    ).toEqual([])
  })

  it('keeps one that is still open', async () => {
    const fake = registry()
    fake.rows = [{ value: invited() }]

    expect(await invitationsFor(fake.couch, 'grace@example.test', clock())).toHaveLength(1)
  })

  it('asks nothing for an empty address', async () => {
    const fake = registry()

    expect(await invitationsFor(fake.couch, '  ', clock())).toEqual([])
  })

  it('lists the open ones for a project', async () => {
    const fake = registry()
    fake.rows = [
      { value: invited() },
      { value: invited({ projectId: 'another', email: 'other@example.test' }) },
    ]

    const found = await invitationsForProject(fake.couch, PROJECT_ID, clock())
    expect(found.map((one) => one.email)).toEqual(['grace@example.test'])
  })
})

describe('redeeming on sign-in', () => {
  /** Dependencies whose `findUser` knows about the person who just signed in. */
  function deps(fake: FakeCouch) {
    return {
      couch: fake.couch,
      findUser: async (value: string) =>
        value.toLowerCase().includes('grace')
          ? { sub: 'google|grace', email: 'grace@example.test' }
          : value === ADA
            ? { sub: ADA, email: 'ada@example.test' }
            : undefined,
    }
  }

  const identity = {
    sub: 'google|grace',
    email: 'grace@example.test',
    emailVerified: true,
  }

  it('adds the person to the project with the invited role', async () => {
    const fake = registry()
    fake.rows = [{ value: invited() }]

    await redeemInvitations(deps(fake), identity, clock())

    expect(
      (
        fake.documents.get(`${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`) as {
          participants: unknown[]
        }
      ).participants,
    ).toContainEqual({ role: 'read', userid: 'google|grace' })
  })

  it('tells CouchDB, so the access is real', async () => {
    const fake = registry()
    fake.rows = [{ value: invited() }]

    await redeemInvitations(deps(fake), identity, clock())

    expect(fake.security.get(DATABASE)?.members?.names).toContain('google|grace')
  })

  it('does not make a reader a writer', async () => {
    const fake = registry()
    fake.rows = [{ value: invited() }]

    await redeemInvitations(deps(fake), identity, clock())

    expect(fake.security.get(DATABASE)?.writers?.names).not.toContain('google|grace')
  })

  it('applies the grant as the inviter, not as the person signing in', async () => {
    // The invitee is not a participant yet, so they could not authorise their own admission.
    // An invitation is a decision the inviter already made.
    const fake = registry()
    fake.rows = [{ value: invited() }]

    await expect(redeemInvitations(deps(fake), identity, clock())).resolves.toEqual([
      { projectId: PROJECT_ID, applied: true },
    ])
  })

  it('removes the invitation once it has been applied', async () => {
    const fake = registry()
    fake.rows = [{ value: invited() }]

    await redeemInvitations(deps(fake), identity, clock())

    expect(fake.documents.get(`${REGISTRY_DATABASE}/${invited()._id}`)).toMatchObject({
      _deleted: true,
    })
  })

  it('refuses an unverified address', async () => {
    // **The claim the whole feature rests on.** Redemption is by address, so an unverified one
    // is somebody claiming to be the invitee.
    const fake = registry()
    fake.rows = [{ value: invited() }]

    await redeemInvitations(deps(fake), { ...identity, emailVerified: false }, clock())

    expect(
      (
        fake.documents.get(`${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`) as {
          participants: unknown[]
        }
      ).participants,
    ).toEqual([{ role: 'owner', userid: ADA }])
  })

  it('refuses an expired invitation', async () => {
    const fake = registry()
    fake.rows = [{ value: invited() }]

    const result = await redeemInvitations(
      deps(fake),
      identity,
      clock(Date.parse('2026-10-01T00:00:00Z')),
    )

    expect(result).toEqual([])
  })

  it('does nothing for an identity with no address', async () => {
    const fake = registry()

    expect(await redeemInvitations(deps(fake), { sub: 'google|x' }, clock())).toEqual([])
  })

  it('applies each invitation independently', async () => {
    // Unrelated grants from unrelated people. One that cannot be applied — the project was
    // deleted meanwhile — must not stop the others.
    const fake = registry()
    fake.rows = [
      { value: invited({ projectId: 'gone', _id: 'invitation:gone:grace@example.test' }) },
      { value: invited() },
    ]

    const result = await redeemInvitations(deps(fake), identity, clock())

    expect(result).toEqual([
      { projectId: 'gone', applied: false },
      { projectId: PROJECT_ID, applied: true },
    ])
  })

  it('keeps an invitation it could not apply', async () => {
    // The project may come back, or the inviter may regain the right to grant it. Neither is
    // the invitee's doing, and a discarded invitation cannot be applied on a later sign-in.
    const fake = registry()
    fake.rows = [
      { value: invited({ projectId: 'gone', _id: 'invitation:gone:grace@example.test' }) },
    ]

    await redeemInvitations(deps(fake), identity, clock())

    expect(
      fake.documents.get(`${REGISTRY_DATABASE}/invitation:gone:grace@example.test`),
    ).toBeUndefined()
  })
})

describe('accepting invitations as part of signing in', () => {
  const identity = { sub: 'google|grace', email: 'grace@example.test', emailVerified: true }

  function deps(fake: FakeCouch) {
    return {
      couch: fake.couch,
      findUser: async (value: string) =>
        value.toLowerCase().includes('grace')
          ? { sub: 'google|grace', email: 'grace@example.test' }
          : value === ADA
            ? { sub: ADA, email: 'ada@example.test' }
            : undefined,
    }
  }

  it('records the account before redeeming', async () => {
    // **The order is the whole point.** Redemption resolves the invitee's address to a subject
    // through `_users`; until `rememberUser` has written that account there is nobody to
    // resolve, and the invitation is silently never applied on the one sign-in it waited for.
    const order: string[] = []
    const fake = registry()
    fake.rows = [{ value: invited() }]

    await acceptInvitationsOnSignIn(
      {
        ...deps(fake),
        findUser: async (value: string) => {
          order.push('resolve')
          return value.toLowerCase().includes('grace')
            ? { sub: 'google|grace', email: 'grace@example.test' }
            : { sub: ADA, email: 'ada@example.test' }
        },
      },
      async () => {
        order.push('remember')
      },
      clock(),
    )(identity)

    expect(order[0]).toBe('remember')
  })

  it('applies the invitation', async () => {
    const fake = registry()
    fake.rows = [{ value: invited() }]

    await acceptInvitationsOnSignIn(deps(fake), async () => undefined, clock())(identity)

    expect(
      (
        fake.documents.get(`${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`) as {
          participants: unknown[]
        }
      ).participants,
    ).toContainEqual({ role: 'read', userid: 'google|grace' })
  })

  it('does not sign somebody in when recording the account failed', async () => {
    // The window `rememberUser` already occupies: a failed sign-in can simply be repeated,
    // whereas somebody signed in without the access they were invited to cannot notice.
    const fake = registry()

    await expect(
      acceptInvitationsOnSignIn(
        deps(fake),
        async () => {
          throw new Error('storage refused')
        },
        clock(),
      )(identity),
    ).rejects.toThrow()
  })

  it('signs in normally when there is nothing waiting', async () => {
    const fake = registry()

    await expect(
      acceptInvitationsOnSignIn(deps(fake), async () => undefined, clock())(identity),
    ).resolves.toBeUndefined()
  })
})
