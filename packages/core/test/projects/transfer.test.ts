import { describe, expect, it } from 'vitest'
import type { Participant } from '../../src/projects/ownership.js'
import {
  acceptable,
  applyTransfer,
  type PendingTransfer,
  planTransfer,
  TRANSFER_LIFETIME,
  TransferError,
} from '../../src/projects/transfer.js'

const INSTALLER = 'google|installer'
const OWNER_TO_BE = 'google|homeowner'
const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'
const NOW = Date.parse('2026-08-27T09:00:00.000Z')
const clock =
  (at = NOW) =>
  () =>
    at

const owned: readonly Participant[] = [{ role: 'owner', userid: INSTALLER }]

const offer = (overrides: Partial<PendingTransfer> = {}): PendingTransfer => ({
  projectId: PROJECT_ID,
  toEmail: 'homeowner@example.test',
  fromSub: INSTALLER,
  retainAccess: 'none',
  createdAt: '2026-08-27T09:00:00.000Z',
  expiresAt: '2026-09-10T09:00:00.000Z',
  ...overrides,
})

/** The homeowner, as Google reports them. */
const homeowner = { email: 'homeowner@example.test', emailVerified: true }

describe('offering a project', () => {
  it('records who is offering what to whom', () => {
    expect(
      planTransfer(
        { projectId: PROJECT_ID, toEmail: 'Homeowner@Example.test', fromSub: INSTALLER },
        owned,
        clock(),
      ),
    ).toEqual({
      projectId: PROJECT_ID,
      toEmail: 'homeowner@example.test',
      fromSub: INSTALLER,
      retainAccess: 'none',
      createdAt: '2026-08-27T09:00:00.000Z',
      expiresAt: new Date(NOW + TRANSFER_LIFETIME).toISOString(),
    })
  })

  it('keeps read access when that was asked for', () => {
    expect(
      planTransfer(
        {
          projectId: PROJECT_ID,
          toEmail: 'homeowner@example.test',
          fromSub: INSTALLER,
          retainAccess: 'read',
        },
        owned,
        clock(),
      ).retainAccess,
    ).toBe('read')
  })

  it('keeps nothing unless asked', () => {
    // The safe default for the person being handed the project: the previous owner does not
    // stay in their house by omission.
    expect(
      planTransfer(
        { projectId: PROJECT_ID, toEmail: 'homeowner@example.test', fromSub: INSTALLER },
        owned,
        clock(),
      ).retainAccess,
    ).toBe('none')
  })

  it('may only be made by the owner', () => {
    // **Not a manager.** Managing who else has access and giving the project away are different
    // powers, and a manager who could transfer could simply take it.
    const withManager: readonly Participant[] = [
      { role: 'owner', userid: INSTALLER },
      { role: 'manage', userid: 'google|helper' },
    ]

    expect(() =>
      planTransfer(
        { projectId: PROJECT_ID, toEmail: 'homeowner@example.test', fromSub: 'google|helper' },
        withManager,
        clock(),
      ),
    ).toThrow(/only the owner/i)
  })

  it('may not be made by somebody who is not a participant at all', () => {
    expect(() =>
      planTransfer(
        { projectId: PROJECT_ID, toEmail: 'homeowner@example.test', fromSub: 'google|stranger' },
        owned,
        clock(),
      ),
    ).toThrow(TransferError)
  })

  it('refuses an offer to yourself', () => {
    expect(() =>
      planTransfer(
        {
          projectId: PROJECT_ID,
          toEmail: 'Installer@Example.test',
          fromSub: INSTALLER,
          fromEmail: 'installer@example.test',
        },
        owned,
        clock(),
      ),
    ).toThrow(/already own/i)
  })

  it('refuses something that is not an address', () => {
    expect(() =>
      planTransfer(
        { projectId: PROJECT_ID, toEmail: 'homeowner', fromSub: INSTALLER },
        owned,
        clock(),
      ),
    ).toThrow(TransferError)
  })

  it('expires after a fortnight', () => {
    const planned = planTransfer(
      { projectId: PROJECT_ID, toEmail: 'homeowner@example.test', fromSub: INSTALLER },
      owned,
      clock(),
    )

    expect(Date.parse(planned.expiresAt) - Date.parse(planned.createdAt)).toBe(TRANSFER_LIFETIME)
  })
})

describe('whether an offer can be accepted', () => {
  it('can be, by the person it names', () => {
    expect(acceptable(offer(), homeowner, owned, clock())).toBeUndefined()
  })

  it('cannot be by somebody whose address is not verified', () => {
    // Matters more here than for an invitation: an invitation grants a role, a transfer hands
    // over everything.
    expect(
      acceptable(
        offer(),
        { email: 'homeowner@example.test', emailVerified: false },
        owned,
        clock(),
      ),
    ).toBe('unverified')
  })

  it('cannot be when the provider sent no verification claim at all', () => {
    // **The case that matters most and is easiest to miss.** A test that only ever passes
    // `true` and `false` never exercises absence, and a check written as `=== false` accepts
    // every provider that simply does not send the claim. This is a transfer of everything.
    expect(acceptable(offer(), { email: 'homeowner@example.test' }, owned, clock())).toBe(
      'unverified',
    )
  })

  it('cannot be by somebody else', () => {
    expect(
      acceptable(offer(), { email: 'someone@example.test', emailVerified: true }, owned, clock()),
    ).toBe('wrong-address')
  })

  it('cannot be after it expires', () => {
    expect(acceptable(offer(), homeowner, owned, clock(Date.parse('2026-10-01T00:00:00Z')))).toBe(
      'expired',
    )
  })

  it('cannot be when the person who offered no longer owns the project', () => {
    // **The case invitations do not have.** Between offer and acceptance the project may have
    // gone to somebody else, and an offer made by a former owner must not still work —
    // ownership can only be given away by whoever holds it at the moment it moves.
    const movedOn: readonly Participant[] = [
      { role: 'read', userid: INSTALLER },
      { role: 'owner', userid: 'google|somebody-else' },
    ]

    expect(acceptable(offer(), homeowner, movedOn, clock())).toBe('no-longer-owner')
  })

  it('cannot be when the person who offered has left entirely', () => {
    expect(
      acceptable(offer(), homeowner, [{ role: 'owner', userid: 'google|other' }], clock()),
    ).toBe('no-longer-owner')
  })
})

describe('what the transfer does to the participants', () => {
  it('makes the recipient the owner', () => {
    expect(applyTransfer(owned, offer(), OWNER_TO_BE)).toEqual([
      { role: 'owner', userid: OWNER_TO_BE },
    ])
  })

  it('leaves the previous owner with read access when that was chosen', () => {
    // The first scenario, exactly: "I hold read access only, and I can no longer manage
    // members." `canManageMembers('read')` is false, so the second half follows from the first.
    expect(applyTransfer(owned, offer({ retainAccess: 'read' }), OWNER_TO_BE)).toEqual([
      { role: 'read', userid: INSTALLER },
      { role: 'owner', userid: OWNER_TO_BE },
    ])
  })

  it('removes the previous owner when nothing was retained', () => {
    expect(applyTransfer(owned, offer(), OWNER_TO_BE).map((p) => p.userid)).toEqual([OWNER_TO_BE])
  })

  it('leaves exactly one owner', () => {
    // The invariant the whole module exists to keep. Two owners is a project nobody is
    // responsible for; none is a project nobody can transfer, share or delete.
    const shared: readonly Participant[] = [
      { role: 'owner', userid: INSTALLER },
      { role: 'write', userid: 'google|colleague' },
    ]

    const after = applyTransfer(shared, offer({ retainAccess: 'read' }), OWNER_TO_BE)
    expect(after.filter((participant) => participant.role === 'owner')).toHaveLength(1)
  })

  it('keeps everybody else exactly as they were', () => {
    const shared: readonly Participant[] = [
      { role: 'owner', userid: INSTALLER },
      { role: 'write', userid: 'google|colleague' },
      { role: 'read', userid: 'google|neighbour' },
    ]

    const after = applyTransfer(shared, offer(), OWNER_TO_BE)
    expect(after).toContainEqual({ role: 'write', userid: 'google|colleague' })
    expect(after).toContainEqual({ role: 'read', userid: 'google|neighbour' })
  })

  it('promotes a recipient who was already a participant, rather than listing them twice', () => {
    const shared: readonly Participant[] = [
      { role: 'owner', userid: INSTALLER },
      { role: 'read', userid: OWNER_TO_BE },
    ]

    const after = applyTransfer(shared, offer(), OWNER_TO_BE)
    expect(after.filter((participant) => participant.userid === OWNER_TO_BE)).toEqual([
      { role: 'owner', userid: OWNER_TO_BE },
    ])
  })

  it('refuses when the offering party is no longer the owner', () => {
    const movedOn: readonly Participant[] = [{ role: 'owner', userid: 'google|somebody-else' }]

    expect(() => applyTransfer(movedOn, offer(), OWNER_TO_BE)).toThrow(/no longer owns/i)
  })

  it('refuses a transfer to the person who already owns it', () => {
    expect(() => applyTransfer(owned, offer(), INSTALLER)).toThrow(/already own/i)
  })

  it('refuses a recipient with no subject', () => {
    expect(() => applyTransfer(owned, offer(), '')).toThrow(TransferError)
  })

  it('does not change the list it was given', () => {
    const before = [...owned]
    applyTransfer(owned, offer(), OWNER_TO_BE)

    expect(owned).toEqual(before)
  })
})
