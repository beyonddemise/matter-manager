#!/usr/bin/env node
/**
 * Enforces the runtime dependency policy (ADR 0013).
 *
 * Dependency creep is silent: nobody decides to add fifteen packages, each one is individually
 * reasonable, and the audit surface has doubled by the time anyone looks. This turns "we try to
 * keep dependencies down" into something that fails a build.
 *
 * `dependencies`, `optionalDependencies` and `peerDependencies` are all checked, because all
 * three can end up installed in production. `devDependencies` are unrestricted ONLY in
 * packages that do not ship a bundle — in `packages/web` a bundler will happily inline a
 * devDependency that application source imports, so "it is a devDependency" is not by itself
 * evidence that it does not reach users.
 *
 * Itself written with no dependencies, which would otherwise be an embarrassing irony.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const policy = JSON.parse(readFileSync(join(root, 'dependency-policy.json'), 'utf8'))

/** Every package.json in the workspace, root included. */
function manifests() {
  const found = [{ name: '<root>', path: join(root, 'package.json') }]
  for (const dir of ['packages', '.']) {
    const base = join(root, dir)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const p = join(base, entry.name, 'package.json')
      if (existsSync(p)) found.push({ name: `${dir}/${entry.name}`, path: p })
    }
  }
  return found
}

/** Fields whose contents can reach a production install. */
const SHIPPING_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

/** Packages that produce a browser bundle: a devDependency imported by source ships too. */
const BUNDLED_PACKAGES = new Set(['packages/web'])

const problems = []

for (const { name, path } of manifests()) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  const fields = BUNDLED_PACKAGES.has(name)
    ? [...SHIPPING_FIELDS, 'devDependencies']
    : SHIPPING_FIELDS

  for (const field of fields) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (policy.banned[dep]) {
        problems.push({ pkg: name, field, dep, reason: policy.banned[dep], banned: true })
      } else if (!policy.allowed[dep] && !policy.allowedDev?.[dep]) {
        problems.push({
          pkg: name,
          field,
          dep,
          reason:
            'Not in dependency-policy.json. Check the platform first (fetch, node:crypto, ' +
            'crypto.randomUUID, structuredClone, Intl). If it is genuinely needed, add it to ' +
            'the allowlist with a one-line justification. Build-only tooling for a bundled ' +
            'package goes in "allowedDev".',
          banned: false,
        })
      }
    }
  }
}

if (problems.length === 0) {
  const count = manifests().length
  console.log(`Dependency policy: ok (${count} manifests, no undeclared shipping dependencies)`)
  process.exit(0)
}

console.error('Dependency policy violations:\n')
for (const p of problems) {
  console.error(`  ${p.banned ? 'BANNED  ' : 'UNLISTED'} ${p.dep}  in ${p.pkg} (${p.field})`)
  console.error(`           ${p.reason}\n`)
}
console.error('See docs/adr/0013-minimal-runtime-dependencies.md')
process.exit(1)
