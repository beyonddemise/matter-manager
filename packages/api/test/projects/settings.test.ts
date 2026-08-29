import type { Participant } from '@matter-manager/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetRegistry, pointerId, REGISTRY_DATABASE } from '../../src/projects/registry.js'
import { SettingsRefused, updateProjectSettings } from '../../src/projects/settings.js'
import { fakeCouch } from '../support/couch.js'

/**
 * Changing a project's name and address (#128).
 *
 * Two things are being tested here and they are easy to conflate. One is the change itself —
 * that a name becomes the new name. The other is everything the change must **not** touch: the
 * participants, the database name, the project id. The pointer is a single document, so a
 * partial update written as a whole-document `put` is exactly how a rename silently removes a
 * member, which is the hazard `applyTransfer` was written against in M5-5.
 */

const ADA = 'google|ada'
const GRACE = 'google|grace'
const STRANGER = 'google|stranger'
const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'
const DATABASE = `project_${PROJECT_ID}`
const POINTER = `${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`

const OWNER_ONLY: readonly Participant[] = [{ role: 'owner', userid: ADA }]

/** A registry holding one project. */
function project(
  participants: readonly Participant[] = OWNER_ONLY,
  address?: string,
): {
  readonly deps: { readonly couch: ReturnType<typeof fakeCouch>['couch'] }
  readonly pointerNow: () => Record<string, unknown>
} {
  const fake = fakeCouch({
    seed: {
      [POINTER]: {
        _id: pointerId(PROJECT_ID),
        _rev: '1-a',
        type: 'projectPointer',
        projectId: PROJECT_ID,
        dbName: DATABASE,
        projectName: 'Musterstraße 12',
        participants: [...participants],
        addedAt: '2026-08-27T09:00:00.000Z',
        ...(address === undefined ? {} : { address }),
      },
    },
  })

  return {
    deps: { couch: fake.couch },
    pointerNow: () => fake.documents.get(POINTER) as Record<string, unknown>,
  }
}

beforeEach(() => {
  forgetRegistry()
})

describe('renaming a project', () => {
  it('stores the new name and reports it back', async () => {
    const { deps, pointerNow } = project()

    const summary = await updateProjectSettings(deps, PROJECT_ID, ADA, { name: 'Lindenstraße 4' })

    expect(summary.name).toBe('Lindenstraße 4')
    expect(pointerNow().projectName).toBe('Lindenstraße 4')
  })

  it('trims what the user typed', async () => {
    const { deps, pointerNow } = project()

    const summary = await updateProjectSettings(deps, PROJECT_ID, ADA, {
      name: '  Villa Kunterbunt  ',
    })

    expect(summary.name).toBe('Villa Kunterbunt')
    expect(pointerNow().projectName).toBe('Villa Kunterbunt')
  })

  it('leaves the participants exactly as they were', async () => {
    // The whole reason this is a read-modify-write of one document rather than a fresh one:
    // a rename that rewrote the pointer from its arguments would drop every member, and the
    // person who renamed it would have no reason to look.
    const participants: readonly Participant[] = [
      { role: 'owner', userid: ADA },
      { role: 'manage', userid: GRACE },
      { role: 'read', userid: STRANGER },
    ]
    const { deps, pointerNow } = project(participants)

    await updateProjectSettings(deps, PROJECT_ID, ADA, { name: 'Renamed' })

    expect(pointerNow().participants).toEqual(participants)
  })

  it('leaves everything else about the project alone', async () => {
    const { deps, pointerNow } = project()

    await updateProjectSettings(deps, PROJECT_ID, ADA, { name: 'Renamed' })

    expect(pointerNow()).toMatchObject({
      type: 'projectPointer',
      projectId: PROJECT_ID,
      dbName: DATABASE,
      addedAt: '2026-08-27T09:00:00.000Z',
    })
  })

  it('refuses a name that says nothing', async () => {
    const { deps, pointerNow } = project()

    await expect(updateProjectSettings(deps, PROJECT_ID, ADA, { name: '   ' })).rejects.toThrow(
      SettingsRefused,
    )
    // Refused means unchanged. A validation that rejected after writing would be worse than
    // none, because the message would say the opposite of what happened.
    expect(pointerNow().projectName).toBe('Musterstraße 12')
  })

  it('refuses a name longer than the contract allows', async () => {
    const { deps } = project()

    await expect(
      updateProjectSettings(deps, PROJECT_ID, ADA, { name: 'x'.repeat(201) }),
    ).rejects.toThrow(SettingsRefused)
  })
})

describe('the address', () => {
  it('is recorded', async () => {
    const { deps, pointerNow } = project()

    const summary = await updateProjectSettings(deps, PROJECT_ID, ADA, {
      address: 'Musterstraße 12, 10115 Berlin',
    })

    expect(summary.address).toBe('Musterstraße 12, 10115 Berlin')
    expect(pointerNow().address).toBe('Musterstraße 12, 10115 Berlin')
  })

  it('is removed by an explicit null, not by omission', async () => {
    // Spelled as a value, the way `role: null` revokes membership. A body that simply forgot
    // the address must not erase the one that is there.
    const { deps, pointerNow } = project(OWNER_ONLY, 'Musterstraße 12')

    await updateProjectSettings(deps, PROJECT_ID, ADA, { address: null })

    expect(pointerNow()).not.toHaveProperty('address')
  })

  it('survives a change that only names the name', async () => {
    const { deps, pointerNow } = project(OWNER_ONLY, 'Musterstraße 12')

    await updateProjectSettings(deps, PROJECT_ID, ADA, { name: 'Renamed' })

    expect(pointerNow().address).toBe('Musterstraße 12')
  })

  it('is absent rather than empty when there is none', async () => {
    // An empty string would be a value the interface has to special-case everywhere it is
    // shown, and would sort and export as a blank line rather than as nothing.
    const { deps, pointerNow } = project()

    const summary = await updateProjectSettings(deps, PROJECT_ID, ADA, { address: '  ' })

    expect(summary.address).toBeUndefined()
    expect(pointerNow()).not.toHaveProperty('address')
  })

  it('refuses one longer than the contract allows', async () => {
    const { deps } = project()

    await expect(
      updateProjectSettings(deps, PROJECT_ID, ADA, { address: 'x'.repeat(501) }),
    ).rejects.toThrow(SettingsRefused)
  })
})

describe('who may change settings', () => {
  it('allows a manager, not only the owner', async () => {
    // Naming is a settings change. Whoever may decide who has access may certainly correct a
    // name, and requiring ownership would make an installer's manager useless for the one
    // thing they are most likely to fix.
    const { deps, pointerNow } = project([
      { role: 'owner', userid: ADA },
      { role: 'manage', userid: GRACE },
    ])

    await updateProjectSettings(deps, PROJECT_ID, GRACE, { name: 'Renamed' })

    expect(pointerNow().projectName).toBe('Renamed')
  })

  it('refuses write access with a 403', async () => {
    const { deps, pointerNow } = project([
      { role: 'owner', userid: ADA },
      { role: 'write', userid: GRACE },
    ])

    await expect(
      updateProjectSettings(deps, PROJECT_ID, GRACE, { name: 'Renamed' }),
    ).rejects.toMatchObject({ status: 403 })
    expect(pointerNow().projectName).toBe('Musterstraße 12')
  })

  it('refuses read access with a 403', async () => {
    const { deps } = project([
      { role: 'owner', userid: ADA },
      { role: 'read', userid: GRACE },
    ])

    await expect(
      updateProjectSettings(deps, PROJECT_ID, GRACE, { name: 'Renamed' }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('tells a stranger the project does not exist', async () => {
    // 404, not 403. A 403 confirms that a project with this id exists, which is a fact about
    // somebody else's home — and the id is a uuid, so the only way to hold one is to have been
    // given it.
    const { deps } = project()

    await expect(
      updateProjectSettings(deps, PROJECT_ID, STRANGER, { name: 'Renamed' }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('says the same thing about a project that is not there', async () => {
    const { deps } = project()

    await expect(
      updateProjectSettings(deps, 'ffffffff-ffff-4fff-8fff-ffffffffffff', ADA, { name: 'x' }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('a change that changes nothing', () => {
  it('is refused rather than written', async () => {
    // An empty body is a client bug. Writing a new revision for it would replicate a document
    // to every device to say that nothing happened.
    const { deps } = project()

    await expect(updateProjectSettings(deps, PROJECT_ID, ADA, {})).rejects.toMatchObject({
      status: 400,
    })
  })
})

describe('the summary it answers with', () => {
  it('carries the owner, which a client needs to know what to offer', async () => {
    const { deps } = project([
      { role: 'owner', userid: ADA },
      { role: 'manage', userid: GRACE },
    ])

    const summary = await updateProjectSettings(deps, PROJECT_ID, GRACE, { name: 'Renamed' })

    expect(summary).toMatchObject({
      projectId: PROJECT_ID,
      dbName: DATABASE,
      name: 'Renamed',
      // The caller's own role, not the owner's — this is what *they* may do next.
      role: 'manage',
      owner: { ownerType: 'user', ownerId: ADA },
    })
  })
})
