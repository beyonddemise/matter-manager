/**
 * Who may do what with a project, and what CouchDB is told about it.
 *
 * **The mapping at the bottom of this file is the security model.** `docs/SECURITY-MODEL.md`
 * describes four roles, of which CouchDB understands two: it has readers and it has the writers
 * that `_design/access` enforces, and it has no way to express "may change who else has access".
 * So `manage` and `owner` are API concepts that map onto *writer* — from the database's point of
 * view a manager and an owner are simply people who may write.
 *
 * Getting that mapping wrong in the permissive direction is the worst bug this application can
 * have: a reader who is silently a writer can edit somebody else's home, and the interface that
 * hides the edit button would look exactly the same. So it is a pure function, here, tested
 * exhaustively — and `infra/couchdb/verify-access-model.sh` proves against a real CouchDB that
 * the shape it produces means what this file thinks it means.
 *
 * @module
 */

import type { Participant, ProjectRole } from './ownership.js'

/** The roles, in order of how much they permit. Exported so a UI can offer them in this order. */
export const PROJECT_ROLES: readonly ProjectRole[] = ['read', 'write', 'manage', 'owner']

/** What CouchDB is told. The shape `_security` takes; see `docs/SECURITY-MODEL.md`. */
export interface ProjectSecurity {
  readonly members: { readonly names: readonly string[]; readonly roles: readonly string[] }
  readonly writers: { readonly names: readonly string[] }
}

/** Whether somebody with this role may change who else has access. Enforced by the API alone. */
export function canManageMembers(role: ProjectRole | undefined): boolean {
  return role === 'owner' || role === 'manage'
}

/** Whether somebody with this role may write documents. What `_design/access` enforces. */
export function canWrite(role: ProjectRole): boolean {
  // Deliberately a list of the roles that *may*, rather than a check for the one that may not.
  // Adding a role to `ProjectRole` then fails this exhaustiveness rather than silently
  // inheriting write access from a `!== 'read'` test.
  return role === 'owner' || role === 'manage' || role === 'write'
}

/** Refused: the change would leave the project without an owner, or is not one to make. */
export class MembershipError extends Error {
  override readonly name = 'MembershipError'
}

/**
 * Grants a role, or changes one somebody already has.
 *
 * @throws {MembershipError} when the change would remove the last owner. A project with no
 *   owner cannot be transferred, shared or deleted by anybody — there is no way back from it
 *   through the API, so it is refused rather than repaired later.
 */
export function grantRole(
  participants: readonly Participant[],
  sub: string,
  role: ProjectRole,
): readonly Participant[] {
  if (sub === '') throw new MembershipError('That person could not be identified.')

  const existing = participants.find((participant) => participant.userid === sub)
  if (existing?.role === 'owner' && role !== 'owner' && ownerCount(participants) === 1) {
    throw new MembershipError(
      'A project must have an owner. Transfer ownership first, then change this role.',
    )
  }

  if (existing === undefined) return [...participants, { role, userid: sub }]

  return participants.map((participant) =>
    participant.userid === sub ? { role, userid: sub } : participant,
  )
}

/**
 * Removes somebody entirely.
 *
 * @throws {MembershipError} when they are the last owner — see {@link grantRole}.
 */
export function revokeAccess(
  participants: readonly Participant[],
  sub: string,
): readonly Participant[] {
  const existing = participants.find((participant) => participant.userid === sub)
  if (existing === undefined) return participants

  if (existing.role === 'owner' && ownerCount(participants) === 1) {
    throw new MembershipError(
      'A project must have an owner. Transfer ownership before removing this person.',
    )
  }

  return participants.filter((participant) => participant.userid !== sub)
}

/** How many owners a participant list has. */
function ownerCount(participants: readonly Participant[]): number {
  return participants.filter((participant) => participant.role === 'owner').length
}

/**
 * What CouchDB should be told about this participant list.
 *
 * **Everybody is a member; only some are writers.** `members.names` is read access, and
 * `writers.names` is the subset `_design/access` lets through — a member who is not a writer
 * gets `{"forbidden": "You have read-only access to this project."}` from the database itself,
 * which is what makes read-only access real rather than an appearance.
 *
 * `members.roles` is empty and stays empty. A role there would grant access to everybody
 * holding it, and this application's access is per person: a `roles` entry is the one way to
 * accidentally share every project with every account at once.
 */
export function securityFor(participants: readonly Participant[]): ProjectSecurity {
  const names = participants.map((participant) => participant.userid)
  const writers = participants
    .filter((participant) => canWrite(participant.role))
    .map((participant) => participant.userid)

  return { members: { names, roles: [] }, writers: { names: writers } }
}

/**
 * Whether applying `next` takes access away from anybody.
 *
 * Decides the **order** the two writes go in. A change that narrows access writes `_security`
 * first, so that the moment between the two writes is one where somebody has already lost
 * access rather than one where they still have it. A change that widens it writes the registry
 * first, for the mirror-image reason: the worst that can happen in between is a project listed
 * before it can be opened.
 *
 * There is no transaction available here — the registry and the project database are two
 * databases — so the only question is which half-applied state is the safe one.
 */
export function narrowsAccess(
  before: readonly Participant[],
  after: readonly Participant[],
): boolean {
  const previous = securityFor(before)
  const next = securityFor(after)

  const lostRead = previous.members.names.some((name) => !next.members.names.includes(name))
  const lostWrite = previous.writers.names.some((name) => !next.writers.names.includes(name))

  return lostRead || lostWrite
}
