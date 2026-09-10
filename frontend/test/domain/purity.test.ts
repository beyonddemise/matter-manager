import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const domain = join(packageRoot, 'src/domain')

/**
 * `src/domain` depends on nothing.
 *
 * Until #181 this was structural: `packages/core` was a separate package with an empty
 * dependency list and its own `tsconfig`, so importing Lit from it was not a policy violation
 * but a resolution failure. Merging the three packages removes both halves of that. Half comes
 * back as `tsconfig.domain.json`, which strips `lib` and `types` so `document` and `process`
 * stop existing for these files.
 *
 * This is the other half, and it covers what the compiler provably cannot: **PouchDB, Lit and
 * Web Awesome all ship their own type definitions**, so `"types": []` does not hide them.
 * `import { LitElement } from 'lit'` typechecks perfectly under `tsconfig.domain.json`. Only a
 * rule about imports catches it.
 *
 * **It walks the graph transitively**, and that is the point rather than thoroughness for its
 * own sake. A direct-imports-only check reads `src/domain/**` and finds nothing but relative
 * paths — while a domain module quietly imports `../ui/theme.js`, which imports Lit. The
 * violation is one hop away from where a shallow check looks, which is where this kind of rot
 * always starts.
 */

/** Static and dynamic imports alike: `from '…'`, `import '…'`, `import('…')`. */
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

function specifiersIn(text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER)].map(([, specifier]) => specifier ?? '')
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

/**
 * The file a relative specifier names, or null when it names nothing on disk.
 *
 * Source here is written in the TypeScript ESM style — `./thing.js` referring to `thing.ts` —
 * so the `.js` has to be mapped back before anything exists to read. Vite does the same when
 * it bundles; 101 imports in `src/ui` rely on it.
 */
function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier)
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, join(base, 'index.ts')]
  return candidates.find((candidate) => candidate.endsWith('.ts') && existsSync(candidate)) ?? null
}

/**
 * Every violation reachable from `src/domain`, each with the chain that reached it.
 *
 * Returned rather than asserted so the "would notice" test below can drive the same function
 * against a planted tree instead of a copy of its logic.
 */
function escapes(roots: string[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const queue = roots.map((file) => ({ file, via: [] as string[] }))

  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    const { file, via } = next
    if (seen.has(file)) continue
    seen.add(file)

    const chain = [...via, relative(packageRoot, file)]
    for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        problems.push(`${chain.join(' -> ')} imports the package '${specifier}'`)
        continue
      }
      const target = resolveRelative(file, specifier)
      if (target === null) continue
      if (!target.startsWith(`${domain}/`)) {
        problems.push(`${chain.join(' -> ')} imports ${relative(packageRoot, target)}`)
      }
      // Followed either way. A file outside the domain is already a violation, and following
      // it is what turns "domain imports ui/theme" into "domain imports ui/theme, which
      // imports lit" - the second line being the one that explains why the first matters.
      queue.push({ file: target, via: chain })
    }
  }
  return problems
}

describe('src/domain depends on nothing', () => {
  const files = sourceFiles(domain)

  it('has source files to check, so the assertion below is not about nothing', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('reaches no package and no file outside src/domain, however indirectly', () => {
    expect(escapes(files)).toEqual([])
  })

  it('would notice an escape if one appeared', () => {
    // The same function, not a copy of it. Asserting an empty result is only meaningful if the
    // scan can produce a non-empty one, and a scan whose pattern quietly stopped matching this
    // codebase's import style would pass the test above forever.
    //
    // Driven from `src/ui`, which is real code that really does import packages - so this
    // stays true without a fixture to maintain, and fails if the UI ever becomes something
    // this scan cannot read.
    const fromUi = escapes(sourceFiles(join(packageRoot, 'src/ui')))

    expect(fromUi.some((problem) => problem.includes("imports the package 'lit'"))).toBe(true)
  })

  it('reports the chain, not just the endpoint', () => {
    // The transitive half, stated as its own expectation because it is the half a shallow
    // check silently lacks. Starting at a UI module that imports another UI module, the
    // report must name both hops - otherwise "domain imports ui/theme" would be all anyone
    // saw, and why that matters would be left to the reader.
    const chained = escapes([join(packageRoot, 'src/ui/app-shell.ts')]).filter((problem) =>
      problem.includes(' -> '),
    )

    expect(chained.length).toBeGreaterThan(0)
  })
})
