#!/usr/bin/env node
/**
 * The devcontainer's CouchDB ini still matches its committed pin.
 *
 * `.devcontainer/couchdb/00-base.ini` is a copy. The original lives in the backend repository
 * (`matter-manager-backend`, `infra/couchdb/00-base.ini`), which is what the production image
 * is built from, and until #258 the agreement between the two was held by comments on both
 * sides — nothing failed when they drifted. The failure mode is the usual one: an auth or
 * CORS fix lands in the backend's copy, the devcontainer keeps the old behaviour, and dev
 * CouchDB stops matching production in exactly the settings the stack depends on most
 * (authentication handlers, validate_doc_update) — surfacing as sync bugs that reproduce
 * nowhere.
 *
 * This is the issue's option 1: a sha256 of the agreed contents, committed next to the file
 * in `00-base.ini.sha256`. Editing the ini then forces re-reading the pair and bumping the
 * pin — acknowledging the pair rather than drifting past it. Deliberately not option 2 (fetch
 * the backend's raw file in CI): that adds a cross-repo fetch to fork PRs, which the dev-image
 * job avoids on purpose. The trade-off is explicit: a backend-side change is caught the next
 * time this file is touched or the pin is bumped, not the moment it lands over there.
 *
 * Fails loudly — not silently passing — when the ini or the pin is missing or the pin holds
 * no recognisable hash (lesson L3): a check that cannot find its subject has lost the tree,
 * and reporting success would be the wrong way round for a check to be wrong.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const INI = '.devcontainer/couchdb/00-base.ini'
const PIN = '.devcontainer/couchdb/00-base.ini.sha256'
const SOURCE_OF_TRUTH = 'matter-manager-backend: infra/couchdb/00-base.ini'

/** How to reconcile, printed on every refusal: a drift check that only says "mismatch" leaves
 * the reader to rediscover which copy is authoritative and where the pin lives. */
const HOW_TO_FIX = [
  `${INI} is pinned to the backend repository's copy (${SOURCE_OF_TRUTH}),`,
  'which production is built from. To reconcile:',
  `  1. diff ${INI} against the backend repository's infra/couchdb/00-base.ini`,
  '  2. make the two agree (the backend copy is the source of truth)',
  `  3. replace the hash line in ${PIN} with the sha256 of the agreed file`,
  `     (this check prints it, or: shasum -a 256 ${INI})`,
].join('\n')

/** Exits 1 with a GitHub error annotation on `file`, plus the reconciliation steps. */
function refuse(file, message) {
  console.error(`::error file=${file}::${message}`)
  console.error(`\n${message}\n\n${HOW_TO_FIX}`)
  process.exit(1)
}

/** The file's bytes, or a loud refusal — a missing file must not read as agreement. */
function read(file, why) {
  try {
    return readFileSync(join(root, file))
  } catch {
    refuse(file, `${file} is missing — ${why}`)
  }
}

const ini = read(INI, 'the devcontainer CouchDB image cannot build without it')
const pin = read(PIN, `the drift pin for ${INI} has to be committed alongside it`)

/**
 * The pinned hash: the single 64-hex-digit token among the pin file's non-comment lines
 * (shasum format, `<hash>  <path>`). Zero hashes means the pin lost its value in an edit or a
 * merge; more than one means nobody can say which the agreement is. And a line that is
 * *neither* a comment nor a hash — a `<<<<<<< HEAD` conflict marker, a truncated hash, stray
 * prose — refuses too, rather than being skipped: a parser that quietly drops what it does not
 * recognise is fail-open on exactly the corruption a pin file is most likely to suffer
 * (PR #313 review). All three refuse rather than guess — a pin this check picked itself would
 * certify agreement with nothing.
 */
function pinnedHash(contents) {
  const lines = contents
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  const strays = lines.filter((line) => !/^[0-9a-f]{64}\b/.test(line))
  if (strays.length > 0) {
    refuse(
      PIN,
      `${PIN} holds a line that is not a sha256 hash (${JSON.stringify(strays[0])}) — ` +
        'the pin is unparseable, and refusing beats guessing which line is the pin',
    )
  }
  const hashes = lines.map((line) => line.slice(0, 64))
  if (hashes.length !== 1) {
    refuse(
      PIN,
      hashes.length === 0
        ? `${PIN} holds no sha256 hash — the pin is unparseable, so there is nothing to check against`
        : `${PIN} holds ${hashes.length} hashes where exactly one is expected`,
    )
  }
  return hashes[0]
}

const expected = pinnedHash(pin)
const actual = createHash('sha256').update(ini).digest('hex')

if (actual !== expected) {
  refuse(
    INI,
    `${INI} no longer matches its committed pin.\n` +
      `  pinned:  ${expected}\n` +
      `  actual:  ${actual}`,
  )
}

console.log(`${INI} matches its committed pin (${expected}).`)
