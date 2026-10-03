/**
 * The projects page's actions menu and the confirmations behind it, as templates.
 *
 * Kept apart from `projects.ts` so the page stays a page: this module only renders what a row's
 * model permissions say and calls back with what the reader chose. Running an action, and
 * deciding whether it may run, are the page's and `project-actions.ts`'s business.
 *
 * **What is confirmed, and how.** Promoting and downloading put data in a second place and lose
 * nothing, so they run at once. Every removal asks first, saying what is lost and what is kept;
 * deleting a project from this device — the one act that may destroy data that is nowhere else —
 * is confirmed by typing its name.
 *
 * @module
 */

import { msg, str } from '@lit/localize'
import { html, nothing, type TemplateResult } from 'lit'
import { isLocalOnlyDatabase } from '../../data/index.js'
import type { Row } from '../projects-model.js'
import { actionText, type MenuAction, reasonText } from './projects-text.js'

/** The menu's actions, in the order offered. */
const MENU_ACTIONS: readonly MenuAction[] = [
  'promote',
  'download',
  'removeLocal',
  'deleteLocal',
  'removeServer',
]

/** The actions that ask before they run. */
export type ConfirmedAction = Exclude<MenuAction, 'promote' | 'download'>

/** Whether an action asks before it runs. */
export function needsConfirmation(action: MenuAction): action is ConfirmedAction {
  return action === 'removeLocal' || action === 'deleteLocal' || action === 'removeServer'
}

/** A confirmation being asked: which action, on which row. */
export interface Confirmation {
  readonly action: ConfirmedAction
  readonly row: Row
}

/**
 * Whether the typed name confirms deleting `row`. The same rule `deleteLocalProject` enforces;
 * here it only decides whether the button is enabled. An unnamed project cannot be confirmed,
 * so it must be named first.
 */
export function nameConfirmed(row: Row, typed: string): boolean {
  const name = row.name.trim()
  return name !== '' && typed.trim() === name
}

/**
 * A row's actions menu: every action that applies to it, refused ones disabled with their
 * reason beside them, so the reader learns what would make them possible. Nothing at all when
 * no action applies.
 */
export function renderActionsMenu(
  row: Row,
  busy: boolean,
  choose: (action: MenuAction) => void,
): TemplateResult | typeof nothing {
  const offered = MENU_ACTIONS.filter((action) => row.actions[action].reason !== 'not-applicable')
  if (offered.length === 0) return nothing
  return html`
    <wa-dropdown
      data-actions
      @wa-select=${(event: CustomEvent<{ item: Element }>) => {
        const action = event.detail.item.getAttribute('value') as MenuAction | null
        if (action !== null) choose(action)
      }}
    >
      <wa-button slot="trigger" data-actions-trigger appearance="plain" size="s" ?disabled=${busy}>
        <wa-icon name="ellipsis-vertical" label=${msg('Project actions')}></wa-icon>
      </wa-button>
      ${offered.map((action) => {
        const { allowed, reason } = row.actions[action]
        return html`
          <wa-dropdown-item
            value=${action}
            data-action=${action}
            ?disabled=${!allowed || busy}
            variant=${action === 'promote' || action === 'download' ? 'default' : 'danger'}
          >
            ${actionText(action)}
            ${
              reason === undefined
                ? nothing
                : html`<span slot="details" class="app-empty">${reasonText(reason)}</span>`
            }
          </wa-dropdown-item>
        `
      })}
    </wa-dropdown>
  `
}

/** What the confirmation dialog needs from the page. */
export interface ConfirmDialogOptions {
  readonly busy: boolean
  /** What has been typed into the name field so far. */
  readonly typed: string
  readonly onType: (typed: string) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/** Whether a row is a local-only database whose promotion stopped half way. */
function promoting(row: Row): boolean {
  return row.projectId !== undefined && isLocalOnlyDatabase(row.dbName)
}

/** The title, the explanation and the confirm button's words for each confirmation. */
function wording({ action, row }: Confirmation): {
  title: string
  body: TemplateResult
  confirm: string
} {
  switch (action) {
    case 'removeLocal':
      return {
        title: msg('Remove the local copy?'),
        body: html`<p>${msg('The server keeps it. Changes not yet uploaded are uploaded first.')}</p>`,
        confirm: actionText(action),
      }
    case 'removeServer':
      return {
        title: msg('Remove from the server?'),
        body: html`<p>${msg('Collaborators lose access. Deleted permanently after 90 days.')}</p>`,
        confirm: actionText(action),
      }
    case 'deleteLocal':
      return {
        title: msg('Delete from this device?'),
        body: html`
          <p>${msg(str`“${row.name}” and everything in it is deleted from this device. This cannot be undone.`)}</p>
          ${
            // An orphan or an archived project's copy: the server takes nothing more, so what
            // never left this device goes now.
            row.actions.deleteLocal.warn === 'unpushed-may-be-lost'
              ? html`<wa-callout variant="warning" data-warn>
                  <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
                  ${
                    row.archived
                      ? msg(
                          'This project was removed from the server. Changes not yet uploaded will be lost.',
                        )
                      : msg(
                          'This project is no longer on the server. Changes not yet uploaded will be lost.',
                        )
                  }
                </wa-callout>`
              : nothing
          }
          ${
            // A promotion that stopped half way already made the server project. Deleting this
            // database does not touch it; the page then lists it, where it can be removed.
            promoting(row)
              ? html`<p data-server-stays>
                  ${msg('The project already created on the server for it stays there. You can remove it from the server afterwards.')}
                </p>`
              : nothing
          }
        `,
        confirm: msg('Delete'),
      }
  }
}

/**
 * The one confirmation dialog, open while a confirmation is asked. Its confirm button stays
 * disabled while an action runs and, for a delete, until the exact name is typed.
 */
export function renderConfirmDialog(
  confirmation: Confirmation | undefined,
  options: ConfirmDialogOptions,
): TemplateResult {
  const words = confirmation === undefined ? undefined : wording(confirmation)
  const typedName = confirmation?.action === 'deleteLocal'
  const ready =
    confirmation !== undefined &&
    !options.busy &&
    (!typedName || nameConfirmed(confirmation.row, options.typed))
  return html`
    <wa-dialog
      data-confirm-dialog
      label=${words?.title ?? ''}
      ?open=${confirmation !== undefined}
      @wa-after-hide=${(event: Event) => {
        // Only the dialog's own hide: an element inside it can fire the same event.
        if (event.target === event.currentTarget) options.onCancel()
      }}
    >
      ${
        words === undefined
          ? nothing
          : html`<div class="wa-stack wa-gap-m">
              ${words.body}
              ${
                typedName
                  ? html`<wa-input
                      data-field="confirm-name"
                      label=${msg('Type the project name to confirm')}
                      .value=${options.typed}
                      @input=${(event: Event) =>
                        options.onType(
                          String((event.currentTarget as { value?: unknown }).value ?? ''),
                        )}
                    ></wa-input>`
                  : nothing
              }
            </div>`
      }
      <wa-button slot="footer" data-cancel-confirm ?disabled=${options.busy} @click=${options.onCancel}>
        ${msg('Cancel')}
      </wa-button>
      <wa-button
        slot="footer"
        data-confirm
        variant="danger"
        ?disabled=${!ready}
        @click=${options.onConfirm}
      >
        ${words?.confirm ?? ''}
      </wa-button>
    </wa-dialog>
  `
}
