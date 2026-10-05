/**
 * The shell's status bar: whether the browser has a network, and where the open project's
 * changes stand. Rendered in the page footer by `<app-shell>`, which owns the state and follows
 * locale changes, so every `msg()` here follows the language with it.
 *
 * **Status, not controls.** Each item is a `<wa-tag>`: a label, never focusable, with no hover
 * or pressed state, because there is nothing to do with it. Each carries `role="status"`, so a
 * change (the connection dropping, a sync completing) is announced without moving focus.
 *
 * **Colour and icon both carry the state**, never colour alone: the word is always there, and
 * the icon differs for every value.
 *
 * @module
 */

import { msg } from '@lit/localize'
import { html, type TemplateResult } from 'lit'
import type { Row } from './projects-model.js'

/**
 * Where the open project's changes stand, as the status bar says it.
 *
 * - `local`: the project lives only on this device; there is nothing to sync.
 * - `pending`: a synchronized copy whose replication is not caught up — transferring, waiting
 *   for a connection, stopped, or not running at all (signed out).
 * - `synced`: a synchronized copy that is caught up (`idle`).
 * - `denied`: the server refuses this copy's writes.
 */
export type SyncStatus = 'local' | 'pending' | 'synced' | 'denied'

/**
 * The status of one row, as the status bar reports it for the open project.
 *
 * Only `idle` is "synced": a summary that said synced while a copy was still transferring or
 * waiting would be reassuring and wrong. A copy with no reported state yet is pending, for the
 * same reason.
 */
export function syncStatusOf(row: Pick<Row, 'location' | 'syncState'>): SyncStatus {
  if (row.location === 'local') return 'local'
  switch (row.syncState) {
    case 'idle':
      return 'synced'
    case 'denied':
      return 'denied'
    default:
      return 'pending'
  }
}

/**
 * Whether the browser has a network.
 *
 * `data-online` exists only while online and `data-offline` only while offline: the offline
 * journey (`e2e/tests/offline.spec.ts`) counts `[data-offline]`.
 */
export function renderNetworkStatus(online: boolean): TemplateResult {
  return online
    ? html`<wa-tag
        data-online
        class="app-status"
        role="status"
        aria-live="polite"
        variant="success"
        appearance="filled"
        size="s"
      >
        <wa-icon name="wifi" class="app-status-icon"></wa-icon>
        ${msg('Online')}
      </wa-tag>`
    : html`<wa-tag
        data-offline
        class="app-status"
        role="status"
        aria-live="polite"
        variant="warning"
        appearance="filled"
        size="s"
      >
        <wa-icon name="plug-circle-xmark" class="app-status-icon"></wa-icon>
        ${msg('Offline')}
      </wa-tag>`
}

/** The variant, icon and words for each sync status. */
const SYNC_LOOK: Readonly<
  Record<SyncStatus, { variant: string; icon: string; text: () => string }>
> = {
  local: { variant: 'brand', icon: 'laptop', text: () => msg('Local') },
  pending: { variant: 'neutral', icon: 'arrows-rotate', text: () => msg('Sync pending') },
  synced: { variant: 'success', icon: 'circle-check', text: () => msg('Synced') },
  denied: {
    variant: 'warning',
    icon: 'triangle-exclamation',
    text: () => msg('No permission to sync'),
  },
}

/**
 * Where the open project's changes stand; nothing until the projects have first been read,
 * because guessing "Local" for a synchronized copy would be wrong for that moment.
 */
export function renderSyncStatus(status: SyncStatus | undefined): TemplateResult | '' {
  if (status === undefined) return ''
  const look = SYNC_LOOK[status]
  return html`<wa-tag
    data-sync-status=${status}
    class="app-status"
    role="status"
    aria-live="polite"
    variant=${look.variant}
    appearance="filled"
    size="s"
  >
    <wa-icon name=${look.icon} class="app-status-icon"></wa-icon>
    ${look.text()}
  </wa-tag>`
}
