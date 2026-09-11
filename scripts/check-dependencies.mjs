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
 * packages that do not ship a bundle — in `frontend` a bundler will happily inline a
 * devDependency that application source imports, so "it is a devDependency" is not by itself
 * evidence that it does not reach users.
 *
 * Itself written with no dependencies, which would otherwise be an embarrassing irony.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const policy = JSON.parse(readFileSync(join(root, 'dependency-policy.json'), 'utf8'))

/**
 * Every package.json in the repository, root included.
 *
 * It scanned `packages/` and the top level until #181, which left `packages/` empty. Scanning
 * only named directories is what made that a silent narrowing rather than a failure: a
 * directory that stops existing simply contributes nothing, and the check keeps passing over
 * whatever is left. So this walks the tree instead of being told where to look — the same
 * correction #179 made to the Dependabot npm entry and #181 made to the .npmrc guard.
 */
function manifests(dir = root, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) continue
    const path = join(dir, entry.name, 'package.json')
    if (existsSync(path)) found.push({ name: relative(root, join(dir, entry.name)), path })
    manifests(join(dir, entry.name), found)
  }
  if (dir === root) found.unshift({ name: '<root>', path: join(root, 'package.json') })
  return found
}

/** Fields whose contents can reach a production install. */
const SHIPPING_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

/**
 * Packages whose code reaches the browser: a devDependency imported by their source ships too.
 *
 * The whole frontend is one package now, so this is one entry where it used to be two. Nothing
 * about the reasoning changed: `src/data` still declares PouchDB builds as devDependencies and
 * is still bundled into the download, and "it is a devDependency" is not evidence it stays out
 * of that download. Only not being imported is, and
 * `frontend/test/data/no-pouchdb-import.test.ts` asserts exactly that.
 */
const BUNDLED_PACKAGES = new Set(['frontend'])

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
