/**
 * What the shell reads to give the projects page its input: the local index, the server list and
 * the cached plan — everything in `ProjectsInput` that is not the session, the connection or the
 * live sync states, which the shell holds itself.
 *
 * **The server list comes fresh or remembered** (ruling C-R5). Every list fetched is written to
 * `mm-local`'s `cache:project:*` documents; when the next one cannot be fetched — offline, or the
 * request failed — the last one heard stands in, flagged stale, so an offline page still knows
 * how many projects are owned, which are shared and which are archived. The model trusts a stale
 * list for those facts and never for acts.
 *
 * Nothing here throws. An unreadable cache reads as a signed-out device with nothing indexed,
 * which the page can render; the reader's data is no less there for it.
 *
 * @module
 */

import type { LocalCache, LocalProjectEntry, ServerProject } from '../data/index.js'
import { DEFAULT_PLAN, type Plan } from '../domain/plan.js'
import { cachedPlan, cachedRequest, type PlanRequest } from './profile.js'
import { type Project, readLifecycle } from './projects.js'
import type { ListedProject } from './projects-model.js'

/** The part of the projects page's input that is read from storage and the server. */
export interface ProjectFacts {
  /** The local index: every project database this device holds. */
  readonly local: readonly LocalProjectEntry[]
  /** The fresh list, or the last one heard, or `undefined` when none ever was. */
  readonly server: readonly ListedProject[] | undefined
  /** Whether {@link server} is the remembered list rather than this session's answer. */
  readonly serverStale: boolean
  /** The cached plan; `free` on a device that never signed in. */
  readonly plan: Plan
  /** The server's project limit, when one was ever heard. */
  readonly reportedLimit?: number
  /** What the plan includes today, when the server ever said (ADR 0020). */
  readonly reportedPlanLimit?: number
  /** The signed-in account's email, when the profile was ever heard. */
  readonly email?: string
  /** The plan the account is waiting for, when the cached profile says it is (#224). */
  readonly request?: PlanRequest
  /**
   * Signed in, but whose session this is is not known yet: no profile is cached (a new token
   * forgets it). {@link local} then holds only unstamped entries, so a choice it lacks may only be
   * waiting for the profile - something to fall back from for now, not to overwrite.
   */
  readonly accountPending: boolean
}

/** A device that never signed in and holds nothing: what an unreadable cache reads as. */
const NOTHING: ProjectFacts = {
  local: [],
  server: undefined,
  serverStale: true,
  plan: DEFAULT_PLAN,
  accountPending: false,
}

/**
 * What of a listed project is remembered: the fields an offline page has questions about — the
 * read-only grace among them (#211, #284), so a copy opened offline is still non-editable and the
 * page still says until when.
 */
function remembered(project: ListedProject): ServerProject {
  return {
    projectId: project.projectId,
    dbName: project.dbName,
    name: project.name,
    role: project.role,
    archived: project.archived,
    ...(project.client === undefined ? {} : { client: project.client }),
    ...readLifecycle(project),
  }
}

/**
 * A remembered project, back in the shape the page reads. Absent `archived` is not archived, and
 * the lifecycle is read as from the server: the cache may hold what an older or newer build wrote.
 */
function listed(project: ServerProject): ListedProject {
  const archived = project.archived ?? false
  return {
    projectId: project.projectId,
    dbName: project.dbName,
    name: project.name,
    role: project.role,
    archived,
    ...(project.client === undefined ? {} : { client: project.client }),
    ...readLifecycle({ ...project, archived }),
  }
}

/**
 * Fetches `GET /projects` and remembers it, or answers `undefined` when it cannot be fetched.
 *
 * A failure to remember is ignored: this session still has the fresh list, and the next fetch
 * writes it again.
 *
 * @param list the request
 * @param now when it was fetched, for the cache
 */
export async function fetchProjectList(
  list: () => Promise<readonly Project[]>,
  cache: LocalCache,
  now: () => string = () => new Date().toISOString(),
): Promise<readonly Project[] | undefined> {
  let fresh: readonly Project[]
  try {
    fresh = await list()
  } catch {
    // Offline, unreachable, or refused: the remembered list stands in (see the module comment).
    return undefined
  }
  await cache.writeProjects(fresh.map(remembered), now()).catch(() => undefined)
  return fresh
}

/**
 * Reads the facts the projects page is computed from.
 *
 * @param fresh this signed-in session's list, if it was fetched; otherwise the remembered one is
 *   used, flagged stale. The caller passes `undefined` whenever the session is not signed in, so
 *   a list nobody is entitled to have just heard is never presented as fresh.
 * @param signedIn whether this device holds a session (a stored refresh token). Signed out,
 *   nothing is hidden; signed in, entries stamped for any other account are
 */
export async function readProjectFacts(
  cache: LocalCache,
  fresh: readonly ListedProject[] | undefined,
  signedIn: boolean,
): Promise<ProjectFacts> {
  const [local, profile, cachedList] = await Promise.all([
    cache.readLocalProjects().catch(() => NOTHING.local),
    cache.readProfile().catch(() => undefined),
    fresh === undefined ? cache.readProjects().catch(() => []) : Promise.resolve([]),
  ])
  // Another account's entries are not this account's to see: an entry stamped with a different
  // `sub` is left out of the list — and so out of the plan count — while its data stays on the
  // device (hiding is listing; removal is a sign-out's decision). An unstamped entry predates
  // the stamp or was made signed out, and shows for everyone. Signed out, nothing is hidden:
  // there is nobody to hide it from, and a profile a half-failed sign-out left behind names
  // nobody who is still here. Signed in with no profile yet - a fresh sign-in forgets it, so the
  // next person is never shown as the last - every stamped entry is somebody else's until the
  // profile says whose this session is.
  const sub = profile?.sub
  const visible = signedIn
    ? local.filter((entry) => entry.account === undefined || entry.account === sub)
    : local
  // A project marked `accessRemoved` was not in the last list heard; it is not part of it.
  const lastHeard = cachedList.filter((project) => !project.accessRemoved).map(listed)
  // An empty remembered list cannot be told from none (the cache has no "heard" marker), and the
  // model reads the two alike: neither names a project, and both refuse every server action.
  const server = fresh ?? (lastHeard.length === 0 ? undefined : lastHeard)
  const request = cachedRequest(profile)
  return {
    local: visible,
    server,
    serverStale: fresh === undefined,
    plan: cachedPlan(profile),
    ...(profile?.projectLimit === undefined ? {} : { reportedLimit: profile.projectLimit }),
    ...(profile?.planProjectLimit === undefined
      ? {}
      : { reportedPlanLimit: profile.planProjectLimit }),
    ...(profile?.email === undefined ? {} : { email: profile.email }),
    ...(request === undefined ? {} : { request }),
    accountPending: signedIn && sub === undefined,
  }
}
