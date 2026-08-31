/**
 * Which project the interface is showing, and which ones it can show.
 *
 * Until #55 there was one catalogue, `project_local`, and no question to answer. Now an account
 * can have several, so something has to remember which one is open and hand the views the right
 * database.
 *
 * @module
 */

import type { ProjectRole } from '@matter-manager/core'
import { writeStoredPreference } from './preferences.js'

/** One project the switcher can offer. */
export interface SwitchableProject {
  readonly projectId: string
  readonly dbName: string
  readonly name: string
  readonly role: ProjectRole
  readonly archived: boolean
}

/**
 * The catalogue that lives only here.
 *
 * It predates accounts, and everything anybody recorded before signing in is in it. Keeping it
 * in the list is the difference between "your devices are under *On this device*" and their
 * having silently vanished the moment somebody signed in — which for an application whose whole
 * promise is not losing a code would be the worst possible first impression of having an
 * account.
 *
 * `owner`, because it is theirs and nobody else's; `archived: false`, because there is nowhere
 * to archive it to. Its name is not stored here — it is a user-visible string and belongs with
 * the translations.
 */
export const LOCAL_PROJECT_ID = 'local'

/** The database that catalogue has always lived in. Unchanged, so nothing has to be moved. */
export const LOCAL_DATABASE_NAME = 'project_local'

export const CURRENT_PROJECT_KEY = 'matter-manager.project'

/**
 * Announced when the open project changes.
 *
 * The views hold their repositories in a field, resolved once, because re-resolving on every
 * render would open a second handle on the same database and fire every change feed twice. So a
 * switch has to tell them, and this is how.
 */
export const PROJECT_CHANGED = 'matter-manager:project-changed'

/**
 * Which projects the switcher offers, the local catalogue first.
 *
 * Archived projects are left out — that is what archiving is for — but they are still *listed*
 * by the API, so somewhere else can offer to bring one back. Filtering here rather than at the
 * source is what keeps both possible.
 *
 * @param name what to call the local catalogue, in the reader's language
 */
export function switchableProjects(
  serverProjects: readonly SwitchableProject[],
  name: string,
): readonly SwitchableProject[] {
  const local: SwitchableProject = {
    projectId: LOCAL_PROJECT_ID,
    dbName: LOCAL_DATABASE_NAME,
    name,
    role: 'owner',
    archived: false,
  }
  return [local, ...serverProjects.filter((project) => !project.archived)]
}

/**
 * The project id currently open, defaulting to the local catalogue.
 *
 * The default matters more than it looks. Somebody who has never signed in, somebody signed out,
 * and somebody whose stored choice names a project they have since lost access to all arrive
 * here — and for all three the honest answer is the catalogue that is definitely on this device.
 */
/*
 * Read by hand rather than through `readStoredPreference`, which takes the set of permitted
 * values: a project id is a uuid from the server, so there is no closed set to check against.
 * The guard around the supplier is the part that matters and is kept.
 */
export function readCurrentProjectId(getStorage: () => Pick<Storage, 'getItem'>): string {
  try {
    return getStorage().getItem(CURRENT_PROJECT_KEY) ?? LOCAL_PROJECT_ID
  } catch {
    // Private browsing, or an origin refusing storage. See `preferences.ts` on why the supplier
    // is called inside the guard rather than passed as an object.
    return LOCAL_PROJECT_ID
  }
}

/** Remembers the open project. A refused write costs the choice on reload, not the session. */
export function writeCurrentProjectId(
  getStorage: () => Pick<Storage, 'setItem'>,
  projectId: string,
): void {
  writeStoredPreference(getStorage, CURRENT_PROJECT_KEY, projectId)
}

/**
 * The database for the open project, given what is available.
 *
 * Falls back to the local catalogue whenever the stored choice is not among the projects on
 * offer: access revoked, project archived, signed out, or a stored id from a build that named
 * them differently. **Never an empty result and never a guess** — a view handed no database
 * shows an empty catalogue, which is indistinguishable from having lost everything.
 */
export function currentDatabaseName(
  available: readonly SwitchableProject[],
  currentId: string,
): string {
  return available.find((project) => project.projectId === currentId)?.dbName ?? LOCAL_DATABASE_NAME
}

/** Whether the open project may be edited. Read-only projects hide their controls entirely. */
export function canEdit(available: readonly SwitchableProject[], currentId: string): boolean {
  const project = available.find((candidate) => candidate.projectId === currentId)
  // Absent means the local catalogue, which is always the reader's own.
  return project === undefined || project.role !== 'read'
}
