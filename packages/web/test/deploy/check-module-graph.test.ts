import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const checker = join(repoRoot, 'scripts/check-module-graph.mjs')

/**
 * #120: seven modules were written, tested, and imported by nothing but their own tests. Every
 * suite passed, because each imported its module directly — which proves the module works and
 * says nothing about whether the application contains it.
 *
 * This is the check that would have caught it, and a checker nobody has watched fail is a
 * checker nobody knows works (L8). Each case plants exactly one thing and asserts the verdict
 * flips.
 */
function walk(files: Record<string, string>): { code: number; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'module-graph-test-'))
  try {
    for (const [name, contents] of Object.entries(files)) {
      const path = join(directory, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, contents)
    }
    const result = spawnSync(
      'node',
      [checker, '--src', directory, '--entry', join(directory, 'main.ts')],
      { encoding: 'utf8' },
    )
    return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('walking the import graph', () => {
  it('accepts a module the entry point imports', () => {
    const result = walk({
      'main.ts': "import './used.js'\n",
      'used.ts': 'export const used = 1\n',
    })
    expect(result.code).toBe(0)
  })

  it('reports a module nothing imports', () => {
    const result = walk({
      'main.ts': "import './used.js'\n",
      'used.ts': 'export const used = 1\n',
      'orphan.ts': 'export const orphan = 2\n',
    })
    expect(result.code).toBe(1)
    expect(result.output).toContain('orphan.ts')
  })

  it('follows a dynamic import', () => {
    // The QR fallback, the locale catalogues and every theme are reached this way deliberately.
    // Treating them as unreachable would make this fire on the code most carefully written.
    const result = walk({
      'main.ts': "const later = () => import('./lazy.js')\nvoid later()\n",
      'lazy.ts': 'export const lazy = 1\n',
    })
    expect(result.code).toBe(0)
  })

  it('ignores a commented-out import', () => {
    const result = walk({
      'main.ts': "// import './orphan.js'\n",
      'orphan.ts': 'export const orphan = 1\n',
    })
    expect(result.code).toBe(1)
    expect(result.output).toContain('orphan.ts')
  })

  it('follows an import through several files', () => {
    const result = walk({
      'main.ts': "import './a.js'\n",
      'a.ts': "import './b.js'\nexport const a = 1\n",
      'b.ts': 'export const b = 2\n',
    })
    expect(result.code).toBe(0)
  })

  it('still reports a module imported only by another orphan', () => {
    // The case that matters most, and the mechanism that hid #120's seven: a grep for the name
    // finds an importer and stops there. Reachability is not local - an orphan importing an
    // orphan leaves both outside the application.
    const result = walk({
      'main.ts': "import './used.js'\n",
      'used.ts': 'export const used = 1\n',
      'lonely.ts': "import './alsoLonely.js'\n",
      'alsoLonely.ts': 'export const value = 2\n',
    })
    expect(result.code).toBe(1)
    expect(result.output).toContain('lonely.ts')
    expect(result.output).toContain('alsoLonely.ts')
  })

  it('reaches a module in a subdirectory', () => {
    const result = walk({
      'main.ts': "import './sync/manager.js'\n",
      'sync/manager.ts': 'export const manager = 1\n',
    })
    expect(result.code).toBe(0)
  })

  it('says which modules, not merely that there were some', () => {
    // A count is not actionable. The report has to name them, because the answer differs per
    // module: wire this one, delete that one.
    const result = walk({
      'main.ts': 'export const main = 1\n',
      'first.ts': 'export const first = 1\n',
      'second.ts': 'export const second = 2\n',
    })
    expect(result.output).toContain('first.ts')
    expect(result.output).toContain('second.ts')
  })
})

describe('the application itself', () => {
  it('has no module the entry point cannot reach', () => {
    // The real tree, which is the assertion #120 asked for. It passes now because part three
    // wired the last of the seven; it did not pass before, and the point of running it here is
    // that the next omission fails rather than ships.
    const result = spawnSync('node', [checker], { encoding: 'utf8' })
    expect(`${result.stdout}${result.stderr}`).toContain('all reachable')
    expect(result.status).toBe(0)
  })
})
