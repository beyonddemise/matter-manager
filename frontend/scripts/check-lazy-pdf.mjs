#!/usr/bin/env node
/**
 * Fails if the PDF writer ended up in the bundle every visitor downloads.
 *
 * `pdf-lib`, its standard-font tables, `@pdf-lib/upng` and `pako` came to **408 kB of a 1,022 kB
 * entry chunk** — 40% of the first load, measured from the build's own sourcemaps — for a feature
 * reached by pressing Export. Somebody filing a device in a basement on a phone downloaded a PDF
 * writer to do it. Loading the two builders on demand took the entry chunk to 619 kB and its
 * gzip from 347 kB to 168 kB.
 *
 * That split is one static import away from being undone, and undoing it is silent: every test
 * passes, the export still works, the only symptom is a first load nobody is counting. `await
 * import('../pdf/inventory.js')` becoming `import { buildInventoryPdf } from …` at the top of
 * `device-list.ts` is the obvious way, but the quieter one is a *type* import — the
 * cancellation class and the progress type live in `src/ui/pdf/progress.ts` precisely so the view
 * can hold them without naming a module that imports `pdf-lib`.
 *
 * The same reasoning as `check-lazy-fallback.mjs`, and a sibling rather than a parameter of it
 * because the two guard different decisions with different failure stories, and a shared script
 * would have to explain both at once. What it borrows is the method:
 *
 * **It does not look for `PDFDocument`.** The entry chunk legitimately contains that name at the
 * call site of a dynamic import. A marker that appears where the library is *referred to* cannot
 * distinguish that from the library being present.
 *
 * **And it does not treat absence as success.** Absence is also what a deleted export, a changed
 * chunk layout, or the wrong directory looks like. So it also insists the writer is present
 * somewhere, reachable only dynamically.
 *
 * Usage:  node scripts/check-lazy-pdf.mjs [--scan <dist directory>]
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
 * Names from inside `pdf-lib` that this repository's own source never mentions.
 *
 * Being internal is the whole qualification: a chunk containing one of these contains the writer
 * itself, not a reference to it. `PDFDocument`, `rgb` and `StandardFonts` are deliberately absent
 * from this list — those are the names `src/ui/pdf/*` imports, so they appear wherever the import
 * is written. Several tokens, so one being minified away in a future version degrades the
 * check's sensitivity rather than silencing it; the positive control below fires if they all
 * stop matching.
 */
const WRITER_TOKENS = [
  'StandardFontEmbedder',
  'CustomFontEmbedder',
  'WinAnsiEncoding',
  'PDFPageLeaf',
  'PngEmbedder',
]

/** The scripts `index.html` loads directly: what every visitor downloads before anything else. */
const entryScripts = (html) =>
  [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1].replace(/^\//, ''))

/**
 * The chunks a chunk pulls in **statically**, resolved against *its own* location.
 *
 * `import("./x.js")` — with the parenthesis — is the dynamic form and is deliberately not
 * matched. That is the distinction this whole script exists to make.
 *
 * Resolved with `posix.join` against `from`'s directory rather than assumed to be a sibling
 * under `assets/`, because a chunk emitted anywhere else under `dist` would write a `../`
 * specifier to reach it, and `./` alone cannot see that. Matches `../` too, for the same
 * reason - a specifier this regex does not capture is a specifier `eagerlyReachable` never
 * walks, which is silence, not safety.
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

/**
 * Everything a visitor downloads before the application runs: the entries and their closure.
 *
 * `unresolved` is a static import this walk could not find under `dist/assets` - a chunk the
 * bundler emitted somewhere else, or a specifier that no longer matches what is on disk. Such
 * an import used to be silently dropped: `chunks.get(name)` came back `undefined`, nothing was
 * queued from it, and the walk carried on as if that branch of the bundle did not exist. That
 * is exactly the gap a PDF writer reached through such an import would fall through - the
 * check would report success on the one case it could not actually evaluate. Returned instead
 * of thrown, so the caller can report every one of them rather than just the first.
 */
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
      if (next.from !== 'index.html') unresolved.push(next)
      continue
    }
    queue.push(...staticImports(code, next.name).map((name) => ({ name, from: next.name })))
  }
  return { seen, unresolved }
}

const holdsWriter = (code) => WRITER_TOKENS.some((token) => code.includes(token))

const { seen: eager, unresolved } = eagerlyReachable()

if (unresolved.length > 0) {
  // Not a verdict on the PDF writer - a refusal to give one. This check can only prove the
  // writer is absent from the first load by seeing the whole closure of what that load pulls
  // in; a chunk it cannot find is a chunk it cannot rule out, and reporting "ok" anyway is how
  // this kind of guard passes while checking nothing.
  console.error('Found a static import this check cannot resolve under dist/assets, so it')
  console.error("cannot tell whether that chunk's contents are part of the first load:\n")
  for (const { name, from } of unresolved) console.error(`  ${name} (imported from ${from})`)
  console.error('\nEither the bundler emitted it outside assets/, or the specifier no longer')
  console.error('matches what is on disk. Fix the mismatch, or teach this check the new layout.')
  process.exit(1)
}

const carrying = [...chunks].filter(([, code]) => holdsWriter(code)).map(([name]) => name)
const shipped = carrying.filter((name) => eager.has(name))

if (shipped.length > 0) {
  console.error('The PDF writer is downloaded by every visitor. It is in, or statically')
  console.error(`imported by, the entry bundle:\n\n  ${shipped.join('\n  ')}\n`)
  console.error('It is 40% of the first load, for a feature behind the Export button. Reach it')
  console.error('through the dynamic imports in src/ui/views/device-list.ts, and take the')
  console.error('cancellation class from src/ui/pdf/progress.ts rather than from pdf/inventory.js')
  console.error('- importing it from there pulls pdf-lib back in through the type-only door.')
  process.exit(1)
}

if (carrying.length === 0) {
  // The positive control. Without it this passes when it is looking in the wrong place.
  console.error(`The PDF writer is in no chunk at all under ${dist}. Either the export has been`)
  console.error('removed - in which case nobody can print an inventory or a label sheet - or')
  console.error('this check has stopped recognising pdf-lib, and "not in the entry bundle" now')
  console.error('means nothing. Check WRITER_TOKENS against the installed version.')
  process.exit(1)
}

console.log(`lazy pdf writer: ok (in ${carrying.join(', ')}, reached only by dynamic import)`)
