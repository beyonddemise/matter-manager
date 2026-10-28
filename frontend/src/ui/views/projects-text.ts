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
import { getLocale } from '../i18n/localization.js'
import type { ActionRefusal } from '../project-actions.js'
import type { UpdateFailure } from '../projects.js'
import type { CreateRefusal, Lifecycle, Location, Refusal, RowActions } from '../projects-model.js'

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
    case 'not-the-owner':
      return msg('Only the owner can choose this')
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
    case 'escrow-unavailable':
      return msg('The server cannot accept encrypted projects yet. Please try again later.')
    case 'unpushed':
      return msg('Not everything could be uploaded, so the local copy was kept. Please try again.')
    case 'name-mismatch':
      return msg('Type the project name exactly to delete it')
  }
}

/**
 * A project created on this device whose way to the server was refused (#326): it exists, here
 * only, and `reason` says why the server did not take it. It can be synchronized later from its
 * menu, which the page shows beside it.
 */
export function keptLocalText(reason: string): string {
  return msg(str`Created on this device only. ${reason}`)
}

/**
 * Why a menu action is refused, beside it. The reason's own sentence, except where the action
 * changes what the reader can do about it: removing from the server is the owner's alone (ruling
 * C-R13), so "the owner or a manager" — right for renaming — would send a manager to try.
 */
export function menuReasonText(action: MenuAction, reason: Refusal): string {
  if (action === 'removeServer' && reason === 'role') {
    return msg('Only the owner can remove this from the server')
  }
  return reasonText(reason)
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
    case 'restore':
      return msg('Put back on the server')
    case 'export':
      return msg('Export project')
    case 'keepActive':
      return msg('Keep this one active')
    case 'makeReadOnly':
      return msg('Make read-only')
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
 * The intro under the page heading: what a project is, then what the plan includes. The
 * allowance is worded as a count rather than "includes N projects", which would read
 * "includes 1 projects" for a plan of one — `@lit/localize` has no plural forms (see
 * {@link overLimitText}).
 *
 * @param limit the limit in force: the account's own; `-1` is unlimited
 * @param syncs whether the plan puts projects on the server; a plan that does not keeps its
 *   projects on this device, and the sentence says so
 * @param legacyPlanLimit what the plan includes today, when the account keeps a higher limit from
 *   before the matrix lowered it (ADR 0020). Both numbers are then said, the account's marked as
 *   a legacy plan, so the reader is not offered more than new accounts get without knowing why.
 */
export function introText(limit: number, syncs: boolean, legacyPlanLimit?: number): string {
  const what = msg('A project holds the rooms and Matter devices of one home or site.')
  return `${what} ${legacyPlanLimit === undefined ? allowanceText(limit, syncs) : legacyText(limit, syncs, legacyPlanLimit)}`
}

/** What the plan includes, when the account holds exactly that. */
function allowanceText(limit: number, syncs: boolean): string {
  if (limit < 0) return msg('Your plan has no project limit.')
  return syncs
    ? msg(str`Projects your plan includes: ${limit}.`)
    : msg(str`Projects your plan includes: ${limit}, kept on this device.`)
}

/**
 * The plan's limit today beside the account's higher one. Only the account's can be unlimited:
 * a legacy limit is above the plan's, and nothing is above unlimited. Exported for the account
 * page, which says the same divergence beside the plan comparison (#263).
 */
export function legacyText(limit: number, syncs: boolean, planLimit: number): string {
  if (limit < 0) {
    return msg(str`Projects your plan includes: ${planLimit}. Yours: no limit (legacy plan).`)
  }
  return syncs
    ? msg(str`Projects your plan includes: ${planLimit}. Yours: ${limit} (legacy plan).`)
    : msg(
        str`Projects your plan includes: ${planLimit}. Yours: ${limit} (legacy plan), kept on this device.`,
      )
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

/**
 * A deadline the server set, as a date in the interface's language: "Oct 26, 2026",
 * "26.10.2026". A date rather than a time: the server's job runs once a day, so the hour would
 * promise a precision it does not have.
 *
 * @param seconds seconds since the epoch, as the contract writes deadlines (`graceUntil`,
 *   `deleteAfter`); `projects.ts` has already refused anything that is not whole and positive
 */
export function dateText(seconds: number): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(seconds * 1000)
}

/** The word on a row's read-only-grace tag (#211, #284); the tooltip says the rest. */
export function lifecycleTagText(state: Lifecycle['state']): string {
  return state === 'read-only' ? msg('Read-only') : msg('Archived by plan')
}

/**
 * What a row in the read-only grace says, behind its tag: why, until when, and how it comes
 * back (#211, #284). The owner is told both ways out; anyone it is shared with only that it is
 * the owner's to restore, because nothing they do changes it. Each part is a sentence of its
 * own, so a deadline the server did not name leaves the rest intact rather than "until ."
 *
 * @param owner whether the reader owns the project, whose plan the limit is
 */
export function lifecycleText(lifecycle: Lifecycle, owner: boolean): string {
  if (lifecycle.state === 'read-only') {
    const why = owner
      ? msg('Read-only: this project is over your plan’s project limit.')
      : msg('Read-only: this project is over its owner’s plan limit.')
    const until = lifecycle.until
    const when =
      until === undefined
        ? ''
        : msg(str`On ${dateText(until)} it is archived, and 90 days later deleted.`)
    const restore = owner
      ? msg(
          str`Upgrade to keep it, or make another project read-only and choose “${actionText('keepActive')}” here.`,
        )
      : msg('Only the owner can make it writable again.')
    return [why, when, restore].filter((part) => part !== '').join(' ')
  }
  const why = owner
    ? msg(
        'Archived: this project was over your plan’s project limit when its read-only period ended.',
      )
    : msg('Archived: this project was over its owner’s plan limit.')
  const at = lifecycle.deleteAfter
  const when = at === undefined ? '' : msg(str`The server deletes it on ${dateText(at)}.`)
  const restore = owner
    ? msg('Upgrading brings it back.')
    : msg('Only the owner can bring it back, by upgrading.')
  return [why, when, restore].filter((part) => part !== '').join(' ')
}

/**
 * The page-wide sentence while some of the owner's projects are read-only for the grace: the
 * counts, as {@link overLimitText} gives them, then what that means and both ways out. Replaces
 * that sentence, whose "everything stays usable" is no longer true.
 *
 * @param until the earliest grace end among the owner's read-only projects, if the server named
 *   one: a swap takes the earliest running deadline, so it is the one that matters
 */
export function graceText(limit: number, owned: number, until: number | undefined): string {
  const counts = msg(str`Projects your plan allows: ${limit}. Projects you own: ${owned}.`)
  const what =
    until === undefined
      ? msg('Those over the limit are read-only, then archived, and deleted 90 days later.')
      : msg(
          str`Those over the limit are read-only until ${dateText(until)}, then archived, and deleted 90 days later.`,
        )
  return `${counts} ${what} ${msg('Upgrade to keep them all, or choose which stay writable from each project’s menu.')}`
}

/**
 * Why keeping a project active was refused for want of a writable slot (403
 * `project-limit-reached`), and the swap that frees one: lock another project, or archive one.
 * Names the two menu items, so the reader can find them.
 */
export function swapText(): string {
  return msg(
    str`No writable project is free on your plan. Choose “${actionText('makeReadOnly')}” or “${actionText('removeServer')}” on another project first, then try again.`,
  )
}
