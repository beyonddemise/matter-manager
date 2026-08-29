/**
 * Asking the browser to keep this data, and reporting whether it agreed.
 *
 * Everything this application holds is local first (ADR 0002). Local storage that has not been
 * marked persistent is **best-effort**: the browser may evict it under pressure, least-recently
 * used across origins, and it does not tell the user. For a catalogue whose promise is that a
 * device recorded is a device kept, that is the difference between best-effort and kept (#112).
 *
 * From MDN: persistent data "is only evicted, or deleted, if the user chooses to", and the
 * eviction mechanism "skips over origins that have been granted data persistence".
 *
 * **The grant behaviour differs per engine, and one of them asks.** Firefox shows a permission
 * prompt; Chromium and Safari decide silently from how the user has engaged with the site. So
 * for most users this is not a prompt at all, and for the rest it is exactly one.
 *
 * The storage object arrives as a **supplier**, invoked inside the guard, for the reason
 * `preferences.ts` sets out at length: on an origin that refuses storage the throwing site is
 * the property access itself, not the call, so accepting the object as a parameter would move
 * the throw to the call site where no guard is watching. It also makes refusal testable, which
 * matters more here than anywhere — a real browser cannot be made to say no, and "no" is the
 * answer most users on most engines will get.
 *
 * @module
 */

import { readStoredPreference, writeStoredPreference } from './preferences.js'

/**
 * What the browser has said about this origin's data.
 *
 * Three states rather than two. `unknown` is what an engine with no Storage API gives, and
 * calling that `best-effort` would report a fact the browser never stated — the interface would
 * be telling the user their data is at risk on the strength of a question nobody answered.
 */
export type StoragePersistence =
  /** Granted. Evicted only if the user chooses to delete it. */
  | 'persisted'
  /** Not granted. Evictable under storage pressure, without warning. */
  | 'best-effort'
  /** The browser does not implement the Storage API, or refused to answer. */
  | 'unknown'

/** What the interface can say about where this data lives. */
export interface StorageReport {
  readonly persistence: StoragePersistence
  /** Bytes in use, when the browser will say. Deliberately absent rather than zero. */
  readonly usage?: number
  /** Bytes available, when the browser will say. */
  readonly quota?: number
}

/** The part of `StorageManager` this module uses, so a test can supply its own. */
export type StorageManagerLike = Pick<StorageManager, 'persist' | 'persisted' | 'estimate'>

/** Records that the question has been put, so it is put exactly once. */
export const STORAGE_ASKED_KEY = 'mm.storage.persistence-requested'

const ASKED = new Set(['yes'])

/**
 * Reads the storage manager, or `undefined` where there is not one to read.
 *
 * The property access is the throwing site on an origin that refuses storage, which is why it
 * happens here rather than at a call site.
 */
function storageManager(
  getStorage: () => StorageManagerLike | undefined,
): StorageManagerLike | undefined {
  try {
    return getStorage()
  } catch {
    // Safari in private browsing, or a restrictive Permissions-Policy.
    return undefined
  }
}

/**
 * What the browser will say about this origin's data, asking nothing of the user.
 *
 * `persisted()` and `estimate()` are read-only and prompt nothing, which is what makes this
 * safe to call from a settings screen. A status display that could raise a permission dialogue
 * would be a surprise in the one place somebody went to avoid surprises.
 */
export async function readStorageReport(
  getStorage: () => StorageManagerLike | undefined,
): Promise<StorageReport> {
  const storage = storageManager(getStorage)
  if (storage === undefined) return { persistence: 'unknown' }

  try {
    const persistence: StoragePersistence = (await storage.persisted())
      ? 'persisted'
      : 'best-effort'
    const { usage, quota } = await storage.estimate()
    // Spread conditionally: `exactOptionalPropertyTypes` keeps "the browser did not say" and
    // "the browser said zero" apart, and they are different facts.
    return {
      persistence,
      ...(usage === undefined ? {} : { usage }),
      ...(quota === undefined ? {} : { quota }),
    }
  } catch {
    return { persistence: 'unknown' }
  }
}

/**
 * Asks the browser to keep this data, once, and reports what it said.
 *
 * Called at first launch. The issue set out four moments and the maintainer chose this one; the
 * objection to it is real and worth keeping in view — on Firefox the prompt arrives before the
 * user has anything at stake. What decides it the other way is that every later moment protects
 * data that has *already* been written to evictable storage.
 *
 * **Already-granted is checked first**, so an origin the browser has persisted never asks.
 *
 * **The flag is written before the answer arrives.** `persist()` on Firefox does not settle
 * until the user responds, so a flag written afterwards means somebody who ignores the prompt
 * and reloads is asked again, and again. It therefore records that the question was *put*, not
 * that it was answered — which is L31's "a flag set after an await is a race" in the form a user
 * actually meets.
 *
 * @param getStorage supplier for `navigator.storage`, called inside the guard
 * @param getLocal supplier for `localStorage`, holding the asked-once flag
 */
export async function requestPersistence(
  getStorage: () => StorageManagerLike | undefined,
  getLocal: () => Pick<Storage, 'getItem' | 'setItem'>,
): Promise<StoragePersistence> {
  const storage = storageManager(getStorage)
  if (storage === undefined) return 'unknown'

  // Two guards rather than one around the lot, because the two failures mean different things.
  // A `persisted()` that throws leaves the standing genuinely unknown; a `persist()` that
  // throws leaves it known and unchanged.
  try {
    if (await storage.persisted()) return 'persisted'
  } catch {
    return 'unknown'
  }

  // The type argument is explicit: inferred from the fallback alone it would be `'no'`, and
  // comparing that to `'yes'` is a type error rather than a question.
  if (readStoredPreference<'yes' | 'no'>(getLocal, STORAGE_ASKED_KEY, ASKED, 'no') === 'yes') {
    return 'best-effort'
  }
  writeStoredPreference(getLocal, STORAGE_ASKED_KEY, 'yes')

  try {
    return (await storage.persist()) ? 'persisted' : 'best-effort'
  } catch {
    // Not a failure the user can do anything about, and it leaves them exactly where they
    // already were: unpersisted, which is what `best-effort` says.
    return 'best-effort'
  }
}
