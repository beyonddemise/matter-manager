/**
 * The central registry: which projects exist, and who may see each one.
 *
 * **Admin-only, and never replicated to anybody** (ADR 0012). CouchDB has no row-level read
 * permission, so a registry readable by authenticated users would disclose every project's
 * name, address and participant list to every user — and in this application a project name is
 * a street address and `participants` is a map of who has access to whose home. The API is the
 * only reader and the only writer.
 *
 * @module
 */

import type { Participant } from '@matter-manager/core'
import type { CouchClient } from '../couch/client.js'
import { installDesign, once } from '../couch/design.js'

/** The registry database. Named once: a typo would create a second one that merely looked empty. */
export const REGISTRY_DATABASE = 'projects'

/** The design document holding the participant index. */
export const BY_PARTICIPANT_DESIGN = 'by_participant'

/** The view within it, keyed on a participant's subject. */
export const BY_USER_VIEW = 'by_user'

/** One project, as the registry records it. `docs/DATA-MODEL.md` is the definition. */
export interface ProjectPointer {
  readonly _id: string
  readonly _rev?: string
  readonly type: 'projectPointer'
  readonly projectId: string
  readonly dbName: string
  /** The registry's own name for the field the API calls `name`. */
  readonly projectName: string
  /**
   * The street address of the building, when there is one.
   *
   * Absent rather than empty. Accepted by `POST /projects` since M5-1 and discarded until
   * #128 — the length was checked and the value went no further.
   */
  readonly address?: string
  /**
   * Whether the project has been put away.
   *
   * Absent means no, so every project written before #55 reads correctly without a migration -
   * which matters because the alternative is rewriting every pointer in the registry to record
   * a fact that is false for all of them.
   *
   * Not a deletion and not a permission: an archived project keeps its database, its members
   * and its name, and an owner can bring it back. It is the client that stops replicating and
   * stops listing it, which is what "stops syncing and is hidden, but is not deleted" means.
   */
  readonly archived?: boolean
  readonly participants: readonly Participant[]
  readonly addedAt: string
}

/** One row of the view, which carries everything `GET /projects` needs without a second read. */
export interface ProjectRow {
  readonly projectId: string
  readonly dbName: string
  readonly projectName: string
  /** Absent when the project has none; see {@link ProjectPointer.address}. */
  readonly address?: string
  readonly role: Participant['role']
  /**
   * Whether the project is archived.
   *
   * Emitted as a real boolean by the map function - `doc.archived === true` - so a pointer
   * written before #55, which has no such field, reads as `false` here rather than as `null`.
   * That is what lets the field be added without rewriting every document in the registry.
   */
  readonly archived: boolean
  /**
   * Who owns the project, emitted alongside the row's own participant.
   *
   * `ProjectSummary` requires an owner, and a row describes one participant — so without this
   * the API would read every pointer again to render a list. `null` when the pointer names no
   * owner, which this API cannot produce and the route refuses to guess at.
   */
  readonly ownerId: string | null
}

/** The serialized view value. CouchDB turns the map function's missing address into `null`. */
interface ProjectViewRow extends Omit<ProjectRow, 'address'> {
  readonly address: string | null
}

/** The document id for a project. Predictable, so a project can be found without a view. */
export function pointerId(projectId: string): string {
  return `project:${projectId}`
}

/**
 * The map function, as `docs/DATA-MODEL.md` defines it.
 *
 * One row **per participant**, not per document. A view keyed on the document would return a
 * project to its owner and to nobody else — which passes every single-user test and fails the
 * moment anything is shared.
 */
const BY_USER_MAP = `function (doc) {
  if (doc.type === 'projectPointer' && doc.participants) {
    var ownerId = null
    doc.participants.forEach(function (p) {
      if (p.role === 'owner' && ownerId === null) ownerId = p.userid
    })
    doc.participants.forEach(function (p) {
      emit(p.userid, { projectId: doc.projectId, dbName: doc.dbName,
                       projectName: doc.projectName, address: doc.address,
                       role: p.role, ownerId: ownerId,
                       archived: doc.archived === true })
    })
  }
}`

/** Whether this process has already established that the registry is there. */
/**
 * Creates the registry and its view if they are not already there.
 *
 * Lazy rather than at startup, so that a service whose CouchDB is briefly unreachable still
 * starts and answers `/healthz` — a restart does not fix a database that is down.
 *
 * Remembered **only on success**. A failed attempt that marked itself done would leave every
 * later project creation writing pointers into a database that is not there.
 */
const registry = once(async (couch: CouchClient) => {
  await couch.createDb(REGISTRY_DATABASE)
  // Rewritten when the map function has changed, which is how a change to it reaches a
  // deployment, and left alone when it has not. `installDesign` carries the existing `_rev`:
  // without one this is a create, and CouchDB refuses it on every process after the first.
  await installDesign(couch, REGISTRY_DATABASE, `_design/${BY_PARTICIPANT_DESIGN}`, {
    [BY_USER_VIEW]: { map: BY_USER_MAP },
  })
})

/**
 * Ensures that the projects registry database and its design document are initialized.
 *
 * @param couch - The CouchDB client used to initialize the registry
 */
export async function ensureRegistry(couch: CouchClient): Promise<void> {
  return registry.ensure(couch)
}

/** Forgets that the registry was established. For tests, and for nothing else. */
export function forgetRegistry(): void {
  registry.forget()
}

/** Writes a pointer. Overwrites by `_id`, so a caller supplies `_rev` when replacing one. */
export async function writePointer(couch: CouchClient, pointer: ProjectPointer): Promise<void> {
  await couch.putDoc(REGISTRY_DATABASE, pointer)
}

/**
 * The projects one subject may see.
 *
 * Asked of the view with that subject as the key, rather than fetched and filtered here. The
 * registry holds every project in the deployment: filtering in the API means the whole list
 * crosses the wire on every request, and one forgotten `filter` discloses all of it.
 *
 * @throws {Error} on an empty subject. An empty key is a query, and a view that emitted
 *   anything under `""` would answer it — a caller arriving here with no subject is a bug in
 *   authentication, and it should look like one rather than like a user with no projects.
 */
export async function projectsFor(couch: CouchClient, sub: string): Promise<readonly ProjectRow[]> {
  if (sub === '') throw new Error('No subject: cannot list projects for nobody.')

  const result = await couch.view<{ value: ProjectViewRow }>(
    REGISTRY_DATABASE,
    BY_PARTICIPANT_DESIGN,
    BY_USER_VIEW,
    { key: sub },
  )
  return result.rows.map(({ value: { address, ...row } }) =>
    address === null ? row : { ...row, address },
  )
}
