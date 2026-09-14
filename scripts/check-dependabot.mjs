#!/usr/bin/env node
/**
 * `.github/dependabot.yml` watches everything there is to watch, and names it correctly.
 *
 * Two checks, one file, because they are the same failure: a Dependabot configuration that is
 * wrong in either way keeps succeeding. Nothing goes red. The updater reads what it was given,
 * finds nothing to do about the part you got wrong, and reports success for the rest.
 *
 * ## 1. Every directory that has something to update is listed
 *
 * **Dependabot does not recurse.** A `directory:` or `directories:` entry covers that directory
 * and no other, so a manifest that moves - or appears - outside the listed set is watched by
 * nothing at all. Three times now:
 *
 * - #156: `directory: /infra` while the Dockerfile was in `/infra/couchdb`. Three base images
 *   unwatched from the day the repository was created.
 * - #179: `directory: /` while #164 had given `backend/` its own lockfile. Nine dependencies,
 *   Fastify and pino among them, unwatched - security advisories included.
 * - This change: #192 gave `e2e/` its own lockfile and did not list it, leaving
 *   `@playwright/test` unwatched. That is the package that has to stay in step with
 *   `frontend`'s `playwright`, whose divergence broke CI in #186 - so the gap quietly undid
 *   the grouping that exists to prevent it.
 *
 * Every one was found by something else failing, weeks later. So: the files on disk are the
 * source of truth, and the configuration is checked against them.
 *
 * ## 2. Every `dependency-name` is spelled the way Dependabot spells it
 *
 * A name that matches nothing is not an error to Dependabot. It reads the entry, finds no
 * dependency called that, and carries on — so a suppression can be inert from the day it is
 * written and look exactly like one that is working. The only visible symptom is the pull
 * request it was supposed to prevent, arriving as though no rule existed.
 *
 * That is what happened. #173 wrote
 *
 *     - dependency-name: mcr.microsoft.com/devcontainers/typescript-node
 *
 * to stop the devcontainer taking a Node major. **Dependabot strips the registry host**, so the
 * dependency is `devcontainers/typescript-node` and the rule never matched. #193 then offered
 * `1-24-bookworm -> 5-26-bookworm` — Node 26 in the devcontainer, the exact update the rule
 * existed to refuse — and `check-node-pins.mjs` is what caught it, a month later.
 *
 * The evidence for the naming rule is Dependabot's own: the compatibility-score link in #193
 * carries `dependency-name=devcontainers/typescript-node`, and the options reference gives the
 * rule by example — for
 * `<account>.dkr.ecr.us-west-2.amazonaws.com/base/foo/bar/ruby:3.1.0-focal-jemalloc`, use
 * `base/foo/bar/ruby`.
 *
 * So: in a container ecosystem, a name whose first path segment contains a dot is a registry
 * host, and the entry is dead. Nothing else in this file's naming is machine-checkable — a
 * misspelled package name is still silent — but this one class of mistake is, it has already
 * cost a month of an unguarded pin, and it costs thirty lines to make impossible.
 *
 * Deliberately parsed by hand rather than with a YAML library: this runs in `npm run verify` at
 * the repository root, and the root installs exactly one package (Biome). Adding `yaml` would
 * give the root a dependency it does not otherwise need, to read a file this repository writes
 * and controls.
 *
 * That trade is only safe because the parser **fails loudly when it does not understand the
 * file**. Every ecosystem it expects must yield at least one directory and the name scan must
 * yield at least one entry; otherwise it exits non-zero saying it can no longer read the file.
 * A hand parser that silently returned nothing would be precisely the class of bug this exists
 * to catch.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, '.github/dependabot.yml')

/** Ecosystems whose dependency names are container images, and so may carry a registry host. */
const CONTAINER_ECOSYSTEMS = new Set(['docker', 'docker-compose'])

const lines = readFileSync(file, 'utf8').split('\n')

const problems = []
const checked = []
let ecosystem = null

/**
 * Which files make a directory worth watching, per ecosystem.
 *
 * Keyed on what Dependabot itself reads. `docker` reads Dockerfiles and Kubernetes YAML and
 * never compose files; `docker-compose` reads only compose files — which is why they are two
 * entries in the configuration rather than one, and why they are two entries here.
 *
 * `github-actions` is absent on purpose: workflows only ever live in `.github/workflows`, so
 * `directory: /` covers them by definition and there is nothing a scan could disagree with.
 */
const WATCHED = {
  npm: (path) => path.endsWith('package-lock.json'),
  docker: (path) => /(^|\/)Dockerfile[^/]*$/.test(path),
  'docker-compose': (path) => /(^|\/)[^/]*compose[^/]*\.ya?ml$/.test(path),
}

/** Tracked files only — an ignored lockfile under node_modules is not ours to watch. */
function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

/** `/` for a file at the root, `/frontend` for one a level down — the form Dependabot takes. */
function directoryOf(path) {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  return `/${parent}`.replace(/\/$/, '') || '/'
}

/**
 * Every directory each ecosystem is configured to watch.
 *
 * Handles both spellings: `directory: /x` and a `directories:` list. Returns a Map so a missing
 * ecosystem is distinguishable from one that is present and empty — the caller treats both as
 * failures, but they mean different things and the message says which.
 */
function configuredDirectories() {
  const found = new Map()
  let current = null
  let inList = false

  for (const line of lines) {
    const eco = /^\s*-\s*package-ecosystem:\s*["']?([\w-]+)["']?/.exec(line)
    if (eco?.[1]) {
      current = eco[1]
      if (!found.has(current)) found.set(current, [])
      inList = false
      continue
    }
    if (current === null) continue

    const single = /^\s*directory:\s*["']?([^"'\s#]+)["']?/.exec(line)
    if (single?.[1]) {
      found.get(current)?.push(single[1])
      inList = false
      continue
    }
    if (/^\s*directories:\s*$/.test(line)) {
      inList = true
      continue
    }
    if (inList) {
      const item = /^\s*-\s*["']?(\/[^"'\s#]*)["']?/.exec(line)
      if (item?.[1]) found.get(current)?.push(item[1])
      // Any other key at this level ends the list.
      else if (/^\s*[\w-]+:/.test(line)) inList = false
    }
  }
  return found
}

const configured = configuredDirectories()
const tracked = trackedFiles()

for (const [ecosystem, matches] of Object.entries(WATCHED)) {
  const listed = configured.get(ecosystem)

  if (listed === undefined) {
    problems.push(
      `no \`package-ecosystem: ${ecosystem}\` entry at all - either it was removed, or this ` +
        `check can no longer read the file`,
    )
    continue
  }
  if (listed.length === 0) {
    problems.push(`\`${ecosystem}\` lists no directories, so it watches nothing`)
    continue
  }

  const needed = [...new Set(tracked.filter(matches).map(directoryOf))].sort()
  if (needed.length === 0) {
    problems.push(
      `found no files for the \`${ecosystem}\` ecosystem anywhere in the repository, but it is ` +
        `configured - either they moved, or this check's patterns have gone stale`,
    )
    continue
  }

  for (const directory of needed) {
    if (listed.includes(directory)) {
      checked.push(`  ok   ${ecosystem} watches ${directory}`)
    } else {
      problems.push(
        `\`${ecosystem}\` does not watch ${directory}, which holds a file it would update. ` +
          `Dependabot does not recurse, so nothing there is watched at all - add it to that ` +
          `entry's \`directories:\` list.`,
      )
    }
  }
}

for (const [index, line] of lines.entries()) {
  const ecosystemMatch = /^\s*-?\s*package-ecosystem:\s*["']?([\w-]+)["']?/.exec(line)
  if (ecosystemMatch?.[1]) {
    ecosystem = ecosystemMatch[1]
    continue
  }

  const nameMatch = /^\s*-\s*dependency-name:\s*["']?([^"'\s#]+)["']?/.exec(line)
  if (!nameMatch?.[1]) continue

  const name = nameMatch[1]
  const where = `.github/dependabot.yml:${index + 1}`

  if (!CONTAINER_ECOSYSTEMS.has(ecosystem ?? '')) {
    checked.push(`  ok   ${name} (${ecosystem})`)
    continue
  }

  // A registry host is a first path segment containing a dot: `mcr.microsoft.com/...`,
  // `ghcr.io/...`, `123.dkr.ecr.eu-west-1.amazonaws.com/...`. A name with no slash at all
  // (`node`) is an official image and correct as written.
  const [first, ...rest] = name.split('/')
  if (rest.length > 0 && first?.includes('.')) {
    problems.push(
      `${where}: '${name}' starts with the registry host '${first}', which Dependabot strips. ` +
        `This entry matches no dependency and does nothing. Write '${rest.join('/')}'.`,
    )
  } else {
    checked.push(`  ok   ${name} (${ecosystem})`)
  }
}

if (checked.length === 0 && problems.length === 0) {
  // Not "nothing to check, carry on". This file has had `ignore` entries since #153, and
  // finding none means the pattern has stopped matching the file rather than that the file is
  // clean — the same way a suppression that matches nothing looks like one that works.
  console.error(`${file}: found no dependency-name entries at all.`)
  console.error('Either the file lost its ignore rules, or this check can no longer read it.')
  process.exit(1)
}

console.log(`.github/dependabot.yml: ${checked.length + problems.length} checks`)
for (const line of checked) console.log(line)

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) {
    console.error(`::error file=.github/dependabot.yml::${problem}`)
  }
  console.error(
    `\n${problems.length} problem(s) in .github/dependabot.yml. Each one is silent to ` +
      `Dependabot itself: the run succeeds and the thing simply goes unwatched.`,
  )
  process.exit(1)
}

console.log(
  '\nEvery directory with something to update is watched, and every dependency-name is ' +
    'spelled the way Dependabot spells it.',
)
