#!/usr/bin/env node
/**
 * Confirms the installed Web Awesome is the Pro build, not the free one.
 *
 * The two packages carry the **same version number**, and the free one sits on public npm
 * under a different name. A misconfigured registry, an expired token, or a lockfile edited by
 * a tool that does not know about `.npmrc` can install something entirely plausible with no
 * error at all — and the first symptom is a component that silently never upgrades, in a
 * browser, at runtime.
 *
 * So the assertion is on a Pro-only *capability*, never on a version string. `data-grid` is
 * one of seventeen components absent from the free build.
 *
 * Skips rather than fails when the package is not installed at all, so `npm ci` without the
 * token — a fork pull request, see issue #18 — reports the real problem rather than this one.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = join(root, 'node_modules/@awesome.me/webawesome-pro')

/**
 * Components that exist only in the Pro build, established by diffing the two packages.
 * Any one of them proves the Pro build is installed; `data-grid` is checked because this
 * application actually uses it.
 */
const PRO_ONLY = 'data-grid'

/** Components this milestone depends on. A rename upstream should fail here, not in a browser. */
const REQUIRED = [
  'qr-code', // the core product feature
  'button',
  'input',
  'select',
  'dialog',
  'drawer',
  'card',
  'tab-group',
  'dropdown', // not `menu`: Web Awesome renamed it, unlike Shoelace
  'tooltip',
  'combobox', // Pro-only, room selection with inline creation
  'date-picker', // Pro-only, installation date
]

if (!existsSync(pkg)) {
  console.log('Web Awesome: not installed, skipping (expected without WEBAWESOME_NPM_TOKEN)')
  process.exit(0)
}

const problems = []

const components = join(pkg, 'dist/components')
if (!existsSync(components)) {
  problems.push(`${components} does not exist; the package layout has changed.`)
} else {
  const installed = new Set(readdirSync(components))

  if (!installed.has(PRO_ONLY)) {
    problems.push(
      `<wa-${PRO_ONLY}> is missing, which means the FREE build is installed under the Pro name. ` +
        'Check WEBAWESOME_NPM_TOKEN and the @awesome.me registry line in .npmrc.',
    )
  }

  for (const component of REQUIRED) {
    if (!installed.has(component)) {
      problems.push(`<wa-${component}> is missing; it was renamed or removed upstream.`)
    }
  }
}

// The lockfile is where a wrong registry shows up as data rather than as a runtime surprise.
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const entry = lock.packages?.['node_modules/@awesome.me/webawesome-pro']
if (entry && !String(entry.resolved ?? '').startsWith('https://npm.webawesome.com/')) {
  problems.push(`Resolved from ${entry.resolved}, which is not the Web Awesome registry.`)
}

if (problems.length > 0) {
  console.error('Web Awesome Pro check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  `Web Awesome Pro: ok (<wa-${PRO_ONLY}> present, ${REQUIRED.length} required components)`,
)
