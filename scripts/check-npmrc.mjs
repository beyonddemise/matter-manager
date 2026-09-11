#!/usr/bin/env node
/**
 * Fails if `.npmrc` contains a literal auth token.
 *
 * This repository is public, so a committed token is a live credential the moment it is
 * pushed. `.npmrc` must reference the environment and nothing else.
 *
 * FAIL CLOSED. The first version of this check was an inline grep that accepted any line
 * containing `${` anywhere, which meant
 *
 *     //npm.webawesome.com/:_authToken=REALSECRET # normally ${WEBAWESOME_NPM_TOKEN}
 *
 * passed cleanly. A guard that pattern-matches "looks like it mentions a variable" is not a
 * guard. This one requires the value to BE a variable reference and rejects everything else,
 * including anything it does not understand.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every `.npmrc` in the repository, not just the root one.
 *
 * It checked `./.npmrc` alone until #181 moved the Web Awesome registry into `frontend/.npmrc`
 * — at which point the guard would have been pointed at a file that no longer held the
 * credential, and would have passed by having nothing to look at. That is the same shape as
 * the Dependabot gap #179 found: a check keyed to a path stops covering anything the moment
 * the thing it checks is moved, and nothing announces it.
 */
function npmrcFiles(dir = root, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) {
        npmrcFiles(join(dir, entry.name), found)
      }
    } else if (entry.name === '.npmrc') {
      found.push(join(dir, entry.name))
    }
  }
  return found
}

const files = npmrcFiles()

if (files.length === 0) {
  // Not "nothing to check, carry on". This repository installs Web Awesome Pro from a private
  // registry, so an .npmrc has to exist somewhere; finding none means this check has lost
  // track of the tree rather than that the tree is clean.
  console.error('No .npmrc found anywhere in the repository.')
  console.error('One is required for the Web Awesome Pro registry - see CONTRIBUTING.md.')
  process.exit(1)
}

/** The only accepted form: an environment reference, optionally surrounded by whitespace. */
// The ${...} here is literal .npmrc syntax, not a JS template placeholder.
// (No biome-ignore needed: noTemplateCurlyInString does not inspect regex
// literals, so the directive that used to sit here suppressed nothing. It
// would be needed again if this were ever rewritten as a string.)
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/

const problems = []

for (const file of files) {
  const where = relative(root, file)
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim()
      if (line === '' || line.startsWith('#') || line.startsWith(';')) return
      if (!/_auth(Token)?|_password/i.test(line)) return

      const eq = line.indexOf('=')
      if (eq === -1) {
        problems.push({ where, n: i + 1, why: 'credential line with no value to inspect', line })
        return
      }
      const value = line.slice(eq + 1).trim()
      if (!ENV_REFERENCE.test(value)) {
        problems.push({
          where,
          n: i + 1,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: describing the required literal syntax
          why: 'value must be exactly ${VARIABLE}',
          // Never echo the offending value: it may be the credential itself.
          line: `${line.slice(0, eq + 1)}<redacted>`,
        })
      }
    })
}

if (problems.length === 0) {
  for (const file of files) {
    console.log(`${relative(root, file)}: ok (credentials reference the environment only)`)
  }
  process.exit(0)
}

console.error('An .npmrc contains a credential that is not an environment reference:\n')
for (const p of problems) {
  console.error(`  ${p.where} line ${p.n}: ${p.why}`)
  console.error(`    ${p.line}\n`)
}
// biome-ignore lint/suspicious/noTemplateCurlyInString: telling the user the literal syntax to write
console.error('Use ${WEBAWESOME_NPM_TOKEN}. See CONTRIBUTING.md.')
process.exit(1)
