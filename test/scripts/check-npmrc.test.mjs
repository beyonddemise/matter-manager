/**
 * Regression tests for `scripts/check-npmrc.mjs` (#187).
 *
 * This repository is public, so the failure the guard exists for is a pushed credential —
 * which is why the suite plants literal tokens and watches them be refused, including the
 * bypass the first (grep-based) version of the guard accepted: a literal token on a line that
 * merely *mentions* a variable. It also asserts the refusal never echoes the planted value,
 * because the failure report lands in public CI logs.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runGuard, runGuardOnRepository } from './fixture.mjs'

const SCRIPT = 'check-npmrc.mjs'

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal .npmrc syntax, not a JS template
const ENV_LINE = '//npm.webawesome.com/:_authToken=${WEBAWESOME_NPM_TOKEN}\n'

test('accepts a credential that references the environment', () => {
  const { code, output } = runGuard(SCRIPT, { '.npmrc': ENV_LINE })
  assert.equal(code, 0)
  assert.match(output, /ok \(credentials reference the environment only\)/)
})

test('accepts the .npmrc files this repository actually commits', () => {
  // The positive control (lesson L3): proof the guard says yes to the tree it guards, so the
  // refusals below are verdicts rather than a harness that fails everything.
  const { code, output } = runGuardOnRepository(SCRIPT)
  assert.equal(code, 0)
  assert.match(output, /ok/)
})

test('catches a literal token, and never echoes it', () => {
  const planted = 'npm_PLANTEDSECRETVALUE'
  const { code, output } = runGuard(SCRIPT, {
    '.npmrc': `//npm.webawesome.com/:_authToken=${planted}\n`,
  })
  assert.equal(code, 1)
  assert.match(output, /value must be exactly \$\{VARIABLE\}/)
  // The report may be the only place the credential would leak next: CI logs are public.
  assert.ok(!output.includes(planted), 'the refusal must redact the planted credential')
})

test('catches a literal token even when the line mentions a variable', () => {
  // The historical bypass: the first version of this guard accepted any line containing `${`
  // anywhere, so a real token followed by a comment naming the variable passed cleanly.
  const planted = 'PLANTEDREALSECRET'
  const { code, output } = runGuard(SCRIPT, {
    '.npmrc': `//npm.webawesome.com/:_authToken=${planted} # normally \${WEBAWESOME_NPM_TOKEN}\n`,
  })
  assert.equal(code, 1)
  assert.ok(!output.includes(planted), 'the refusal must redact the planted credential')
})

test('catches a credential in a nested .npmrc, not only the root one', () => {
  // #181 moved the registry line into frontend/.npmrc; a guard keyed to the root path would
  // have gone on passing by having nothing to look at.
  const { code, output } = runGuard(SCRIPT, {
    'frontend/.npmrc': '//npm.webawesome.com/:_password=hunter2\n',
  })
  assert.equal(code, 1)
  assert.match(output, /frontend[/\\]\.npmrc line 1/)
  assert.ok(!output.includes('hunter2'), 'the refusal must redact the planted credential')
})

test('refuses a credential line with no value to inspect', () => {
  const { code, output } = runGuard(SCRIPT, { '.npmrc': `${ENV_LINE}_authToken\n` })
  assert.equal(code, 1)
  assert.match(output, /credential line with no value to inspect/)
})

test('reads comments as comments', () => {
  const { code } = runGuard(SCRIPT, {
    '.npmrc': `# _authToken=not-a-real-credential\n; _password=also-a-comment\n${ENV_LINE}`,
  })
  assert.equal(code, 0)
})

test('finding no .npmrc anywhere fails rather than passes', () => {
  // Lesson L3, and the guard's own documented stance: this repository needs an .npmrc for the
  // Web Awesome Pro registry, so an empty scan means the check lost the tree, not that the
  // tree is clean.
  const { code, output } = runGuard(SCRIPT, {})
  assert.equal(code, 1)
  assert.match(output, /No \.npmrc found anywhere in the repository/)
})
