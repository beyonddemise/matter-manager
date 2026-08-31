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
 * Usage:  node scripts/check-module-graph.mjs [--src <directory>] [--entry <file>]...
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const src = resolve(argument('--src', join(root, 'packages/web/src')))

/**
 * Where the application starts.
 *
 * `main.ts` is the only one today. Listed rather than discovered, because "what the browser
 * loads" is a fact about `index.html` and the build, not something a directory can be asked.
 */
const entries = process.argv.includes('--entry')
  ? process.argv.filter((_, i) => process.argv[i - 1] === '--entry').map((path) => resolve(path))
  : [join(src, 'main.ts')]

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
 * The compiler parser distinguishes imports from lookalikes in comments and string literals.
 */
function specifiersIn(source) {
  const file = ts.createSourceFile(
    'module.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  )
  const found = []

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }

  visit(file)
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

const orphans = [...modules(src)].filter((file) => !reached.has(file)).sort()

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

console.log(`module graph: ok (${reached.size} modules, all reachable from an entry point)`)
