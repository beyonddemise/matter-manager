import type { Participant } from '@matter-manager/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { CouchError } from '../../src/couch/client.js'
import { changeMembership, listMembers, MembershipRefused } from '../../src/projects/members.js'
import { forgetRegistry, pointerId, REGISTRY_DATABASE } from '../../src/projects/registry.js'
import { fakeCouch, operations } from '../support/couch.js'

const ADA = 'google|ada'
const GRACE = 'google|grace'
const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'
const DATABASE = `project_${PROJECT_ID}`

const ACCOUNTS: Record<string, { sub: string; email: string }> = {
  'ada@example.test': { sub: ADA, email: 'ada@example.test' },
  'grace@example.test': { sub: GRACE, email: 'grace@example.test' },
  [ADA]: { sub: ADA, email: 'ada@example.test' },
  [GRACE]: { sub: GRACE, email: 'grace@example.test' },
}

/** A registry holding one project with the given participants. */
function project(participants: readonly Participant[] = [{ role: 'owner', userid: ADA }]) {
  const fake = fakeCouch({
    seed: {
      [`${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`]: {
        _id: pointerId(PROJECT_ID),
        _rev: '1-a',
        type: 'projectPointer',
        projectId: PROJECT_ID,
        dbName: DATABASE,
        projectName: 'Musterstraße 12',
        participants: [...participants],
        addedAt: '2026-08-27T09:00:00.000Z',
      },
    },
  })

  const deps = {
    couch: fake.couch,
    findUser: async (value: string) => ACCOUNTS[value.toLowerCase()],
  }

  /** The participants as the registry now holds them. */
  const participantsNow = () =>
    (
      fake.documents.get(`${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`) as {
        participants: Participant[]
      }
    ).participants

  return { fake, deps, participantsNow }
}

beforeEach(forgetRegistry)

describe('granting access', () => {
  it('adds the person to the project', async () => {
    const { deps, participantsNow } = project()
    await changeMembership(deps, PROJECT_ID, ADA, 'grace@example.test', 'read')

    expect(participantsNow()).toContainEqual({ role: 'read', userid: GRACE })
  })

  it('tells CouchDB who may read', async () => {
    const { fake, deps } = project()
    await changeMembership(deps, PROJECT_ID, ADA, 'grace@example.test', 'read')

    expect(fake.security.get(DATABASE)?.members?.names).toEqual([ADA, GRACE])
  })

  it('does not make a reader a writer', async () => {
    // **The scenario the issue calls out.** A reader in `writers.names` can edit somebody
    // else's home, and an interface that hides the edit button looks exactly the same.
    const { fake, deps } = project()
    await changeMembership(deps, PROJECT_ID, ADA, 'grace@example.test', 'read')

    expect(fake.security.get(DATABASE)?.writers?.names).toEqual([ADA])
  })

  it('makes a writer a writer', async () => {
    const { fake, deps } = project()
    await changeMembership(deps, PROJECT_ID, ADA, 'grace@example.test', 'write')

    expect(fake.security.get(DATABASE)?.writers?.names).toEqual([ADA, GRACE])
  })

  it('writes the registry before CouchDB when access is being given', async () => {
    // Widening. The worst state to be caught in between the two writes is a project listed
    // before it can be opened, which is a refresh away from correct.
    const { fake, deps } = project()
    await changeMembership(deps, PROJECT_ID, ADA, 'grace@example.test', 'read')

    const order = operations(fake)
    expect(order.indexOf('putDoc')).toBeLessThan(order.indexOf('putSecurity'))
  })

  it('changes a role somebody already has', async () => {
    const { deps, participantsNow } = project([
      { role: 'owner', userid: ADA },
      { role: 'read', userid: GRACE },
    ])
    await changeMembership(deps, PROJECT_ID, ADA, 'grace@example.test', 'write')

    expect(participantsNow()).toEqual([
      { role: 'owner', userid: ADA },
      { role: 'write', userid: GRACE },
    ])
  })

  it('refuses somebody who has no account yet', async () => {
    // Distinguished from "not allowed", because it is the one refusal the caller can act on —
    // and M5-4 turns it into an invitation rather than a dead end.
    const { deps } = project()

    await expect(
      changeMembership(deps, PROJECT_ID, ADA, 'nobody@example.test', 'read'),
    ).rejects.toThrow(/has an account yet/i)
  })
})

describe('revoking access', () => {
  it('removes the person from the project', async () => {
    const { deps, participantsNow } = project([
      { role: 'owner', userid: ADA },
      { role: 'write', userid: GRACE },
    ])
    await changeMembership(deps, PROJECT_ID, ADA, 'grace@example.test', undefined)

    expect(participantsNow()).toEqual([{ role: 'owner', userid: ADA }])
  })

  it('tells CouchDB first', async () => {
    // **Narrowing goes to the database first.** The moment between the two writes is then one
    // where somebody has already lost access, rather than one where they still have it — and
    // with replication running, "still has it" means "is still pulling changes".
    const { fake, deps } = project([
      { role: 'owner', userid: ADA },
      { role: 'write', userid: GRACE },
    ])
    await changeMembership(deps, PROJECT_ID, ADA, 'grace@example.test', undefined)

    const order = operations(fake)
    expect(order.indexOf('putSecurity')).toBeLessThan(order.lastIndexOf('putDoc'))
  })

  it('goes to the database first for a demotion too', async () => {
    // A writer demoted to reader keeps read access, so `members.names` does not change — and
    // until CouchDB is told, they can still write.
    const { fake, deps } = project([
      { role: 'owner', userid: ADA },
      { role: 'write', userid: GRACE },
    ])
    await changeMembership(deps, PROJECT_ID, ADA, 'grace@example.test', 'read')

    const order = operations(fake)
    expect(order.indexOf('putSecurity')).toBeLessThan(order.lastIndexOf('putDoc'))
  })

  it('leaves the last owner alone', async () => {
    // A project with no owner cannot be transferred, shared or deleted by anybody.
    const { deps } = project()

    await expect(
      changeMembership(deps, PROJECT_ID, ADA, 'ada@example.test', undefined),
    ).rejects.toThrow(/must have an owner/i)
  })

  it('reports the last-owner rule as the caller’s mistake, not the server’s', async () => {
    // The status, not just the message. `MembershipError` carries the same words, so asserting
    // only on the text passes even when the refusal escapes as an unhandled 500 — which tells
    // the user something went wrong rather than what they need to do first.
    const { deps } = project()

    const error = await changeMembership(
      deps,
      PROJECT_ID,
      ADA,
      'ada@example.test',
      undefined,
    ).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(MembershipRefused)
    expect((error as MembershipRefused).status).toBe(400)
  })

  it('changes nothing when it refuses', async () => {
    const { fake, deps } = project()
    await changeMembership(deps, PROJECT_ID, ADA, 'ada@example.test', undefined).catch(
      () => undefined,
    )

    expect(operations(fake)).not.toContain('putSecurity')
  })
})

describe('who may change access', () => {
  it('an owner may', async () => {
    const { deps } = project()

    await expect(
      changeMembership(deps, PROJECT_ID, ADA, 'grace@example.test', 'read'),
    ).resolves.toBeUndefined()
  })

  it('a manager may', async () => {
    const { deps } = project([
      { role: 'owner', userid: ADA },
      { role: 'manage', userid: GRACE },
    ])

    await expect(
      changeMembership(deps, PROJECT_ID, GRACE, 'grace@example.test', 'write'),
    ).resolves.toBeUndefined()
  })

  it('a writer may not', async () => {
    // Writing devices and deciding who else may see the house are different things. A writer
    // who can add themselves a co-owner has effectively taken the project.
    const { deps } = project([
      { role: 'owner', userid: ADA },
      { role: 'write', userid: GRACE },
    ])

    await expect(
      changeMembership(deps, PROJECT_ID, GRACE, 'grace@example.test', 'owner'),
    ).rejects.toThrow(MembershipRefused)
  })

  it('a reader may not', async () => {
    const { deps } = project([
      { role: 'owner', userid: ADA },
      { role: 'read', userid: GRACE },
    ])

    await expect(
      changeMembership(deps, PROJECT_ID, GRACE, 'grace@example.test', 'write'),
    ).rejects.toThrow(MembershipRefused)
  })

  it('somebody who is not a participant is told the project does not exist', async () => {
    // **404, not 403.** A 403 confirms that a project with that id exists, which is a fact
    // about somebody else's home — and the id is a uuid, so the only way to have one is to
    // have been told it.
    const { deps } = project()

    const error = await changeMembership(
      deps,
      PROJECT_ID,
      'google|stranger',
      'grace@example.test',
      'read',
    ).catch((thrown: unknown) => thrown)

    expect((error as MembershipRefused).status).toBe(404)
  })

  it('writes nothing when it refuses', async () => {
    const { fake, deps } = project([
      { role: 'owner', userid: ADA },
      { role: 'read', userid: GRACE },
    ])
    await changeMembership(deps, PROJECT_ID, GRACE, 'grace@example.test', 'write').catch(
      () => undefined,
    )

    expect(operations(fake)).not.toContain('putSecurity')
  })
})

describe('two changes at once', () => {
  it('retries a conflicting write', async () => {
    // All participants live in one document, so two membership changes to the same project
    // conflict (docs/DATA-MODEL.md). The API is the only writer, so this is a re-read and
    // retry rather than a merge.
    let attempts = 0
    const { fake, deps } = project()
    const conflictOnce: typeof fake.couch = {
      ...fake.couch,
      putDoc: async (database, document) => {
        attempts += 1
        if (attempts === 1) throw new CouchError(409, 'conflict', 'conflict')
        return fake.couch.putDoc(database, document)
      },
    }

    await changeMembership(
      { ...deps, couch: conflictOnce },
      PROJECT_ID,
      ADA,
      'grace@example.test',
      'read',
    )

    expect(attempts).toBeGreaterThan(1)
  })

  it('gives up rather than retrying forever', async () => {
    // A conflict that keeps happening is a problem the caller should hear about rather than
    // wait through. The **count** is asserted, not just that it eventually stops: a bound of
    // ten thousand also stops, and a caller holding a request open while it happens cannot
    // tell that apart from a hang.
    let attempts = 0
    const { fake, deps } = project()
    const alwaysConflicts: typeof fake.couch = {
      ...fake.couch,
      putDoc: async () => {
        attempts += 1
        throw new CouchError(409, 'conflict', 'conflict')
      },
    }

    const error = await changeMembership(
      { ...deps, couch: alwaysConflicts },
      PROJECT_ID,
      ADA,
      'grace@example.test',
      'read',
    ).catch((thrown: unknown) => thrown)

    expect((error as MembershipRefused).status).toBe(409)
    expect(attempts).toBeLessThanOrEqual(5)
  })
})

describe('listing members', () => {
  it('reports everybody and their role', async () => {
    const { deps } = project([
      { role: 'owner', userid: ADA },
      { role: 'read', userid: GRACE },
    ])

    expect(await listMembers(deps, PROJECT_ID, ADA)).toEqual([
      { sub: ADA, email: 'ada@example.test', role: 'owner' },
      { sub: GRACE, email: 'grace@example.test', role: 'read' },
    ])
  })

  it('lets a reader see who else is on the project', async () => {
    // Somebody sharing a house with other people is entitled to know who those people are.
    const { deps } = project([
      { role: 'owner', userid: ADA },
      { role: 'read', userid: GRACE },
    ])

    expect(await listMembers(deps, PROJECT_ID, GRACE)).toHaveLength(2)
  })

  it('tells somebody who is not a participant that the project does not exist', async () => {
    const { deps } = project()

    await expect(listMembers(deps, PROJECT_ID, 'google|stranger')).rejects.toThrow(
      MembershipRefused,
    )
  })

  it('reads the address per member rather than trusting the pointer', async () => {
    // An address that changed would otherwise be wrong here forever: the pointer is not the
    // place that owns it.
    const { deps } = project()
    const members = await listMembers(
      { ...deps, findUser: async () => ({ sub: ADA, email: 'moved@example.test' }) },
      PROJECT_ID,
      ADA,
    )

    expect(members[0]?.email).toBe('moved@example.test')
  })
})
