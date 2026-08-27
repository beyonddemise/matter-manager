import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const checker = join(repoRoot, 'scripts/check-lazy-fallback.mjs')

/**
 * Runs the check over a throwaway `dist`.
 *
 * Fixtures rather than a real build, for the reason the other checkers use fixtures: a case has
 * to be *planted* for its verdict to mean anything, and there is no way to plant "the bundler
 * inlined the dynamic import" into a real build without breaking the application to do it.
 */
function scan(files: Record<string, string>): { code: number; output: string } {
  const dist = mkdtempSync(join(tmpdir(), 'check-lazy-fallback-test-'))
  try {
    mkdirSync(join(dist, 'assets'))
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dist, name), contents)
    }
    const result = spawnSync('node', [checker, '--scan', dist], { encoding: 'utf8' })
    return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
}

const INDEX = '<!doctype html><script type="module" src="/assets/index-aaa.js"></script>'
/** Stands in for the decoder: one of the tokens only `@zxing/library` contains. */
const DECODER = 'class ChecksumException extends Error {}'

/** The shape a correct build has: a dynamic import, and the decoder in its own chunk. */
const GOOD = {
  'index.html': INDEX,
  'assets/index-aaa.js': 'const load=()=>import("./esm-bbb.js");export{load}',
  'assets/esm-bbb.js': DECODER,
}

describe('the lazy-fallback check', () => {
  it('accepts a decoder reached only through a dynamic import', () => {
    const { code, output } = scan(GOOD)
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('accepts the build this repository actually produces', () => {
    // The positive control that matters. Skipped rather than failed when there is no build:
    // `npm test` does not build the site, and a test that demanded one would fail for everyone
    // running the suite on its own.
    const built = spawnSync('node', [checker], { encoding: 'utf8' })
    const output = `${built.stdout}${built.stderr}`
    if (output.includes('No built site')) return
    expect(output).toContain('ok')
    expect(built.status).toBe(0)
  })

  it('catches a decoder inlined into the entry chunk', () => {
    // What a bundler does when it decides the dynamic import is not worth splitting. The
    // source still reads as lazy; the download is not.
    const { code, output } = scan({
      'index.html': INDEX,
      'assets/index-aaa.js': DECODER,
    })
    expect(code).toBe(1)
    expect(output).toContain('index-aaa.js')
  })

  it('catches a decoder pulled in by a static import', () => {
    // The change this whole check exists to catch: `import { … } from '@zxing/browser'` at the
    // top of the module instead of `await import(…)` inside the function.
    const { code, output } = scan({
      'index.html': INDEX,
      'assets/index-aaa.js': 'import"./esm-bbb.js";export{}',
      'assets/esm-bbb.js': DECODER,
    })
    expect(code).toBe(1)
    expect(output).toContain('esm-bbb.js')
  })

  it('catches one reached through a chain of static imports', () => {
    // Two hops rather than one. A check that only looked at the entry chunk's own imports
    // would pass this, and this is what a shared "vendor" chunk looks like.
    const { code } = scan({
      'index.html': INDEX,
      'assets/index-aaa.js': 'import"./middle-ccc.js";export{}',
      'assets/middle-ccc.js': 'import"./esm-bbb.js";export{}',
      'assets/esm-bbb.js': DECODER,
    })
    expect(code).toBe(1)
  })

  it('does not mistake the name at the call site for the library', () => {
    // The false positive the first version of this check produced, kept as a test so it cannot
    // come back. The entry legitimately contains `BrowserQRCodeReader` — destructured out of
    // the dynamic import, right beside the `import()` that proves it is lazy.
    const { code, output } = scan({
      'index.html': INDEX,
      'assets/index-aaa.js':
        'const f=async()=>{const{BrowserQRCodeReader:R}=await import("./esm-bbb.js");return new R()}',
      'assets/esm-bbb.js': DECODER,
    })
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('refuses a build with no decoder anywhere, rather than calling it lazy', () => {
    // Absence is what a deleted fallback looks like, and what a wrong directory looks like.
    // Reading it as success is how this check would pass while proving nothing.
    const { code, output } = scan({
      'index.html': INDEX,
      'assets/index-aaa.js': 'export{}',
    })
    expect(code).toBe(1)
    expect(output).toContain('no chunk at all')
  })

  it('says so when there is no build to look at', () => {
    const empty = mkdtempSync(join(tmpdir(), 'check-lazy-fallback-test-'))
    try {
      const result = spawnSync('node', [checker, '--scan', empty], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain('No built site')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('refuses an index that loads no module at all', () => {
    const { code, output } = scan({ 'index.html': '<!doctype html><p>hello</p>' })
    expect(code).toBe(1)
    expect(output).toContain('cannot see anything')
  })
})
