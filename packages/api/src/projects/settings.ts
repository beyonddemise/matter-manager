/**
 * Changing a project's name and address (#128).
 *
 * A **settings** change, deliberately kept apart from `members.ts`: that module decides who may
 * reach a project, this one decides what it is called. They share an authorisation rule and
 * nothing else, and folding them together would put a rename in the same code path as a
 * permission change.
 *
 * The one hazard worth naming is that the registry pointer is a *single document* holding both
 * the name and the participant list. A rename written as a fresh document from its arguments
 * would silently drop every member — the same failure `applyTransfer` was written to avoid in
 * M5-5 — so every change here is a read, an amendment of the fields being changed, and a write
 * of the whole thing back.
 *
 * @module
 */

import { canManageMembers, type Owner, roleOf } from '@matter-manager/core'
import type { CouchClient } from '../couch/client.js'
import { MAX_ADDRESS, MAX_NAME, type ProjectSummary } from './provision.js'
import { type ProjectPointer, pointerId, REGISTRY_DATABASE, writePointer } from './registry.js'

/** What a caller asked to change. Both optional and independent; at least one is required. */
export interface SettingsChange {
  /** The new name. Trimmed, and refused when it says nothing. */
  readonly name?: string
  /**
   * The new address, or `null` to remove it.
   *
   * `null` rather than an absent field, the same way `role: null` revokes membership. A body
   * that simply forgot the address must not erase the one that is already there, and the two
   * are indistinguishable once "missing" is allowed to mean "remove".
   */
  readonly address?: string | null
}

/** A settings change that will not happen, carrying the status the route should answer with. */
export class SettingsRefused extends Error {
  override readonly name = 'SettingsRefused'
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** What this module needs. */
export interface SettingsDependencies {
  readonly couch: CouchClient
}

/** Trims, and refuses a name that says nothing or is longer than the contract allows. */
function readName(value: string): string {
  const name = value.trim()
  if (name === '') {
    throw new SettingsRefused(400, 'A project needs a name.')
  }
  if (name.length > MAX_NAME) {
    throw new SettingsRefused(400, `A project name may be at most ${MAX_NAME} characters.`)
  }
  return name
}

/**
 * The address as it should be stored: a string, or nothing at all.
 *
 * Whitespace becomes absence rather than an empty string. An empty string is a value every
 * reader then has to special-case, and it exports as a blank line rather than as nothing.
 */
function readAddress(value: string | null): string | undefined {
  if (value === null) return undefined
  const address = value.trim()
  if (address.length > MAX_ADDRESS) {
    throw new SettingsRefused(400, `An address may be at most ${MAX_ADDRESS} characters.`)
  }
  return address === '' ? undefined : address
}

/** The project's owner, as `ProjectSummary` requires it. */
function ownerOf(pointer: ProjectPointer): Owner {
  const owner = pointer.participants.find((participant) => participant.role === 'owner')
  if (owner === undefined) {
    // Broken data this API cannot produce. Refusing beats guessing: `owner` decides which
    // controls a client offers, and naming the wrong one is worse than answering nothing.
    throw new SettingsRefused(404, 'No such project.')
  }
  return { ownerType: 'user', ownerId: owner.userid }
}

/**
 * Changes a project's name, its address, or both.
 *
 * @param projectId the project to change
 * @param caller the OIDC subject of whoever is asking
 * @param change what to change; at least one field, or there is nothing to do
 * @returns the project as it now stands, so a client can replace what it was showing
 * @throws {SettingsRefused} 400 when there is nothing to change or a value is unusable, 403
 *   when the caller is a participant who may not change settings, and **404 when they are not a
 *   participant at all** — a 403 there would confirm that a project with this id exists, which
 *   is a fact about somebody else's home.
 */
export async function updateProjectSettings(
  deps: SettingsDependencies,
  projectId: string,
  caller: string,
  change: SettingsChange,
): Promise<ProjectSummary> {
  if (change.name === undefined && change.address === undefined) {
    // A client bug rather than a request. Writing a revision for it would replicate a document
    // to every device to announce that nothing happened.
    throw new SettingsRefused(400, 'Nothing to change.')
  }

  const pointer = await deps.couch.getDoc<ProjectPointer>(REGISTRY_DATABASE, pointerId(projectId))
  if (pointer === undefined) throw new SettingsRefused(404, 'No such project.')

  const role = roleOf(pointer.participants, caller)
  if (role === undefined) throw new SettingsRefused(404, 'No such project.')
  if (!canManageMembers(role)) {
    throw new SettingsRefused(403, 'Only an owner or a manager can change project settings.')
  }

  // Validated before anything is written, so a refusal leaves the stored project exactly as it
  // was. A validation that ran after the write would report the opposite of what happened.
  const name = change.name === undefined ? pointer.projectName : readName(change.name)
  const address = change.address === undefined ? pointer.address : readAddress(change.address)

  // Spread from the pointer that was read, never rebuilt from arguments. `participants` is in
  // this document, and a rename that reconstructed it would drop every member of the project
  // with nothing to show for it.
  const { address: _previous, ...rest } = pointer
  await writePointer(deps.couch, {
    ...rest,
    projectName: name,
    // Absent rather than `undefined`: an explicit `address: undefined` serialises to a key
    // CouchDB stores as null, which reads back as a value where there should be none.
    ...(address === undefined ? {} : { address }),
  })

  return {
    projectId: pointer.projectId,
    dbName: pointer.dbName,
    name,
    // The caller's own role, not the owner's: it says what *they* may do next.
    role,
    owner: ownerOf(pointer),
    ...(address === undefined ? {} : { address }),
  }
}
