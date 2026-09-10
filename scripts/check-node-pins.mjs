#!/usr/bin/env node
/**
 * Every declaration of "which Node" agrees with `.nvmrc`.
 *
 * `.nvmrc` is the runtime. Four other kinds of file have an opinion about the Node version,
 * and each of them is wrong in a different way when it drifts:
 *
 * - **Container pins** (`FROM node:24-...`) decide what production actually runs. A pin ahead
 *   of `.nvmrc` means CI tested a runtime nobody deploys; behind it, the reverse.
 * - **`@types/node`** decides what the compiler believes exists. This is the quiet one, and
 *   the reason this check grew past images (#179): `@types/node` majors track Node majors, so
 *   `^26` against a Node 24 runtime hands the compiler the Node 26 API surface. Anything added
 *   in 25 or 26 then typechecks cleanly and throws at runtime — a type checker that certifies
 *   a crash. That was the state of `main` when this file was written.
 * - **`engines.node`** is what npm refuses to install under, and what a reader takes as the
 *   supported floor.
 *
 * A floor (`>=24`) and a pin (`24`) are different statements, and this check deliberately
 * requires the same *major* from both rather than treating a looser floor as acceptable. The
 * repository has one runtime. A package claiming to support an older Node is claiming something
 * nothing here tests, and `backend`'s stale `>=22` — left behind by the move in #164 and true
 * of nothing — is what that leniency looks like in practice.
 *
 * Extracted from an inline `run:` block in `ci.yml` so it can be run before pushing, which the
 * shell version could not be. Adding the two package.json checks to thirty lines of YAML shell
 * would also have meant parsing JSON in `sed`.
 *
 * Exits 1 and names every disagreement, rather than stopping at the first: a version bump
 * usually misses several files at once, and one round trip through CI per file is the failure
 * mode this is meant to spare.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Directories that hold generated or vendored copies of files this check reads. */
const SKIP = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'test-results',
  'playwright-report',
])

/**
 * Every major a version range permits: `^24.13.4`, `~24.1`, `>=24` and `24` all yield `[24]`.
 *
 * **Every one, not the first one.** Reading only the leading number made `^24.13.4 || ^26.0.0`
 * report `[24]` and pass, while the declaration went on permitting Node 26 — the check saying
 * yes to precisely the drift it exists to catch. So each `||` alternative is read separately
 * and all of them have to agree.
 *
 * An alternative naming more than one version (`>=20 <25`) is a range this cannot reduce to a
 * major, and it says so rather than guessing: `NaN` propagates to the caller, which reports the
 * declaration as unverifiable and fails. Guessing would mean picking one end of a range and
 * calling it the answer, which is how a check comes to certify something nobody checked.
 *
 * An empty result means nothing numeric was found at all — `*`, `latest`, a typo. Also a
 * failure, in the caller: a range that pins nothing is not a range that agrees.
 */
function majorsOf(range) {
  return String(range ?? '')
    .split('||')
    .map((alternative) => alternative.trim())
    .filter((alternative) => alternative !== '')
    .map((alternative) => {
      const versions = alternative.match(/\d+(?:\.\d+)*/g) ?? []
      if (versions.length !== 1) return Number.NaN
      return Number(versions[0]?.split('.')[0])
    })
}

/** Every package.json in the repository, generated and vendored trees excluded. */
function packageManifests(dir = root, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.devcontainer') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) packageManifests(path, found)
    } else if (entry.name === 'package.json') {
      found.push(path)
    }
  }
  return found
}

/** The first capture of `pattern` on every matching line, deduplicated. */
function scan(file, pattern) {
  const contents = readFileSync(join(root, file), 'utf8')
  const found = new Set()
  for (const line of contents.split('\n')) {
    const match = pattern.exec(line)
    if (match?.[1]) found.add(Number(match[1]))
  }
  return [...found]
}

const expected = Number(readFileSync(join(root, '.nvmrc'), 'utf8').trim())
if (!Number.isInteger(expected)) {
  console.error(`.nvmrc does not contain a Node major: ${JSON.stringify(expected)}`)
  process.exit(1)
}

const problems = []
const checked = []

/**
 * @param {string} where  file the claim is made in, for the failure message
 * @param {string} what   which kind of claim, so two claims in one file stay distinguishable
 * @param {number[]} majors  every major found; empty means the pattern stopped matching
 */
function expect(where, what, majors) {
  if (majors.length === 0) {
    // An empty result is a failure, not a pass. A renamed `FROM` line or a moved field would
    // otherwise read as agreement, which is the wrong way round for a check to be wrong.
    problems.push(`${where}: ${what} — found nothing to check, but .nvmrc declares ${expected}`)
    return
  }
  for (const major of majors) {
    if (Number.isNaN(major)) {
      // Refused rather than guessed. A compound range like `>=20 <25` has no single major, and
      // picking one end of it would be this check certifying something it never established.
      problems.push(
        `${where}: ${what} is a range this check cannot reduce to one major - ` +
          `write it as a single ${expected}.x range, or teach this check to read it`,
      )
    } else if (major === expected) {
      checked.push(`  ok   ${where}: ${what} -> ${major}`)
    } else {
      problems.push(`${where}: ${what} declares ${major}, but .nvmrc declares ${expected}`)
    }
  }
}

expect('backend/Dockerfile', 'FROM node', scan('backend/Dockerfile', /^FROM node:(\d+)-/))
expect(
  '.devcontainer/docker-compose.yml',
  'typescript-node image',
  scan('.devcontainer/docker-compose.yml', /devcontainers\/typescript-node:\d+-(\d+)-/),
)

for (const manifest of packageManifests()) {
  const where = relative(root, manifest) || 'package.json'
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))

  const types = pkg.devDependencies?.['@types/node'] ?? pkg.dependencies?.['@types/node']
  if (types !== undefined) expect(where, `@types/node (${types})`, majorsOf(types))

  const engines = pkg.engines?.node
  if (engines !== undefined) expect(where, `engines.node (${engines})`, majorsOf(engines))
}

console.log(`.nvmrc declares Node ${expected}`)
for (const line of checked) console.log(line)

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) {
    // GitHub renders `::error file=` as an annotation on the file itself, which is where
    // somebody reading a failed run wants to be taken.
    const [file] = problem.split(':')
    console.error(`::error file=${file}::${problem}`)
  }
  console.error(`\n${problems.length} declaration(s) disagree with .nvmrc.`)
  process.exit(1)
}

console.log(`\nAll ${checked.length} Node declarations agree with .nvmrc.`)
