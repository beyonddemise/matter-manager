/**
 * Regression tests for `scripts/check-dependencies.mjs` (#187, policy in ADR 0013).
 *
 * The cases mirror the ways the policy has actually been dodged or narrowed: a banned
 * package, an unlisted one, a dependency hiding in `peerDependencies`, a bundled package's
 * `devDependencies` (which a bundler ships anyway), and a manifest in a directory the scan
 * was never told about — the #181 shape, where scanning named paths silently stopped
 * covering anything.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runGuard, runGuardOnRepository } from './fixture.mjs'

const SCRIPT = 'check-dependencies.mjs'

const manifest = (fields) => JSON.stringify({ name: 'fixture', ...fields })

const POLICY = JSON.stringify({
  allowed: { lit: 'The component model itself.' },
  allowedDev: { vite: 'Build-only tooling for the bundled package.' },
  banned: { axios: 'Use native fetch.' },
})

/** A repository that satisfies the policy. Each case below breaks exactly one thing in it. */
const GOOD = {
  'dependency-policy.json': POLICY,
  'package.json': manifest({ dependencies: { lit: '^3.0.0' } }),
  'frontend/package.json': manifest({
    dependencies: { lit: '^3.0.0' },
    devDependencies: { vite: '^6.0.0' },
  }),
}

test('accepts a repository whose dependencies are all on the allowlist', () => {
  const { code, output } = runGuard(SCRIPT, GOOD)
  assert.equal(code, 0)
  assert.match(output, /Dependency policy: ok \(2 manifests/)
})

test('accepts the repository this check actually guards', () => {
  // The positive control (lesson L3): the refusals below are verdicts, not a harness that
  // fails whatever it is pointed at.
  const { code, output } = runGuardOnRepository(SCRIPT)
  assert.equal(code, 0)
  assert.match(output, /Dependency policy: ok/)
})

test('catches a banned dependency, with the reason it is banned', () => {
  const { code, output } = runGuard(SCRIPT, {
    ...GOOD,
    'package.json': manifest({ dependencies: { lit: '^3.0.0', axios: '^1.7.0' } }),
  })
  assert.equal(code, 1)
  assert.match(output, /BANNED\s+axios/)
  assert.match(output, /Use native fetch\./)
})

test('catches a dependency that is simply not in the policy', () => {
  const { code, output } = runGuard(SCRIPT, {
    ...GOOD,
    'package.json': manifest({ dependencies: { 'left-pad': '^1.3.0' } }),
  })
  assert.equal(code, 1)
  assert.match(output, /UNLISTED\s+left-pad/)
  assert.match(output, /Not in dependency-policy\.json/)
})

test('checks peerDependencies too — all three shipping fields reach production', () => {
  const { code, output } = runGuard(SCRIPT, {
    ...GOOD,
    'package.json': manifest({ peerDependencies: { axios: '^1.7.0' } }),
  })
  assert.equal(code, 1)
  assert.match(output, /BANNED\s+axios\s+in <root> \(peerDependencies\)/)
})

test("checks the bundled package's devDependencies — a bundler ships those as well", () => {
  const { code, output } = runGuard(SCRIPT, {
    ...GOOD,
    'frontend/package.json': manifest({ devDependencies: { 'left-pad': '^1.3.0' } }),
  })
  assert.equal(code, 1)
  assert.match(output, /UNLISTED\s+left-pad\s+in frontend \(devDependencies\)/)
})

test('leaves devDependencies alone in packages that do not ship a bundle', () => {
  const { code } = runGuard(SCRIPT, {
    ...GOOD,
    'tools/package.json': manifest({ devDependencies: { 'left-pad': '^1.3.0' } }),
  })
  assert.equal(code, 0)
})

test('finds a manifest in a directory nobody named — the walk is the point', () => {
  // The #181 regression shape: scanning only `packages/` and the root made an emptied
  // `packages/` a silent narrowing. The walk has to find a manifest wherever it appears.
  const { code, output } = runGuard(SCRIPT, {
    ...GOOD,
    'services/api/package.json': manifest({ dependencies: { axios: '^1.7.0' } }),
  })
  assert.equal(code, 1)
  assert.match(output, /BANNED\s+axios\s+in services[/\\]api/)
})

test('fails rather than passes when the policy file is missing', () => {
  // Lesson L3 again: a check that cannot find its own allowlist has nothing to enforce, and
  // "nothing to enforce" must never present as "no violations".
  const { 'dependency-policy.json': _policy, ...withoutPolicy } = GOOD
  const { code, output } = runGuard(SCRIPT, withoutPolicy)
  assert.notEqual(code, 0)
  assert.match(output, /dependency-policy\.json/)
})
