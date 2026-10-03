/**
 * Which project the interface is showing.
 *
 * Every device holds one or more project databases, listed in the local index; the projects page
 * is where one is chosen (Open), and this module remembers the choice and, given the page's
 * model, says which database the views open and whether it may be written to.
 *
 * @module
 */

import { writeStoredPreference } from './preferences.js'
import type { ProjectsModel } from './projects-model.js'

/**
 * The choice stored before projects had ids of their own on every device: today's catalogue.
 *
 * Still the default when nothing is stored, and still matched, because browsers that used the
 * header switcher hold it. It means {@link LOCAL_DATABASE_NAME}.
 */
export const LOCAL_PROJECT_ID = 'local'

/** The database the first-run catalogue has always lived in. Unchanged, so nothing moves. */
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

/** Which project to make current, and how to open it. */
export interface CurrentTarget {
  readonly dbName: string
  /** What the current-project choice remembers: the project id, or the name while local-only. */
  readonly id: string
  readonly editable: boolean
}

/**
 * The project id currently open, defaulting to the local catalogue.
 *
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
 * The project the views open, given the stored choice and the page's model.
 *
 * The choice is matched by **project id or database name**, because Open stores
 * `projectId ?? dbName`: a local-only project has only its name, and a project promoted since it
 * was chosen keeps its old name in storage. The legacy {@link LOCAL_PROJECT_ID} means the
 * first-run catalogue. Only projects with a database on this device are candidates.
 *
 * When nothing matches — a copy removed, signed out, a stale id — it falls back to the first
 * local-only project (always editable), then to any copy, then to the first-run catalogue.
 * **Never an empty answer**: a view handed no database shows an empty catalogue, which looks
 * exactly like having lost everything.
 *
 * `editable` is the model's: that is how a lapsed owner's server project, or an archived one's
 * copy, comes to open read-only.
 */
export function resolveCurrentProject(storedId: string, model: ProjectsModel): CurrentTarget {
  const onDevice = [...model.owned, ...model.shared].filter((row) => row.location !== 'server')
  const wanted = storedId === LOCAL_PROJECT_ID ? LOCAL_DATABASE_NAME : storedId
  const chosen =
    onDevice.find((row) => row.projectId === wanted || row.dbName === wanted) ??
    onDevice.find((row) => row.projectId === undefined) ??
    onDevice[0]
  if (chosen === undefined) {
    return { dbName: LOCAL_DATABASE_NAME, id: LOCAL_DATABASE_NAME, editable: true }
  }
  return { dbName: chosen.dbName, id: chosen.projectId ?? chosen.dbName, editable: chosen.editable }
}
