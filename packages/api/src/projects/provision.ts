/**
 * Creating a project, all of it or none of it.
 *
 * **A half-created project is a security hole, not an inconvenience.** A CouchDB database
 * exists from the moment it is created, and until its `_security` is written it is readable by
 * anyone with an account — in this application that means somebody else's home. So every step
 * after the database exists is wrapped, and a failure removes it again.
 *
 * The order is chosen for what each failure leaves behind:
 *
 * 1. **The registry**, before anything is created. A registry that cannot be reached then costs
 *    nothing; the other order creates a database and deletes it again to learn the same fact.
 * 2. **The database.**
 * 3. **`_security`, immediately.** The window between 2 and 3 is the one dangerous moment and
 *    nothing may widen it — not the design document, and certainly not a round trip.
 * 4. **`_design/access`**, which turns "may write" into a rule CouchDB enforces.
 * 5. **The pointer, last.** A pointer to a half-made database is a project that appears in the
 *    list and does not work. An unpointed database is invisible, and step 2's rollback removes
 *    it.
 *
 * @module
 */

import type { Owner, Participant } from '@matter-manager/core'
import type { CouchClient } from '../couch/client.js'
import { projectDatabaseName } from './names.js'
import { ensureRegistry, pointerId, writePointer } from './registry.js'

/** The longest name the contract allows. */
const MAX_NAME = 200

/** The longest address the contract allows. */
const MAX_ADDRESS = 500

/** What provisioning needs. Everything impure is here, so the sequence itself is testable. */
export interface ProvisionDependencies {
  readonly couch: CouchClient
  /** The `validate_doc_update` source. See `design-docs.ts` for why it is read, not embedded. */
  readonly validator: () => string
  /** A new project id. `crypto.randomUUID` in production. */
  readonly newId?: (() => string) | undefined
  /** The clock, as an ISO-8601 string. */
  readonly now?: (() => string) | undefined
}

/** What the caller asked for. */
export interface NewProject {
  readonly name: string
  readonly address?: string | undefined
}

/** A project as the contract describes it (`ProjectSummary`). */
export interface ProjectSummary {
  readonly projectId: string
  readonly dbName: string
  readonly name: string
  readonly role: Participant['role']
  readonly owner: Owner
}

/**
 * Provisioning failed and nothing was left behind.
 *
 * Deliberately says nothing about CouchDB. The same rule as `couch/client.ts`: an error that
 * echoes the server tells whoever triggered it about the deployment. The reason travels in
 * `cause`, which is for the log.
 */
export class ProvisioningError extends Error {
  override readonly name: string = 'ProvisioningError'
}

/**
 * Provisioning failed **and the rollback failed too**.
 *
 * The one failure that must never be swallowed: a database with no `_security` is sitting in
 * CouchDB readable by every account in the deployment. It gets its own type because the
 * operator's next action is different — go and delete it by hand — and it names the database so
 * that action is possible.
 */
export class OrphanedDatabaseError extends ProvisioningError {
  override readonly name = 'OrphanedDatabaseError'
  /** The database that is still there and should not be. */
  readonly database: string

  constructor(database: string, options?: { cause?: unknown }) {
    super(
      `A project database was left behind and could not be removed: ${database}. It has no ` +
        '_security document, so it is readable by every account. Delete it.',
      options,
    )
    this.database = database
  }
}

/** Checks what the caller sent, before anything exists to clean up. */
function checkRequest(request: NewProject, owner: string): string {
  if (owner === '') throw new ProvisioningError('A project needs an owner.')

  const name = request.name.trim()
  if (name === '') throw new ProvisioningError('A project needs a name.')
  if (name.length > MAX_NAME) {
    throw new ProvisioningError(`A project name may be at most ${MAX_NAME} characters.`)
  }
  if ((request.address ?? '').length > MAX_ADDRESS) {
    throw new ProvisioningError(`An address may be at most ${MAX_ADDRESS} characters.`)
  }

  return name
}

/**
 * Creates a project: its database, its access rules and its entry in the registry.
 *
 * @param owner the OIDC subject of whoever is creating it, which is also their CouchDB name
 * @throws {ProvisioningError} when anything failed and everything was cleaned up
 * @throws {OrphanedDatabaseError} when the cleanup failed too — see the type
 */
export async function provisionProject(
  deps: ProvisionDependencies,
  request: NewProject,
  owner: string,
): Promise<ProjectSummary> {
  const name = checkRequest(request, owner)
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const now = deps.now ?? (() => new Date().toISOString())

  await ensureRegistry(deps.couch)

  const projectId = newId()
  const dbName = projectDatabaseName(projectId)

  const created = await deps.couch.createDb(dbName)
  if (!created) {
    // A uuid collision, which does not happen — and that is exactly why this path would never
    // be exercised by accident. The database is **not** ours, so it is not rolled back:
    // deleting somebody else's project because a random name matched it is the worst thing
    // this code could do.
    throw new ProvisioningError('That project could not be created. Please try again.')
  }

  try {
    // Immediately, and before anything else. Until this lands the database is readable by
    // every account in the deployment.
    await deps.couch.putSecurity(dbName, {
      members: { names: [owner], roles: [] },
      writers: { names: [owner] },
    })

    await deps.couch.putDoc(dbName, {
      _id: '_design/access',
      validate_doc_update: deps.validator(),
      language: 'javascript',
    } as unknown as { _id: string })

    await writePointer(deps.couch, {
      _id: pointerId(projectId),
      type: 'projectPointer',
      projectId,
      dbName,
      projectName: name,
      participants: [{ role: 'owner', userid: owner }],
      addedAt: now(),
    })
  } catch (cause) {
    await rollback(deps.couch, dbName, cause)
    throw new ProvisioningError('That project could not be created. Nothing was saved.', { cause })
  }

  return {
    projectId,
    dbName,
    name,
    role: 'owner',
    owner: { ownerType: 'user', ownerId: owner },
  }
}

/**
 * Removes a database that should not exist.
 *
 * @throws {OrphanedDatabaseError} if it could not, carrying the original failure as its cause —
 *   both facts matter, and a rollback error that replaced the original would leave nobody
 *   knowing why provisioning failed in the first place
 */
async function rollback(couch: CouchClient, dbName: string, cause: unknown): Promise<void> {
  try {
    await couch.deleteDb(dbName)
  } catch {
    throw new OrphanedDatabaseError(dbName, { cause })
  }
}
