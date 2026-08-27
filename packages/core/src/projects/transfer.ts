/**
 * Handing a project to somebody else.
 *
 * **Ownership is offered, not pushed.** An installer finishing a job hands the project to the
 * homeowner, and the homeowner has to say yes — because ownership is a responsibility for
 * somebody's data and eventually for a bill, and neither is a thing one person may assign to
 * another. So a transfer is two acts by two people, and the moment in between is a state this
 * module has to represent.
 *
 * The acceptance half reuses M5-4's rule exactly: the recipient is identified by an address the
 * provider has **verified**, never by possession of a link. See `invitation.ts`, and note that
 * this matters more here than there — an invitation grants a role, a transfer hands over
 * everything.
 *
 * @module
 */

import { foldEmail } from './invitation.js'
import type { Participant } from './ownership.js'

/** How long an offer stays open, in milliseconds. A fortnight, as invitations are. */
export const TRANSFER_LIFETIME = 14 * 24 * 60 * 60 * 1000

/** What the outgoing owner keeps. */
export type RetainedAccess =
  /** Read access, so an installer can still look up what they fitted. */
  | 'read'
  /** Nothing. The project leaves their list entirely. */
  | 'none'

/** An offer of ownership, waiting for an answer. */
export interface PendingTransfer {
  readonly projectId: string
  /** Folded, because that is what a verified claim is compared against. */
  readonly toEmail: string
  /** The current owner, who made the offer. */
  readonly fromSub: string
  readonly retainAccess: RetainedAccess
  readonly createdAt: string
  readonly expiresAt: string
}

/** Refused: the transfer does not describe anything that can happen. */
export class TransferError extends Error {
  override readonly name = 'TransferError'
}

/**
 * Prepares an offer.
 *
 * @throws {TransferError} when the offer is not one that could be accepted
 */
export function planTransfer(
  request: {
    readonly projectId: string
    readonly toEmail: string
    readonly fromSub: string
    readonly fromEmail?: string
    readonly retainAccess?: RetainedAccess
  },
  participants: readonly Participant[],
  now: () => number,
  lifetime: number = TRANSFER_LIFETIME,
): PendingTransfer {
  const toEmail = foldEmail(request.toEmail)
  if (!toEmail.includes('@')) {
    throw new TransferError('That does not look like an email address.')
  }

  // **Only the owner may offer.** Not a manager: managing who else has access and giving the
  // project away are different powers, and a manager who could transfer could take it.
  const offering = participants.find((participant) => participant.userid === request.fromSub)
  if (offering?.role !== 'owner') {
    throw new TransferError('Only the owner can transfer a project.')
  }

  if (request.fromEmail !== undefined && foldEmail(request.fromEmail) === toEmail) {
    throw new TransferError('You already own this project.')
  }

  const created = now()
  return {
    projectId: request.projectId,
    toEmail,
    fromSub: request.fromSub,
    retainAccess: request.retainAccess ?? 'none',
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + lifetime).toISOString(),
  }
}

/** Why an offer cannot be accepted, or `undefined` when it can. */
export type TransferProblem =
  /** Past its `expiresAt`. */
  | 'expired'
  /** The provider did not say the address is verified. */
  | 'unverified'
  /** The signed-in address is not the one the offer names. */
  | 'wrong-address'
  /** The person who offered is no longer the owner, so the offer is not theirs to keep. */
  | 'no-longer-owner'

/**
 * Whether this identity may accept this offer.
 *
 * The **`no-longer-owner`** case is the one that does not exist for invitations: between offer
 * and acceptance the project may have been transferred to somebody else, and an offer made by a
 * former owner must not still work. Ownership can only ever be given away by whoever holds it
 * at the moment it moves.
 */
export function acceptable(
  transfer: PendingTransfer,
  identity: { readonly email?: string; readonly emailVerified?: boolean },
  participants: readonly Participant[],
  now: () => number,
): TransferProblem | undefined {
  if (identity.emailVerified !== true) return 'unverified'
  if (identity.email === undefined || foldEmail(identity.email) !== transfer.toEmail) {
    return 'wrong-address'
  }
  if (Date.parse(transfer.expiresAt) <= now()) return 'expired'

  const offering = participants.find((participant) => participant.userid === transfer.fromSub)
  if (offering?.role !== 'owner') return 'no-longer-owner'

  return undefined
}

/**
 * The participant list after a transfer.
 *
 * Both halves happen together, which is why this is one function over the whole list rather than
 * a demotion followed by a promotion. Done in two steps there is a moment with two owners or
 * none — and `grantRole` refuses to demote the last owner precisely so that no such moment can
 * be reached by accident.
 *
 * @param toSub the recipient, who by now has an account
 * @throws {TransferError} when the list does not describe a transferable project
 */
export function applyTransfer(
  participants: readonly Participant[],
  transfer: PendingTransfer,
  toSub: string,
): readonly Participant[] {
  if (toSub === '') throw new TransferError('The recipient could not be identified.')
  if (toSub === transfer.fromSub) throw new TransferError('You already own this project.')

  const offering = participants.find((participant) => participant.userid === transfer.fromSub)
  if (offering?.role !== 'owner') {
    throw new TransferError('The person who offered this project no longer owns it.')
  }

  // The outgoing owner first, so the order of the list is stable — somebody watching a member
  // list sees a role change rather than a person leaving and a stranger appearing.
  const withoutRecipient = participants.filter((participant) => participant.userid !== toSub)
  const rewritten = withoutRecipient.flatMap((participant): readonly Participant[] => {
    if (participant.userid !== transfer.fromSub) return [participant]
    return transfer.retainAccess === 'read'
      ? [{ role: 'read', userid: participant.userid }]
      : // Removed entirely. The project leaves their list, which for an installer who has
        // finished a job is the point.
        []
  })

  return [...rewritten, { role: 'owner', userid: toSub }]
}
