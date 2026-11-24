#!/usr/bin/env node
/**
 * Fails if the plan sanitiser (DOMPurify) ended up in the bundle every visitor downloads.
 *
 * DOMPurify joined the accepted dependencies for SVG layouts (#143, ADR 0023) on the condition
 * that it is lazy: it is loaded with the layout feature, so somebody filing a device who never
 * opens a plan never downloads a sanitiser. `src/ui/layouts/sanitise.ts` is the only module that
 * imports it, and that module must be reached through `import()`. One static import, or a type
 * import of something it exports, undoes that silently: every test still passes.
 *
 * A sibling of `check-lazy-pdf.mjs`, whose method it borrows whole: internal markers rather than
 * names the application writes, the entry's static closure walked chunk by chunk, an unresolved
 * chunk treated as a refusal to judge, and absence never taken for success.
 *
 * **Two states, read from `scripts/awaiting-consumer.json`.** The sanitiser lands one pull
 * request before the layout view that imports it (spec 2026-11-24, PR 5 then PR 6). While it is
 * listed there as awaiting its consumer, nothing may import it, so DOMPurify must be in **no
 * chunk at all**; that is the stronger claim, and the honest one for code nothing uses yet. Once
 * the entry is removed (which `check-module-graph.mjs` forces the moment the module becomes
 * reachable), the check becomes the ordinary one: present, and reached only dynamically.
 *
 * Usage:  node scripts/check-lazy-svg.mjs [--scan <dist directory>] [--awaiting <json>]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSanitiserBundle } from './sanitiser-bundle.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const dist = argument('--scan', join(root, 'dist'))
const awaitingFile = argument('--awaiting', join(root, 'scripts/awaiting-consumer.json'))

if (dist === undefined || awaitingFile === undefined) {
  console.error('--scan and --awaiting each need a path.')
  process.exit(1)
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`No built site in ${dist}. Run: npm --prefix frontend run build`)
  process.exit(1)
}

/** Whether the sanitiser is still listed as awaiting the module that will import it. */
const awaitingConsumer = Object.hasOwn(
  JSON.parse(readFileSync(awaitingFile, 'utf8')),
  'layouts/sanitise.ts',
)

/**
 * Names from inside DOMPurify that this repository's own source never writes.
 *
 * Configuration keys DOMPurify reads from its options object and hook names it registers: a
 * minifier keeps property names, so they survive. `USE_PROFILES`, `FORBID_TAGS`, `RETURN_DOM`
 * and `uponSanitizeAttribute` are deliberately absent, because `sanitise.ts` writes them and they
 * would mark the call site rather than the library. Several, so losing one degrades the check
 * rather than silencing it; the positive control below fires if they all stop matching.
 */
const SANITISER_TOKENS = [
  'SAFE_FOR_TEMPLATES',
  'ALLOWED_URI_REGEXP',
  'uponSanitizeShadowNode',
  'RETURN_TRUSTED_TYPE',
]

/** The scripts `index.html` loads directly: what every visitor downloads before anything else. */
const entryScripts = (html) =>
  [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1].replace(/^\//, ''))

/**
 * The chunks a chunk pulls in **statically**, resolved against its own location. The same
 * expression as `check-lazy-pdf.mjs`: `import("…")` is deliberately not matched.
 */
const staticImports = (code, from) =>
  [...code.matchAll(/(?:from|import)\s*["'](\.\.?\/[^"']+\.js)["']/g)].map((match) =>
    posix.join(posix.dirname(from), match[1]),
  )

const html = readFileSync(join(dist, 'index.html'), 'utf8')
const entries = entryScripts(html)

if (entries.length === 0) {
  console.error(`No <script src> in ${join(dist, 'index.html')}; this check cannot see anything.`)
  process.exit(1)
}

const assets = join(dist, 'assets')
const chunks = new Map(
  existsSync(assets)
    ? readdirSync(assets)
        .filter((name) => name.endsWith('.js'))
        .map((name) => [`assets/${name}`, readFileSync(join(assets, name), 'utf8')])
    : [],
)

/** The entries and their static closure, plus anything referenced that is not on disk. */
function eagerlyReachable() {
  const seen = new Set()
  const unresolved = []
  const queue = entries.map((name) => ({ name, from: 'index.html' }))
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined || seen.has(next.name)) continue
    seen.add(next.name)
    const code = chunks.get(next.name)
    if (code === undefined) {
      unresolved.push(next)
      continue
    }
    queue.push(...staticImports(code, next.name).map((name) => ({ name, from: next.name })))
  }
  return { seen, unresolved }
}

const holdsSanitiser = (code) => SANITISER_TOKENS.some((token) => code.includes(token))
const carrying = [...chunks].filter(([, code]) => holdsSanitiser(code)).map(([name]) => name)

// Resolved before either verdict, both of which are claims about the whole first load: a chunk
// this walk cannot find is a chunk it cannot rule out, for the reason check-lazy-pdf.mjs gives.
const { seen: eager, unresolved } = eagerlyReachable()

if (unresolved.length > 0) {
  console.error('Found a script this check cannot resolve under dist/assets, so it cannot tell')
  console.error("whether that chunk's contents are part of the first load:\n")
  for (const { name, from } of unresolved) {
    console.error(`  ${name} (${from === 'index.html' ? 'loaded by' : 'imported from'} ${from})`)
  }
  process.exit(1)
}

if (awaitingConsumer) {
  // The positive control for this state. "In no chunk" is also what tokens that no longer match
  // DOMPurify look like, so the tokens must be found in the sanitiser itself, bundled from
  // src/ui/layouts/sanitise.ts exactly as probe:svg bundles it.
  const bundle = await buildSanitiserBundle()
  const missing = SANITISER_TOKENS.filter((token) => !bundle.includes(token))
  if (missing.length > 0) {
    console.error(`The sanitiser, bundled on its own, does not contain ${missing.join(', ')}.`)
    console.error('This check has stopped recognising DOMPurify, so "in no chunk" would mean')
    console.error('nothing. Update SANITISER_TOKENS against the installed version.')
    process.exit(1)
  }

  // Nothing imports the sanitiser yet, so nothing may ship it. A chunk holding it means some
  // module imports DOMPurify directly, outside `sanitise.ts` and outside this decision.
  if (carrying.length > 0) {
    console.error('DOMPurify is in the built site, but nothing is meant to import it yet')
    console.error('(scripts/awaiting-consumer.json lists layouts/sanitise.ts as awaiting):\n')
    console.error(`  ${carrying.join('\n  ')}\n`)
    console.error(
      'Import it only through src/ui/layouts/sanitise.ts, and reach that with import().',
    )
    process.exit(1)
  }
  console.log(
    'lazy sanitiser: ok (not yet imported by the application, and in no chunk; the markers match the sanitiser bundled on its own)',
  )
  process.exit(0)
}

const shipped = carrying.filter((name) => eager.has(name))

if (shipped.length > 0) {
  console.error('The plan sanitiser is downloaded by every visitor. It is in, or statically')
  console.error(`imported by, the entry bundle:\n\n  ${shipped.join('\n  ')}\n`)
  console.error('Reach src/ui/layouts/sanitise.ts only with import(), and import nothing from it')
  console.error('statically, types included: a type import names the module that loads DOMPurify.')
  process.exit(1)
}

if (carrying.length === 0) {
  // The positive control. Without it this passes when it is looking in the wrong place.
  console.error(`The plan sanitiser is in no chunk at all under ${dist}, yet nothing lists it as`)
  console.error('awaiting a consumer. Either the layout feature lost its sanitiser - in which case')
  console.error('plans render unsanitised or not at all - or this check has stopped recognising')
  console.error('DOMPurify. Check SANITISER_TOKENS against the installed version.')
  process.exit(1)
}

console.log(`lazy sanitiser: ok (in ${carrying.join(', ')}, reached only by dynamic import)`)
