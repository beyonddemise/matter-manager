/**
 * Regression tests for `scripts/check-node-pins.mjs` (#187).
 *
 * The one that earns this file its place is the `||` case: `majorsOf` once read only the
 * leading number of a range, so `^24.13.4 || ^26.0.0` reported `[24]` and PASSED while the
 * declaration went on permitting Node 26 — the check saying yes to precisely the drift it
 * exists to catch. That bug reached review before anything mechanical noticed it. Now a test
 * notices it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runGuard, runGuardOnRepository } from './fixture.mjs'

const SCRIPT = 'check-node-pins.mjs'

const manifest = (fields) => JSON.stringify({ name: 'fixture', ...fields })

/** A repository in which every declaration agrees with `.nvmrc`. Each case breaks one thing. */
const GOOD = {
  '.nvmrc': '24\n',
  '.devcontainer/docker-compose.yml':
    'services:\n  app:\n    image: mcr.microsoft.com/devcontainers/typescript-node:1-24-bookworm\n',
  'package.json': manifest({
    engines: { node: '>=24' },
    devDependencies: { '@types/node': '^24.13.4' },
  }),
  'frontend/package.json': manifest({ devDependencies: { '@types/node': '^24.13.4' } }),
}

test('accepts a repository in which every declaration agrees with .nvmrc', () => {
  const { code, output } = runGuard(SCRIPT, GOOD)
  assert.equal(code, 0)
  assert.match(output, /All 4 Node declarations agree with \.nvmrc/)
})

test('accepts the repository this check actually guards', () => {
  // The positive control (lesson L3): the fixtures below prove the check can say no, this
  // proves the real tree says yes — and that the harness is not failing everything it touches.
  const { code, output } = runGuardOnRepository(SCRIPT)
  assert.equal(code, 0)
  assert.match(output, /All \d+ Node declarations agree with \.nvmrc/)
})

test('reads every || alternative: ^24.13.4 || ^26.0.0 against an .nvmrc of 24 must fail', () => {
  // The historical bug, pinned. Reading only the leading number reports [24] and passes.
  const { code, output } = runGuard(SCRIPT, {
    ...GOOD,
    'package.json': manifest({
      engines: { node: '>=24' },
      devDependencies: { '@types/node': '^24.13.4 || ^26.0.0' },
    }),
  })
  assert.equal(code, 1)
  assert.match(output, /@types\/node .* declares 26, but \.nvmrc declares 24/)
})

test('catches an engines.node pointing at a major .nvmrc does not declare', () => {
  const { code, output } = runGuard(SCRIPT, {
    ...GOOD,
    'package.json': manifest({ engines: { node: '>=26' } }),
  })
  assert.equal(code, 1)
  assert.match(output, /engines\.node .* declares 26, but \.nvmrc declares 24/)
})

test('catches a drifted devcontainer image pin', () => {
  const { code, output } = runGuard(SCRIPT, {
    ...GOOD,
    '.devcontainer/docker-compose.yml':
      'services:\n  app:\n    image: mcr.microsoft.com/devcontainers/typescript-node:1-26-bookworm\n',
  })
  assert.equal(code, 1)
  assert.match(output, /typescript-node image declares 26, but \.nvmrc declares 24/)
})

test('catches a declaration buried in a nested manifest, not only the root one', () => {
  // The walk is the guard against #181-shaped drift: a check keyed to named paths stops
  // covering anything the moment the file it checks moves.
  const { code, output } = runGuard(SCRIPT, {
    ...GOOD,
    'frontend/package.json': manifest({ devDependencies: { '@types/node': '^26.0.0' } }),
  })
  assert.equal(code, 1)
  assert.match(output, /frontend[/\\]package\.json.*declares 26, but \.nvmrc declares 24/)
})

test('a scan that finds no declarations at all fails rather than passes', () => {
  // Lesson L3: zero findings is a broken scan, not a clean repository. A renamed FROM line
  // and manifests with no Node fields must read as failure, never as agreement.
  const { code, output } = runGuard(SCRIPT, {
    '.nvmrc': '24\n',
    '.devcontainer/docker-compose.yml': 'services:\n  app:\n    image: ubuntu:24.04\n',
    'package.json': manifest({}),
  })
  assert.equal(code, 1)
  assert.match(output, /found nothing to check, but \.nvmrc declares 24/)
})

test('refuses a compound range it cannot reduce to one major, rather than guessing', () => {
  const { code, output } = runGuard(SCRIPT, {
    ...GOOD,
    'package.json': manifest({ engines: { node: '>=20 <25' } }),
  })
  assert.equal(code, 1)
  assert.match(output, /cannot reduce to one major/)
})

test('refuses an .nvmrc that does not name a Node major', () => {
  const { code, output } = runGuard(SCRIPT, { ...GOOD, '.nvmrc': 'lts/jod\n' })
  assert.equal(code, 1)
  assert.match(output, /\.nvmrc does not contain a Node major/)
})
