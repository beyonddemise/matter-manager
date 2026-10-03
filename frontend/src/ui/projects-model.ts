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
 * Two readings the table leaves open are decided here:
 *
 * - **A copy the server has put away** — its project archived, or no longer listed at all
 *   (access revoked, deleted) — reads `local`, opens read-only and offers only "delete local
 *   copy". CouchDB refuses every write to an archived project, so an edit could never arrive,
 *   and promoting it would mint a second project from one that was deliberately put away. It is
 *   not counted: the service does not count archived projects either.
 * - **A copy while the server list is unheard** (offline, or the request failed) reads `synced`,
 *   its last known state, so that removing it still demands the push that only `synced` asks
 *   for. Its role is unknown — the index does not record one — so it is treated as **owned**:
 *   counted, listed under "mine", editable only on a plan that syncs. That reading can refuse a
 *   create that would have fitted; the opposite reading could create past the limit.
 *
 * **No tier literal** (ADR 0009): every plan question goes through `domain/plan.ts`.
 *
 * @module
 */

import type { LocalProjectEntry } from '../data/index.js'
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
  /** The plan does not put projects on the server (lapsed or free owner). */
  | 'plan'
  /** The caller's role on a shared project does not allow it. */
  | 'role'
  /** The server has put the project away; only deleting the local copy is left. */
  | 'read-only'

/** Whether an action is allowed, and why not when it is not. */
export interface Permission<R extends string = Refusal> {
  readonly allowed: boolean
  /** Present exactly when `allowed` is false. */
  readonly reason?: R
}

/** Every action a row can offer. */
export interface RowActions {
  /** Make it the current project and go to its devices. */
  readonly open: Permission
  /** Change the name or client. */
  readonly rename: Permission
  /** Put a local-only project on the server. Slot-neutral: it is already counted. */
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
  /** The caller's role, as the server last said. Absent when the server has not said. */
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
  /** Online and signed in, but the server's list was not heard, so a server create is blind. */
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
}

/** What the model is computed from. */
export interface ProjectsInput {
  /** The local index: every project database this device holds. */
  readonly local: readonly LocalProjectEntry[]
  /** `GET /projects`, archived included. `undefined` when it has not been heard. */
  readonly server: readonly Project[] | undefined
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
 * What a row is, before the page's vocabulary is applied. `remnant` is a local copy whose
 * server project is archived or no longer listed: shown as `local`, but not the same thing.
 */
type Kind = 'local-only' | 'remnant' | 'synced' | 'server'

const LOCATIONS: Readonly<Record<Kind, Location>> = {
  'local-only': 'local',
  remnant: 'local',
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

/** Builds the page's model. See the module comment for the rules and the two judgment calls. */
export function projectsModel(input: ProjectsInput): ProjectsModel {
  const { plan, online } = input
  const signedIn = input.session === 'signed-in'
  const syncs = planSyncs(plan)
  const heard = input.server !== undefined

  const matched = new Set<Project>()
  const remnants = new Set<Row>()
  const rows: Row[] = input.local.map((entry) => {
    const project = input.server?.find(
      (candidate) =>
        candidate.dbName === entry.dbName ||
        (entry.projectId !== undefined && candidate.projectId === entry.projectId),
    )
    if (project !== undefined) matched.add(project)
    const kind = kindOf(entry, project, heard)
    const built = row(entry, project, kind)
    if (kind === 'remnant') remnants.add(built)
    return built
  })
  for (const project of input.server ?? []) {
    // Archived with no local copy: nothing to open and nothing to remove, so not on the page.
    if (!matched.has(project) && !project.archived) rows.push(row(undefined, project, 'server'))
  }

  function row(
    entry: LocalProjectEntry | undefined,
    project: Project | undefined,
    kind: Kind,
  ): Row {
    const role = project?.role
    // Unheard role counts as owned; see the module comment.
    const mine = role === undefined || role === 'owner'
    const projectId = project?.projectId ?? entry?.projectId
    // Both are defined for every kind but `server` (no entry) and `local-only` (no project).
    const dbName = entry?.dbName ?? (project as Project).dbName
    const client = project === undefined ? entry?.client : project.client
    const syncState = projectId === undefined ? undefined : input.syncStates(projectId)
    const needsServer = [
      [signedIn, 'signed-out'],
      [online, 'offline'],
    ] as const
    const manages = mine || role === 'manage'

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
      editable: editable(kind, role, mine, syncs),
      actions: {
        // A server-only row has nothing on this device, so it cannot be opened without the server.
        open: kind === 'server' ? gate(...needsServer) : ALLOWED,
        rename:
          kind === 'local-only'
            ? ALLOWED
            : kind === 'remnant'
              ? gate([false, 'read-only'])
              : gate<Refusal>(...needsServer, [manages, 'role']),
        promote: gate<Refusal>([kind === 'local-only', 'not-applicable'], ...needsServer, [
          syncs,
          'plan',
        ]),
        // A shared project's owner pays for it, so the caller's own plan does not matter.
        download: gate<Refusal>([kind === 'server', 'not-applicable'], ...needsServer, [
          syncs || !mine,
          'plan',
        ]),
        // Online only: the push that proves nothing is pending needs the server (`pushNow`).
        removeLocal: gate<Refusal>([kind === 'synced', 'not-applicable'], ...needsServer),
        deleteLocal: gate<Refusal>([kind === 'local-only' || kind === 'remnant', 'not-applicable']),
        removeServer: gate<Refusal>(
          [kind === 'server' || kind === 'synced', 'not-applicable'],
          ...needsServer,
          [mine, 'role'],
        ),
      },
    }
  }

  const byName = (a: Row, b: Row): number =>
    a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
  const isMine = (candidate: Row): boolean =>
    candidate.role === undefined || candidate.role === 'owner'
  const owned = rows.filter(isMine).sort(byName)
  const shared = rows.filter((candidate) => !isMine(candidate)).sort(byName)
  // Remnants are listed but not counted: the service does not count what it has put away.
  const ownedCount = owned.filter((candidate) => !remnants.has(candidate)).length

  const limit = limitFor(plan, input.reportedLimit)
  const createTarget = signedIn && online && syncs ? 'synced' : 'local'

  return {
    owned,
    shared,
    limit,
    ownedCount,
    overLimit: exceedsLimit(ownedCount, limit),
    canCreate: gate<CreateRefusal>(
      [signedIn, 'signed-out'],
      [canOwnAnother(plan, ownedCount, input.reportedLimit), 'limit'],
      // A server create counts server-only projects the page cannot see without the list.
      [createTarget === 'local' || heard, 'offline-server'],
    ),
    createTarget,
    layout: LAYOUTS[plan],
  }
}

/** Which kind a local entry is, given its server project (if any) and whether the list was heard. */
function kindOf(entry: LocalProjectEntry, project: Project | undefined, heard: boolean): Kind {
  if (project !== undefined) return project.archived ? 'remnant' : 'synced'
  if (entry.projectId === undefined) return 'local-only'
  return heard ? 'remnant' : 'synced'
}

/**
 * Whether the project may be written to when opened.
 *
 * Local-only projects always: nothing outside this device judges them. A remnant never: the
 * server refuses its writes. Otherwise the validator's rule is predicted — readers never write,
 * an owner only on a plan that syncs (the lapsed owner), and a writer or manager always, since
 * the owner's plan, not theirs, is what the project rests on.
 */
function editable(kind: Kind, role: Project['role'] | undefined, mine: boolean, syncs: boolean) {
  if (kind === 'local-only') return true
  if (kind === 'remnant' || role === 'read') return false
  return mine ? syncs : true
}
