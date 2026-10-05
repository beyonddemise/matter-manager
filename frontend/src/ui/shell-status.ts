/**
 * The shell's status bar: whether the browser has a network, and where the open project's
 * changes stand. Rendered in the page footer by `<app-shell>`, which owns the state and follows
 * locale changes, so every `msg()` here follows the language with it.
 *
 * **Status, not controls.** Each item is a `<wa-tag>`: a label, never focusable, with no hover
 * or pressed state, because there is nothing to do with it.
 *
 * **Announced once, by one live region.** The tags themselves are not live regions: a sync that
 * flips between pending and synced every few seconds would talk over everything else. The shell
 * keeps one persistent `role="status"` element beside them and writes into it only what is worth
 * interrupting for — the network coming or going, a refusal starting or ending
 * ({@link announcementFor}).
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
 * Where a project's changes stand, in the words the status bar and the projects page share.
 *
 * - `local`: the project lives only on this device; there is nothing to sync.
 * - `pending`: a synchronized copy whose replication is not caught up — transferring, waiting
 *   for a connection, stopped, or not yet reported.
 * - `synced`: a synchronized copy that is caught up (`idle`).
 * - `paused`: a synchronized copy with nobody signed in, so nothing replicates.
 * - `denied`: the server refuses this copy's writes.
 */
export type SyncStatus = 'local' | 'pending' | 'synced' | 'paused' | 'denied'

/** The open project's status, and the name it is announced with. */
export interface CurrentSync {
  readonly status: SyncStatus
  /** The project's name; empty for one not yet named. */
  readonly name: string
}

/**
 * The status of one row.
 *
 * Only `idle` is "synced": a summary that said synced while a copy was still transferring or
 * waiting would be reassuring and wrong. A copy with no reported state yet is pending, for the
 * same reason — unless nobody is signed in, when nothing will replicate until somebody is.
 *
 * @param signedIn whether there is a session; without one a synchronized copy is paused
 */
export function syncStatusOf(
  row: Pick<Row, 'location' | 'syncState'>,
  signedIn: boolean,
): SyncStatus {
  if (row.location === 'local') return 'local'
  if (row.syncState === 'denied') return 'denied'
  if (!signedIn) return 'paused'
  return row.syncState === 'idle' ? 'synced' : 'pending'
}

/** The tag variant, icon and words for each sync status. */
const SYNC_LOOK: Readonly<
  Record<SyncStatus, { variant: string; icon: string; text: () => string }>
> = {
  local: { variant: 'neutral', icon: 'laptop', text: () => msg('Local') },
  pending: { variant: 'warning', icon: 'arrows-rotate', text: () => msg('Sync pending') },
  synced: { variant: 'success', icon: 'circle-check', text: () => msg('Synced') },
  paused: { variant: 'neutral', icon: 'circle-pause', text: () => msg('Sync paused – signed out') },
  denied: {
    variant: 'danger',
    icon: 'triangle-exclamation',
    text: () => msg('No permission to sync'),
  },
}

/** The words for a sync status, shared by the status bar and the projects page's rows. */
export function syncStatusText(status: SyncStatus): string {
  return SYNC_LOOK[status].text()
}

/** The tag variant for a sync status, shared by the status bar and the projects page's rows. */
export function syncStatusVariant(status: SyncStatus): string {
  return SYNC_LOOK[status].variant
}

/** The words for the network state. */
function networkText(online: boolean): string {
  return online ? msg('Online') : msg('Offline')
}

/**
 * Whether the browser has a network.
 *
 * One template whatever the state, so the element is kept and its attributes change, rather
 * than one tag being replaced by another. `data-online` exists only while online and
 * `data-offline` only while offline: the offline journey (`e2e/tests/offline.spec.ts`) counts
 * `[data-offline]`.
 */
export function renderNetworkStatus(online: boolean): TemplateResult {
  return html`<wa-tag
    data-network
    ?data-online=${online}
    ?data-offline=${!online}
    variant=${online ? 'success' : 'warning'}
    appearance="filled"
    size="s"
  >
    <wa-icon name=${online ? 'wifi' : 'plug-circle-xmark'} class="app-status-icon"></wa-icon>
    ${networkText(online)}
  </wa-tag>`
}

/**
 * Where the open project's changes stand; nothing until the projects have first been read,
 * because guessing "Local" for a synchronized copy would be wrong for that moment.
 *
 * The project's name leads, visually hidden: on screen the bar sits under the project being
 * shown, but read out of context "Synced" does not say what is.
 */
export function renderSyncStatus(current: CurrentSync | undefined): TemplateResult | '' {
  if (current === undefined) return ''
  const look = SYNC_LOOK[current.status]
  return html`<wa-tag
    data-sync-status=${current.status}
    variant=${look.variant}
    appearance="filled"
    size="s"
  >
    <wa-icon name=${look.icon} class="app-status-icon"></wa-icon>
    ${current.name === '' ? '' : html`<span class="wa-visually-hidden">${current.name}: </span>`}
    ${look.text()}
  </wa-tag>`
}

/** What the status bar last showed, for deciding what is worth announcing. */
export interface StatusSnapshot {
  readonly online: boolean
  readonly sync: CurrentSync | undefined
}

/**
 * What the live region should say when the status bar changes from `before` to `after`, or
 * `undefined` for a change not worth interrupting for.
 *
 * Only two kinds of change are: the network coming or going, and a refusal starting or ending.
 * Pending and synced trade places every few seconds while anything is being written, and a
 * screen reader that said so each time would be unusable.
 */
export function announcementFor(
  before: StatusSnapshot | undefined,
  after: StatusSnapshot,
): string | undefined {
  if (before === undefined) return undefined
  const parts: string[] = []
  if (before.online !== after.online) parts.push(networkText(after.online))
  const wasDenied = before.sync?.status === 'denied'
  const isDenied = after.sync?.status === 'denied'
  if (wasDenied !== isDenied && after.sync !== undefined) {
    const words = syncStatusText(after.sync.status)
    parts.push(after.sync.name === '' ? words : `${after.sync.name}: ${words}`)
  }
  return parts.length === 0 ? undefined : parts.join('. ')
}
