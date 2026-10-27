#!/usr/bin/env node
/**
 * Fails if the Excel writer ended up in the bundle every visitor downloads.
 *
 * The xlsx export (#295) is hand-written over the project's own zip container rather than a
 * library, so it is small — but the acceptance criterion is categorical: the entry chunk must
 * not grow for a feature behind a button, and this split is one static import away from being
 * silently undone. `views/device-list.ts` reaches `ui/xlsx/export.ts` with `import()`, and
 * `ui/xlsx/export.ts` deliberately imports `domain/xlsx/*` by deep path rather than through the
 * `domain/index.ts` barrel — the barrel is in the entry's static closure, so a re-export there
 * is the quiet way the writer would come back.
 *
 * A sibling of `check-lazy-pdf.mjs` rather than a parameter of it, as that script is of
 * `check-lazy-fallback.mjs`: the three guard different decisions with different failure
 * stories. The method is borrowed whole; see `check-lazy-pdf.mjs` for why the markers are
 * internal strings and why absence alone is not success.
 *
 * Usage:  node scripts/check-lazy-xlsx.mjs [--scan <dist directory>]
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
 * Strings from inside `domain/xlsx/workbook.ts` that nothing else in the application writes.
 *
 * They are the format itself — the content type of a workbook part and the inline-string cell
 * type — so a chunk containing one contains the writer, not a reference to it, and minification
 * cannot remove them without removing the format. Several, so losing one degrades the check's
 * sensitivity rather than silencing it; the positive control below fires if all stop matching.
 */
const WRITER_TOKENS = ['spreadsheetml.sheet.main+xml', 'inlineStr', '[Content_Types].xml']

/** The scripts `index.html` loads directly: what every visitor downloads before anything else. */
const entryScripts = (html) =>
  [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1].replace(/^\//, ''))

/**
 * The chunks a chunk pulls in **statically**, resolved against its own location — the same
 * expression as `check-lazy-pdf.mjs`, for the same reasons: `import("…")` is deliberately not
 * matched, and `../` specifiers are resolved rather than silently dropped.
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

/** The entry scripts and their static closure; see `check-lazy-pdf.mjs` on the unresolved case. */
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

const holdsWriter = (code) => WRITER_TOKENS.some((token) => code.includes(token))

const { seen: eager, unresolved } = eagerlyReachable()

if (unresolved.length > 0) {
  console.error('Found a script this check cannot resolve under dist/assets, so it cannot tell')
  console.error("whether that chunk's contents are part of the first load:\n")
  for (const { name, from } of unresolved) {
    console.error(`  ${name} (${from === 'index.html' ? 'loaded by' : 'imported from'} ${from})`)
  }
  console.error('\nEither the bundler emitted it outside assets/, or the specifier no longer')
  console.error('matches what is on disk. Fix the mismatch, or teach this check the new layout.')
  process.exit(1)
}

const carrying = [...chunks].filter(([, code]) => holdsWriter(code)).map(([name]) => name)
const shipped = carrying.filter((name) => eager.has(name))

if (shipped.length > 0) {
  console.error('The Excel writer is downloaded by every visitor. It is in, or statically')
  console.error(`imported by, the entry bundle:\n\n  ${shipped.join('\n  ')}\n`)
  console.error('It belongs behind the Export button. Reach it through the dynamic import in')
  console.error('src/ui/views/device-list.ts, and keep src/ui/xlsx/export.ts importing')
  console.error('domain/xlsx/* by deep path — a re-export from domain/index.ts is the quiet')
  console.error('way the writer comes back, because the barrel is in the entry closure.')
  process.exit(1)
}

if (carrying.length === 0) {
  // The positive control. Without it this passes when it is looking in the wrong place.
  console.error(`The Excel writer is in no chunk at all under ${dist}. Either the export has`)
  console.error('been removed - in which case nobody can hand an inventory to a client - or')
  console.error('this check has stopped recognising the writer, and "not in the entry bundle"')
  console.error('now means nothing. Check WRITER_TOKENS against domain/xlsx/workbook.ts.')
  process.exit(1)
}

console.log(`lazy xlsx writer: ok (in ${carrying.join(', ')}, reached only by dynamic import)`)
