import { describe, expect, it } from 'vitest'
import {
  foldEmail,
  INVITATION_LIFETIME,
  type Invitation,
  InvitationError,
  isOpen,
  planInvitation,
  redeemable,
} from '../../src/projects/invitation.js'

const NOW = Date.parse('2026-08-27T09:00:00.000Z')
const clock =
  (at = NOW) =>
  () =>
    at

const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'

const invitation = (overrides: Partial<Invitation> = {}): Invitation => ({
  projectId: PROJECT_ID,
  email: 'grace@example.test',
  role: 'read',
  invitedBy: 'google|ada',
  createdAt: '2026-08-27T09:00:00.000Z',
  expiresAt: '2026-09-10T09:00:00.000Z',
  ...overrides,
})

/** A verified Google identity for the invited address. */
const invitee = { email: 'grace@example.test', emailVerified: true }

describe('folding an address', () => {
  it('lower-cases it', () => {
    expect(foldEmail('Ada@Example.TEST')).toBe('ada@example.test')
  })

  it('trims it', () => {
    expect(foldEmail('  ada@example.test  ')).toBe('ada@example.test')
  })

  it('does not strip dots', () => {
    // A Gmail convention rather than a rule. Applying it would make `a.b@example.test` and
    // `ab@example.test` the same person at a provider where they are two people.
    expect(foldEmail('a.b@example.test')).toBe('a.b@example.test')
  })

  it('does not strip a +tag', () => {
    // Same reason. And somebody who invited `ada+house@example.test` meant that address.
    expect(foldEmail('ada+house@example.test')).toBe('ada+house@example.test')
  })
})

describe('preparing an invitation', () => {
  it('records who, what and when', () => {
    expect(
      planInvitation(
        {
          projectId: PROJECT_ID,
          email: 'Grace@Example.test',
          role: 'read',
          invitedBy: 'google|ada',
        },
        clock(),
      ),
    ).toEqual({
      projectId: PROJECT_ID,
      email: 'grace@example.test',
      role: 'read',
      invitedBy: 'google|ada',
      createdAt: '2026-08-27T09:00:00.000Z',
      expiresAt: new Date(NOW + INVITATION_LIFETIME).toISOString(),
    })
  })

  it('stores the address folded, because that is what a lookup compares', () => {
    const planned = planInvitation(
      { projectId: PROJECT_ID, email: 'GRACE@EXAMPLE.TEST', role: 'read', invitedBy: 'google|ada' },
      clock(),
    )

    expect(planned.email).toBe('grace@example.test')
  })

  it('expires after a fortnight', () => {
    const planned = planInvitation(
      { projectId: PROJECT_ID, email: 'grace@example.test', role: 'read', invitedBy: 'google|ada' },
      clock(),
    )

    expect(Date.parse(planned.expiresAt) - Date.parse(planned.createdAt)).toBe(INVITATION_LIFETIME)
  })

  it.each([
    ['grace'],
    ['grace@'],
    ['@example.test'],
    ['grace@example'],
    ['a b@example.test'],
    [''],
  ])('refuses %o, which is not an address', (value) => {
    expect(() =>
      planInvitation(
        { projectId: PROJECT_ID, email: value, role: 'read', invitedBy: 'google|ada' },
        clock(),
      ),
    ).toThrow(InvitationError)
  })

  it('refuses to make somebody an owner', () => {
    // Ownership is transferred, not granted — M5-5, with the checks that need. An invitation
    // that could make a stranger an owner on sign-in would be a way to give a project away to
    // somebody who has not appeared yet.
    expect(() =>
      planInvitation(
        {
          projectId: PROJECT_ID,
          email: 'grace@example.test',
          role: 'owner',
          invitedBy: 'google|ada',
        },
        clock(),
      ),
    ).toThrow(/transfer/i)
  })

  it('refuses somebody inviting themselves', () => {
    // Not merely pointless. The inviter already has a role, and redeeming overwrites it — so an
    // owner inviting themselves as a reader would demote themselves on their next sign-in.
    expect(() =>
      planInvitation(
        {
          projectId: PROJECT_ID,
          email: 'Ada@Example.test',
          role: 'read',
          invitedBy: 'google|ada',
          inviterEmail: 'ada@example.test',
        },
        clock(),
      ),
    ).toThrow(/already have access/i)
  })

  it('allows a role below owner', () => {
    for (const role of ['read', 'write', 'manage'] as const) {
      expect(
        planInvitation(
          { projectId: PROJECT_ID, email: 'grace@example.test', role, invitedBy: 'google|ada' },
          clock(),
        ).role,
      ).toBe(role)
    }
  })
})

describe('redeeming an invitation', () => {
  it('is allowed for the invited address, verified', () => {
    expect(redeemable(invitation(), invitee, clock())).toBeUndefined()
  })

  it('is refused when the provider did not verify the address', () => {
    // **The claim the whole feature rests on.** Redemption is by address, so an unverified one
    // is somebody *claiming* to be the invitee — and Google issues tokens with
    // `email_verified: false` for an address a user merely typed in.
    expect(
      redeemable(invitation(), { email: 'grace@example.test', emailVerified: false }, clock()),
    ).toBe('unverified')
  })

  it('is refused when the claim is absent altogether', () => {
    // Treating a missing claim as verified would turn "invite grace@example.test" into "let
    // anybody who says they are Grace in". A provider that does not say has not said yes.
    expect(redeemable(invitation(), { email: 'grace@example.test' }, clock())).toBe('unverified')
  })

  it('is refused for a different address', () => {
    expect(
      redeemable(invitation(), { email: 'mallory@example.test', emailVerified: true }, clock()),
    ).toBe('wrong-address')
  })

  it('is refused for an identity with no address', () => {
    expect(redeemable(invitation(), { emailVerified: true }, clock())).toBe('wrong-address')
  })

  it('matches the address whatever case it arrives in', () => {
    // The provider's casing is not the inviter's casing, and neither is canonical.
    expect(
      redeemable(invitation(), { email: 'GRACE@Example.test', emailVerified: true }, clock()),
    ).toBeUndefined()
  })

  it('is refused after it expires', () => {
    const after = Date.parse('2026-09-10T09:00:00.001Z')

    expect(redeemable(invitation(), invitee, clock(after))).toBe('expired')
  })

  it('is refused exactly at the moment it expires', () => {
    // The boundary belongs to the expired side: an invitation that is "still valid at exactly
    // its expiry" is one whose stated lifetime is a fortnight and a millisecond.
    const at = Date.parse('2026-09-10T09:00:00.000Z')

    expect(redeemable(invitation(), invitee, clock(at))).toBe('expired')
  })

  it('is still allowed a moment before', () => {
    const before = Date.parse('2026-09-10T08:59:59.999Z')

    expect(redeemable(invitation(), invitee, clock(before))).toBeUndefined()
  })

  it('reports being unverified before being wrong', () => {
    // Deliberate order. The address not matching is something the user can see and act on; not
    // being verified is a fact about their account. Reporting the second first means a person
    // whose address is both wrong and unverified is told the thing they can actually fix.
    expect(redeemable(invitation(), { email: 'other@example.test' }, clock())).toBe('unverified')
  })
})

describe('whether an invitation is still an offer', () => {
  it('is open before it expires', () => {
    expect(isOpen(invitation(), clock())).toBe(true)
  })

  it('is not open after', () => {
    expect(isOpen(invitation(), clock(Date.parse('2026-10-01T00:00:00.000Z')))).toBe(false)
  })
})
