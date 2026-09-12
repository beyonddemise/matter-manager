#!/usr/bin/env node
/**
 * Every `dependency-name` in `.github/dependabot.yml` is spelled the way Dependabot spells it.
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
 * Deliberately parsed with a regex rather than a YAML library: this runs in `npm run verify` at
 * the repository root, and the root installs exactly one package (Biome). Adding `yaml` here to
 * read one field would give the root a dependency it does not otherwise need.
 */

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

console.log(`dependabot ignores: ${checked.length + problems.length} dependency-name entries`)
for (const line of checked) console.log(line)

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) {
    console.error(`::error file=.github/dependabot.yml::${problem}`)
  }
  console.error(`\n${problems.length} ignore rule(s) name a dependency Dependabot does not use.`)
  process.exit(1)
}

console.log('\nEvery dependency-name is spelled the way Dependabot spells it.')
