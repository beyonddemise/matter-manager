/**
 * The shell's account controls, as template functions: the account (email or Sign in), Upgrade,
 * and Sign out with its confirmation. The network and sync status are in the footer's status
 * bar (`shell-status.ts`).
 *
 * Plain functions over plain values, rendered inside `<app-shell>`, which owns the state and
 * subscribes to locale changes — so every `msg()` here follows the language with it.
 *
 * @module
 */

import { msg } from '@lit/localize'
import { html, type TemplateResult } from 'lit'
import { showsUpgrade } from '../domain/plan.js'
import type { SessionState } from './session.js'
import {
  renderPlanComparison,
  renderWaitlist,
  type WaitlistHandlers,
  type WaitlistState,
} from './upgrade-dialog.js'

/**
 * The account, top right: the signed-in email, or the way to sign in, or nothing at all until
 * the first answer arrives — offering "Sign in" to somebody who *is* signed in, for the moment
 * it takes to find out, is worse than offering nothing for that moment.
 *
 * `expired` gets the same control as `signed-out` and a different word. The remedy is identical
 * - sign in again - but "your session ended" and "you are not signed in" are different facts, and
 * the first one reassures somebody whose data is still on the device that nothing has been lost.
 *
 * Signing out is not here but in the navigation ({@link renderSignOut}): it is rarely wanted,
 * and the header is for what is true now.
 */
export function renderAccount(
  session: SessionState | undefined,
  email: string | undefined,
  onSignIn: () => void,
): TemplateResult | '' {
  if (session === undefined) return ''
  if (session === 'signed-in') {
    // Desktop only: at phone width the header has room for the menu, the name and two controls,
    // and the account's email is the one thing there that is context rather than a control.
    return email === undefined
      ? ''
      : html`<span data-user-email class="app-email wa-desktop-only">${email}</span>`
  }
  return html`
    <wa-button data-sign-in appearance="plain" @click=${onSignIn}>
      ${
        // At phone width the short form: the header has no room for the sentence, and the
        // session-ended notice above the page already says it.
        session === 'expired'
          ? html`<span class="wa-desktop-only">${msg('Session ended - sign in again')}</span>
              <span class="wa-mobile-only">${msg('Sign in')}</span>`
          : msg('Sign in')
      }
    </wa-button>
  `
}

/**
 * The way to a bigger plan, while there is one (`showsUpgrade`, never a tier literal: ADR 0009),
 * or while a request is pending: an account raised to the top plan after asking for it has
 * nothing left to upgrade to, but still needs the dialog to leave the waitlist.
 * The dialog compares the plans and offers the free waitlist (#224).
 *
 * @param state the plan, the session, the connection, the cached request and the change in flight
 * @param handlers join, leave and sign in; closing is `onClose`
 */
export function renderUpgrade(
  state: WaitlistState,
  open: boolean,
  onOpen: () => void,
  onClose: () => void,
  handlers: WaitlistHandlers,
): TemplateResult | '' {
  if (!offersUpgrade(state)) return ''
  return html`
    <!-- The rocket is desktop only: at phone width it is what keeps the header on one line at
         360px, and the word says more than the icon. -->
    <wa-button data-upgrade size="s" variant="brand" appearance="outlined" @click=${onOpen}>
      <wa-icon slot="start" name="rocket" class="wa-desktop-only"></wa-icon>
      ${msg('Upgrade')}
    </wa-button>
    ${
      open
        ? html`<wa-dialog
            data-upgrade-dialog
            open
            label=${msg('Upgrade')}
            @wa-after-hide=${(event: Event) => {
              // Only the dialog's own hide: an element inside it can fire the same event.
              if (event.target === event.currentTarget) onClose()
            }}
          >
            <div class="wa-stack wa-gap-m">
              ${renderPlanComparison(state.plan)}
              <p data-waitlist-statement>
                ${msg('Under heavy development. Join the waitlist for free.')}
              </p>
              ${renderWaitlist(state, handlers)}
            </div>
            <wa-button slot="footer" data-close-upgrade @click=${onClose}>${msg('Close')}</wa-button>
          </wa-dialog>`
        : ''
    }
  `
}

/**
 * Whether the header offers Upgrade: a bigger plan exists, or a request is pending (ruling R3).
 * Exported so the shell can close a dialog whose button has just gone.
 */
export function offersUpgrade(state: Pick<WaitlistState, 'plan' | 'request'>): boolean {
  return showsUpgrade(state.plan) || state.request !== undefined
}

/**
 * Signing out, as the navigation's last item while there is a session. It still asks first:
 * see {@link renderSignOutConfirmation}.
 */
export function renderSignOut(
  session: SessionState | undefined,
  onAsk: () => void,
): TemplateResult | '' {
  if (session !== 'signed-in') return ''
  return html`
    <wa-button
      data-sign-out
      data-drawer="close"
      appearance="plain"
      class="app-nav-action"
      @click=${onAsk}
    >
      <wa-icon slot="start" name="right-from-bracket"></wa-icon>
      ${msg('Sign out')}
    </wa-button>
  `
}

/**
 * Where the sign-out confirmation is.
 *
 * - `ask`: the first question, with the box for the local-only projects. `pushing` while the
 *   synchronized copies are being pushed after it was confirmed.
 * - `unpushed`: some copies may hold changes the server lacks (rulings C-R10, C-R16) — a push
 *   failed, or they cannot be pushed at all — or the index could not be read to tell. Signing
 *   out may then destroy changes that exist nowhere else, so it takes a second, explicit confirm.
 */
export type SignOutStep =
  | { readonly step: 'ask'; readonly pushing: boolean }
  | {
      readonly step: 'unpushed'
      readonly names: readonly string[]
      /** The index could not be read, so what signing out would destroy is unknown. */
      readonly unreadable: boolean
    }

/** What the sign-out confirmation calls back with. */
export interface SignOutHandlers {
  readonly onCancel: () => void
  /** The first step's confirm; reads the box (`[data-remove-local]`) itself. */
  readonly onConfirm: () => void
  /** The second step's: sign out although the named copies were not pushed. */
  readonly onConfirmUnpushed: () => void
}

/**
 * The sign-out confirmation.
 *
 * It exists because signing out has a question in it. Everything the *account* put on this
 * browser goes either way; the projects stored only on this device predate the account or never
 * left it, so taking them would be destroying data the account never had. Unticked by default:
 * the safe answer is the one that keeps things.
 *
 * Its second step names the synchronized copies whose push did not get through: they are
 * destroyed with the rest, and what they hold that the server lacks is lost unless the reader
 * cancels and tries again online.
 */
export function renderSignOutConfirmation(
  state: SignOutStep | undefined,
  handlers: SignOutHandlers,
): TemplateResult | '' {
  if (state === undefined) return ''
  // The dialog's own hide (Escape, its X) is a cancel: without this the dialog would close while
  // the shell still believed it open, and a push still running would carry on into a sign-out.
  // Only the dialog's own: an element inside it can fire the same event.
  const onHide = (event: Event) => {
    if (event.target === event.currentTarget) handlers.onCancel()
  }
  // Outlined, so the confirm beside it is the button that stands out; focused first, because it
  // is the safe answer.
  const cancel = html`<wa-button
    slot="footer"
    data-cancel-sign-out
    appearance="outlined"
    autofocus
    @click=${handlers.onCancel}
  >
    ${msg('Cancel')}
  </wa-button>`
  if (state.step === 'unpushed') {
    return html`
      <wa-dialog data-sign-out-dialog open label=${msg('Sign out')} @wa-after-hide=${onHide}>
        <wa-callout variant="warning">
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          ${msg('These projects may have changes that are not on the server. Signing out removes them from this device.')}
        </wa-callout>
        ${
          state.names.length === 0
            ? ''
            : html`<ul data-unpushed>
                ${state.names.map((name) => html`<li>${name}</li>`)}
              </ul>`
        }
        ${
          state.unreadable
            ? html`<p data-unreadable>
                ${msg('The projects on this device could not be checked.')}
              </p>`
            : ''
        }
        ${cancel}
        <wa-button
          slot="footer"
          variant="danger"
          data-confirm-unpushed
          @click=${handlers.onConfirmUnpushed}
        >
          ${msg('Sign out anyway')}
        </wa-button>
      </wa-dialog>
    `
  }
  return html`
    <wa-dialog data-sign-out-dialog open label=${msg('Sign out')} @wa-after-hide=${onHide}>
      <p>${msg('Everything this account put on this browser will be removed.')}</p>
      <wa-checkbox data-remove-local ?disabled=${state.pushing}>
        ${msg('Also remove projects stored only on this device')}
      </wa-checkbox>
      ${cancel}
      <wa-button
        slot="footer"
        variant="brand"
        data-confirm-sign-out
        ?loading=${state.pushing}
        ?disabled=${state.pushing}
        @click=${handlers.onConfirm}
      >
        ${msg('Sign out')}
      </wa-button>
    </wa-dialog>
  `
}
