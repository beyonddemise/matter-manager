import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const checker = join(packageRoot, 'scripts/check-lazy-svg.mjs')

/** The repository's list states nothing about these fixtures, so each scan brings its own. */
const AWAITING = { 'layouts/sanitise.ts': 'the layout view' }
const WIRED = {}

/** Runs the check over a throwaway `dist`, with the awaiting-consumer list given. */
function scan(
  files: Record<string, string>,
  awaiting: Record<string, string>,
): { code: number; output: string } {
  const dist = mkdtempSync(join(tmpdir(), 'check-lazy-svg-test-'))
  try {
    mkdirSync(join(dist, 'assets'))
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(dist, name), contents)
    const list = join(dist, 'awaiting.json')
    writeFileSync(list, JSON.stringify(awaiting))
    const result = spawnSync('node', [checker, '--scan', dist, '--awaiting', list], {
      encoding: 'utf8',
    })
    return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
}

const INDEX = '<!doctype html><script type="module" src="/assets/index-aaa.js"></script>'
/** Stands in for DOMPurify: one of the configuration keys only the library itself reads. */
const SANITISER = 'const c={};if(c.SAFE_FOR_TEMPLATES){}'

const LAZY = {
  'index.html': INDEX,
  'assets/index-aaa.js': 'const load=()=>import("./sanitise-bbb.js");export{load}',
  'assets/sanitise-bbb.js': SANITISER,
}

describe('while the sanitiser awaits its consumer', () => {
  it('accepts a build that does not contain it', () => {
    const { code, output } = scan(
      { 'index.html': INDEX, 'assets/index-aaa.js': 'export{}' },
      AWAITING,
    )
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('refuses a build that contains it, even lazily: nothing should import it yet', () => {
    const { code, output } = scan(LAZY, AWAITING)
    expect(code).toBe(1)
    expect(output).toContain('sanitise-bbb.js')
  })
})

describe('once the sanitiser is wired in', () => {
  it('accepts a sanitiser reached only through a dynamic import', () => {
    const { code, output } = scan(LAZY, WIRED)
    expect(output).toContain('reached only by dynamic import')
    expect(code).toBe(0)
  })

  it('catches a sanitiser inlined into the entry chunk', () => {
    const { code, output } = scan({ 'index.html': INDEX, 'assets/index-aaa.js': SANITISER }, WIRED)
    expect(code).toBe(1)
    expect(output).toContain('index-aaa.js')
  })

  it('catches one reached through a chain of static imports', () => {
    const { code } = scan(
      {
        'index.html': INDEX,
        'assets/index-aaa.js': 'import"./middle-ccc.js";export{}',
        'assets/middle-ccc.js': 'import"./sanitise-bbb.js";export{}',
        'assets/sanitise-bbb.js': SANITISER,
      },
      WIRED,
    )
    expect(code).toBe(1)
  })

  it('does not mistake the call site for the library', () => {
    // The entry legitimately names the configuration sanitise.ts writes, beside the import().
    const { code } = scan(
      {
        ...LAZY,
        'assets/index-aaa.js':
          'const load=()=>import("./sanitise-bbb.js");const c={USE_PROFILES:1,RETURN_DOM:1};export{load,c}',
      },
      WIRED,
    )
    expect(code).toBe(0)
  })

  it('refuses a build with no sanitiser anywhere, rather than calling it lazy', () => {
    const { code, output } = scan({ 'index.html': INDEX, 'assets/index-aaa.js': 'export{}' }, WIRED)
    expect(code).toBe(1)
    expect(output).toContain('no chunk at all')
  })

  it('refuses a chunk it cannot resolve', () => {
    const { code, output } = scan(
      { 'index.html': INDEX, 'assets/index-aaa.js': 'import"../elsewhere/x.js";export{}' },
      WIRED,
    )
    expect(code).toBe(1)
    expect(output).toContain('cannot resolve')
  })
})

describe('the build this repository produces', () => {
  it('passes, when there is one to look at', () => {
    // Skipped rather than failed without a build: `npm test` does not build the site.
    const built = spawnSync('node', [checker], { encoding: 'utf8' })
    const output = `${built.stdout}${built.stderr}`
    if (output.includes('No built site')) return
    expect(output).toContain('ok')
    expect(built.status).toBe(0)
  })
})
