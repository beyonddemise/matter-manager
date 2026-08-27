import type { Participant } from '@matter-manager/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { MembershipRefused } from '../../src/projects/members.js'
import { forgetRegistry, pointerId, REGISTRY_DATABASE } from '../../src/projects/registry.js'
import {
  acceptTransfer,
  forgetTransferIndex,
  storeTransfer,
  type TransferDocument,
  transferId,
  transfersFor,
} from '../../src/projects/transfers.js'
import { type FakeCouch, fakeCouch, operations } from '../support/couch.js'

const INSTALLER = 'google|installer'
const HOMEOWNER = 'google|homeowner'
const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'
const DATABASE = `project_${PROJECT_ID}`
const NOW = Date.parse('2026-08-27T09:00:00.000Z')
const clock =
  (at = NOW) =>
  () =>
    at

const offer = (overrides: Partial<TransferDocument> = {}): TransferDocument => ({
  _id: transferId(PROJECT_ID),
  type: 'transfer',
  projectId: PROJECT_ID,
  toEmail: 'homeowner@example.test',
  fromSub: INSTALLER,
  retainAccess: 'none',
  createdAt: '2026-08-27T09:00:00.000Z',
  expiresAt: '2026-09-10T09:00:00.000Z',
  ...overrides,
})

/** A registry holding one project and, optionally, an offer for it. */
function registry(
  participants: readonly Participant[] = [{ role: 'owner', userid: INSTALLER }],
  pending?: TransferDocument,
): FakeCouch {
  return fakeCouch({
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
      ...(pending === undefined
        ? {}
        : { [`${REGISTRY_DATABASE}/${pending._id}`]: { ...pending, _rev: '1-a' } }),
    },
  })
}

/** Dependencies that know both people. */
function deps(fake: FakeCouch) {
  return {
    couch: fake.couch,
    findUser: async (value: string) => {
      const lower = value.toLowerCase()
      if (lower.includes('homeowner')) return { sub: HOMEOWNER, email: 'homeowner@example.test' }
      if (lower.includes('installer')) return { sub: INSTALLER, email: 'installer@example.test' }
      return undefined
    },
  }
}

/** The homeowner as Google reports them. */
const homeowner = { sub: HOMEOWNER, email: 'homeowner@example.test', emailVerified: true }

const participantsIn = (fake: FakeCouch) =>
  (
    fake.documents.get(`${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`) as {
      participants: Participant[]
    }
  ).participants

beforeEach(() => {
  forgetRegistry()
  forgetTransferIndex()
})

describe('offering a project', () => {
  it('keeps one offer per project, so a change of mind replaces it', async () => {
    // An owner who changes their mind about *who* to hand the house to has changed their mind.
    // Two live offers would be a race between two people to accept the same project.
    const fake = registry()
    await storeTransfer(fake.couch, offer())
    await storeTransfer(fake.couch, offer({ toEmail: 'somebody@example.test' }))

    const stored = [...fake.documents.keys()].filter((key) => key.includes('transfer:'))
    expect(stored).toHaveLength(1)
    expect(fake.documents.get(stored[0] as string)).toMatchObject({
      toEmail: 'somebody@example.test',
    })
  })

  it('changes nothing about who has access', async () => {
    // **An offer is not a transfer.** Ownership does not move until it is accepted, so nothing
    // reaches CouchDB yet.
    const fake = registry()
    await storeTransfer(fake.couch, offer())

    expect(participantsIn(fake)).toEqual([{ role: 'owner', userid: INSTALLER }])
    expect(operations(fake)).not.toContain('putSecurity')
  })
})

describe('finding offers made to somebody', () => {
  it('asks the index with the folded address', async () => {
    const fake = registry()
    await transfersFor(fake.couch, '  Homeowner@Example.TEST ', clock())

    expect(fake.calls.at(-1)).toMatchObject({
      detail: { params: { key: 'homeowner@example.test' } },
    })
  })

  it('leaves out an expired one', async () => {
    const fake = registry()
    fake.rows = [{ value: offer() }]

    expect(
      await transfersFor(
        fake.couch,
        'homeowner@example.test',
        clock(Date.parse('2026-10-01T00:00:00Z')),
      ),
    ).toEqual([])
  })
})

describe('accepting an offer', () => {
  it('makes the recipient the owner', async () => {
    const fake = registry(undefined, offer())

    await acceptTransfer(deps(fake), PROJECT_ID, homeowner, clock())

    expect(participantsIn(fake)).toEqual([{ role: 'owner', userid: HOMEOWNER }])
  })

  it('leaves the previous owner with read access when that was agreed', async () => {
    const fake = registry(undefined, offer({ retainAccess: 'read' }))

    await acceptTransfer(deps(fake), PROJECT_ID, homeowner, clock())

    expect(participantsIn(fake)).toEqual([
      { role: 'read', userid: INSTALLER },
      { role: 'owner', userid: HOMEOWNER },
    ])
  })

  it('takes the previous owner out of the writers', async () => {
    // "I hold read access only" has to be true in CouchDB, not merely in a list — otherwise the
    // installer can still edit a house they no longer own.
    const fake = registry(undefined, offer({ retainAccess: 'read' }))

    await acceptTransfer(deps(fake), PROJECT_ID, homeowner, clock())

    expect(fake.security.get(DATABASE)?.writers?.names).toEqual([HOMEOWNER])
    expect(fake.security.get(DATABASE)?.members?.names).toContain(INSTALLER)
  })

  it('removes the previous owner entirely when nothing was retained', async () => {
    const fake = registry(undefined, offer())

    await acceptTransfer(deps(fake), PROJECT_ID, homeowner, clock())

    expect(fake.security.get(DATABASE)?.members?.names).toEqual([HOMEOWNER])
  })

  it('writes to CouchDB before the registry', async () => {
    // A transfer always narrows somebody's access — the outgoing owner loses write, and often
    // loses everything. The same rule `members.ts` follows, for the same reason.
    const fake = registry(undefined, offer())

    await acceptTransfer(deps(fake), PROJECT_ID, homeowner, clock())

    // Against the **pointer** write specifically. Accepting also deletes the offer, which is
    // another `putDoc` — so "before the last putDoc" is true however the two are ordered.
    const security = fake.calls.findIndex((call) => call.operation === 'putSecurity')
    const pointerWrite = fake.calls.findIndex(
      (call) =>
        call.operation === 'putDoc' &&
        (call.detail as { _id?: string } | undefined)?._id === pointerId(PROJECT_ID),
    )
    expect(security).toBeLessThan(pointerWrite)
  })

  it('withdraws the offer once it has been accepted', async () => {
    const fake = registry(undefined, offer())

    await acceptTransfer(deps(fake), PROJECT_ID, homeowner, clock())

    expect(fake.documents.get(`${REGISTRY_DATABASE}/${transferId(PROJECT_ID)}`)).toMatchObject({
      _deleted: true,
    })
  })

  it('refuses an unverified address', async () => {
    // A transfer hands over everything, so this matters more here than anywhere else.
    const fake = registry(undefined, offer())

    await expect(
      acceptTransfer(deps(fake), PROJECT_ID, { ...homeowner, emailVerified: false }, clock()),
    ).rejects.toThrow(MembershipRefused)
    expect(participantsIn(fake)).toEqual([{ role: 'owner', userid: INSTALLER }])
  })

  it('refuses somebody the offer was not made to, without confirming it exists', async () => {
    // 404, not 403: whether there is an offer for this project is a fact about somebody else's
    // house, and the project id is a uuid.
    const fake = registry(undefined, offer())

    // The installer, who has an account and is a participant — so this reaches the
    // wrong-address check rather than stopping at "no such account", which is a different
    // refusal and would leave the interesting one untested.
    const error = await acceptTransfer(
      deps(fake),
      PROJECT_ID,
      { sub: INSTALLER, email: 'installer@example.test', emailVerified: true },
      clock(),
    ).catch((thrown: unknown) => thrown)

    expect((error as MembershipRefused).status).toBe(404)
  })

  it('refuses an expired offer', async () => {
    const fake = registry(undefined, offer())

    await expect(
      acceptTransfer(deps(fake), PROJECT_ID, homeowner, clock(Date.parse('2026-10-01T00:00:00Z'))),
    ).rejects.toThrow(/expired/i)
  })

  it('refuses an offer from somebody who no longer owns the project', async () => {
    // **The case invitations do not have.** Between offer and acceptance the project may have
    // gone elsewhere, and an offer made by a former owner must not still work.
    const fake = registry(
      [
        { role: 'read', userid: INSTALLER },
        { role: 'owner', userid: 'google|somebody-else' },
      ],
      offer(),
    )

    await expect(acceptTransfer(deps(fake), PROJECT_ID, homeowner, clock())).rejects.toThrow(
      /no-longer-owner/,
    )
  })

  it('refuses when there is no offer at all', async () => {
    const fake = registry()

    await expect(acceptTransfer(deps(fake), PROJECT_ID, homeowner, clock())).rejects.toThrow(
      MembershipRefused,
    )
  })

  it('changes nothing when it refuses', async () => {
    const fake = registry(undefined, offer())
    await acceptTransfer(
      deps(fake),
      PROJECT_ID,
      { ...homeowner, emailVerified: false },
      clock(),
    ).catch(() => undefined)

    expect(operations(fake)).not.toContain('putSecurity')
  })
})
