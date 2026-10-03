/**
 * What the projects page says: every reason, location and limit as a sentence, in one place.
 *
 * Pure `msg()` helpers with no DOM, so the wording is tested once, in both languages, and the
 * view only places the sentences. Reasons are the model's and the API's (`projects-model.ts`,
 * `projects.ts`); neither writes English, because the interface is sometimes German (#75).
 *
 * @module
 */

import { msg, str } from '@lit/localize'
import type { ActionRefusal } from '../project-actions.js'
import type { UpdateFailure } from '../projects.js'
import type { CreateRefusal, Location, Refusal, RowActions } from '../projects-model.js'

/** Every reason the page may have to say why something is not possible. */
export type Reason = Refusal | CreateRefusal | UpdateFailure | ActionRefusal

/**
 * The sentence for a reason. The one place reasons become words.
 *
 * Kept short: these sit beside a disabled control or under a field, and what the reader needs
 * there is the next step, not the cause. Several reasons share a sentence where the next step
 * is the same — a plan that has no synchronized projects is the same news whether the page
 * predicted it (`plan`) or the server said so (`plan-no-sync`).
 */
export function reasonText(reason: Reason): string {
  switch (reason) {
    case 'not-applicable':
      return ''
    case 'signed-out':
    case 'not-signed-in':
      return msg('Sign in to sync')
    case 'offline':
      return msg('Needs a connection')
    case 'stale':
    case 'offline-server':
      return msg('Waiting for the project list')
    case 'plan':
    case 'plan-no-sync':
    case 'not-entitled':
      return msg('Your plan does not include synchronized projects')
    case 'limit':
    case 'project-limit-reached':
      return msg('Your plan has no room for another project')
    case 'role':
    case 'not-a-manager':
      return msg('Only the owner or a manager can change this')
    case 'read-only':
      return msg('Read-only')
    case 'unreachable':
      return msg('The server could not be reached')
    case 'refused':
      return msg('The server did not accept this')
    case 'failed':
      return msg('Something went wrong on the server')
    case 'not-found':
      return msg('This project is no longer on the server')
    case 'unpushed':
      return msg('Not everything could be uploaded, so the local copy was kept. Please try again.')
    case 'name-mismatch':
      return msg('Type the project name exactly to delete it')
  }
}

/** The actions the menu offers: every row action except opening and renaming, in menu order. */
export type MenuAction = Exclude<keyof RowActions, 'open' | 'rename'>

/** What each menu action is called. */
export function actionText(action: MenuAction): string {
  switch (action) {
    case 'promote':
      return msg('Synchronize')
    case 'download':
      return msg('Download')
    case 'removeLocal':
      return msg('Remove local copy')
    case 'deleteLocal':
      return msg('Delete from this device')
    case 'removeServer':
      return msg('Remove from server')
  }
}

/**
 * Why a row cannot be opened. Offline gets its own words: the project is not on this device,
 * so "needs a connection" would read as a delay, when the truth is that there is nothing here.
 */
export function openRefusalText(reason: Refusal): string {
  return reason === 'offline' ? msg('Not available offline') : reasonText(reason)
}

/** What each location is called on the page. */
export function locationText(location: Location): string {
  switch (location) {
    case 'local':
      return msg('On this device')
    case 'server':
      return msg('On the server')
    case 'synced':
      return msg('Synchronized')
  }
}

/**
 * The over-limit sentence. Worded as two counts rather than "allows N projects", which would
 * read "allows 1 projects" for a plan of one, and `@lit/localize` has no plural forms.
 */
export function overLimitText(limit: number, owned: number): string {
  return msg(
    str`Projects your plan allows: ${limit}. Projects you own: ${owned}. Everything stays usable, but no new project can be created.`,
  )
}
