/**
 * Storing invitations, and redeeming them when somebody signs in.
 *
 * Invitations live in the **registry** database, beside the project pointers. That is the only
 * place they can go: they are not project data (a project database replicates to every member,
 * and an invitation carries the address of somebody who is not one yet), and they are not
 * account data (there is no account). The registry is admin-only and never replicated —
 * ADR 0012 — which is exactly the property an invitation needs.
 *
 * @module
 */

import { foldEmail, type Invitation, isOpen, redeemable } from '@matter-manager/core'
import type { Identity } from '../auth/oidc.js'
import type { CouchClient } from '../couch/client.js'
import { changeMembership, type MembershipDependencies } from './members.js'
import { ensureRegistry, REGISTRY_DATABASE } from './registry.js'

/** The design document indexing invitations by address. */
export const BY_INVITEE_DESIGN = 'by_invitee'

/** The view within it. */
export const BY_INVITEE_VIEW = 'by_email'

/** The document id for one invitation. One per address per project, so a re-invite replaces. */
export function invitationId(projectId: string, email: string): string {
  return `invitation:${projectId}:${foldEmail(email)}`
}

/** An invitation as the registry stores it. */
export interface InvitationDocument extends Invitation {
  readonly _id: string
  readonly _rev?: string
  readonly type: 'invitation'
}

/**
 * The map function.
 *
 * Keyed on the **folded** address, for the same reason the user index is: a folded query against
 * an unfolded index matches nothing, which is the same failure as not folding at all.
 */
const BY_EMAIL_MAP = `function (doc) {
  if (doc.type === 'invitation' && doc.email) {
    emit(doc.email, doc)
  }
}`

let established = false

/** Forgets that the index was established. For tests. */
export function forgetInvitationIndex(): void {
  established = false
}

/** Installs the invitation index if it is not already there. */
export async function ensureInvitationIndex(couch: CouchClient): Promise<void> {
  if (established) return

  await ensureRegistry(couch)
  await couch.putDoc(REGISTRY_DATABASE, {
    _id: `_design/${BY_INVITEE_DESIGN}`,
    views: { [BY_INVITEE_VIEW]: { map: BY_EMAIL_MAP } },
    language: 'javascript',
  } as unknown as { _id: string })

  established = true
}

/**
 * Records an invitation, replacing any earlier one for the same address and project.
 *
 * Replacing rather than accumulating: two invitations for one person would be two roles to
 * apply in an order nobody chose. The most recent decision is the decision.
 */
export async function storeInvitation(couch: CouchClient, invitation: Invitation): Promise<void> {
  await ensureInvitationIndex(couch)

  const _id = invitationId(invitation.projectId, invitation.email)
  const existing = await couch.getDoc<InvitationDocument>(REGISTRY_DATABASE, _id)

  await couch.putDoc(REGISTRY_DATABASE, {
    ...invitation,
    _id,
    ...(existing?._rev === undefined ? {} : { _rev: existing._rev }),
    type: 'invitation' as const,
  })
}

/** Every open invitation for one address. Expired ones are not offers any more. */
export async function invitationsFor(
  couch: CouchClient,
  email: string,
  now: () => number,
): Promise<readonly InvitationDocument[]> {
  const folded = foldEmail(email)
  if (folded === '') return []

  await ensureInvitationIndex(couch)
  const result = await couch.view<{ value: InvitationDocument }>(
    REGISTRY_DATABASE,
    BY_INVITEE_DESIGN,
    BY_INVITEE_VIEW,
    { key: folded },
  )

  return result.rows.map((row) => row.value).filter((invitation) => isOpen(invitation, now))
}

/** Every open invitation for one project, for a member list. */
export async function invitationsForProject(
  couch: CouchClient,
  projectId: string,
  now: () => number,
): Promise<readonly InvitationDocument[]> {
  await ensureInvitationIndex(couch)
  const result = await couch.view<{ value: InvitationDocument }>(
    REGISTRY_DATABASE,
    BY_INVITEE_DESIGN,
    BY_INVITEE_VIEW,
  )

  return result.rows
    .map((row) => row.value)
    .filter((invitation) => invitation.projectId === projectId && isOpen(invitation, now))
}

/**
 * How an invitation reaches the person invited.
 *
 * A seam with **no default**, and that is deliberate: a sender that quietly did nothing would
 * mean invitations that are recorded, never delivered, and indistinguishable from delivered
 * ones. A deployment with no sender configured simply cannot invite — `PUT /members` for an
 * unknown address answers the same "nobody with that address has an account yet" it did before
 * M5-4, which is true and actionable.
 *
 * **What the message may contain:** the project's name, who invited them, and a link to the
 * application. Nothing else. It carries no device data, no setup code, and — importantly — **no
 * token**: an invitation is redeemed by signing in with the address it was sent to, so a
 * forwarded message grants nothing. See `core/projects/invitation.ts`.
 */
export interface InvitationSender {
  send(message: {
    readonly to: string
    readonly projectName: string
    readonly invitedByName: string
    readonly role: Invitation['role']
    readonly expiresAt: string
  }): Promise<void>
}

/** What redemption reports, per invitation. */
export interface Redemption {
  readonly projectId: string
  readonly applied: boolean
}

/**
 * Applies every invitation this identity may redeem, and removes it.
 *
 * Called during sign-in, **after** the identity has been verified and **before** the session is
 * issued — the same window `rememberUser` occupies, and for the same reason: a failure here
 * means no session, which is a sign-in that can simply be repeated. The alternative is somebody
 * signed in without the access they were invited to and no way to notice.
 *
 * Each invitation is applied independently. One that cannot be applied — the project was deleted
 * meanwhile, the last-owner rule refuses it — must not stop the others, because they are
 * unrelated grants from unrelated people.
 *
 * **`emailVerified` decides everything here.** See `core/projects/invitation.ts`.
 */
export async function redeemInvitations(
  deps: MembershipDependencies & { readonly couch: CouchClient },
  identity: Identity,
  now: () => number,
): Promise<readonly Redemption[]> {
  if (identity.email === undefined) return []

  const invitations = await invitationsFor(deps.couch, identity.email, now)
  const applied: Redemption[] = []

  for (const invitation of invitations) {
    if (redeemable(invitation, identity, now) !== undefined) continue

    try {
      // Applied as the **inviter**, not as the person signing in: the invitee is not a
      // participant yet, so they could not authorise their own admission — and an invitation is
      // a decision the inviter already made.
      await changeMembership(
        deps,
        invitation.projectId,
        invitation.invitedBy,
        identity.email,
        invitation.role,
      )
      await removeInvitation(deps.couch, invitation)
      applied.push({ projectId: invitation.projectId, applied: true })
    } catch {
      // Left in place rather than discarded: the project may have been deleted, or the inviter
      // may have lost the right to grant it. Neither is the invitee's doing, and a retained
      // invitation can be applied on a later sign-in if the situation changes.
      //
      // Not logged with the address: an invitation names somebody who has no account here.
      applied.push({ projectId: invitation.projectId, applied: false })
    }
  }

  return applied
}

/** Removes a redeemed invitation. It has done its job and now names a member. */
async function removeInvitation(couch: CouchClient, invitation: InvitationDocument): Promise<void> {
  await couch.putDoc(REGISTRY_DATABASE, {
    ...invitation,
    _deleted: true,
  } as unknown as { _id: string })
}

/**
 * Wraps `rememberUser` so that signing in also accepts any invitations waiting for the address.
 *
 * **The order is load-bearing.** `remember` runs first, because redemption calls
 * `changeMembership`, which resolves the invitee's address to a subject through `_users` — and
 * until `remember` has written that account, there is nobody to resolve. Reversing the two
 * produces an invitation that is silently never applied on the one sign-in it was waiting for.
 *
 * A failure in either half means **no session** — the window `AuthDependencies.rememberUser`
 * already occupies (M4-3), and for the same reason: a failed sign-in can simply be repeated,
 * whereas somebody signed in without the access they were invited to has no way to notice.
 */
export function acceptInvitationsOnSignIn(
  deps: MembershipDependencies & { readonly couch: CouchClient },
  remember: (identity: Identity) => Promise<void>,
  now: () => number = () => Date.now(),
): (identity: Identity) => Promise<void> {
  return async (identity) => {
    await remember(identity)
    await redeemInvitations(deps, identity, now)
  }
}
