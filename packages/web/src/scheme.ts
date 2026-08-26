/**
 * The light/dark preference.
 *
 * Three states rather than two: "follow the system" is a distinct choice from "light", and
 * collapsing them means a user who has chosen light gets dark the moment their laptop does.
 *
 * Storage is passed in rather than reached for, so the logic tests without a browser and
 * without touching real `localStorage`. The guard that makes that safe lives in
 * `preferences.ts` — see there for why the supplier is called inside the `try`.
 *
 * @module
 */

import { readStoredPreference, writeStoredPreference } from './preferences.js'

/** What the user chose. */
export type SchemePreference = 'light' | 'dark' | 'system'

/** What is actually applied to the document. */
export type Scheme = 'light' | 'dark'

/** Where the preference is stored. Namespaced, because the origin may host other things. */
export const SCHEME_STORAGE_KEY = 'matter-manager.scheme'

const PREFERENCES: ReadonlySet<string> = new Set(['light', 'dark', 'system'])

/** Turns a preference plus the system setting into the scheme to apply. */
export function resolveScheme(preference: SchemePreference, systemPrefersDark: boolean): Scheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/**
 * Reads the stored preference, falling back to following the system.
 *
 * Anything unrecognised — written by an older build, or edited by hand — falls back rather
 * than being applied, because "system" is the one answer that is never wrong.
 */
export function readPreference(getStorage: () => Pick<Storage, 'getItem'>): SchemePreference {
  return readStoredPreference(getStorage, SCHEME_STORAGE_KEY, PREFERENCES, 'system')
}

/** Stores the preference. A refused write is not worth breaking the page over. */
export function writePreference(
  getStorage: () => Pick<Storage, 'setItem'>,
  preference: SchemePreference,
): void {
  writeStoredPreference(getStorage, SCHEME_STORAGE_KEY, preference)
}

/** Applies the scheme to the document element, leaving theme and palette classes untouched. */
export function applyScheme(root: Element, scheme: Scheme): void {
  root.classList.toggle('wa-dark', scheme === 'dark')
  root.classList.toggle('wa-light', scheme === 'light')
}
