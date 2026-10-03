/**
 * What the projects page shows, and what it lets each project do — decided once, here.
 *
 * **Pure: no DOM, no PouchDB, no network.** It joins what this device holds (the local index in
 * `mm-local`), what the server last said (`GET /projects`) and the cached plan into rows, and
 * answers for every row and every combination of plan, session and connection which actions
 * are allowed and, when not, why. The view renders those answers and the actions obey them;
 * neither re-derives a rule, so a rule changes in one place and is tested in one place.
 *
 * **Location is derived, never stored** (spec, "Location and status"):
 *
 * | In the local index | In the server list, not archived | Location |
 * | --- | --- | --- |
 * | yes | no | `local` |
 * | no | yes | `server` |
 * | yes | yes | `synced` |
 *
 * The server list comes in three states: **fresh** (this session's answer), **stale** (the
 * last one heard, cached in `mm-local`, while offline or after a failed request) and
 * **unheard** (`undefined`). A stale list is trusted for facts — counts, roles, archived — so an
 * offline member with five server projects cannot create a sixth; it is never trusted for acts:
 * everything that needs the server is refused (`offline`, or `stale` when online). An unheard
 * list is refused the same way: without this session's answer the page cannot see server-only
 * projects, archived state or roles.
 *
 * Readings the table leaves open are decided here:
 *
 * - **A copy of an archived project** (fresh or stale list) reads `local`, opens read-only and
 *   offers only "delete local copy". CouchDB refuses every write to an archived project, so an
 *   edit could never arrive, and promoting it would mint a second project from one that was
 *   deliberately put away. It is not counted: the service does not count archived projects.
 * - **A copy a fresh list no longer names** (access revoked, deleted) — an orphan — is treated
 *   the same, and its delete carries a stronger warning, since unpushed changes cannot leave.
 *   Only a fresh list proves this; a stale one may simply predate the project.
 * - **A promotion that stopped half way** — a local-only database (`project_local…`) whose
 *   entry already records the server's id, because `POST /projects` answered and the data has
 *   not yet reached the server-named copy — reads `local` and stays editable: the data is still
 *   only here. It matches its server project by id, so it is counted once and lists no second
 *   row. It offers promote again, to finish the job (no slot needed: the project exists), and
 *   delete; rename waits, since the name now lives on the server too. It is never an orphan:
 *   its data has never been anywhere else, whatever the list says.
 * - **A copy with no server project to compare with** (stale list not naming it, or unheard)
 *   reads `synced`, its last known state, so removing it still demands the push only `synced`
 *   asks for. Its role is the one the index recorded, and **owner** when none was: counting a
 *   project that may be shared can refuse a create that would have fitted, while the opposite
 *   reading could create past the limit.
 *
 * **No tier literal** (ADR 0009): every plan question goes through `domain/plan.ts`.
 *
 * @module
 */

import { isLocalOnlyDatabase, type LocalProjectEntry } from '../data/index.js'
import {
  canOwnAnother,
  exceedsLimit,
  LAYOUTS,
  limitFor,
  type Plan,
  planSyncs,
} from '../domain/plan.js'
import type { Project } from './projects.js'
import type { SyncState } from './sync/replication.js'

/**
 * Whether there is a session, and if not, why.
 *
 * `expired` is a session whose refresh was refused (401). It allows exactly what `signed-out`
 * allows; it exists so the view can say "your session has ended" rather than "sign in".
 */
export type Session = 'signed-in' | 'signed-out' | 'expired'

/** Where a project lives, as the page labels it. */
export type Location = 'local' | 'server' | 'synced'

/** Why an action is not offered. The view turns each into a sentence. */
export type Refusal =
  /** The action means nothing for this row, e.g. promoting a project already on the server. */
  | 'not-applicable'
  /** It needs the server, and there is no session. */
  | 'signed-out'
  /** It needs the server, and there is no connection: "Needs a connection". */
  | 'offline'
  /**
   * It needs the server, and the server has not just confirmed the list: the page holds only the
   * last one heard, or none at all (the request failed with nothing cached). Without this
   * session's list the page cannot see server-only projects, archived state or roles, so it
   * would offer what the service then refuses. Offline reads `offline` instead.
   */
  | 'stale'
  /** The plan does not put projects on the server (lapsed or free owner). */
  | 'plan'
  /** The account owns more than its limit, so the server would refuse another active project. */
  | 'limit'
  /** The caller's role on a shared project does not allow it. */
  | 'role'
  /** The server has put the project away; only deleting the local copy is left. */
  | 'read-only'

/** Whether an action is allowed, and why not when it is not. */
export interface Permission<R extends string = Refusal> {
  readonly allowed: boolean
  /** Present exactly when `allowed` is false. */
  readonly reason?: R
  /**
   * Allowed, but the confirmation must say more. `unpushed-may-be-lost`: the copy's project is
   * gone from the server's list, or archived, so changes made here and never pushed go with it.
   */
  readonly warn?: 'unpushed-may-be-lost'
}

/** Every action a row can offer. */
export interface RowActions {
  /** Make it the current project and go to its devices. */
  readonly open: Permission
  /** Change the name or client. */
  readonly rename: Permission
  /** Put a local-only project on the server. Already counted here, but refused over the limit. */
  readonly promote: Permission
  /** Start keeping a local copy of a server-only project. */
  readonly download: Permission
  /** Drop the local copy of a synchronized project, after a push that leaves nothing behind. */
  readonly removeLocal: Permission
  /** Destroy a local database that has nowhere else to go. Confirmed by typing the name. */
  readonly deleteLocal: Permission
  /** Archive the project on the server. */
  readonly removeServer: Permission
}

/** One project on the page. */
export interface Row {
  /** Stable across renders: the database name, which is unique per device and per server. */
  readonly key: string
  readonly name: string
  readonly client?: string
  readonly location: Location
  /** Absent while the project exists only on this device. */
  readonly projectId?: string
  readonly dbName: string
  /**
   * The caller's role: the server list's (fresh or stale), else the one the index recorded, else
   * owner. Absent only while the project exists only on this device.
   */
  readonly role?: Project['role']
  /** Whether the server project has been archived. Its local copy, if any, is read-only. */
  readonly archived: boolean
  /** The live replication state, for projects that have a server side. */
  readonly syncState?: SyncState
  /** Whether opening it allows writes — what `useProjectDatabase(dbName, editable)` is given. */
  readonly editable: boolean
  readonly actions: RowActions
}

/** Why a new project cannot be created. */
export type CreateRefusal =
  | 'signed-out'
  | 'limit'
  /** Online and signed in, but the server's list is unheard or stale, so a server create is blind. */
  | 'offline-server'

/** Everything the page needs. */
export interface ProjectsModel {
  /** The caller's own projects, sorted by name. */
  readonly owned: readonly Row[]
  /** Projects others share with the caller, sorted by name. Never counted. */
  readonly shared: readonly Row[]
  /** The limit in force; `-1` is unlimited. */
  readonly limit: number
  /** Owned projects wherever they live, each once; archived and shared ones excluded. */
  readonly ownedCount: number
  /** Whether a downgrade left more projects than the plan allows. */
  readonly overLimit: boolean
  readonly canCreate: Permission<CreateRefusal>
  /** Where a new project goes: the server when signed in, online and on a plan that syncs. */
  readonly createTarget: 'synced' | 'local'
  /** Which layout the plan sees. */
  readonly layout: (typeof LAYOUTS)[Plan]
  /**
   * The owned local-only project that has no name yet, if any: the first-run catalogue, adopted
   * before the reader was asked what to call it. The page asks for the name before anything
   * else, since until then there is nothing to "continue with". Never a server project — the
   * service names those, and the page cannot.
   */
  readonly needsName: Row | undefined
}

/** What the model is computed from. */
export interface ProjectsInput {
  /** The local index: every project database this device holds. */
  readonly local: readonly LocalProjectEntry[]
  /**
   * `GET /projects`, archived included — or, with {@link serverStale}, the last list heard (the
   * cached `cache:project:*` data). `undefined` when no list has ever been heard.
   */
  readonly server: readonly Project[] | undefined
  /**
   * Whether `server` is a cached list rather than this session's answer. Its facts (counts, roles,
   * archived) still apply; actions that need the server are refused until a fresh one arrives.
   *
   * **Callers:** a list is fresh only if it was fetched in the current signed-in session, so pass
   * `true` (or no list) whenever the session is `signed-out` or `expired`. The model checks the
   * session before freshness, so a wrong `false` there cannot unlock anything, but it would claim
   * a list nobody is entitled to have just heard.
   */
  readonly serverStale?: boolean
  /** The cached plan; `free` on a device that never signed in. */
  readonly plan: Plan
  /** The server's `projectLimit`, when heard. Preferred over the plan table. */
  readonly reportedLimit?: number
  readonly session: Session
  readonly online: boolean
  /** `SyncManager.stateOf`. */
  readonly syncStates: (projectId: string) => SyncState | undefined
}

/**
 * What a row is, before the page's vocabulary is applied. Both `remnant` (a copy whose server
 * project is archived) and `orphan` (a copy a fresh server list no longer names) are shown as
 * `local`, but neither is a local-only project. `promoting` (a local-only database whose
 * promotion stopped half way) is shown as `local` too, and its data is local-only.
 */
type Kind = 'local-only' | 'promoting' | 'remnant' | 'orphan' | 'synced' | 'server'

const LOCATIONS: Readonly<Record<Kind, Location>> = {
  'local-only': 'local',
  promoting: 'local',
  remnant: 'local',
  orphan: 'local',
  synced: 'synced',
  server: 'server',
}

const ALLOWED: Permission<never> = Object.freeze({ allowed: true })

/**
 * The first failed check's reason, or allowed.
 *
 * Checks are listed in the order a user can do something about them — applicability, then
 * session, then connection, then plan, then role — so the reason shown is the one to fix first.
 */
function gate<R extends string>(...checks: readonly (readonly [boolean, R])[]): Permission<R> {
  const failed = checks.find(([passes]) => !passes)
  return failed === undefined ? ALLOWED : { allowed: false, reason: failed[1] }
}

/** One project before the page's vocabulary is applied: where it came from and what it is. */
interface Source {
  readonly entry?: LocalProjectEntry
  readonly project?: Project
  readonly kind: Kind
  /** The caller's role: the server list's, else the index's, else owner; absent if local-only. */
  readonly role?: Project['role']
}

/** Builds the page's model. See the module comment for the rules and the judgment calls. */
export function projectsModel(input: ProjectsInput): ProjectsModel {
  const { plan, online } = input
  const signedIn = input.session === 'signed-in'
  const syncs = planSyncs(plan)
  const stale = input.server !== undefined && input.serverStale === true
  const fresh = input.server !== undefined && !stale

  const sources = join(input.local, input.server, fresh)
  const mine = (source: Source): boolean => source.role === undefined || source.role === 'owner'
  // Remnants and orphans are listed but not counted: the service does not count what it has put
  // away, and what it no longer lists it does not count at all.
  const ownedCount = sources.filter(
    (source) =>
      mine(source) &&
      (source.kind === 'synced' ||
        source.kind === 'server' ||
        source.kind === 'local-only' ||
        source.kind === 'promoting'),
  ).length
  const limit = limitFor(plan, input.reportedLimit)
  const overLimit = exceedsLimit(ownedCount, limit)

  // Every action that needs the server asks these, in this order. Only a fresh list lets one
  // through: a stale one (offline, or the request failed) is good enough to count against, never
  // to act on, and an unheard one is not even that.
  const needsServer = [
    [signedIn, 'signed-out'],
    [online, 'offline'],
    [fresh, 'stale'],
  ] as const

  function row({ entry, project, kind, role }: Source): Row {
    const owner = role === undefined || role === 'owner'
    const projectId = project?.projectId ?? entry?.projectId
    // `join` gives every source an entry, a project, or both.
    const dbName = entry?.dbName ?? (project as Project).dbName
    const client = project === undefined ? entry?.client : project.client
    const syncState = projectId === undefined ? undefined : input.syncStates(projectId)
    const manages = owner || role === 'manage'
    const removable =
      kind === 'local-only' || kind === 'promoting' || kind === 'remnant' || kind === 'orphan'

    return {
      key: dbName,
      name: project?.name ?? (entry as LocalProjectEntry).name,
      ...(client === undefined ? {} : { client }),
      location: LOCATIONS[kind],
      ...(projectId === undefined ? {} : { projectId }),
      dbName,
      ...(role === undefined ? {} : { role }),
      archived: project?.archived ?? false,
      ...(syncState === undefined ? {} : { syncState }),
      editable: editable(kind, role, owner, syncs),
      actions: {
        // A server-only row has nothing on this device, so it cannot be opened without the server.
        open: kind === 'server' ? gate<Refusal>(...needsServer) : ALLOWED,
        rename:
          kind === 'local-only'
            ? ALLOWED
            : kind === 'promoting'
              ? gate<Refusal>([false, 'not-applicable'])
              : kind === 'remnant' || kind === 'orphan'
                ? gate<Refusal>([false, 'read-only'])
                : gate<Refusal>(...needsServer, [manages, 'role']),
        // Slot-neutral on this page, but `POST /projects` counts the server's active projects
        // only, so over the limit the server refuses what the page would offer. Finishing a
        // half-done promotion creates nothing, so the limit does not apply to it.
        promote: gate<Refusal>(
          [kind === 'local-only' || kind === 'promoting', 'not-applicable'],
          ...needsServer,
          [syncs, 'plan'],
          [kind === 'promoting' || !overLimit, 'limit'],
        ),
        // A shared project's owner pays for it, so the caller's own plan does not matter.
        download: gate<Refusal>([kind === 'server', 'not-applicable'], ...needsServer, [
          syncs || !owner,
          'plan',
        ]),
        // Online only: the push that proves nothing is pending needs the server (`pushNow`).
        removeLocal: gate<Refusal>([kind === 'synced', 'not-applicable'], ...needsServer),
        // A remnant warns too: archiving pushes first, but only as best it can, and once the
        // server refuses writes whatever did not get through can only be lost.
        deleteLocal:
          kind === 'orphan' || kind === 'remnant'
            ? { allowed: true, warn: 'unpushed-may-be-lost' }
            : gate<Refusal>([removable, 'not-applicable']),
        removeServer: gate<Refusal>(
          [kind === 'server' || kind === 'synced', 'not-applicable'],
          ...needsServer,
          [owner, 'role'],
        ),
      },
    }
  }

  const byName = (a: Row, b: Row): number =>
    a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
  const owned = sources.filter(mine).map(row).sort(byName)
  const shared = sources
    .filter((source) => !mine(source))
    .map(row)
    .sort(byName)
  const createTarget = signedIn && online && syncs ? 'synced' : 'local'

  return {
    owned,
    shared,
    limit,
    ownedCount,
    overLimit,
    canCreate: gate<CreateRefusal>(
      [signedIn, 'signed-out'],
      [canOwnAnother(plan, ownedCount, input.reportedLimit), 'limit'],
      // A server create needs the server to have just answered: an unheard or stale list cannot
      // vouch for the count the service will check.
      [createTarget === 'local' || fresh, 'offline-server'],
    ),
    createTarget,
    layout: LAYOUTS[plan],
    needsName: owned.find((row) => row.projectId === undefined && row.name.trim() === ''),
  }
}

/**
 * Joins the local index with the server list (fresh, stale or unheard) into sources.
 *
 * A local entry matches its server project by database name or project id. Server projects
 * nothing local matches become `server` rows, unless archived: an archived project with no copy
 * has nothing to open and nothing to remove, so it is not on the page.
 */
function join(
  local: readonly LocalProjectEntry[],
  server: readonly Project[] | undefined,
  fresh: boolean,
): Source[] {
  const matched = new Set<Project>()
  const sources: Source[] = local.map((entry) => {
    const project = server?.find(
      (candidate) =>
        candidate.dbName === entry.dbName ||
        (entry.projectId !== undefined && candidate.projectId === entry.projectId),
    )
    if (project !== undefined) matched.add(project)
    const role =
      project?.role ??
      (entry.projectId === undefined || isLocalOnlyDatabase(entry.dbName)
        ? undefined
        : (entry.role ?? 'owner'))
    return {
      entry,
      ...(project === undefined ? {} : { project }),
      kind: kindOf(entry, project, fresh),
      ...(role === undefined ? {} : { role }),
    }
  })
  for (const project of server ?? []) {
    if (!matched.has(project) && !project.archived) {
      sources.push({ project, kind: 'server', role: project.role })
    }
  }
  return sources
}

/**
 * Which kind a local entry is.
 *
 * Only a **fresh** list proves a copy an orphan: a stale one may predate the project, and
 * deleting on that evidence would destroy data the server would still have taken.
 */
function kindOf(entry: LocalProjectEntry, project: Project | undefined, fresh: boolean): Kind {
  // Before the server project: whatever the server says, this data has not left the device.
  if (entry.projectId !== undefined && isLocalOnlyDatabase(entry.dbName)) return 'promoting'
  if (project !== undefined) return project.archived ? 'remnant' : 'synced'
  if (entry.projectId === undefined) return 'local-only'
  return fresh ? 'orphan' : 'synced'
}

/**
 * Whether the project may be written to when opened.
 *
 * Local-only projects always, half-promoted ones included: nothing outside this device judges
 * their data yet. A remnant or an orphan
 * never: the server refuses (or no longer takes) its writes. Otherwise the validator's rule is
 * predicted — readers never write, an owner only on a plan that syncs (the lapsed owner), and a
 * writer or manager always, since the owner's plan, not theirs, is what the project rests on.
 */
function editable(kind: Kind, role: Project['role'] | undefined, owner: boolean, syncs: boolean) {
  if (kind === 'local-only' || kind === 'promoting') return true
  if (kind === 'remnant' || kind === 'orphan' || role === 'read') return false
  return owner ? syncs : true
}
