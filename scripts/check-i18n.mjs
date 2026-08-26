#!/usr/bin/env node
/**
 * Two i18n guards that a code review cannot reliably perform.
 *
 * **1. The catalogue is not stale.** `lit-localize` output is committed, because a checkout
 * must build without a code generation step. Committed generated files go stale silently: a
 * developer adds `msg('Add device')`, never runs extract, and the string is simply English
 * forever with nothing red anywhere. This regenerates everything into a temporary directory
 * and compares it byte for byte against what is committed. The working tree is never touched,
 * so the check is safe to run mid-edit and behaves identically on a laptop and in CI.
 *
 * **2. No unwrapped user-visible string.** That is the story's own "done when", and it is a
 * property of code not yet written as much as of code that exists. This scans `html` tagged
 * templates for text content and for user-visible attributes that are plain literals.
 *
 * The scan is a lint heuristic and is documented as one: it cannot see a string assembled in a
 * helper and returned into a template, and it does not try. What it catches reliably is the
 * actual failure mode, someone typing visible text straight into markup. `test/check-i18n.test.ts`
 * proves it catches a planted one rather than trusting that it would.
 *
 * Usage:
 *   node scripts/check-i18n.mjs              both checks, against this repository
 *   node scripts/check-i18n.mjs --scan DIR   only the literal scan, against DIR
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// The literal scan
// ---------------------------------------------------------------------------

/** Attributes whose value a user reads or hears. Not an exhaustive list of all attributes. */
const VISIBLE_ATTRIBUTES = new Set(['label', 'placeholder', 'title', 'alt', 'aria-label', 'hint'])

/** Stands in for a substitution once it has been removed from a template. */
const EXPRESSION = ' '

/** Two or more letters in a row: enough to be a word, few enough to still catch "OK". */
const LOOKS_LIKE_A_WORD = /\p{L}{2,}/u

/**
 * Reduces every `html` tagged template in `source` to its static text, with each substitution
 * replaced by {@link EXPRESSION}.
 *
 * Nested templates need no special handling: a template inside a substitution is found by this
 * same scan on its own, because the scan walks every `html` backtick in the file rather than
 * only the outermost ones.
 */
function htmlTemplateSkeletons(source) {
  const skeletons = []

  for (let i = 0; i < source.length; i++) {
    // A tag, not the word "html" inside an identifier, a string or a path.
    if (!source.startsWith('html`', i)) continue
    if (i > 0 && /[\w$.'"`/-]/.test(source[i - 1])) continue

    let cursor = i + 'html`'.length
    let skeleton = ''

    while (cursor < source.length) {
      const character = source[cursor]

      if (character === '\\') {
        cursor += 2
        continue
      }
      if (character === '`') {
        skeletons.push({ skeleton, offset: i })
        break
      }
      if (character === '$' && source[cursor + 1] === '{') {
        cursor = endOfSubstitution(source, cursor + 2)
        skeleton += EXPRESSION
        continue
      }
      skeleton += character
      cursor++
    }
  }
  return skeletons
}

/**
 * Given the index just past an opening substitution, returns the index just past its matching
 * closing brace.
 *
 * Tracks nested braces and skips over string and template literals, so a brace inside a quoted
 * value or an inner template does not close the substitution early.
 */
function endOfSubstitution(source, start) {
  let depth = 1
  let cursor = start

  while (cursor < source.length && depth > 0) {
    const character = source[cursor]

    if (character === '\\') {
      cursor += 2
      continue
    }
    if (character === '{') depth++
    else if (character === '}') depth--
    else if (character === "'" || character === '"') cursor = endOfQuoted(source, cursor)
    else if (character === '`') cursor = endOfTemplate(source, cursor)

    cursor++
  }
  return cursor
}

/** Index of the closing quote that matches the one at `start`. */
function endOfQuoted(source, start) {
  const quote = source[start]
  let cursor = start + 1
  while (cursor < source.length) {
    if (source[cursor] === '\\') cursor += 2
    else if (source[cursor] === quote) return cursor
    else cursor++
  }
  return cursor
}

/** Index of the backtick closing the template that opens at `start`, substitutions included. */
function endOfTemplate(source, start) {
  let cursor = start + 1
  while (cursor < source.length) {
    if (source[cursor] === '\\') cursor += 2
    else if (source[cursor] === '`') return cursor
    else if (source[cursor] === '$' && source[cursor + 1] === '{') {
      cursor = endOfSubstitution(source, cursor + 2) + 1
    } else cursor++
  }
  return cursor
}

/**
 * Finds text and user-visible attributes in one template skeleton that are plain literals.
 *
 * Walks the skeleton as markup rather than applying a regex to it, because "is this inside a
 * tag" is exactly the distinction that matters and a regex cannot hold it.
 */
function violationsIn(skeleton) {
  const found = []
  let cursor = 0

  while (cursor < skeleton.length) {
    const nextTag = skeleton.indexOf('<', cursor)
    const text = (nextTag === -1 ? skeleton.slice(cursor) : skeleton.slice(cursor, nextTag))
      // HTML entities are markup, not prose: `&nbsp;` is not an untranslated word.
      .replace(/&[a-zA-Z#][a-zA-Z0-9]*;/g, '')

    if (LOOKS_LIKE_A_WORD.test(text)) {
      found.push({ kind: 'text', text: text.trim().replace(/\s+/g, ' ') })
    }
    if (nextTag === -1) break

    if (skeleton.startsWith('<!--', nextTag)) {
      const end = skeleton.indexOf('-->', nextTag)
      cursor = end === -1 ? skeleton.length : end + 3
      continue
    }

    const tagEnd = skeleton.indexOf('>', nextTag)
    const tag = skeleton.slice(nextTag, tagEnd === -1 ? skeleton.length : tagEnd)

    for (const [, name, value] of tag.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)) {
      if (!VISIBLE_ATTRIBUTES.has(name.toLowerCase())) continue
      if (value.includes(EXPRESSION)) continue
      if (LOOKS_LIKE_A_WORD.test(value)) {
        found.push({ kind: 'attribute', text: `${name}="${value}"` })
      }
    }

    cursor = tagEnd === -1 ? skeleton.length : tagEnd + 1
  }
  return found
}

/** Every `.ts` file under `directory`, excluding generated output. */
function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'generated' || entry.name === 'node_modules') continue
      files.push(...sourceFiles(path))
    } else if (entry.name.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files
}

/** Runs the literal scan over a directory tree. Returns a list of human-readable problems. */
export function scanForUnwrappedStrings(directory) {
  const problems = []
  for (const file of sourceFiles(directory)) {
    const source = readFileSync(file, 'utf8')
    for (const { skeleton, offset } of htmlTemplateSkeletons(source)) {
      const line = source.slice(0, offset).split('\n').length
      for (const violation of violationsIn(skeleton)) {
        problems.push(`${relative(directory, file)}:${line}  ${violation.kind}  ${violation.text}`)
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// The drift check
// ---------------------------------------------------------------------------

/** Every file under `directory`, keyed by its path relative to it. */
function treeContents(directory) {
  const contents = new Map()
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else contents.set(relative(directory, path), readFileSync(path, 'utf8'))
    }
  }
  if (statSync(directory, { throwIfNoEntry: false })) walk(directory)
  return contents
}

/**
 * Regenerates the catalogue and the runtime modules into a temporary directory and compares.
 *
 * The generated output goes somewhere else entirely rather than over the top of the committed
 * files, so a developer running `npm run verify` with work in progress gets an answer instead
 * of a modified working tree.
 */
function checkCatalogueIsCurrent() {
  const config = JSON.parse(readFileSync(join(repoRoot, 'lit-localize.json'), 'utf8'))
  const scratch = mkdtempSync(join(tmpdir(), 'matter-manager-i18n-'))

  try {
    // `extract` MERGES: it reads the existing catalogue so that translations already written
    // survive a new message being added. Extracting into an empty directory would therefore
    // produce a catalogue with no targets at all and report every string as drifted. Seeding
    // the scratch directory with the committed catalogue reproduces what `npm run i18n` does
    // in place, which is the thing being compared against.
    cpSync(join(repoRoot, config.interchange.xliffDir), join(scratch, 'xliff'), {
      recursive: true,
    })

    const derived = {
      ...config,
      output: {
        ...config.output,
        outputDir: join(scratch, 'locales'),
        localeCodesModule: join(scratch, 'locale-codes.ts'),
      },
      interchange: { ...config.interchange, xliffDir: join(scratch, 'xliff') },
    }
    // Written inside the repository so that `inputFiles` and every other relative path in the
    // config still resolves against the same base directory it was written for.
    const derivedPath = join(repoRoot, '.lit-localize.check.json')
    writeFileSync(derivedPath, JSON.stringify(derived))

    try {
      for (const command of ['extract', 'build']) {
        execFileSync('npx', ['lit-localize', command, `--config=${derivedPath}`], {
          cwd: repoRoot,
          stdio: 'pipe',
        })
      }
    } finally {
      rmSync(derivedPath, { force: true })
    }

    const differences = []
    for (const [committed, regenerated] of [
      [join(repoRoot, config.interchange.xliffDir), join(scratch, 'xliff')],
      [join(repoRoot, config.output.outputDir), join(scratch, 'locales')],
    ]) {
      const before = treeContents(committed)
      const after = treeContents(regenerated)
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(name) !== after.get(name)) {
          differences.push(join(relative(repoRoot, committed), name))
        }
      }
    }

    const committedCodes = readFileSync(join(repoRoot, config.output.localeCodesModule), 'utf8')
    if (committedCodes !== readFileSync(join(scratch, 'locale-codes.ts'), 'utf8')) {
      differences.push(config.output.localeCodesModule)
    }
    return differences
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

const scanOnly = process.argv.indexOf('--scan')
if (scanOnly !== -1) {
  const problems = scanForUnwrappedStrings(resolve(process.argv[scanOnly + 1]))
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    problems.length === 0 ? 'i18n scan: ok' : `i18n scan: ${problems.length} problem(s)`,
  )
  process.exit(problems.length === 0 ? 0 : 1)
}

const drift = checkCatalogueIsCurrent()
const unwrapped = scanForUnwrappedStrings(join(repoRoot, 'packages/web/src'))

if (drift.length > 0) {
  console.error('The committed translation output is out of date:\n')
  for (const file of drift) console.error(`  ${file}`)
  console.error('\nRun `npm run i18n` and commit the result. If a new message appeared, the')
  console.error('XLIFF now has a trans-unit with no target: write the German before committing,')
  console.error('or the string ships as English.')
}

if (unwrapped.length > 0) {
  console.error(`${drift.length > 0 ? '\n' : ''}User-visible text is not wrapped in msg():\n`)
  for (const problem of unwrapped) console.error(`  ${problem}`)
  console.error('\nWrap it in msg(). See CONTRIBUTING.md.')
}

if (drift.length === 0 && unwrapped.length === 0) {
  console.log('i18n: ok (catalogue current, no unwrapped user-visible strings)')
  process.exit(0)
}
process.exit(1)
