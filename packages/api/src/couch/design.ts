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

/** Whether what is stored already says exactly what we are about to write. */
function unchanged(stored: DesignDocument['views'], wanted: Views): boolean {
  if (stored === undefined) return false
  const names = Object.keys(wanted)
  if (Object.keys(stored).length !== names.length) return false
  return names.every((name) => stored[name]?.map === wanted[name]?.map)
}

/**
 * Writes a design document, creating it or replacing it as required.
 *
 * **Skips the write when the stored map functions already match.** Not an optimisation: a design
 * document that is written back identically still gets a new `_rev` and still replicates, and
 * on a deployment with several nodes that is a stream of no-op updates every time anything
 * restarts. Writing only on a real change is also what makes "rewritten on every fresh process"
 * safe to say — the rewrite is how a changed map function reaches a deployment, and an
 * unchanged one has nothing to reach it with.
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
 * Runs an installation once per process, and shares it with whoever asks while it is in flight.
 *
 * A boolean set *after* the write does not do this: two callers that arrive together both see
 * `false`, both write, and the second is refused with the conflict this module exists to avoid.
 * `findUser` awaits one of these on the path of every invitation, so that race is reachable
 * from two people sharing a project at the same moment.
 *
 * **A failure is forgotten**, so a transient CouchDB error is retried by the next caller rather
 * than remembered as a permanent one — the behaviour the boolean had, kept deliberately.
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
