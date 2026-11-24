#!/usr/bin/env node
/**
 * Fails if a module under `src` is reachable from no entry point.
 *
 * #120 found seven modules written, tested, and imported by nothing but their own tests. Signing
 * in, signing out, replication, project creation, the profile and the access token were all
 * implemented, reviewed and green — and none of them existed in the running application.
 *
 * **Nothing could have noticed.** Each module had its own suite and each suite passed, which is
 * exactly what a well-tested feature looks like from the inside. The tests imported the module
 * directly, so they proved it worked and said nothing about whether anything used it. #118 was
 * the same defect on the API side, where `GOOGLE_CLIENT_ID` was documented in three files and
 * read by no source file.
 *
 * So this walks the import graph from the entry points and reports what it never arrives at.
 *
 * **Why a graph walk and not a grep.** A grep for the module's name finds its own tests, its own
 * documentation, and the comment explaining why it exists. Reachability is the property that
 * matters and it is not local: a module imported only by another orphan is still an orphan, and
 * the chain that made #120's seven invisible was exactly that - `db/project-database.ts`
 * mentions `accessToken`, which made `tokens.ts` look used.
 *
 * **One sanctioned exception: a module awaiting its consumer.** A feature that lands in
 * reviewable slices sometimes lands a module one pull request before the one that imports it:
 * #143's plan sanitiser is reviewed and proven by `probe:svg` before the layout view exists. Such
 * a module is listed in `scripts/awaiting-consumer.json` with the change that will import it,
 * and is not reported. The list cannot rot quietly: an entry naming a module that does not exist
 * fails, and so does an entry whose module has become reachable, so the entry is removed by the
 * same pull request that wires the module in. An unlisted orphan still fails exactly as before.
 *
 * Usage:  node scripts/check-module-graph.mjs [--src <directory>] [--entry <file>]...
 *           [--awaiting <json>]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const src = resolve(argument('--src', join(root, 'src/ui')))

/**
 * Where the application starts.
 *
 * `main.ts` is the only one today. Listed rather than discovered, because "what the browser
 * loads" is a fact about `index.html` and the build, not something a directory can be asked.
 */
const entries = process.argv.includes('--entry')
  ? process.argv.filter((_, i) => process.argv[i - 1] === '--entry').map((path) => resolve(path))
  : [join(src, 'main.ts')]

/**
 * Modules awaiting their consumer, as paths relative to `src`, each with the change that will
 * import it. The repository's own list applies only to the repository's own tree: a `--src`
 * pointed elsewhere (the checker's tests) brings its list with `--awaiting`, or has none.
 */
const awaitingFile = argument(
  '--awaiting',
  process.argv.includes('--src') ? undefined : join(root, 'scripts/awaiting-consumer.json'),
)
const awaiting = new Map(
  awaitingFile === undefined
    ? []
    : Object.entries(JSON.parse(readFileSync(awaitingFile, 'utf8')))
        .filter(([key]) => key !== '$comment')
        .map(([key, why]) => [resolve(src, key), why]),
)

if (!existsSync(src)) {
  console.error(`No such directory: ${src}`)
  process.exit(1)
}

/** Every `.ts` file under a directory, recursively. */
function* modules(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) yield* modules(path)
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) yield path
  }
}

/**
 * The specifiers one module imports, static and dynamic alike.
 *
 * Dynamic imports count, and must: the QR fallback, the locale catalogues and every theme are
 * reached that way on purpose, and treating them as unreachable would make this check fire on
 * the code most deliberately written.
 *
 * **A tokeniser rather than a regular expression over the raw text.** The first version scanned
 * the source directly, so a commented-out `// import './orphan.js'` marked that module reached -
 * a false clean bill of health from the one check whose entire job is noticing absent code. A
 * string containing the word had the same effect.
 *
 * **And not the TypeScript compiler API**, which would be the obvious answer: TypeScript 7 is
 * the native rewrite and exposes no `preProcessFile` or `createSourceFile` to JavaScript at all.
 *
 * So the source is walked once, splitting it into code and string literals and discarding
 * comments. A string is a specifier only when the code immediately before it ends in `from`,
 * `import` or `import(` - which is what tells `import './x.js'` from `const s = "import './x.js'"`,
 * because the second is a single string token whose preceding code ends in `=`.
 */
function specifiersIn(source) {
  const found = []
  let code = ''
  let index = 0

  /** Whether the code so far ends where an import specifier may follow. */
  const expectsSpecifier = () => /(?:^|[^\w$])(?:from|import)\s*\(?\s*$/.test(code)

  /** Reads a quoted run, returning its contents and the index after the closing quote. */
  const readString = (quote) => {
    let value = ''
    let at = index + 1
    while (at < source.length) {
      const character = source[at]
      // A backslash escapes whatever follows, including the closing quote.
      if (character === '\\') {
        value += source.slice(at, at + 2)
        at += 2
        continue
      }
      if (character === quote) return { value, next: at + 1 }
      value += character
      at += 1
    }
    // Unterminated. Not this script's business to complain - `tsc` will - so it stops here.
    return { value, next: source.length }
  }

  while (index < source.length) {
    const two = source.slice(index, index + 2)

    if (two === '//') {
      index = source.indexOf('\n', index)
      if (index === -1) break
      // The newline is kept, so a `from` on the line above cannot join a string on the one below.
      code += '\n'
      continue
    }

    if (two === '/*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      code += ' '
      continue
    }

    const character = source[index]

    if (character === "'" || character === '"' || character === '`') {
      const { value, next } = readString(character)
      if (expectsSpecifier()) found.push(value)
      index = next
      // Replaced by a placeholder rather than kept: its contents are not code, and leaving them
      // in would let a string ending in `from` make the *next* string look like a specifier.
      code += '""'
      continue
    }

    code += character
    index += 1
  }

  return found
}

/** Resolves a relative specifier to a file under `src`, or `undefined` for anything else. */
function resolveLocal(fromFile, specifier) {
  if (!specifier.startsWith('.')) return undefined

  // Written as `.js` because this is real ESM under NodeNext; the file on disk is `.ts`.
  const guesses = [
    specifier.replace(/\.js$/, '.ts'),
    `${specifier}.ts`,
    join(specifier, 'index.ts'),
  ]
  for (const guess of guesses) {
    const path = resolve(dirname(fromFile), guess)
    if (existsSync(path) && statSync(path).isFile()) return path
  }
  return undefined
}

const reached = new Set()
const queue = entries.filter((entry) => existsSync(entry))

if (queue.length === 0) {
  console.error(`No entry point exists. Looked for: ${entries.join(', ')}`)
  process.exit(1)
}

while (queue.length > 0) {
  const file = queue.pop()
  if (reached.has(file)) continue
  reached.add(file)

  for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
    const resolved = resolveLocal(file, specifier)
    if (resolved !== undefined && !reached.has(resolved)) queue.push(resolved)
  }
}

// An existing path that is not a `.ts` module under `src` would be listed as "awaiting" while
// describing nothing the graph contains.
const inventory = new Set(modules(src))
const notModules = [...awaiting.keys()].filter((file) => existsSync(file) && !inventory.has(file))
if (notModules.length > 0) {
  console.error(
    `${awaitingFile} lists path(s) that are not modules under ${relative(root, src)}:\n`,
  )
  for (const file of notModules) console.error(`  ${relative(root, file)}`)
  process.exit(1)
}

const stale = [...awaiting.keys()].filter((file) => !existsSync(file) || reached.has(file))
if (stale.length > 0) {
  console.error(`${awaitingFile} lists module(s) that are not awaiting anything:\n`)
  for (const file of stale) {
    const why = existsSync(file) ? 'now reachable from an entry point' : 'does not exist'
    console.error(`  ${relative(root, file)}: ${why}`)
  }
  console.error('\nRemove the entry. The list is only for modules no entry point reaches yet.')
  process.exit(1)
}

const orphans = [...modules(src)].filter((file) => !reached.has(file) && !awaiting.has(file)).sort()

if (orphans.length > 0) {
  console.error(`${orphans.length} module(s) under ${relative(root, src)} reach no entry point:\n`)
  for (const orphan of orphans) console.error(`  ${relative(root, orphan)}`)
  console.error(
    '\nEach of these is code the application does not contain. Its tests still pass, because ' +
      'they import it directly - which is what made #120 invisible for a whole milestone.\n' +
      'Import it from something the entry point reaches, or delete it.',
  )
  process.exit(1)
}

const waiting = awaiting.size === 0 ? '' : `; ${awaiting.size} awaiting a consumer`
console.log(
  `module graph: ok (${reached.size} modules, all reachable from an entry point${waiting})`,
)
for (const [file, why] of awaiting) console.log(`  awaiting: ${relative(root, file)}: ${why}`)
