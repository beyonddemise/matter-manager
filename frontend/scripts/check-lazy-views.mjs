#!/usr/bin/env node
/**
 * Fails if the route views ended up in the bundle every visitor parses before first paint,
 * or fell out of the shell's offline precache.
 *
 * #214: the entry chunk had grown to 652 kB and `chunkSizeWarningLimit` had been raised four
 * times to keep pace (700 → 730 → 740 → 770). The views were the bulk nobody had split: every
 * one of them was statically imported into `app-shell.ts`, so somebody opening the device list
 * parsed the projects page, the account page, the settings page and both device forms first.
 *
 * The split this guards is the route-level one: each view in `src/ui/views/` that a route
 * reaches is imported dynamically (`routes.ts` carries the loaders), so it lands in a chunk of
 * its own. That split is one static import away from being undone, and undoing it is silent —
 * every test still passes, every view still renders, the only symptom is a first load nobody
 * is counting until the size warning returns. The sibling scripts `check-lazy-fallback.mjs`
 * and `check-lazy-pdf.mjs` explain the method; this one adds a second claim of its own:
 *
 * **Lazy must not mean absent offline.** This application opens with no connectivity (ADR
 * 0002), and the service worker precaches exactly the `/assets/` URLs the built `index.html`
 * names (see `public/sw.js`, `assetsNamedIn`). A view chunk the shell does not name is a view
 * an installed offline application cannot open. So every view chunk — and everything it pulls
 * in statically — must be named in `index.html`; the build injects `<link rel="modulepreload">`
 * tags for them (`nameLazyChunksInShell` in `vite.config.ts`), and this is what notices that
 * injection silently finding nothing.
 *
 * It does not look for the custom element tags (`<device-list-view>` and friends): the entry
 * chunk legitimately contains those at the render sites in `app-shell.ts`. A chunk *named
 * after* the view module is the artefact the split produces, so its existence, its absence
 * from the entry's static closure, and its presence in the shell's precache manifest are the
 * three facts asserted — and "no such chunk at all" fails too, because absence is also what a
 * renamed view or the wrong directory looks like.
 *
 * Usage:  node scripts/check-lazy-views.mjs [--scan <dist directory>]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scanIndex = process.argv.indexOf('--scan')
const dist = scanIndex === -1 ? join(root, 'dist') : process.argv[scanIndex + 1]

if (dist === undefined) {
  console.error('--scan needs a directory.')
  process.exit(1)
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`No built site in ${dist}. Run: npm --prefix frontend run build`)
  process.exit(1)
}

/**
 * The views the route registry reaches, by module name. Chunk names follow the module
 * (`[name]-[hash].js`), so renaming a view file fails here loudly — which is the intended
 * behaviour, since whoever renames it should decide anew whether it stays lazy.
 * `not-found` is deliberately absent: it is the fallback for a view that failed to arrive,
 * so it stays in the entry chunk, where no fetch can take it away.
 */
const VIEWS = [
  'projects',
  'device-list',
  'add-device',
  'device',
  'edit-device',
  'rooms',
  'account',
  'settings',
]

const html = readFileSync(join(dist, 'index.html'), 'utf8')

/** The scripts `index.html` loads directly: what every visitor downloads before anything else. */
const entries = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) =>
  match[1].replace(/^\//, ''),
)

if (entries.length === 0) {
  console.error(`No <script src> in ${join(dist, 'index.html')}; this check cannot see anything.`)
  process.exit(1)
}

/** Every `/assets/` URL the shell names — which is exactly what `sw.js` precaches. */
const precached = new Set(
  [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) =>
    match[1].replace(/^\//, ''),
  ),
)

const assets = join(dist, 'assets')
const chunks = new Map(
  existsSync(assets)
    ? readdirSync(assets)
        .filter((name) => name.endsWith('.js'))
        .map((name) => [`assets/${name}`, readFileSync(join(assets, name), 'utf8')])
    : [],
)

/**
 * The chunks a chunk pulls in **statically**, resolved against its own location.
 * `import("./x.js")` — the dynamic form — is deliberately not matched; that distinction is
 * what this whole script exists to make. Same walk as `check-lazy-pdf.mjs`.
 */
const staticImports = (code, from) =>
  [...code.matchAll(/(?:from|import)\s*["'](\.\.?\/[^"']+\.js)["']/g)].map((match) =>
    posix.join(posix.dirname(from), match[1]),
  )

/** The static closure of a set of chunk names, the starting set included. */
function closure(start) {
  const seen = new Set()
  const queue = [...start]
  while (queue.length > 0) {
    const name = queue.shift()
    if (name === undefined || seen.has(name)) continue
    seen.add(name)
    const code = chunks.get(name)
    if (code !== undefined) queue.push(...staticImports(code, name))
  }
  return seen
}

const eager = closure(entries)

const failures = []
const found = []

for (const view of VIEWS) {
  // The suffix is exactly the build's 8-character hash, not `[\w-]+`: `device-` would otherwise
  // also match `device-form-<hash>.js` and `device-list-<hash>.js`, and the positive control for
  // the device view would be satisfied by a neighbour while the view itself was folded away. A
  // bundler upgrade that changes the hash length fails here loudly, which is the right way round.
  const pattern = new RegExp(`^assets/${view}-[\\w-]{8}\\.js$`)
  const matching = [...chunks.keys()].filter((name) => pattern.test(name))

  if (matching.length === 0) {
    // The positive control: without it this passes when the chunk layout changed under it.
    failures.push(
      `${view}: no chunk assets/${view}-*.js exists. Either the view was renamed — update ` +
        'VIEWS here and decide anew whether it stays lazy — or it has been folded back into ' +
        'another chunk, and the route-level split is gone for this view.',
    )
    continue
  }

  for (const name of matching) {
    if (eager.has(name)) {
      failures.push(
        `${view}: ${name} is statically reachable from the entry, so every visitor parses it ` +
          'before first paint. Reach it only through the dynamic import in ' +
          'src/ui/router/routes.ts.',
      )
    }

    const missing = [...closure([name])].filter((dep) => !precached.has(dep))
    if (missing.length > 0) {
      failures.push(
        `${view}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not named in ` +
          'index.html, so the service worker never precaches it and an installed offline ' +
          'application cannot open this view. See nameLazyChunksInShell in vite.config.ts.',
      )
    }
  }

  found.push(...matching)
}

if (failures.length > 0) {
  console.error('The route-level view split (#214) does not hold:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    '\nViews must be reached through the dynamic imports in src/ui/router/routes.ts, and their' +
      '\nchunks must be named in index.html so public/sw.js precaches them for offline use.',
  )
  process.exit(1)
}

console.log(
  `lazy views: ok (${found.length} view chunks, none eagerly reachable, all precached offline)`,
)
