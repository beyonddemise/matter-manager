/**
 * The `@lit/localize` runtime wiring: one module, configured once at import time.
 *
 * Runtime mode rather than transform mode, because the story requires that changing language
 * does not reload the page. Transform mode compiles a separate bundle per locale and switching
 * means navigating to a different one; runtime mode ships one bundle, loads a catalogue on
 * demand and re-renders subscribed components in place.
 *
 * `configureLocalization` throws if it runs twice on a page. It is called at module scope and
 * nothing else calls it, so module caching makes that once — including under test, where the
 * suites import this module rather than configuring their own.
 *
 * @module
 */

import { configureLocalization, type LocaleModule } from '@lit/localize'
import { sourceLocale, targetLocales } from '../generated/locale-codes.js'
import type { Locale } from './locale.js'

/**
 * One loader per target locale, written out rather than built from a template string.
 *
 * A dynamic import with an interpolated path (`` import(`./locales/${locale}.js`) ``) is not
 * statically analysable, so a bundler has to guess which files it might reach. Listing them
 * means the graph is exact, an unknown locale is a visible failure rather than a 404, and
 * `i18n.browser.test.ts` can assert the keys still match the generated locale codes.
 */
const LOADERS: Readonly<Record<string, () => Promise<LocaleModule>>> = {
  de: () => import('../generated/locales/de.js'),
}

/** The loaders, exposed so the drift test can compare them against the generated codes. */
export const LOCALE_LOADERS: ReadonlySet<string> = new Set(Object.keys(LOADERS))

const { getLocale, setLocale } = configureLocalization({
  sourceLocale,
  targetLocales,
  loadLocale: async (locale) => {
    const load = LOADERS[locale]
    if (load === undefined) throw new Error(`No catalogue is bundled for the locale "${locale}".`)
    return load()
  },
})

/** The locale currently rendering. */
export { getLocale }

/**
 * Activates a locale and tells the document about it.
 *
 * Setting `documentElement.lang` is not decoration. It is what a screen reader uses to pick a
 * voice, what the browser uses for hyphenation and spell-checking, and what `:lang()` matches.
 * `index.html` ships `lang="en"`, so leaving it alone while rendering German would have the
 * page assert something false about itself.
 *
 * Re-activating the current locale is a no-op rather than a redundant catalogue load, so
 * callers may call this whenever the preference is touched without checking first.
 */
export async function activateLocale(locale: Locale): Promise<void> {
  if (getLocale() !== locale) await setLocale(locale)
  document.documentElement.lang = locale
}
