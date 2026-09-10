/**
 * Reading and writing user preferences in `localStorage`, guarded.
 *
 * There is one subtlety here and it is the reason this module exists rather than each
 * preference hand-rolling its own pair of functions: the storage *supplier* must be invoked
 * **inside** the `try`. On an origin that refuses storage entirely — Safari in private
 * browsing, a page under a restrictive `Permissions-Policy` — the throwing site is the
 * `localStorage` property access itself, not `getItem`. Accepting a `Storage` object as a
 * parameter would move that access to the call site, outside any guard, where a
 * `SecurityError` aborts application startup before the guard ever runs.
 *
 * Passing a supplier also means the logic tests in Node with no browser and no real storage.
 *
 * @module
 */

/**
 * Reads a stored preference, falling back when it is absent, unrecognised or unreadable.
 *
 * "Unrecognised" is not an error worth surfacing. A value can be missing because nothing was
 * ever chosen, or junk because an older build wrote a value this one has since retired. Both
 * mean the same thing to a user: they have not chosen, so use the default.
 *
 * @param getStorage supplier for the storage object, called inside the guard
 * @param key the namespaced storage key
 * @param allowed every value this preference accepts
 * @param fallback what to return when the stored value is not one of them
 */
export function readStoredPreference<T extends string>(
  getStorage: () => Pick<Storage, 'getItem'>,
  key: string,
  allowed: ReadonlySet<string>,
  fallback: T,
): T {
  try {
    const stored = getStorage().getItem(key)
    // `stored !== null` is a type narrowing, not a behavioural guard, and a mutation probe
    // will report it as a survivor: `allowed` is a `Set<string>` and never contains `null`, so
    // dropping it changes nothing a test could observe. It is what lets `allowed.has(stored)`
    // typecheck without a cast, which is the whole reason to keep it (lesson L19).
    return stored !== null && allowed.has(stored) ? (stored as T) : fallback
  } catch {
    return fallback
  }
}

/**
 * Stores a preference. A refused write is not worth breaking the page over: the user keeps
 * the setting for this session and loses it on reload, which beats an error page.
 */
export function writeStoredPreference(
  getStorage: () => Pick<Storage, 'setItem'>,
  key: string,
  value: string,
): void {
  try {
    getStorage().setItem(key, value)
  } catch {
    // Private browsing, a full quota, or an origin refusing `localStorage` outright.
  }
}
