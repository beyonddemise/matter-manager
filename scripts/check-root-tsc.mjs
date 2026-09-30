#!/usr/bin/env node
/**
 * No script in the ROOT package may invoke `tsc`.
 *
 * Two TypeScripts are installed in this repository on purpose. `frontend` and `backend` each
 * hold `^7` — the Go port — and compile with it; the root holds `^5` for `openapi-typescript`
 * alone, which builds its output by constructing a TypeScript AST and therefore needs the
 * compiler API that `^7` does not publish. They cannot be one version, and they must not share
 * a `node_modules`: both declare `bin.tsc`, so whichever npm links last wins. That is why the
 * generator and its compiler live at the root, where nothing is compiled.
 *
 * The residual hazard is the bin. `npx tsc` resolves upward, so from `backend/` or `frontend/`
 * it means 7, and **from the repository root it silently means 5.9.3**. A root script that
 * reached for `tsc` would therefore compile against a different compiler from the one the
 * package it was compiling declares, and succeed: 5 accepts almost everything 7 does. The
 * failure is not a broken build, it is a build that was checked by the wrong thing — the same
 * shape as `@types/node@^26` against a Node 24 runtime, which `check-node-pins.mjs` exists for.
 *
 * `dependency-policy.json` records the arrangement and states the premise it rests on: "the
 * root compiles nothing, so the 5 there is reached only by the generator". Prose is not a
 * guard. This is.
 *
 * FAIL CLOSED, in both directions:
 *
 * - An empty or missing `scripts` block is a failure, not a clean pass. A scan over nothing
 *   agrees with everything, and this branch has already produced six assertions that passed
 *   while checking nothing.
 * - If the root's TypeScript ever stops differing in major from the bundled packages', the
 *   collision this protects against is gone and so is the reason for this file. It says so and
 *   fails, rather than staying green while guarding a hazard that no longer exists.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Directories holding generated or vendored copies of files this check would otherwise read. */
const SKIP = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'test-results',
  'playwright-report',
])

/**
 * Whether one shell word runs the TypeScript compiler.
 *
 * Matched on the word's **basename**, so `tsc`, `npx tsc`, `node_modules/.bin/tsc` and
 * `./node_modules/typescript/bin/tsc.js` are all caught. Matched on a whole word rather than a
 * substring, so `tsconfig.json`, `biome check tsconfig.build.json` and a script named
 * `check:tsc-policy` are not — a guard that fired on those would be turned off within a week,
 * which is the only failure mode worse than not having one.
 */
function runsTsc(word) {
  return /^tsc(\.(js|cjs|mjs|cmd|exe))?$/.test(word.split(/[/\\]/).pop() ?? '')
}

/**
 * Every word of a script command, split on the shell metacharacters that start a new one.
 *
 * `&&`, `;` and `|` are what a chained script is written with, and each of them introduces a
 * fresh command — so `biome check . && tsc --build` has to be read as two, not as one string
 * that happens to start with `biome`.
 */
function wordsOf(command) {
  return String(command)
    .split(/[\s;&|()<>"']+/)
    .filter((word) => word !== '')
}

/** Every package.json in the repository, generated and vendored trees excluded. */
function packageManifests(dir = root, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) packageManifests(path, found)
    } else if (entry.name === 'package.json') {
      found.push(path)
    }
  }
  return found
}

/** The major a version range asks for, or `NaN` when it names more than one thing. */
function majorOf(range) {
  const versions = String(range ?? '').match(/\d+(?:\.\d+)*/g) ?? []
  if (versions.length !== 1) return Number.NaN
  return Number(versions[0]?.split('.')[0])
}

const problems = []
const checked = []

const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const scripts = rootManifest.scripts ?? {}
const names = Object.keys(scripts)

if (names.length === 0) {
  // The positive control. A root package with no scripts would pass every assertion below by
  // giving them nothing to disagree with, and would do it silently.
  console.error('package.json declares no scripts, so this check inspected nothing.')
  console.error('The root package has scripts; finding none means this check is looking at')
  console.error('the wrong file rather than that the scripts are clean.')
  process.exit(1)
}

for (const name of names) {
  const offending = wordsOf(scripts[name]).filter(runsTsc)
  if (offending.length === 0) continue
  problems.push(
    `package.json: script "${name}" invokes ${offending.join(', ')} - ` +
      'from the repository root that resolves to TypeScript 5, not the 7 that ' +
      'frontend and backend compile with. Run it with `npm --prefix <package> run ...`.',
  )
}

/**
 * The premise: the root's compiler is still a different major from the bundled ones.
 *
 * This is the fact that makes a root `tsc` dangerous rather than merely untidy. If somebody
 * unifies the versions - because `openapi-typescript` gains support for the Go port, most
 * likely - then `npx tsc` means the same compiler everywhere, and this file is guarding nothing
 * while reporting success. Checked so that unifying them is a deliberate edit here.
 */
const rootTypeScript = rootManifest.devDependencies?.typescript
if (rootTypeScript === undefined) {
  problems.push(
    'package.json: no devDependencies.typescript at the root. If the compiler has moved out ' +
      'of the root package there is no bin left to resolve to the wrong version, and this ' +
      'check should be deleted rather than left passing.',
  )
} else {
  const rootMajor = majorOf(rootTypeScript)
  const bundled = []
  for (const manifest of packageManifests()) {
    const where = relative(root, manifest)
    if (where === 'package.json' || where === '') continue
    const declared = JSON.parse(readFileSync(manifest, 'utf8')).devDependencies?.typescript
    if (declared !== undefined) bundled.push({ where, major: majorOf(declared), declared })
  }

  if (bundled.length === 0) {
    problems.push(
      'no package other than the root declares typescript, so there is no second major for ' +
        'a root `tsc` to be the wrong one of. Either a package.json moved, or the arrangement ' +
        'dependency-policy.json describes has changed and this check is stale.',
    )
  }
  for (const { where, major, declared } of bundled) {
    if (Number.isNaN(major) || Number.isNaN(rootMajor)) {
      problems.push(
        `${where}: typescript (${declared}) or the root's (${rootTypeScript}) is a range this ` +
          'check cannot reduce to one major. Refused rather than guessed.',
      )
    } else if (major === rootMajor) {
      problems.push(
        `${where}: typescript (${declared}) is now the same major as the root's ` +
          `(${rootTypeScript}). The bin collision this check protects against is gone - ` +
          'delete scripts/check-root-tsc.mjs and its entry in dependency-policy.json, or say ' +
          'here why it is still needed.',
      )
    } else {
      checked.push(`  ok   ${where}: typescript ${declared} vs the root's ${rootTypeScript}`)
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    // `::error file=` renders as an annotation on the file itself, which is where somebody
    // reading a failed run wants to be taken.
    const [file] = problem.split(':')
    console.error(`::error file=${file}::${problem}`)
  }
  console.error(`\n${problems.length} problem(s). See dependency-policy.json on typescript.`)
  process.exit(1)
}

console.log(`package.json: ok (none of ${names.length} root scripts invokes tsc)`)
for (const line of checked) console.log(line)
