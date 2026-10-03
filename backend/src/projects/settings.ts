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

import { type CouchClient, CouchError } from '../couch/client.js'
import { canManageMembers, type Owner, roleOf } from '../domain/index.js'
import { MAX_ADDRESS, MAX_NAME, PROJECT_DOCUMENT_ID, type ProjectSummary } from './provision.js'
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
  /**
   * Who the project is for, or `null` to remove it.
   *
   * Spelled like `address`, for the same reason: a body that forgot the client must not erase
   * the one that is stored. A blank string clears it too, since whitespace says nothing.
   */
  readonly client?: string | null
  /**
   * Whether to put the project away, or bring it back.
   *
   * A state rather than an event, so it can be undone. A project that could be archived and not
   * unarchived would be deleted with extra steps, and #55 says explicitly that it is not
   * deleted.
   */
  readonly archived?: boolean
}

/**
 * The statuses a settings change can be refused with.
 *
 * A union rather than `number`, and it is not decoration. `status` is handed straight to
 * `problem()` and becomes the HTTP status, so this type *is* the list of refusals
 * `PATCH /projects/{projectId}` can answer — which is the question `openapi.yaml` has to agree
 * with. Typed as `number` it was a question only grep could answer, and grep does not run in
 * CI: a new `throw new SettingsRefused(422, …)` compiled, shipped, and drifted from the
 * contract silently. Now the compiler refuses it until somebody has declared it.
 *
 * Mirrors what `MembershipRefused` has always done, for the same reason.
 */
export type SettingsRefusalStatus = 400 | 403 | 404

/**
 * The refusals a client branches on, named. Only the role refusal has one: the others are
 * answered by their status and message alone. It is a name rather than "status is 403" because
 * 403 is shared with the plan refusals the route adds, and a route that inferred the name from
 * the status would label the next 403 somebody throws here as a role refusal.
 */
export type SettingsRefusalReason = 'not-a-manager'

/** A settings change that will not happen, carrying the status the route should answer with. */
export class SettingsRefused extends Error {
  override readonly name = 'SettingsRefused'
  /** What the caller should be told, as an HTTP status. See {@link SettingsRefusalStatus}. */
  readonly status: SettingsRefusalStatus
  /** The name a client branches on, when the refusal has one. See {@link SettingsRefusalReason}. */
  readonly reason?: SettingsRefusalReason

  constructor(status: SettingsRefusalStatus, message: string, reason?: SettingsRefusalReason) {
    super(message)
    this.status = status
    if (reason !== undefined) this.reason = reason
  }
}

/** What this module needs. */
export interface SettingsDependencies {
  readonly couch: CouchClient
  /** The clock in seconds since the epoch, which is what `archivedAt` records. */
  readonly now: () => number
  /**
   * Whether the project's **owner** may have one more active project, asked only when an archived
   * project is being brought back.
   *
   * Injected rather than decided here because the answer is a plan lookup and a gate, which
   * belong to the route's entitlement seam (ADR 0009) and not to a module about names. It runs
   * after the pointer has been read and the caller's role checked, and before anything is
   * written, so a refusal leaves the stored project exactly as it was. Rejects (with the seam's
   * own `NotEntitledError`) to refuse; the route maps that to its named 403.
   *
   * @param owner the OIDC subject of the project's owner, whose plan pays whoever is asking
   */
  readonly authoriseUnarchive: (owner: string) => Promise<void>
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

/** The client as it should be stored: trimmed, and nothing at all when blank or `null`. */
function readClient(value: string | null): string | undefined {
  if (value === null) return undefined
  const client = value.trim()
  if (client.length > MAX_NAME) {
    throw new SettingsRefused(400, `A client may be at most ${MAX_NAME} characters.`)
  }
  return client === '' ? undefined : client
}

/** How many times the `project` document write is retried on a conflict. As `transfers.ts`. */
const DOCUMENT_ATTEMPTS = 3

/**
 * Keeps the `project` document in the project's own database in step with the pointer.
 *
 * A get-modify-put, so `serverDb` and any field a later phase adds survive. A missing document
 * is created, which makes this total for a database provisioned before the document existed.
 * Written as the server admin, which bypasses the validator.
 *
 * @throws {CouchError} when the write fails, or keeps conflicting
 */
async function syncProjectDocument(
  couch: CouchClient,
  dbName: string,
  name: string,
  client: string | undefined,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const existing = await couch.getDoc<{ _id: string; _rev?: string }>(dbName, PROJECT_DOCUMENT_ID)
    // Already right: nothing to write. Comparing against the document itself, not the pointer,
    // is what lets a repeated PATCH heal a document whose earlier write failed.
    if (existing !== undefined) {
      const current = existing as {
        type?: unknown
        name?: unknown
        client?: unknown
        serverDb?: unknown
      }
      // `type` too: a replica recognises the document by it, so a wrong or missing one is as
      // stale as a wrong name, and is repaired by the same write.
      if (
        current.type === 'project' &&
        current.name === name &&
        current.client === client &&
        current.serverDb === dbName
      ) {
        return
      }
    }
    const { client: _client, name: _name, ...rest } = (existing ?? {}) as Record<string, unknown>
    try {
      await couch.putDoc(dbName, {
        ...rest,
        _id: PROJECT_DOCUMENT_ID,
        type: 'project',
        name,
        ...(client === undefined ? {} : { client }),
        serverDb: dbName,
      } as unknown as { _id: string })
      return
    } catch (error) {
      if (!(error instanceof CouchError && error.status === 409 && attempt < DOCUMENT_ATTEMPTS)) {
        throw error
      }
    }
  }
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
 * Changes a project's name, address, client or archived state, in any combination.
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
  if (
    change.name === undefined &&
    change.address === undefined &&
    change.client === undefined &&
    change.archived === undefined
  ) {
    // A client bug rather than a request. Writing a revision for it would replicate a document
    // to every device to announce that nothing happened.
    throw new SettingsRefused(400, 'Nothing to change.')
  }

  const pointer = await deps.couch.getDoc<ProjectPointer>(REGISTRY_DATABASE, pointerId(projectId))
  if (pointer === undefined) throw new SettingsRefused(404, 'No such project.')

  const role = roleOf(pointer.participants, caller)
  if (role === undefined) throw new SettingsRefused(404, 'No such project.')
  if (!canManageMembers(role)) {
    throw new SettingsRefused(
      403,
      'Only an owner or a manager can change project settings.',
      'not-a-manager',
    )
  }

  // Validated before anything is written, so a refusal leaves the stored project exactly as it
  // was. A validation that ran after the write would report the opposite of what happened.
  const name = change.name === undefined ? pointer.projectName : readName(change.name)
  const address = change.address === undefined ? pointer.address : readAddress(change.address)
  const client = change.client === undefined ? pointer.client : readClient(change.client)

  // Checked here as well as at the route, because this function is the one with the invariant.
  // A route is one caller; the next one would have to remember, and forgetting would write a
  // string into a field every reader treats as a boolean.
  if (change.archived !== undefined && typeof change.archived !== 'boolean') {
    throw new SettingsRefused(400, 'Archiving a project is true or false.')
  }
  const archived = change.archived ?? pointer.archived ?? false

  // Archived projects do not count toward the plan limit, so bringing one back is the moment it
  // starts counting again: without this, archive-create-unarchive walks past the limit. The
  // owner's plan is asked, not the caller's, because the owner pays — a manager may unarchive,
  // and a manager on a better plan than the owner must not lend it. Only the archived-to-active
  // transition is gated; archiving and every other edit never is.
  if (change.archived === false && pointer.archived === true) {
    await deps.authoriseUnarchive(ownerOf(pointer).ownerId)
  }

  // Stamped only by the `archived: true` event, and then once. A second `archived: true` is a
  // client repeating itself, and moving the stamp would make "how long has this been put away"
  // depend on how often somebody pressed the button. A rename of a pointer archived before the
  // stamp existed must not invent one, so every other change carries the stored value through.
  const archivedAt =
    change.archived === true
      ? (pointer.archivedAt ?? deps.now())
      : change.archived === false
        ? undefined
        : pointer.archivedAt

  // Spread from the pointer that was read, never rebuilt from arguments. `participants` is in
  // this document, and a rename that reconstructed it would drop every member of the project
  // with nothing to show for it.
  const { address: _address, client: _client, archivedAt: _archivedAt, ...rest } = pointer
  await writePointer(deps.couch, {
    ...rest,
    projectName: name,
    archived,
    // Absent rather than `undefined`: an explicit `address: undefined` serialises to a key
    // CouchDB stores as null, which reads back as a value where there should be none.
    ...(address === undefined ? {} : { address }),
    ...(client === undefined ? {} : { client }),
    ...(archivedAt === undefined ? {} : { archivedAt }),
  })

  // After the pointer, deliberately: the pointer is the source of truth for listing, so a
  // failure here leaves the list right and the replicated copy stale. It is not swallowed — it
  // propagates as a 500 so the client knows the rename is half done. Repeating the PATCH heals
  // it, because the document is compared with itself and not with the pointer, which already
  // holds the new values; every PATCH therefore converges the document, at the cost of one read.
  await syncProjectDocument(deps.couch, pointer.dbName, name, client)

  return {
    projectId: pointer.projectId,
    dbName: pointer.dbName,
    name,
    // The caller's own role, not the owner's: it says what *they* may do next.
    role,
    owner: ownerOf(pointer),
    archived,
    ...(address === undefined ? {} : { address }),
    ...(client === undefined ? {} : { client }),
    ...(archivedAt === undefined ? {} : { archivedAt }),
  }
}
