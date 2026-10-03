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

/** What the caller wants to create. */
export interface NewProject {
  readonly name: string
  /** Who the project is for. Optional, as the contract has it. */
  readonly client?: string
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
  /** When it was put away, as the API spells it (an ISO date-time). Absent while active. */
  readonly archivedAt?: string
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
  /** Changes a project's name, client or archived state, and returns it as it now stands. */
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
const FORBIDDEN_REASONS: readonly CreateFailure[] = [
  'plan-no-sync',
  'project-limit-reached',
  'not-a-manager',
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
  return reason === 'not-found' ? 'refused' : reason
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
      return (await response.json()) as Project[]
    },

    async create(request: NewProject): Promise<Project> {
      const response = await fetchImpl(`${base}/projects`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new ProjectCreationError(await creationReasonFor(response))
      return (await response.json()) as Project
    },

    async update(projectId: string, patch: ProjectPatch): Promise<Project> {
      const response = await fetchImpl(`${base}/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) throw new ProjectUpdateError(await reasonFor(response))
      return (await response.json()) as Project
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
