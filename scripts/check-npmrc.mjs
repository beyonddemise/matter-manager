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

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, '.npmrc')

if (!existsSync(file)) {
  console.log('.npmrc: not present, nothing to check')
  process.exit(0)
}

/** The only accepted form: an environment reference, optionally surrounded by whitespace. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the literal npmrc syntax
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/

const problems = []

readFileSync(file, 'utf8')
  .split('\n')
  .forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return
    if (!/_auth(Token)?|_password/i.test(line)) return

    const eq = line.indexOf('=')
    if (eq === -1) {
      problems.push({ n: i + 1, why: 'credential line with no value to inspect', line })
      return
    }
    const value = line.slice(eq + 1).trim()
    if (!ENV_REFERENCE.test(value)) {
      problems.push({
        n: i + 1,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: describing the required literal syntax
        why: 'value must be exactly ${VARIABLE}',
        // Never echo the offending value: it may be the credential itself.
        line: `${line.slice(0, eq + 1)}<redacted>`,
      })
    }
  })

if (problems.length === 0) {
  console.log('.npmrc: ok (credentials reference the environment only)')
  process.exit(0)
}

console.error('.npmrc contains a credential that is not an environment reference:\n')
for (const p of problems) {
  console.error(`  line ${p.n}: ${p.why}`)
  console.error(`    ${p.line}\n`)
}
// biome-ignore lint/suspicious/noTemplateCurlyInString: telling the user the literal syntax to write
console.error('Use ${WEBAWESOME_NPM_TOKEN}. See CONTRIBUTING.md.')
process.exit(1)
