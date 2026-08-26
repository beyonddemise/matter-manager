/**
 * Changing who has access to a project.
 *
 * Two databases have to agree: the registry pointer says who the participants are, and the
 * project database's `_security` is what CouchDB actually enforces. There is no transaction
 * across them, so the only question is **which half-applied state is the safe one** — and that
 * is decided by `narrowsAccess` in `core`:
 *
 * - **Taking access away** writes `_security` first. The moment between the two writes is then
 *   one where somebody has already lost access, rather than one where they still have it.
 * - **Giving access** writes the registry first, for the mirror-image reason: the worst that
 *   can happen in between is a project listed before it can be opened.
 *
 * @module
 */

import {
  canManageMembers,
  grantRole,
  MembershipError,
  narrowsAccess,
  type Participant,
  type ProjectRole,
  revokeAccess,
  roleOf,
  securityFor,
} from '@matter-manager/core'
import { type CouchClient, CouchError } from '../couch/client.js'
import { type ProjectPointer, pointerId, REGISTRY_DATABASE } from './registry.js'

/** How many times a conflicting pointer write is retried. */
const CONFLICT_ATTEMPTS = 3

/** One member, as `GET /projects/{projectId}/members` returns them. */
export interface Member {
  readonly sub: string
  readonly email: string
  readonly role: ProjectRole
}

/** Refused: the caller may not do this, or the request does not describe anything doable. */
export class MembershipRefused extends Error {
  override readonly name = 'MembershipRefused'
  /** What the caller should be told, as an HTTP status. */
  readonly status: 403 | 404 | 400 | 409

  constructor(status: 403 | 404 | 400 | 409, message: string) {
    super(message)
    this.status = status
  }
}

/** What this module needs. */
export interface MembershipDependencies {
  readonly couch: CouchClient
  /** Finds a user by email address. See `users.ts`. */
  readonly findUser: (email: string) => Promise<{ sub: string; email: string } | undefined>
}

/** Reads a pointer, or refuses. */
async function pointerFor(couch: CouchClient, projectId: string): Promise<ProjectPointer> {
  const pointer = await couch.getDoc<ProjectPointer>(REGISTRY_DATABASE, pointerId(projectId))
  // 404 rather than 403, and this is the one place the distinction leaks: a caller who is not a
  // participant is told the same thing whether the project is absent or merely not theirs —
  // see `assertMayManage`, which refuses before this is ever reported.
  if (pointer === undefined) throw new MembershipRefused(404, 'No such project.')
  return pointer
}

/**
 * Refuses unless the caller may change who has access.
 *
 * **404, not 403, for somebody who is not a participant.** A 403 would confirm that a project
 * with that id exists, which is a fact about somebody else's home — and the id is a uuid, so
 * the only way to have one is to have been told it.
 */
function assertMayManage(pointer: ProjectPointer, caller: string): void {
  const role = roleOf(pointer.participants, caller)
  if (role === undefined) throw new MembershipRefused(404, 'No such project.')
  if (!canManageMembers(role)) {
    throw new MembershipRefused(403, 'Only an owner or a manager can change who has access.')
  }
}

/** The members of a project, for the caller — who must be one of them. */
export async function listMembers(
  deps: MembershipDependencies,
  projectId: string,
  caller: string,
): Promise<readonly Member[]> {
  const pointer = await pointerFor(deps.couch, projectId)
  // Any participant may see who else is on the project. Somebody sharing a house with other
  // people is entitled to know who those people are.
  if (roleOf(pointer.participants, caller) === undefined) {
    throw new MembershipRefused(404, 'No such project.')
  }

  return Promise.all(
    pointer.participants.map(async (participant) => ({
      sub: participant.userid,
      // The address is read per member rather than stored in the pointer: an email that changed
      // would otherwise be wrong here forever, and the pointer is not the place that owns it.
      email: (await deps.findUser(participant.userid))?.email ?? '',
      role: participant.role,
    })),
  )
}

/**
 * Grants or changes a role, or revokes access when `role` is `undefined`.
 *
 * @param caller the subject making the change, who must be an owner or a manager
 * @throws {MembershipRefused} when the caller may not, the person is unknown, or the change
 *   would leave the project without an owner
 */
export async function changeMembership(
  deps: MembershipDependencies,
  projectId: string,
  caller: string,
  email: string,
  role: ProjectRole | undefined,
): Promise<void> {
  const found = await deps.findUser(email)
  if (found === undefined) {
    // Distinguished from "not allowed" deliberately: this is the one refusal the caller can act
    // on, and M5-4 turns it into an invitation rather than a dead end.
    throw new MembershipRefused(404, 'Nobody with that address has an account yet.')
  }

  for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
    const pointer = await pointerFor(deps.couch, projectId)
    assertMayManage(pointer, caller)

    let participants: readonly Participant[]
    try {
      participants =
        role === undefined
          ? revokeAccess(pointer.participants, found.sub)
          : grantRole(pointer.participants, found.sub, role)
    } catch (error) {
      if (error instanceof MembershipError) throw new MembershipRefused(400, error.message)
      throw error
    }

    try {
      await apply(deps.couch, pointer, participants)
      return
    } catch (error) {
      // The registry holds all participants in one document, so two membership changes to the
      // same project conflict (docs/DATA-MODEL.md). The API is the only writer, so this is a
      // re-read and retry rather than a merge — and it is bounded, because a conflict that
      // keeps happening is a problem the caller should hear about rather than wait through.
      if (error instanceof CouchError && error.status === 409) continue
      throw error
    }
  }

  throw new MembershipRefused(409, 'Somebody else changed this project at the same time.')
}

/** Writes both halves, in the order that makes the moment between them safe. */
async function apply(
  couch: CouchClient,
  pointer: ProjectPointer,
  participants: readonly Participant[],
): Promise<void> {
  const security = securityFor(participants)
  const next: ProjectPointer = { ...pointer, participants }

  if (narrowsAccess(pointer.participants, participants)) {
    await couch.putSecurity(pointer.dbName, security)
    await couch.putDoc(REGISTRY_DATABASE, next)
    return
  }

  await couch.putDoc(REGISTRY_DATABASE, next)
  await couch.putSecurity(pointer.dbName, security)
}
