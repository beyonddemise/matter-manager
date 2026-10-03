/**
 * The shell's account and status controls, as template functions: the network tag, the sync
 * summary, the account (email or Sign in), Upgrade, and Sign out with its confirmation.
 *
 * Plain functions over plain values, rendered inside `<app-shell>`, which owns the state and
 * subscribes to locale changes — so every `msg()` here follows the language with it.
 *
 * @module
 */

import { msg } from '@lit/localize'
import { html, type TemplateResult } from 'lit'
import { type Plan, showsUpgrade } from '../domain/plan.js'
import type { SessionState } from './session.js'
import type { SyncState } from './sync/replication.js'

/**
 * Whether the browser has a network, said quietly either way.
 *
 * Always present since the projects page: whether a project can be created on the server,
 * promoted or removed depends on it, so the reader should not have to infer it from a refusal.
 * Neutral in both states — nothing in this application is blocked by being offline: every write
 * goes to a local database first, so offline explains a delay in sharing rather than a loss of
 * function. `data-offline` exists only while offline, which is what the offline journey asserts.
 */
export function renderNetwork(online: boolean): TemplateResult {
  return online
    ? html`<wa-tag data-online variant="neutral" size="s">
        <wa-icon slot="start" name="plug-circle-check"></wa-icon>
        ${msg('Online')}
      </wa-tag>`
    : html`<wa-tag data-offline variant="neutral" size="s">
        <wa-icon slot="start" name="plug-circle-xmark"></wa-icon>
        ${msg('Offline')}
      </wa-tag>`
}

/**
 * What replication is doing, when it is doing anything.
 *
 * Nothing at all when it is `idle`: the steady state is everything being fine, and a badge that
 * is always present says nothing when it matters. `offline` is not an error - the local database
 * is complete and usable - so it is shown as quietly as the network tag beside it.
 */
export function renderSyncing(syncing: SyncState | undefined): TemplateResult | '' {
  if (syncing === undefined || syncing === 'idle') return ''
  return html`
    <wa-tag data-syncing variant=${syncing === 'denied' ? 'warning' : 'neutral'} size="s">
      <wa-icon slot="start" name="arrows-rotate"></wa-icon>
      ${
        syncing === 'denied'
          ? msg('No permission to sync')
          : syncing === 'offline'
            ? msg('Waiting to sync')
            : msg('Syncing')
      }
    </wa-tag>
  `
}

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
    return email === undefined ? '' : html`<span data-user-email class="app-email">${email}</span>`
  }
  return html`
    <wa-button data-sign-in appearance="plain" @click=${onSignIn}>
      ${session === 'expired' ? msg('Session ended - sign in again') : msg('Sign in')}
    </wa-button>
  `
}

/**
 * The way to a bigger plan, while there is one (`showsUpgrade`, never a tier literal: ADR 0009).
 * There is nothing to buy yet, and the dialog says so plainly.
 */
export function renderUpgrade(
  plan: Plan,
  open: boolean,
  onOpen: () => void,
  onClose: () => void,
): TemplateResult | '' {
  if (!showsUpgrade(plan)) return ''
  return html`
    <wa-button data-upgrade size="s" variant="brand" appearance="outlined" @click=${onOpen}>
      <wa-icon slot="start" name="rocket"></wa-icon>
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
            <p>${msg("It's just alpha — coming soon")}</p>
            <wa-button slot="footer" data-close-upgrade @click=${onClose}>${msg('Close')}</wa-button>
          </wa-dialog>`
        : ''
    }
  `
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
 * The sign-out confirmation.
 *
 * It exists because signing out has a question in it. Everything the *account* put on this
 * browser goes either way; the catalogue on this device predates accounts and holds whatever was
 * recorded before signing in, so taking it would be destroying data the account never owned.
 * Unticked by default: the safe answer is the one that keeps things. The confirm handler reads
 * the box (`[data-remove-local]`) itself.
 */
export function renderSignOutConfirmation(
  open: boolean,
  onCancel: () => void,
  onConfirm: () => void,
): TemplateResult | '' {
  if (!open) return ''
  return html`
    <wa-dialog data-sign-out-dialog open label=${msg('Sign out')}>
      <p>${msg('Everything this account put on this browser will be removed.')}</p>
      <wa-checkbox data-remove-local>
        ${msg('Also remove the devices stored only on this device')}
      </wa-checkbox>
      <wa-button slot="footer" data-cancel-sign-out @click=${onCancel}>${msg('Cancel')}</wa-button>
      <wa-button slot="footer" variant="brand" data-confirm-sign-out @click=${onConfirm}>
        ${msg('Sign out')}
      </wa-button>
    </wa-dialog>
  `
}
