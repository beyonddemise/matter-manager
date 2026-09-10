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
  readonly address?: string
}

/** A project, as `GET /projects` and `POST /projects` both return it. */
export interface Project {
  readonly projectId: string
  readonly dbName: string
  readonly name: string
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
}

/** Why creating a project did not work. The view turns each of these into a sentence. */
export type CreateFailure =
  /** The browser is certain there is no network. Nothing was attempted. */
  | 'offline'
  /** The request went out and did not arrive, or the answer never came. */
  | 'unreachable'
  /** Not signed in, or the token has expired. */
  | 'not-signed-in'
  /** The plan does not include this (ADR 0009). */
  | 'not-entitled'
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

/** How projects are reached. Injected so a view can be tested without a server. */
export interface ProjectsApi {
  list(): Promise<readonly Project[]>
  create(request: NewProject): Promise<Project>
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

/** Maps an HTTP status onto a reason. */
function reasonFor(status: number): CreateFailure {
  if (status === 401) return 'not-signed-in'
  if (status === 403) return 'not-entitled'
  if (status >= 400 && status < 500) return 'refused'
  return 'failed'
}

/**
 * The API client.
 *
 * The access token goes in an `Authorization` header, which is what the contract declares and
 * what the API's `auth/bearer.ts` reads. Not `credentials: 'include'`: the session cookie is
 * `SameSite=Lax`, so it would not be sent to an API on another site at all — and a request that
 * silently arrives unauthenticated answers 401, which reads as "signed out" on a page that is
 * signed in.
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
      if (!response.ok) throw new ProjectCreationError(reasonFor(response.status))
      return (await response.json()) as Project[]
    },

    async create(request: NewProject): Promise<Project> {
      const response = await fetchImpl(`${base}/projects`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new ProjectCreationError(reasonFor(response.status))
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
