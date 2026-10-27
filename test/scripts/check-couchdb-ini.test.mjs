/**
 * Regression tests for `scripts/check-couchdb-ini.mjs` (#258).
 *
 * The devcontainer's `00-base.ini` is a copy of the backend repository's production source of
 * truth, and the agreement between the two was held by comments alone. The guard pins the
 * local copy to a committed checksum, so drift cannot pass unacknowledged. The failure the
 * suite plants is the real one: somebody edits one copy, the checksum stops matching, and the
 * guard has to refuse — naming the file and the reconciliation steps, not just "mismatch".
 *
 * A missing ini or a missing/unparseable pin fails loudly rather than reading as agreement
 * (lesson L3: a check that cannot find its subject must not report success).
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { runGuard, runGuardOnRepository } from './fixture.mjs'

const SCRIPT = 'check-couchdb-ini.mjs'
const INI = '.devcontainer/couchdb/00-base.ini'
const PIN = '.devcontainer/couchdb/00-base.ini.sha256'

const INI_CONTENTS = '[chttpd]\nrequire_valid_user = true\n'

/** The pin file as the repository commits it: comments, then the shasum-style hash line. */
function pinFor(contents) {
  const hash = createHash('sha256').update(contents).digest('hex')
  return `# pinned copy of matter-manager-backend infra/couchdb/00-base.ini\n${hash}  ${INI}\n`
}

test('accepts an ini that matches its committed pin', () => {
  const { code, output } = runGuard(SCRIPT, {
    [INI]: INI_CONTENTS,
    [PIN]: pinFor(INI_CONTENTS),
  })
  assert.equal(code, 0)
  assert.match(output, /matches its committed pin/)
})

test('accepts the pair this repository actually commits', () => {
  // The positive control (lesson L3): proof the guard says yes to the tree it guards, so the
  // refusals below are verdicts rather than a harness that fails everything.
  const { code, output } = runGuardOnRepository(SCRIPT)
  assert.equal(code, 0)
  assert.match(output, /matches its committed pin/)
})

test('refuses a drifted ini, naming the file and the reconciliation steps', () => {
  const { code, output } = runGuard(SCRIPT, {
    [INI]: `${INI_CONTENTS}; a local edit nobody reconciled\n`,
    [PIN]: pinFor(INI_CONTENTS),
  })
  assert.equal(code, 1)
  // The refusal has to say what to do, not just that something is wrong: diff against the
  // backend repository's copy (the production source of truth), reconcile, re-pin.
  assert.match(output, /\.devcontainer\/couchdb\/00-base\.ini/)
  assert.match(output, /matter-manager-backend/)
  assert.match(output, /diff/)
  assert.match(output, /00-base\.ini\.sha256/)
})

test('a drift refusal prints the computed hash, so re-pinning needs no extra tooling', () => {
  const drifted = `${INI_CONTENTS}[cors]\norigins = http://localhost:5173\n`
  const { code, output } = runGuard(SCRIPT, {
    [INI]: drifted,
    [PIN]: pinFor(INI_CONTENTS),
  })
  assert.equal(code, 1)
  assert.ok(
    output.includes(createHash('sha256').update(drifted).digest('hex')),
    'the refusal must print the hash of what the file now contains',
  )
})

test('a missing ini fails rather than passes', () => {
  // Lesson L3: the file this guard protects being gone is the loudest possible drift, not a
  // reason to have nothing to say.
  const { code, output } = runGuard(SCRIPT, { [PIN]: pinFor(INI_CONTENTS) })
  assert.equal(code, 1)
  assert.match(output, /\.devcontainer\/couchdb\/00-base\.ini/)
})

test('a missing pin fails rather than passes', () => {
  const { code, output } = runGuard(SCRIPT, { [INI]: INI_CONTENTS })
  assert.equal(code, 1)
  assert.match(output, /00-base\.ini\.sha256/)
})

test('an unparseable pin fails rather than passes', () => {
  // A pin file holding no recognisable hash — comments only, a truncated hash, prose — means
  // the check has lost its reference value. Guessing would make the guard certify agreement
  // with nothing.
  const { code, output } = runGuard(SCRIPT, {
    [INI]: INI_CONTENTS,
    [PIN]: '# comments only, the hash line went missing in a merge\n',
  })
  assert.equal(code, 1)
  assert.match(output, /no sha256 hash/i)
})

test('a pin with a stray non-hash line fails rather than skipping it', () => {
  // The line a merge leaves behind: one valid hash line plus `<<<<<<< HEAD`. A parser that
  // quietly drops lines it does not recognise would pass this pin — fail-open on exactly the
  // corruption a pin file is most likely to suffer (PR #313 review).
  const { code, output } = runGuard(SCRIPT, {
    [INI]: INI_CONTENTS,
    [PIN]: `${pinFor(INI_CONTENTS)}<<<<<<< HEAD\n`,
  })
  assert.equal(code, 1)
  assert.match(output, /00-base\.ini\.sha256/)
  assert.match(output, /not a sha256 hash/i)
})

test('a truncated hash is a non-hash line, not a near-miss to accept', () => {
  const truncated = createHash('sha256').update(INI_CONTENTS).digest('hex').slice(0, 63)
  const { code, output } = runGuard(SCRIPT, {
    [INI]: INI_CONTENTS,
    [PIN]: `${truncated}  ${INI}\n`,
  })
  assert.equal(code, 1)
  assert.match(output, /not a sha256 hash/i)
})

test('a pin with two competing hashes fails rather than picking one', () => {
  const hash = createHash('sha256').update(INI_CONTENTS).digest('hex')
  const other = createHash('sha256').update('something else').digest('hex')
  const { code, output } = runGuard(SCRIPT, {
    [INI]: INI_CONTENTS,
    [PIN]: `${hash}  ${INI}\n${other}  ${INI}\n`,
  })
  assert.equal(code, 1)
  assert.match(output, /exactly one/i)
})
