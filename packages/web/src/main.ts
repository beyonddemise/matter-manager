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
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/combobox/combobox.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import '@awesome.me/webawesome-pro/dist/components/radio/radio.js'
import '@awesome.me/webawesome-pro/dist/components/radio-group/radio-group.js'
import './styles/app.css'
import './app-shell.js'
import { negotiateLocale, readLocalePreference } from './i18n/locale.js'
import { activateLocale } from './i18n/localization.js'
import { applyScheme, readPreference, resolveScheme } from './scheme.js'

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
