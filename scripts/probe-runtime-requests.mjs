#!/usr/bin/env node

/**
 * Serves the built site under its own Content-Security-Policy and fails on any request that
 * leaves the origin.
 *
 * `check-offline-assets.mjs` reads the built files; this one runs them. The two catch different
 * things, and #106 needed both:
 *
 * - A URL can be in the bundle and never fetched — Web Awesome ships Font Awesome's CDN template
 *   whether or not the icon library is overridden — so the static check has to allow those, and
 *   an allowlist entry is a promise rather than a proof. This is the proof.
 * - A request can be made by a URL that is not in the bundle as a literal, because it was built
 *   at run time or arrived through a stylesheet's `@import`. Nothing static sees that.
 *
 * It also applies the `_headers` policy, so the policy is tested rather than asserted. #47
 * measured it that way in the first place, and a policy that has drifted from what the
 * application needs is invisible until it reaches a user: locally everything is `file:` or
 * `localhost` and nothing enforces it.
 *
 * Usage:  node scripts/probe-runtime-requests.mjs [--scan <dist directory>]
 */

import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scanIndex = process.argv.indexOf('--scan')
const dist = scanIndex === -1 ? join(root, 'packages/web/dist') : process.argv[scanIndex + 1]

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`No built site in ${dist}. Run: npm --workspace @matter-manager/web run build`)
  process.exit(1)
}

/** The policy the deployment serves, read from the same file the deployment reads. */
const policy = (() => {
  const headers = readFileSync(join(root, 'packages/web/public/_headers'), 'utf8')
  const line = headers.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'))
  if (line === undefined)
    throw new Error('No Content-Security-Policy in packages/web/public/_headers')
  return line.slice(line.indexOf(':') + 1).trim()
})()

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

const server = createServer((request, response) => {
  let path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  if (path === '/') path = '/index.html'
  const file = join(dist, normalize(path))
  const send = (body, type) => {
    response.writeHead(200, { 'content-type': type, 'content-security-policy': policy })
    response.end(body)
  }
  try {
    send(readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream')
  } catch {
    // Single-page application: an unknown path is a route, not a missing file.
    send(readFileSync(join(dist, 'index.html')), 'text/html')
  }
})

await new Promise((resolve) => server.listen(0, resolve))
const origin = `http://localhost:${server.address().port}`

const browser = await chromium.launch()
const page = await browser.newPage()

const external = new Set()
const violations = []

page.on('request', (request) => {
  const url = request.url()
  // `data:` and `blob:` never leave the page; the policy allows both deliberately.
  if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) {
    external.add(url)
  }
})
// A blocked request reports itself here and nowhere the application can see, which is exactly
// why a too-tight policy is worth catching before a user finds it.
page.on('console', (message) => {
  const text = message.text()
  if (text.includes('Content Security Policy')) violations.push(text)
})

for (const path of ['/', '/add', '/settings']) {
  await page.goto(origin + path, { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(500)
}

await browser.close()
server.close()

if (external.size > 0) {
  console.error(`The running application made ${external.size} request(s) to another origin:\n`)
  for (const url of [...external].sort()) console.error(`  ${url}`)
  console.error(
    '\nThis application is offline-first (ADR 0002): anything fetched at run time is ' +
      'missing exactly when it is needed most. Bundle it - see packages/web/src/fonts and ' +
      'packages/web/src/icons, and scripts/fetch-offline-assets.mjs.',
  )
  process.exit(1)
}

if (violations.length > 0) {
  console.error(
    'The Content-Security-Policy in packages/web/public/_headers blocked the application:\n',
  )
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(
    '\nThe policy is a floor, so it can be relaxed - but only for something observed to be needed.',
  )
  process.exit(1)
}

console.log('runtime requests: ok (nothing left the origin, and the policy blocked nothing)')
