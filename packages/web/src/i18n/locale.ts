/**
 * Which language the interface speaks.
 *
 * Split from the `@lit/localize` wiring on purpose: everything here is a pure function over
 * plain values, so the part that can actually be *wrong* — subtag matching, precedence,
 * fallback — is tested in Node at the same rigour as `packages/core`, with no browser and no
 * catalogue loaded.
 *
 * @module
 */

import { readStoredPreference, writeStoredPreference } from '../preferences.js'

/** A language the interface is actually translated into. */
export type Locale = 'en' | 'de'

/** What the user chose. `auto` follows the browser. */
export type LocalePreference = 'auto' | Locale

/**
 * The locales that exist, source locale first.
 *
 * The order is load-bearing in one direction only: `SUPPORTED_LOCALES[0]` must be the locale
 * that needs no catalogue, because it is what negotiation falls back to.
 */
export const SUPPORTED_LOCALES = ['en', 'de'] as const satisfies readonly Locale[]

/** The locale the source is written in, and therefore the one that always renders. */
export const SOURCE_LOCALE: Locale = SUPPORTED_LOCALES[0]

/**
 * How each language names itself.
 *
 * Deliberately **not** wrapped in `msg()`, and deliberately not `Intl.DisplayNames`. Both
 * would render the list in the language currently active, so a user who has landed in a
 * language they cannot read would find their own language named in a language they cannot
 * read. A picker names each option in its own language; that is the whole point of an
 * endonym, and translating one would be an error rather than a localisation.
 *
 * It lives here, as data, rather than as literal text in a template, which is also why
 * `scripts/check-i18n.mjs` never sees it.
 */
export const LOCALE_NAMES = {
  en: 'English',
  de: 'Deutsch',
} as const satisfies Record<Locale, string>

/** Where the preference is stored. Namespaced, because the origin may host other things. */
export const LOCALE_STORAGE_KEY = 'matter-manager.locale'

const PREFERENCES: ReadonlySet<string> = new Set<LocalePreference>(['auto', ...SUPPORTED_LOCALES])

const SUPPORTED: ReadonlySet<string> = new Set<string>(SUPPORTED_LOCALES)

/**
 * The primary language subtag of a BCP 47 tag, lowercased.
 *
 * `de-DE`, `de-AT` and `de-DE-1996` all reduce to `de`. Matching on the whole tag instead
 * would give a German-speaking Austrian an English interface, which is the exact failure the
 * subtag structure exists to prevent.
 */
function primarySubtag(languageTag: string): string {
  return languageTag.trim().split('-')[0]?.toLowerCase() ?? ''
}

/**
 * Decides the locale to render in.
 *
 * `browserLanguages` is passed in rather than read from `navigator`, so this is a pure
 * function over strings.
 *
 * With no explicit preference the browser's own order decides: the first entry whose language
 * we support wins. That is the browser's stated preference order, so `['fr-FR', 'de']` is
 * German — the user prefers French, cannot have it, and asked for German next.
 *
 * @param preference the stored preference, or `auto`
 * @param browserLanguages `navigator.languages`, most preferred first
 * @returns a locale from {@link SUPPORTED_LOCALES}, always
 */
export function negotiateLocale(
  preference: LocalePreference,
  browserLanguages: readonly string[],
): Locale {
  if (preference !== 'auto') return preference

  for (const tag of browserLanguages) {
    const language = primarySubtag(tag)
    if (SUPPORTED.has(language)) return language as Locale
  }
  return SOURCE_LOCALE
}

/** Reads the stored preference, falling back to following the browser. */
export function readLocalePreference(getStorage: () => Pick<Storage, 'getItem'>): LocalePreference {
  return readStoredPreference(getStorage, LOCALE_STORAGE_KEY, PREFERENCES, 'auto')
}

/** Stores the preference. */
export function writeLocalePreference(
  getStorage: () => Pick<Storage, 'setItem'>,
  preference: LocalePreference,
): void {
  writeStoredPreference(getStorage, LOCALE_STORAGE_KEY, preference)
}

/** Whether an arbitrary value — a DOM property, a stored string — is a preference we accept. */
export function isLocalePreference(value: unknown): value is LocalePreference {
  return typeof value === 'string' && PREFERENCES.has(value)
}
