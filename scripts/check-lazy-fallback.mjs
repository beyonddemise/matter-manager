#!/usr/bin/env node
/**
 * Fails if the QR fallback decoder ended up in the bundle every visitor downloads.
 *
 * M2b-2 has two halves. "iOS Safari can scan" is the one anybody would test. The other is
 * "browsers with the native API never download the fallback", and it is the one that breaks
 * silently: a static import satisfies the first, ships a decoder to everyone else, and nothing
 * anywhere turns red. `@zxing/browser` pulls in `@zxing/library`, which is over 400kB.
 *
 * A unit test can prove the *decision* — that the loader is not called when the platform has
 * its own detector — and `packages/web/test/scan/detector.browser.test.ts` does. It cannot
 * prove the *bundling*: a bundler that inlined the dynamic import would satisfy it exactly.
 * Only the built output can answer that, so this reads the built output.
 *
 * **Two things it deliberately does not do.**
 *
 * It does not look for `BrowserQRCodeReader`. The first version did, and reported a failure
 * that was not one: the entry chunk contains that name because the code destructures it out of
 * the dynamic import — `const { BrowserQRCodeReader } = await import(…)` — right next to the
 * `import()` that proves it is lazy. A marker that appears at the call site cannot distinguish
 * "the library is here" from "the library is referred to here".
 *
 * And it does not treat mere absence as success. Absence is also what you would see if the
 * fallback had been deleted, if the chunk layout changed, or if this were pointed at the wrong
 * directory. So it also insists the decoder is present *somewhere*, and reachable only
 * dynamically.
 *
 * Usage:  node scripts/check-lazy-fallback.mjs [--scan <dist directory>]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
 * Names from inside `@zxing/library` that this repository's own source never mentions.
 *
 * Being internal is the whole qualification: a chunk containing one of these contains the
 * decoder itself, not a reference to it. Several, so that one being minified away in a future
 * version degrades the check's sensitivity rather than silencing it — and the positive control
 * below fires if they all stop matching.
 */
const DECODER_TOKENS = ['ChecksumException', 'FormatException', 'ReedSolomonDecoder']

/** The scripts `index.html` loads directly: what every visitor downloads before anything else. */
const entryScripts = (html) =>
  [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1].replace(/^\//, ''))

/**
 * The chunks a chunk pulls in **statically**.
 *
 * `import("./x.js")` — with the parenthesis — is the dynamic form and is deliberately not
 * matched. That is the distinction this whole script exists to make.
 */
const staticImports = (code) =>
  [...code.matchAll(/(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g)].map((match) =>
    match[1].replace(/^\.\//, 'assets/'),
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

/** Everything a visitor downloads before the application runs: the entries and their closure. */
function eagerlyReachable() {
  const seen = new Set()
  const queue = [...entries]
  while (queue.length > 0) {
    const name = queue.shift()
    if (name === undefined || seen.has(name)) continue
    seen.add(name)
    const code = chunks.get(name)
    if (code !== undefined) queue.push(...staticImports(code))
  }
  return seen
}

const holdsDecoder = (code) => DECODER_TOKENS.some((token) => code.includes(token))

const eager = eagerlyReachable()
const carrying = [...chunks].filter(([, code]) => holdsDecoder(code)).map(([name]) => name)
const shipped = carrying.filter((name) => eager.has(name))

if (shipped.length > 0) {
  console.error('The QR fallback is downloaded by every visitor. It is in, or statically')
  console.error(`imported by, the entry bundle:\n\n  ${shipped.join('\n  ')}\n`)
  console.error('It must be reached through a dynamic import so that browsers with')
  console.error('BarcodeDetector never fetch it. See packages/web/src/scan/detector.ts.')
  process.exit(1)
}

if (carrying.length === 0) {
  // The positive control. Without it this passes when it is looking in the wrong place.
  console.error(`The QR fallback is in no chunk at all under ${dist}. Either it has been`)
  console.error('removed — in which case iOS Safari can no longer scan — or this check has')
  console.error('stopped recognising it, and "not in the entry bundle" now means nothing.')
  process.exit(1)
}

console.log(`lazy fallback: ok (in ${carrying.join(', ')}, reached only by dynamic import)`)
