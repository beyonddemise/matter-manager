/**
 * Installing a design document, more than once.
 *
 * Four helpers used to write their design document with a bare `putDoc` and no `_rev`. That
 * works exactly once per database: CouchDB requires the current revision to *replace* a
 * document, so the first process created it and the second was refused with `409 conflict`.
 * Because each helper set its "already done" flag only after a successful write, the refusal
 * repeated on every call for as long as the process lived — and the operations that await it
 * (creating a project, redeeming an invitation, accepting a transfer, finding anybody by
 * address) stayed broken until somebody deleted the design document by hand.
 *
 * It survived review and a full test suite because every test starts with an empty database,
 * where the write is a *create* and needs no `_rev`. A deployment is empty once.
 *
 * @module
 */

import type { CouchClient } from './client.js'

/** A design document, as far as this module reads one. */
interface DesignDocument {
  readonly _id: string
  readonly _rev?: string
  readonly views?: Record<string, { readonly map?: string }>
}

/** The views a design document holds, keyed by view name. */
export type Views = Record<string, { readonly map: string }>

/**
 * Determines whether the stored views match the requested views exactly.
 *
 * @param stored - The views currently stored in the design document
 * @param wanted - The views that should be stored
 * @returns `true` if both sets contain the same view names with identical map functions, `false` otherwise.
 */
function unchanged(stored: DesignDocument['views'], wanted: Views): boolean {
  if (stored === undefined) return false
  const names = Object.keys(wanted)
  if (Object.keys(stored).length !== names.length) return false
  return names.every((name) => stored[name]?.map === wanted[name]?.map)
}

/**
 * Installs a CouchDB design document when its views differ from the stored document.
 *
 * @param views - The JavaScript view definitions to install
 */
export async function installDesign(
  couch: CouchClient,
  database: string,
  id: string,
  views: Views,
): Promise<void> {
  const existing = await couch.getDoc<DesignDocument>(database, id)
  if (existing !== undefined && unchanged(existing.views, views)) return

  await couch.putDoc(database, {
    _id: id,
    // The whole point. Absent on a create, and required on a replace.
    ...(existing?._rev === undefined ? {} : { _rev: existing._rev }),
    views,
    language: 'javascript',
  } as unknown as { _id: string })
}

/**
 * Coordinates one in-flight installation and shares its result among callers.
 *
 * Failed installations are cleared so later callers can retry. The stored installation can also
 * be cleared explicitly.
 *
 * @param install - Installation operation to run at most once while it is in flight
 * @returns Methods for starting or sharing the installation and clearing it
 */
export function once(install: (couch: CouchClient) => Promise<void>): {
  ensure: (couch: CouchClient) => Promise<void>
  forget: () => void
} {
  let running: Promise<void> | undefined

  return {
    ensure(couch: CouchClient): Promise<void> {
      running ??= install(couch).catch((error: unknown) => {
        running = undefined
        throw error
      })
      return running
    },
    forget(): void {
      running = undefined
    },
  }
}
