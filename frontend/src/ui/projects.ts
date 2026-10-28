/**
 * Creating and listing projects — the one place this application needs a network.
 *
 * Everything else here works offline, because everything else is written to a local database
 * first. Creating a project cannot be: it means creating a CouchDB database, writing its
 * `_security` and installing its access rules, all of which need admin credentials the browser
 * does not and must not have (ADR 0003).
 *
 * **Nothing is queued.** A "create project" waiting to run when the network returns would be a
 * project the user believes exists: they would name it, put devices in it, and find later that
 * neither the project nor the devices were ever real. Refusing immediately is the honest
 * answer, and it is the whole of the second scenario in M5-1.
 *
 * Failures are reported as **reasons, not messages**. The message is the view's business, so
 * that it is translated — see issue #75, which is what happens when a domain module writes
 * English into an interface that is sometimes German.
 *
 * @module
 */

/**
 * A project DEK wrapped for the escrow public key, as `POST /projects` carries it (#305): the
 * `kid` and `wrapped` of the source database's `key:escrow` document, verbatim.
 */
export interface EscrowWrap {
  /** The escrow kid the wrap was made for, from `GET /escrowkey`. */
  readonly kid: string
  /** base64, the RSA-OAEP-256 wrap of the project DEK. */
  readonly wrapped: string
}

/** What the caller wants to create. */
export interface NewProject {
  readonly name: string
  /** Who the project is for. Optional, as the contract has it. */
  readonly client?: string
  /**
   * The escrow wrap the server test-unwraps before creating anything (spec decision 10). The
   * server stores nothing from it: the same wrap reaches the new database by replication, as
   * `key:escrow`. Promoting always sends one (`project-actions.ts`).
   *
   * Optional in the type because the contract makes it so — it is required only on a
   * deployment with escrow configured, and ignored elsewhere.
   */
  readonly escrowWrap?: EscrowWrap
}

/**
 * What the caller wants to change. Every field is optional and independent, but at least one
 * must be present — the contract declares `minProperties: 1`, so an empty patch is a 400.
 */
export interface ProjectPatch {
  readonly name?: string
  /** `null` clears the client; absent leaves it alone. There is no third spelling. */
  readonly client?: string | null
  /** Absent leaves the state alone: archiving and unarchiving are both explicit. */
  readonly archived?: boolean
  /**
   * The owner's choice during the read-only grace (#211, #284): `false` keeps the project
   * writable, taking one of the plan's writable slots; `true` gives its slot up, which the
   * server allows only while the owner is over the limit. Owner only, and never in one body
   * with `archived` (the contract answers that with a 400).
   */
  readonly readOnly?: boolean
}

/** A project, as `GET /projects` and `POST /projects` both return it. */
export interface Project {
  readonly projectId: string
  readonly dbName: string
  readonly name: string
  /** Who the project is for, when it was given one. */
  readonly client?: string
  readonly role: 'owner' | 'manage' | 'write' | 'read'
  readonly owner: { readonly ownerType: 'user' | 'org'; readonly ownerId: string }
  /**
   * Whether the project has been put away (#55).
   *
   * Required, as the contract declares it, even though the stored field is optional: the API
   * answers the question for every project, so nothing here has to read an absence as a `false`.
   * Archived projects are still listed - a client that could not see what it had put away could
   * not bring it back.
   */
  readonly archived: boolean
  /**
   * When it was put away, in seconds since the epoch, as the contract declares. Absent while
   * active.
   */
  readonly archivedAt?: number
  /**
   * Over its owner's plan limit after a downgrade (#211, #284): listed, readable and syncing,
   * and CouchDB refuses every write to it, for every participant. Never `true` on an archived
   * project.
   *
   * Required by the contract, optional here: a list cached by an older build, or answered by an
   * API older than #57, lacks it, and absent reads as writable. {@link readLifecycle} always
   * fills it in for what this client parses.
   */
  readonly readOnly?: boolean
  /** When the read-only grace ends, in seconds since the epoch. Present only while `readOnly`. */
  readonly graceUntil?: number
  /**
   * Archived because its read-only grace ended, rather than by a person: an upgrade brings it
   * back, which it never does for an archive somebody chose. Only ever `true` on an archived
   * project; optional for the reason {@link readOnly} is.
   */
  readonly autoArchived?: boolean
  /**
   * When the server may hard-delete the archived project, in seconds since the epoch
   * (`archivedAt` plus 90 days). Present only while archived.
   */
  readonly deleteAfter?: number
}

/** The read-only grace lifecycle fields of a {@link Project}, as {@link readLifecycle} reads them. */
export type Lifecycle = Pick<Project, 'readOnly' | 'graceUntil' | 'autoArchived' | 'deleteAfter'>

/** A deadline as the contract writes one: whole seconds since the epoch, after it began. */
function isEpochSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * The read-only grace lifecycle of a project as the contract allows it to be, whatever the body
 * said (#211, #284).
 *
 * Read defensively, because a wrong answer here is a page that invites writes the server refuses,
 * or tells a reader a project is deleted on a date nobody set. A flag that is not exactly `true`
 * reads as `false`, so an older API or cache reads as writable, which is what it was. A deadline
 * that is not whole positive seconds is dropped, and the page then says what it can without a
 * date. The pairings the contract fixes are enforced too: `readOnly` and `graceUntil` only on an
 * active project, `autoArchived` and `deleteAfter` only on an archived one.
 *
 * @param raw a project as the server or the cache gave it, possibly from another build
 */
export function readLifecycle(raw: {
  readonly archived?: unknown
  readonly readOnly?: unknown
  readonly graceUntil?: unknown
  readonly autoArchived?: unknown
  readonly deleteAfter?: unknown
}): Required<Pick<Lifecycle, 'readOnly' | 'autoArchived'>> & Lifecycle {
  const archived = raw.archived === true
  const readOnly = !archived && raw.readOnly === true
  const autoArchived = archived && raw.autoArchived === true
  return {
    readOnly,
    autoArchived,
    ...(readOnly && isEpochSeconds(raw.graceUntil) ? { graceUntil: raw.graceUntil } : {}),
    ...(archived && isEpochSeconds(raw.deleteAfter) ? { deleteAfter: raw.deleteAfter } : {}),
  }
}

/** A project from the API, its lifecycle read by {@link readLifecycle} and nothing else changed. */
function parsed(raw: Project): Project {
  const { readOnly: _r, graceUntil: _g, autoArchived: _a, deleteAfter: _d, ...rest } = raw
  return { ...rest, ...readLifecycle(raw) }
}

/** Why creating a project did not work. The view turns each of these into a sentence. */
export type CreateFailure =
  /** The browser is certain there is no network. Nothing was attempted. */
  | 'offline'
  /** The request went out and did not arrive, or the answer never came. */
  | 'unreachable'
  /** Not signed in, or the token has expired. */
  | 'not-signed-in'
  /** The plan does not include this (ADR 0009), and the server named no more specific reason. */
  | 'not-entitled'
  /** The owner's plan has no synchronized projects (`403`, reason `plan-no-sync`). */
  | 'plan-no-sync'
  /** The owner's plan has no room for another active project (`403`, `project-limit-reached`). */
  | 'project-limit-reached'
  /** The caller's role may not change settings (`403`, `not-a-manager`): ask the owner. */
  | 'not-a-manager'
  /** The server would not accept the request — a name too long, say. */
  | 'refused'
  /** Something went wrong at the other end. */
  | 'failed'
  /**
   * The server has no escrow key (`GET /escrowkey` answers 404: the feature is off there), so
   * no escrow wrap can be made and the project would land on the server unrecoverable. Nothing
   * was sent (#305).
   */
  | 'escrow-unavailable'

/** Creating a project did not work, and nothing was created. */
export class ProjectCreationError extends Error {
  override readonly name = 'ProjectCreationError'
  readonly reason: CreateFailure

  constructor(reason: CreateFailure) {
    super(`A project could not be created: ${reason}.`)
    this.reason = reason
  }
}

/** Why changing a project did not work: everything creating can fail with, and a 404. */
export type UpdateFailure =
  | CreateFailure
  /** No such project, or the caller is not a participant — the API answers both the same. */
  | 'not-found'
  /**
   * `readOnly` was sent by somebody other than the owner (`403`, `not-the-owner`): which projects
   * keep the plan's writable slots is the owner's choice (#284).
   */
  | 'not-the-owner'

/** Changing a project did not work, and nothing was changed. */
export class ProjectUpdateError extends Error {
  override readonly name = 'ProjectUpdateError'
  readonly reason: UpdateFailure

  constructor(reason: UpdateFailure) {
    super(`A project could not be changed: ${reason}.`)
    this.reason = reason
  }
}

/** How projects are reached. Injected so a view can be tested without a server. */
export interface ProjectsApi {
  list(): Promise<readonly Project[]>
  create(request: NewProject): Promise<Project>
  /** Changes a project's name, client, archived or read-only state; returns it as it now stands. */
  update(projectId: string, patch: ProjectPatch): Promise<Project>
}

/** What `createProject` needs besides the API. */
export interface CreateDependencies {
  readonly api: ProjectsApi
  /**
   * Whether the browser believes it has a network.
   *
   * Trusted only when it says **no**. `navigator.onLine` is false only when the browser is
   * certain there is no network at all, and true for a café network nobody has paid for — see
   * `connectivity.ts`. So a `false` here short-circuits, and a `true` means "worth trying",
   * not "this will work".
   */
  readonly online: () => boolean
}

/** The 403 reasons the contract pins, which a client branches on. */
const FORBIDDEN_REASONS: readonly UpdateFailure[] = [
  'plan-no-sync',
  'project-limit-reached',
  'not-a-manager',
  'not-the-owner',
]

/**
 * Maps a refused response onto a reason.
 *
 * A 403 is read for its body's `reason`, because "upgrade", "make room" and "ask the owner" are
 * different next steps. A body that is missing, is not JSON or names a reason this client does
 * not know falls back to `not-entitled` rather than throwing: the status alone was the answer
 * before the reasons existed, and a newer server must not turn a refusal into a crash.
 */
async function reasonFor(response: Response): Promise<UpdateFailure> {
  const { status } = response
  if (status === 401) return 'not-signed-in'
  if (status === 403) {
    const body = (await response.json().catch(() => undefined)) as { reason?: unknown } | undefined
    return FORBIDDEN_REASONS.find((known) => known === body?.reason) ?? 'not-entitled'
  }
  if (status === 404) return 'not-found'
  if (status >= 400 && status < 500) return 'refused'
  return 'failed'
}

/**
 * Creating has no 404 of its own, so a stray one is a plain refusal there; the narrower type
 * keeps `not-found` out of what the page has to handle for creation.
 */
async function creationReasonFor(response: Response): Promise<CreateFailure> {
  const reason = await reasonFor(response)
  // `not-the-owner` answers only a patch's `readOnly`; on a create it is a reason this client
  // does not know there, read as the status alone.
  return reason === 'not-found' ? 'refused' : reason === 'not-the-owner' ? 'not-entitled' : reason
}

/**
 * The API client.
 *
 * The access token goes in an `Authorization` header, which is what the contract declares and
 * what the API's `auth/bearer.ts` reads. There is no cookie that authenticates these routes:
 * the only one the API sets after sign-in is the handoff, which authorises a single
 * `POST /auth/token` and nothing else.
 */
export function projectsApi(
  baseUrl: string,
  token: () => string | undefined,
  fetchImpl: typeof fetch = fetch,
): ProjectsApi {
  const base = baseUrl.replace(/\/+$/, '')

  const headers = (): Record<string, string> => {
    const held = token()
    return {
      accept: 'application/json',
      ...(held === undefined ? {} : { authorization: `Bearer ${held}` }),
    }
  }

  return {
    async list(): Promise<readonly Project[]> {
      const response = await fetchImpl(`${base}/projects`, { headers: headers() })
      if (!response.ok) throw new ProjectCreationError(await creationReasonFor(response))
      const body: unknown = await response.json()
      // Not a list is a server fault, not an empty list: read as empty, it would prove every
      // copy here an orphan (`projects-model.ts`).
      if (!Array.isArray(body)) throw new ProjectCreationError('failed')
      return (body as Project[]).map(parsed)
    },

    async create(request: NewProject): Promise<Project> {
      const response = await fetchImpl(`${base}/projects`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new ProjectCreationError(await creationReasonFor(response))
      return parsed((await response.json()) as Project)
    },

    async update(projectId: string, patch: ProjectPatch): Promise<Project> {
      const response = await fetchImpl(`${base}/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) throw new ProjectUpdateError(await reasonFor(response))
      return parsed((await response.json()) as Project)
    },
  }
}

/**
 * Creates a project, or says why it could not.
 *
 * **It never queues and never retries.** A retry is indistinguishable to the user from a
 * success that has not appeared yet, and a queue is worse: it is a project they believe exists.
 * One attempt, one answer.
 *
 * @throws {ProjectCreationError} with a reason the interface can turn into a sentence
 */
export async function createProject(
  deps: CreateDependencies,
  request: NewProject,
): Promise<Project> {
  // The one thing `navigator.onLine` can be trusted for. Nothing is sent, so there is nothing
  // in flight to wonder about afterwards.
  if (!deps.online()) throw new ProjectCreationError('offline')

  try {
    return await deps.api.create(request)
  } catch (error) {
    if (error instanceof ProjectCreationError) throw error
    // A `TypeError` from `fetch` — DNS, a dropped connection, a captive portal. The browser
    // thought there was a network and there was not, which is a different sentence from
    // "you are offline" because the user may well believe they are online, and be right about
    // the wifi and wrong about the internet.
    throw new ProjectCreationError('unreachable')
  }
}

/**
 * Changes a project's name, client or archived state, or says why it could not.
 *
 * The same discipline as {@link createProject}: one attempt, never queued, offline refused
 * before anything is sent. A rename waiting for the network would be a name the user sees on
 * one device and nobody else ever does.
 *
 * @throws {ProjectUpdateError} with a reason the interface can turn into a sentence
 */
export async function updateProject(
  deps: CreateDependencies,
  projectId: string,
  patch: ProjectPatch,
): Promise<Project> {
  // `refused`, because that is what the server would answer: the contract declares
  // `minProperties: 1`, so an empty patch is a 400. Known here, so not worth a round trip.
  if (Object.keys(patch).length === 0) throw new ProjectUpdateError('refused')
  if (!deps.online()) throw new ProjectUpdateError('offline')

  try {
    return await deps.api.update(projectId, patch)
  } catch (error) {
    if (error instanceof ProjectUpdateError) throw error
    // A `TypeError` from `fetch`: see `createProject` on why this is not `offline`.
    throw new ProjectUpdateError('unreachable')
  }
}
