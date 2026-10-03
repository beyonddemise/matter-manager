/**
 * Pending transfers: offering a project, and accepting one.
 *
 * Stored beside invitations in the registry, for the same reasons (ADR 0012) — and the offer is
 * addressed to an **email address** rather than a subject, because the homeowner an installer is
 * handing a house to may have no account at all yet.
 *
 * @module
 */

import type { Identity } from '../auth/oidc.js'
import { type CouchClient, CouchError } from '../couch/client.js'
import { installDesign, once } from '../couch/design.js'
import {
  acceptable,
  applyTransfer,
  foldEmail,
  type PendingTransfer,
  securityFor,
  TransferError,
} from '../domain/index.js'
import type { EnsureRecord } from '../users/ensure.js'
import { MembershipRefused } from './members.js'
import { type ProjectPointer, pointerId, REGISTRY_DATABASE } from './registry.js'

/** The design document indexing offers by the address they were sent to. */
export const BY_RECIPIENT_DESIGN = 'by_recipient'

/** The view within it. */
export const BY_RECIPIENT_VIEW = 'by_email'

/** How many times a conflicting write is retried. As membership: the same one document. */
const CONFLICT_ATTEMPTS = 3

/** One offer, as the registry stores it. One per project: a second offer replaces the first. */
export interface TransferDocument extends PendingTransfer {
  readonly _id: string
  readonly _rev?: string
  readonly type: 'transfer'
}

/** The document id for a project's pending offer. */
export function transferId(projectId: string): string {
  return `transfer:${projectId}`
}

/** Keyed on the folded address, as every other index here is. */
const BY_EMAIL_MAP = `function (doc) {
  if (doc.type === 'transfer' && doc.toEmail) {
    emit(doc.toEmail, doc)
  }
}`

const index = once(async (couch: CouchClient) => {
  await installDesign(couch, REGISTRY_DATABASE, `_design/${BY_RECIPIENT_DESIGN}`, {
    [BY_RECIPIENT_VIEW]: { map: BY_EMAIL_MAP },
  })
})

/** Forgets that the index was established. For tests. */
export function forgetTransferIndex(): void {
  index.forget()
}

/** Installs the offer index if it is not already there. */
export async function ensureTransferIndex(couch: CouchClient): Promise<void> {
  return index.ensure(couch)
}

/**
 * Records an offer, replacing any earlier one for the same project.
 *
 * One offer per project rather than one per recipient: an owner who changes their mind about
 * *who* to hand the house to has changed their mind, and two live offers would be a race between
 * two people to accept the same project.
 */
export async function storeTransfer(couch: CouchClient, transfer: PendingTransfer): Promise<void> {
  await ensureTransferIndex(couch)

  const _id = transferId(transfer.projectId)
  const existing = await couch.getDoc<TransferDocument>(REGISTRY_DATABASE, _id)

  await couch.putDoc(REGISTRY_DATABASE, {
    ...transfer,
    _id,
    ...(existing?._rev === undefined ? {} : { _rev: existing._rev }),
    type: 'transfer' as const,
  })
}

/** The offers waiting for one address. Expired ones are not offers any more. */
export async function transfersFor(
  couch: CouchClient,
  email: string,
  now: () => number,
): Promise<readonly TransferDocument[]> {
  const folded = foldEmail(email)
  if (folded === '') return []

  await ensureTransferIndex(couch)
  const result = await couch.view<{ value: TransferDocument }>(
    REGISTRY_DATABASE,
    BY_RECIPIENT_DESIGN,
    BY_RECIPIENT_VIEW,
    { key: folded },
  )

  return result.rows
    .map((row) => row.value)
    .filter((transfer) => Date.parse(transfer.expiresAt) > now())
}

/** Withdraws an offer. Called when it is declined, and when it has been accepted. */
export async function removeTransfer(
  couch: CouchClient,
  transfer: TransferDocument,
): Promise<void> {
  await couch.putDoc(REGISTRY_DATABASE, {
    ...transfer,
    _deleted: true,
  } as unknown as { _id: string })
}

/**
 * Accepts an offer: the recipient becomes the owner, and the previous owner keeps what was
 * agreed.
 *
 * **The whole change is computed and then written**, participants and `_security` together, so
 * there is no moment with two owners or none. `applyTransfer` is what guarantees that, and it is
 * a pure function so the guarantee is tested without a database.
 *
 * `_security` is written **first**, because a transfer always narrows somebody's access — the
 * outgoing owner loses write, and often loses everything. The rule is the same one
 * `members.ts` follows and for the same reason.
 *
 * **The recipient's record is ensured before anything is written**, once the offer is known to
 * be theirs. An owner must be resolvable — member listings read every participant's address from
 * their record — and a person who has only signed in has none, while one an operator created by
 * address has no `sub` yet. `ensureRecord` creates the first and fills in the second, as accepting
 * an invitation at sign-in does. Ensured first so a failure leaves the project untouched, and
 * only after the offer is checked so nobody gets a record by asking for one.
 *
 * **An active project is accepted only if the recipient's plan allows it.** Accepting makes
 * them the owner, which is a creation as far as a plan is concerned: without this a free account
 * could be handed a server project it could never have made. `authoriseAccept` is asked after
 * the offer is known to be theirs and before the record is ensured or anything is written, so a
 * refusal leaves the project, the offer and the user records exactly as they were, and the offer
 * stays pending for when the plan changes. An archived project is not asked about: it does not
 * count, and bringing it back is gated where that happens.
 *
 * @param deps - CouchDB, how the recipient's record is created or completed, and whether the
 *   recipient's plan may take one more active project. `authoriseAccept` rejects to refuse; the
 *   route maps the seam's own error to its named 403
 * @param identity - The recipient, from their verified access token
 * @throws {MembershipRefused} when the offer is not this person's to accept, has expired, or the
 *   person who made it no longer owns the project
 */
export async function acceptTransfer(
  deps: {
    readonly couch: CouchClient
    readonly ensureRecord: EnsureRecord
    readonly authoriseAccept: (recipient: Identity) => Promise<void>
  },
  projectId: string,
  identity: Identity,
  now: () => number,
): Promise<void> {
  // The recipient is the identity itself, not an account looked up from it. Somebody who has
  // only signed in has no user record, and requiring one turned "a house was offered to you"
  // into a 404 for exactly the person the offer was for. `acceptable` below still decides on
  // the verified address, so a subject alone accepts nothing.
  let ensured = false
  // The plan decision is made once. A retry follows a `_security` write, and a second answer
  // (the recipient's count may have moved) must not refuse a transfer already half applied.
  let authorised = false

  for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
    const offer = await deps.couch.getDoc<TransferDocument>(
      REGISTRY_DATABASE,
      transferId(projectId),
    )
    // 404 for every refusal a stranger could provoke: whether there is an offer for this
    // project at all is a fact about somebody else's house.
    if (offer === undefined) throw new MembershipRefused(404, 'No such transfer.')

    const pointer = await deps.couch.getDoc<ProjectPointer>(REGISTRY_DATABASE, pointerId(projectId))
    if (pointer === undefined) throw new MembershipRefused(404, 'No such transfer.')

    const problem = acceptable(offer, identity, pointer.participants, now)
    if (problem === 'wrong-address') throw new MembershipRefused(404, 'No such transfer.')
    if (problem !== undefined) {
      // Expired, unverified, or offered by somebody who no longer owns it. The recipient is
      // named by the offer, so these can be reported plainly — they are facts about the offer
      // they were sent rather than about a project they cannot see.
      throw new MembershipRefused(400, `That transfer cannot be accepted: ${problem}.`)
    }
    // The recipient's plan, for a project that is active. Before `ensureRecord`, which writes:
    // an account that is refused must not leave a record behind for having asked.
    if (!authorised && pointer.archived !== true) await deps.authoriseAccept(identity)
    authorised = true
    // `acceptable` has matched the verified address to the offer, so it is present. Once, not
    // per conflict retry: the record does not change between attempts.
    if (!ensured && identity.email !== undefined) {
      await deps.ensureRecord({
        email: identity.email,
        sub: identity.sub,
        ...(identity.name === undefined ? {} : { name: identity.name }),
      })
      ensured = true
    }

    let participants: readonly ProjectPointer['participants'][number][]
    try {
      participants = applyTransfer(pointer.participants, offer, identity.sub)
    } catch (error) {
      if (error instanceof TransferError) throw new MembershipRefused(400, error.message)
      throw error
    }

    try {
      await deps.couch.putSecurity(pointer.dbName, securityFor(participants))
      await deps.couch.putDoc(REGISTRY_DATABASE, { ...pointer, participants })
      await removeTransfer(deps.couch, offer)
      return
    } catch (error) {
      if (error instanceof CouchError && error.status === 409) continue
      throw error
    }
  }

  throw new MembershipRefused(409, 'Somebody else changed this project at the same time.')
}
