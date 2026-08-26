import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = join(dirname(fileURLToPath(import.meta.url)), '../src')

/** Static and dynamic imports alike: `from '…'`, `import '…'`, `import('…')`. */
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

/** The pouchdb packages a chunk of source imports. */
function pouchdbImports(text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER)]
    .map(([, specifier]) => specifier ?? '')
    .filter((specifier) => specifier.startsWith('pouchdb'))
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('this package constructs no database', () => {
  const files = sourceFiles(source)

  it('has source files to check, so the assertion below is not about nothing', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('imports no pouchdb package at all', () => {
    // `pouchdb-core` and `pouchdb-adapter-memory` are devDependencies of a package whose code
    // reaches the browser, and `dependency-policy.json` claims they are "provably absent from
    // the built output". This is that proof: nothing in src imports them, so nothing can
    // bundle them. The only PouchDB name in src is the *type* `PouchDB.Database`, erased at
    // compile time.
    const offenders = files.flatMap((file) =>
      pouchdbImports(readFileSync(file, 'utf8')).map(
        (specifier) => `${relative(source, file)} imports ${specifier}`,
      ),
    )

    expect(offenders).toEqual([])
  })

  it('would notice an import if one appeared', () => {
    // The same function, not a copy of it. Asserting an empty result is only meaningful if the
    // scan can produce a non-empty one, and a scan whose pattern quietly stopped matching this
    // codebase's import style would pass the test above forever.
    const planted = [
      `import PouchDB from 'pouchdb-browser'`,
      `const adapter = await import("pouchdb-adapter-memory")`,
      `import 'pouchdb-core'`,
      `import { documentId } from '@matter-manager/core'`,
    ].join('\n')

    expect(pouchdbImports(planted)).toEqual([
      'pouchdb-browser',
      'pouchdb-adapter-memory',
      'pouchdb-core',
    ])
  })
})
