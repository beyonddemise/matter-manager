#!/usr/bin/env node
/**
 * Fails if the built site would fetch anything from a third party at runtime.
 *
 * This application is offline-first (ADR 0002). An interface whose icons and typography arrive
 * over the network is one that degrades in exactly the situation the product was built for —
 * and it degrades **silently**: everything works on the machine of whoever built it, because
 * their browser has the files cached and their network is fine.
 *
 * #106 found three fonts and eight icons being fetched on a first visit. Finding them took
 * serving `dist`, loading it in Chromium under a strict Content-Security-Policy and reading the
 * violations. Nobody is going to do that again by accident, which is why this exists: the next
 * dependency that reaches for a CDN should turn something red without a browser session.
 *
 * **What it can and cannot see.**
 *
 * CSS is checked exactly, because in CSS a URL *is* a fetch: `@import url(…)` and `url(…)` in a
 * `src`, a `background-image` or a `@font-face` are all requests the browser makes, and there is
 * no way to write one that is not. So any absolute URL in built CSS is a finding, with no
 * allowlist.
 *
 * JavaScript cannot be read that way. A bundle contains the strings of code paths it never
 * takes — `@awesome.me/webawesome-pro` ships Font Awesome's CDN template whether or not the
 * default icon library is overridden, and after #106 it is overridden at startup. Absence of the
 * string is therefore not achievable and its presence is not proof of a fetch. So JavaScript
 * gets an allowlist with a written reason per origin, in the manner of `dependency-policy.json`:
 * a new origin fails, and a known-dead one is documented rather than hidden.
 *
 * The claim "the override actually happens" is not this file's to make. It belongs to
 * `packages/web/test/icons.browser.test.ts`, which resolves every icon the application uses and
 * asserts each URL is same-origin.
 *
 * Usage:  node scripts/check-offline-assets.mjs [--scan <dist directory>]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scanIndex = process.argv.indexOf('--scan')
const dist = scanIndex === -1 ? join(root, 'packages/web/dist') : process.argv[scanIndex + 1]

if (dist === undefined) {
  console.error('--scan needs a directory.')
  process.exit(1)
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`No built site in ${dist}. Run: npm --workspace @matter-manager/web run build`)
  process.exit(1)
}

/**
 * Origins allowed to appear in built JavaScript, each with the reason it is harmless.
 *
 * An entry here is a claim that the string is present but never fetched. That claim is worth
 * making only when something else proves it — which is why each one names its proof.
 */
const ALLOWED_IN_JS = new Map([
  [
    'http://www.w3.org',
    'The XML namespace of every `<svg>` element, including the bundled icons. A namespace is ' +
      'an identifier and has never been fetched by anything.',
  ],
  [
    'https://ka-f.fontawesome.com',
    "Font Awesome's CDN in Web Awesome's default icon library, which " +
      'packages/web/src/icons/library.ts replaces before anything renders. Proved by ' +
      'icons.browser.test.ts, which resolves every icon the application uses and asserts none ' +
      'of them is cross-origin.',
  ],
  [
    'https://ka-p.fontawesome.com',
    'The kit-authenticated half of the same resolver, replaced by the same registration. No ' +
      'kit code is configured, so this branch was unreachable even before #106.',
  ],
  [
    'https://fontawesome.com',
    "Font Awesome's attribution comment, carried inside the bundled icon markup because CC " +
      'BY 4.0 asks for it. A comment in an SVG, not a request.',
  ],
  [
    'https://github.com',
    "In `uuid`'s error message about `crypto.getRandomValues`, and in the producer string " +
      '`pdf-lib` writes into a generated document. Both are text.',
  ],
  [
    'https://webawesome.com',
    'A documentation link Web Awesome writes into each component as an HTML comment node ' +
      '(`document.createComment`). A comment in the DOM is never fetched.',
  ],
  [
    'https://issues.chromium.org',
    'A browser-bug URL in a comment a dependency asks the minifier to preserve.',
  ],
])

/** Every file under `dist`, recursively. */
function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

/** Absolute `http(s)` origins in a string, deduplicated. */
const originsIn = (text) => {
  const found = new Set()
  for (const [url] of text.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
    try {
      found.add(new URL(url).origin)
    } catch {
      // Not a URL after all - a template with a placeholder in the host, say. Ignored here;
      // the CSS check below does not rely on parsing.
    }
  }
  return found
}

const failures = []

for (const file of walk(dist)) {
  const name = relative(dist, file)

  if (file.endsWith('.css')) {
    const css = readFileSync(file, 'utf8')
    // Every URL in CSS is a request. `url(…)` covers @font-face src, background-image and the
    // rest; `@import` is matched separately because it may be written without `url()`.
    for (const [, url] of css.matchAll(/url\(\s*['"]?(https?:\/\/[^)'"]+)/g)) {
      failures.push(`${name}: fetches ${url}`)
    }
    for (const [, url] of css.matchAll(/@import\s+['"](https?:\/\/[^'"]+)/g)) {
      failures.push(`${name}: @imports ${url}`)
    }
  }

  if (file.endsWith('.js')) {
    for (const origin of originsIn(readFileSync(file, 'utf8'))) {
      if (!ALLOWED_IN_JS.has(origin)) failures.push(`${name}: names ${origin}`)
    }
  }
}

if (failures.length > 0) {
  console.error('The built site would reach a third party at runtime:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    '\nThis application is offline-first (ADR 0002), so an asset behind a network request is ' +
      'an asset the user does not have when they need it most.\n' +
      'Bundle it - see packages/web/src/fonts and packages/web/src/icons - or, if the string ' +
      'is genuinely never fetched, add the origin to ALLOWED_IN_JS with the proof.',
  )
  process.exit(1)
}

console.log('offline assets: ok (nothing in the built site is fetched from a third party)')
