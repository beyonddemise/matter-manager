#!/usr/bin/env node
/**
 * Guards the caching contract the deployment publishes in `_headers`.
 *
 * A single-page application that is cached wrongly does not break. It keeps working, on last
 * week's code, for as long as the cache says — and the person who deployed sees the new
 * version immediately, because their own browser revalidated. That is the failure M2-10 names,
 * and the reason it gets a checker rather than a comment: it is invisible from the inside.
 *
 * Three paths carry the whole contract:
 *
 * - `/assets/*` is fingerprinted by Vite. The bytes behind a given URL never change, so those
 *   URLs are cached for a year and never revalidated. Not caching them is pure cost, paid on
 *   the connection least able to afford it.
 * - `/index.html` and `/` name which fingerprinted bundle to load. Cached, they name an old
 *   one forever, and every immutable asset around them is then correctly serving the wrong
 *   application.
 * - `/sw.js` is the one that cannot be recovered from. A cached service worker cannot be
 *   replaced by a newer one, so a bad long `max-age` here is not "stale until it expires"; it
 *   is stale until the user clears storage, which they have no reason to think of doing.
 *
 * **Every matching rule has to satisfy the contract on its own, not just the last one.** That
 * is not caution, it is Cloudflare's documented behaviour: a request matching several rules
 * "will inherit all rules' headers", and "if a header is applied twice in the `_headers` file,
 * the values are joined with a comma separator". There is no last-one-wins to rely on. A
 * `/*` rule adding `max-age=604800` alongside the shell's `no-cache` does not replace it — it
 * produces `no-cache, max-age=604800`, which every cache in the path is then free to
 * interpret its own way.
 *
 * https://developers.cloudflare.com/pages/configuration/headers/
 *
 * Usage:  node scripts/check-deploy-headers.mjs [--scan <directory>]
 *
 * `--scan` points at a directory containing a `_headers` file, so the checker itself can be
 * exercised over fixtures. Without it, the real one under `packages/web/public`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const scanIndex = process.argv.indexOf('--scan')
const directory = scanIndex === -1 ? join(root, 'packages/web/public') : process.argv[scanIndex + 1]

if (directory === undefined) {
  console.error('--scan needs a directory.')
  process.exit(1)
}

const file = join(directory, '_headers')

if (!existsSync(file)) {
  // Not "nothing to check". An absent `_headers` is the same deployment as a wrong one, and is
  // easier to reach by accident: moving the file out of `public/` stops it being published
  // with nothing anywhere turning red.
  console.error(`No _headers in ${directory}. The deployment would publish no caching rules.`)
  process.exit(1)
}

/** A year, the conventional ceiling and the maximum any client is obliged to honour. */
const A_YEAR = 31536000

/**
 * What each path has to promise.
 *
 * `revalidate` means the client must ask before reusing what it has. `immutable` means it
 * never has to ask again.
 */
const CONTRACT = [
  {
    path: '/index.html',
    want: 'revalidate',
    why: 'the shell names which fingerprinted bundle to load; cached, it names an old one',
  },
  { path: '/', want: 'revalidate', why: 'the same document, at the address people actually visit' },
  {
    path: '/sw.js',
    want: 'revalidate',
    why: 'a cached service worker cannot be replaced, so it serves an old bundle until the user clears storage',
  },
  {
    path: '/assets/index-DzihouQZ.js',
    want: 'immutable',
    why: 'Vite fingerprints these, so the bytes behind the URL never change',
  },
]

const problems = []

/**
 * Turns a Cloudflare path pattern into a matcher.
 *
 * `*` spans anything including `/`; `:name` is one path segment. Everything else is literal,
 * so a `.` in `index.html` cannot quietly become "any character".
 */
function matcher(pattern) {
  const source = pattern
    .split('')
    .map((character) => {
      if (character === '*') return '.*'
      return /[a-zA-Z0-9/_-]/.test(character) ? character : `\\${character}`
    })
    .join('')
    // Applied after escaping, so the `\:` an escaped colon produced is what is replaced.
    .replace(/\\:[a-zA-Z0-9_]+/g, '[^/]+')
  return new RegExp(`^${source}$`)
}

/**
 * Reads a `Cache-Control` value into directives.
 *
 * Returns `null` for anything it does not understand, and the caller treats that as a failure
 * rather than as an absence. A checker that skips what it cannot parse passes the one file
 * most likely to be wrong.
 */
function parseCacheControl(value) {
  const directives = new Map()
  for (const part of value.split(',')) {
    const directive = part.trim()
    if (directive === '') return null
    const eq = directive.indexOf('=')
    if (eq === -1) {
      if (!/^[a-z-]+$/.test(directive)) return null
      directives.set(directive, true)
      continue
    }
    const name = directive.slice(0, eq).trim()
    const raw = directive.slice(eq + 1).trim()
    if (!/^[a-z-]+$/.test(name) || !/^\d+$/.test(raw)) return null
    directives.set(name, Number(raw))
  }
  return directives.size === 0 ? null : directives
}

/** Parses the file into `{ path, headers }`, failing closed on any line it cannot place. */
function parseHeaders(text) {
  const rules = []
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return

    if (line.startsWith('/')) {
      rules.push({ path: line, headers: new Map(), line: index + 1 })
      return
    }

    // Cloudflare also accepts an absolute URL as a rule — `https://site.pages.dev/sw.js`.
    // This checker does not model host patterns, and the failure of *not* saying so is silent
    // and specific: `https://…` contains a colon, so it parses as a header named `https`, and
    // every `Cache-Control` beneath it attaches to whichever rule came before. The absolute
    // rule is then never evaluated, and any complaint names the wrong line.
    //
    // Refused rather than handled, which is the same choice the `:placeholder` matcher makes:
    // there is no rule this project needs whose pattern is a URL, so the safe answer is to
    // reject the form rather than to be clever about it.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
      problems.push({
        where: `line ${index + 1}`,
        what: 'an absolute URL as a rule, which this checker does not model',
        detail:
          `${line} — write it as a path pattern instead. Left as a URL it parses as a header ` +
          'called "https", its own headers attach to the rule above it, and nothing here ever ' +
          'checks the path it names.',
      })
      return
    }

    const colon = line.indexOf(':')
    const current = rules.at(-1)
    if (colon === -1 || current === undefined) {
      problems.push({
        where: `line ${index + 1}`,
        what: current === undefined ? 'a header before any path' : 'neither a path nor a header',
        detail: line,
      })
      return
    }
    current.headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  })
  return rules
}

/** Whether a client must ask before reusing what it holds. */
function revalidates(directives) {
  if (directives.has('immutable')) return false
  if (directives.has('no-store') || directives.has('no-cache')) return true
  return directives.get('max-age') === 0 && directives.has('must-revalidate')
}

/** Whether a client never has to ask again, for long enough to be worth it. */
function isImmutable(directives) {
  return directives.has('immutable') && (directives.get('max-age') ?? 0) >= A_YEAR
}

const rules = parseHeaders(readFileSync(file, 'utf8'))

for (const { path, want, why } of CONTRACT) {
  const matches = rules.filter((rule) => matcher(rule.path).test(path))
  const stating = matches.filter((rule) => rule.headers.has('cache-control'))

  if (stating.length === 0) {
    problems.push({
      where: path,
      what: 'no rule states a Cache-Control',
      detail: `${why}. Unstated is not safe: the browser and the CDN each apply a heuristic, and they need not agree.`,
    })
    continue
  }

  // Every matching rule, not the last one: Cloudflare joins duplicate headers with a comma
  // rather than letting one win. See the note at the top.
  for (const rule of stating) {
    const value = rule.headers.get('cache-control')
    const directives = parseCacheControl(value)
    if (directives === null) {
      problems.push({
        where: `${rule.path} (line ${rule.line})`,
        what: 'Cache-Control could not be parsed',
        detail: value,
      })
      continue
    }

    const satisfied = want === 'revalidate' ? revalidates(directives) : isImmutable(directives)
    if (!satisfied) {
      problems.push({
        where: `${rule.path} (line ${rule.line})`,
        what: `matches ${path}, which must ${want === 'revalidate' ? 'revalidate' : `stay cacheable for at least ${A_YEAR} seconds and be immutable`}`,
        detail: `${value} — ${why}`,
      })
    }
  }
}

if (problems.length === 0) {
  console.log('deploy headers: ok (shell and worker revalidate, fingerprinted assets pinned)')
  process.exit(0)
}

console.error(`The caching contract in ${file} would deploy a stale application:\n`)
for (const problem of problems) {
  console.error(`  ${problem.where}: ${problem.what}`)
  console.error(`    ${problem.detail}\n`)
}
console.error('See docs/adr/0014-cloudflare-pages-deployment.md.')
process.exit(1)
