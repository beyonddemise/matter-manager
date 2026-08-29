/**
 * Application entry point.
 *
 * Theme CSS and Web Awesome components are imported here rather than linked from
 * `index.html`, because a `<link href="/node_modules/…">` resolves against the Vite root
 * and fails silently — a missing stylesheet is not a console error, and the page renders
 * unstyled while reporting success.
 *
 * @module
 */
import '@awesome.me/webawesome-pro/dist/styles/webawesome.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/glossy.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/anodized.css'
// The theme's own webfont @import is stripped at build time; this replaces it with files
// served from this origin, so the interface has its typography offline (#106).
import './fonts/fonts.css'
import '@awesome.me/webawesome-pro/dist/components/badge/badge.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/combobox/combobox.js'
import '@awesome.me/webawesome-pro/dist/components/copy-button/copy-button.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import '@awesome.me/webawesome-pro/dist/components/radio/radio.js'
import '@awesome.me/webawesome-pro/dist/components/qr-code/qr-code.js'
import '@awesome.me/webawesome-pro/dist/components/radio-group/radio-group.js'
import '@awesome.me/webawesome-pro/dist/components/select/select.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import '@awesome.me/webawesome-pro/dist/components/textarea/textarea.js'
import './styles/app.css'
import { useBundledIcons } from './icons/library.js'

// Before `app-shell.js`, and before anything else that renders. Registering the library
// replaces Web Awesome's own `default` library, and an icon that renders first would already
// have asked the CDN for its SVG (#106).
useBundledIcons()

import './app-shell.js'
import { negotiateLocale, readLocalePreference } from './i18n/locale.js'
import { activateLocale } from './i18n/localization.js'
import { registerServiceWorker } from './register-sw.js'
import { applyScheme, readPreference, resolveScheme } from './scheme.js'
import { requestPersistence } from './storage.js'
import { checkForUpdate, watchForUpdate } from './updates.js'

// Applied from this deferred module, after the CSS and component imports above and after
// `index.html` has already hard-coded `wa-light` on the root element. A page loading dark
// can flash light first. Avoiding that would need the scheme decided inline in `index.html`,
// before any class is set and before this module runs.
const media = window.matchMedia('(prefers-color-scheme: dark)')
const apply = () =>
  applyScheme(
    document.documentElement,
    resolveScheme(
      readPreference(() => localStorage),
      media.matches,
    ),
  )

apply()
media.addEventListener('change', apply)

// Asynchronous, and `<app-shell>` is already in the document, so a German user sees English
// for the moment it takes to fetch the catalogue chunk. That is the same trade the scheme
// makes above, for the same reason: the alternative is holding the entire interface back on a
// network request, which is worse on the slow connection where it would actually be noticed.
//
// A failed catalogue load leaves the source locale rendering, which is a degraded page rather
// than a blank one - so it is logged and not rethrown.
activateLocale(
  negotiateLocale(
    readLocalePreference(() => localStorage),
    navigator.languages,
  ),
).catch((error: unknown) => {
  console.error('The translation catalogue could not be loaded; continuing in English.', error)
})

// Asks the browser to keep this data, once (#112). Everything here is local first (ADR 0002),
// and storage that has not been marked persistent is evictable under pressure, across origins,
// without the user being told.
//
// Not awaited, and nothing on screen waits for it. On Firefox this raises a permission prompt
// that does not settle until the user answers; on Chromium and Safari it is decided silently
// from how the user has engaged with the site. Neither outcome changes what the application
// does next, and a refusal is an ordinary state rather than a failure - most users on most
// browsers will be in it.
void requestPersistence(
  () => navigator.storage,
  () => localStorage,
)

// Last, and not awaited. The worker is what makes the application open with no connectivity on
// the *next* visit; it does nothing for this one, so holding anything back on it would trade a
// visible delay for an invisible benefit. `registerServiceWorker` reports no failure for the
// same reason - see there.
void registerServiceWorker().then((registration) => {
  if (registration === undefined) return

  // Read *before* anything is awaited on the registration. `controller` is what distinguishes
  // an update from a first install, and a first install sets it partway through this flow — so
  // reading it later would classify a brand-new visitor's install as an update, and greet them
  // with "a new version is ready" on their first ever visit.
  const controlled = navigator.serviceWorker.controller !== null

  watchForUpdate(registration, controlled, (waiting) => {
    // The shell announces the update; it does not go looking for one. Two concerns, two sets
    // of tests, and the noticing keeps working if the component is ever replaced.
    const shell = document.querySelector('app-shell') as { updateReady?: ServiceWorker } | null
    if (shell !== null) shell.updateReady = waiting
  })

  // Someone returning to an application they left open for days is exactly the person pinned
  // to an old build without knowing it. The browser checks on navigation, and an installed PWA
  // can go a long time without one.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate(registration)
  })
})
