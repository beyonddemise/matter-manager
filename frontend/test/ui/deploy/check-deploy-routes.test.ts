import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const checker = join(packageRoot, 'scripts/check-deploy-routes.mjs')
const missingDbFixture = join(packageRoot, 'test/ui/deploy/fixtures/routes-missing-db')

/**
 * Runs the routes check over a throwaway `_routes.json`.
 *
 * The same shape as the headers checker's test, and for the same reason: a checker nobody has
 * watched fail is a checker nobody knows works. Each case below plants exactly one thing and
 * asserts the verdict flips - including a positive control, so a checker that failed everything
 * would not read as thorough.
 */
function scan(routes: unknown): { code: number; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'check-deploy-routes-test-'))
  try {
    writeFileSync(join(directory, '_routes.json'), JSON.stringify(routes))
    const result = spawnSync('node', [checker, '--scan', directory], { encoding: 'utf8' })
    return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** A contract that covers both forwarded prefixes and excludes nothing. */
const GOOD = { version: 1, include: ['/api/*', '/db/*'], exclude: [] }

describe('the deployment routing contract', () => {
  it('accepts a contract that covers both /api and /db', () => {
    const { code, output } = scan(GOOD)
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('accepts the contract this repository actually deploys', () => {
    // The positive control that matters: every case below proves the checker can say no, and
    // this one proves the file it guards says yes. Run without --scan, against the real thing.
    const result = spawnSync('node', [checker], { encoding: 'utf8' })
    expect(`${result.stdout}${result.stderr}`).toContain('ok')
    expect(result.status).toBe(0)
  })

  it('catches the fixture this directory exists to prove: /db missing from include', () => {
    // The committed negative fixture, run in place rather than replanted here - the plan's
    // manual repro step (`node scripts/check-deploy-routes.mjs --scan
    // test/ui/deploy/fixtures/routes-missing-db`) names this exact path, so it stays live
    // rather than becoming a file nothing exercises after the day it was written.
    const result = spawnSync('node', [checker, '--scan', missingDbFixture], { encoding: 'utf8' })
    const output = `${result.stdout}${result.stderr}`
    expect(result.status).toBe(1)
    expect(output).toContain('/db')
  })

  it('catches an exclude pattern that silently overrides an include', () => {
    // Cloudflare evaluates `exclude` before `include`, so a pattern here wins even though the
    // same prefix also appears in `include` and reads, at a glance, as covered.
    const { code, output } = scan({ ...GOOD, exclude: ['/db/*'] })
    expect(code).toBe(1)
    expect(output).toContain('/db')
    expect(output).toContain('exclude pattern covers it')
  })

  it('rejects a version other than 1', () => {
    // Cloudflare accepts only version 1 and would refuse the deploy - checked here so the
    // message names the file rather than arriving as an API error.
    const { code, output } = scan({ ...GOOD, version: 2 })
    expect(code).toBe(1)
    expect(output).toContain('version')
  })

  it('rejects include that is not an array', () => {
    // With nothing included, no request invokes a Function and every path serves the app shell.
    const { code, output } = scan({ ...GOOD, include: '/api/*' })
    expect(code).toBe(1)
    expect(output).toContain('include is not an array')
  })

  it('says so when there is no _routes.json to check', () => {
    // An absent file is not "nothing to check": without it wrangler generates one from the
    // functions tree, which is usually right and is not what was reviewed.
    const directory = mkdtempSync(join(tmpdir(), 'check-deploy-routes-test-'))
    try {
      const result = spawnSync('node', [checker, '--scan', directory], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain('_routes.json')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // Not covered here: an `include` entry whose route file does not exist under `functions/`.
  // That check only runs against the real tree (`scanIndex === -1` in the checker), because a
  // fixture directory has no `functions/` beside it to check against - there is no `--scan`
  // argument that can drive it, so it is left unexercised by design rather than by oversight.
})
