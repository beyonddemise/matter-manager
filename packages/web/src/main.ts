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
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import './styles/app.css'
import './app-shell.js'
import { applyScheme, readPreference, resolveScheme } from './scheme.js'

// Applied from this deferred module, after the CSS and component imports above and after
// `index.html` has already hard-coded `wa-light` on the root element. A page loading dark
// can flash light first. Avoiding that would need the scheme decided inline in `index.html`,
// before any class is set and before this module runs.
const media = window.matchMedia('(prefers-color-scheme: dark)')
const apply = () =>
  applyScheme(document.documentElement, resolveScheme(readPreference(localStorage), media.matches))

apply()
media.addEventListener('change', apply)
