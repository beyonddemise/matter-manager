/**
 * Inviting somebody who has no account yet.
 *
 * **There is no invitation token, and that is the design.** An invitation is redeemed by
 * signing in with the address it was sent to — so what grants access is control of that mailbox
 * as *the identity provider verifies it*, not possession of a link. A link that granted access
 * could be forwarded, quoted in a support ticket, or read out of a shared inbox; an address
 * cannot be any of those things.
 *
 * That shifts the whole weight of this feature onto one claim: the provider must say the
 * address is **verified**. `redeemable` refuses otherwise, and it is the reason
 * `Identity.emailVerified` exists.
 *
 * @module
 */

import type { ProjectRole } from './ownership.js'

/** How long an invitation stays open, in milliseconds. Fourteen days. */
export const INVITATION_LIFETIME = 14 * 24 * 60 * 60 * 1000

/** An invitation, as it is stored and as it is read back. */
export interface Invitation {
  readonly projectId: string
  /** Folded, because that is what a lookup compares against. See {@link foldEmail}. */
  readonly email: string
  readonly role: ProjectRole
  /** Who sent it, so a member list can say and an audit can answer. */
  readonly invitedBy: string
  /** ISO-8601. */
  readonly createdAt: string
  /** ISO-8601. After this it cannot be redeemed. */
  readonly expiresAt: string
}

/** Refused: the invitation does not describe anything that can be sent. */
export class InvitationError extends Error {
  override readonly name = 'InvitationError'
}

/**
 * The comparison form of an email address.
 *
 * Lower-cased and trimmed, and nothing else — no dot-stripping, no `+tag` removal. Those are
 * Gmail conventions rather than rules, and applying them would make `a.b@example.test` and
 * `ab@example.test` the same person at a provider where they are two people.
 *
 * The local part is case-sensitive by the letter of RFC 5321 and case-insensitive at every
 * provider anybody uses. Folding is therefore wrong by the specification and right in practice,
 * which is worth stating out loud because it is a deliberate choice rather than an oversight:
 * somebody typing `Ada@Example.test` to share their house means the person they know as
 * `ada@example.test`.
 */
export function foldEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Whether this looks like an address at all. Deliberately minimal — the provider decides. */
function looksLikeEmail(email: string): boolean {
  // One `@`, something before it, and a dot-bearing something after it. Anything stricter
  // rejects addresses that exist; anything looser accepts a project id typed into the wrong box.
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)
}

/**
 * Prepares an invitation.
 *
 * @param now the clock, in milliseconds
 * @throws {InvitationError} when the address is unusable, or somebody is inviting themselves
 */
export function planInvitation(
  request: {
    readonly projectId: string
    readonly email: string
    readonly role: ProjectRole
    readonly invitedBy: string
    /** The inviter's own address, so inviting oneself can be refused. */
    readonly inviterEmail?: string
  },
  now: () => number,
  lifetime: number = INVITATION_LIFETIME,
): Invitation {
  const email = foldEmail(request.email)
  if (!looksLikeEmail(email)) {
    throw new InvitationError('That does not look like an email address.')
  }

  if (request.inviterEmail !== undefined && foldEmail(request.inviterEmail) === email) {
    // Not merely pointless: the inviter already has a role, and redeeming would overwrite it —
    // so an owner inviting themselves as a reader would demote themselves on next sign-in.
    throw new InvitationError('You already have access to this project.')
  }

  if (request.role === 'owner') {
    // Ownership is transferred, not granted, and M5-5 is where that happens with the checks it
    // needs. An invitation that could make a stranger an owner on sign-in would be a way to
    // give away a project to somebody who has not appeared yet.
    throw new InvitationError('Ownership cannot be given by invitation. Transfer it instead.')
  }

  const created = now()
  return {
    projectId: request.projectId,
    email,
    role: request.role,
    invitedBy: request.invitedBy,
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + lifetime).toISOString(),
  }
}

/** Why an invitation cannot be redeemed, or `undefined` when it can. */
export type InvitationProblem =
  /** Past its `expiresAt`. */
  | 'expired'
  /** The provider did not say the address is verified. */
  | 'unverified'
  /** The signed-in address is not the invited one. */
  | 'wrong-address'

/**
 * Whether this identity may redeem this invitation.
 *
 * **`emailVerified` is not optional here.** Redemption is by address, so an unverified address
 * is somebody claiming to be the invitee — and Google will issue a token with
 * `email_verified: false` for an address a user has merely typed in. Treating a missing claim
 * as verified would turn "invite ada@example.test" into "let anybody who says they are Ada in".
 */
export function redeemable(
  invitation: Invitation,
  identity: { readonly email?: string; readonly emailVerified?: boolean },
  now: () => number,
): InvitationProblem | undefined {
  if (identity.emailVerified !== true) return 'unverified'
  if (identity.email === undefined || foldEmail(identity.email) !== invitation.email) {
    return 'wrong-address'
  }
  if (Date.parse(invitation.expiresAt) <= now()) return 'expired'

  return undefined
}

/** Whether an invitation is still worth showing. Expired ones are not offers any more. */
export function isOpen(invitation: Invitation, now: () => number): boolean {
  return Date.parse(invitation.expiresAt) > now()
}
