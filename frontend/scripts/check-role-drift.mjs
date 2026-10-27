#!/usr/bin/env node
/**
 * Fails if the hand-written `ProjectRole` union drifts from the contract's `Role` enum.
 *
 * `src/domain/role.ts` says why the union is declared by hand rather than generated: a shared
 * package for one four-value type is not worth a build boundary, and generation is deferred.
 * The cost of that decision is that nothing structural fails when the two copies diverge —
 * divergence would surface as an authorization disagreement across the wire (#183). This check
 * is the "change one, change the other" comment made enforceable.
 *
 * It compares against the repository's own vendored `openapi.yaml` deliberately. ADR 0017 keeps
 * that file byte-identical with the backend's copy, and the backend pins its code to its copy
 * with its own tests — so agreeing with the vendored contract *is* agreeing with the server.
 *
 * The parse is a targeted line-scan, not a YAML library: the scripts in this directory carry no
 * dependencies, and the shape being read is one schema with one enum. What makes that honest is
 * the refusal to pass on an empty extraction — a schema renamed, reformatted beyond what this
 * reads, or a file moved turns the check red, never silently green (lessons.md L3: a check that
 * cannot find its subject must not report ok). The test suite's positive control runs it against
 * the real files, so "the parser no longer recognises the contract" cannot land unnoticed.
 *
 * Usage:  node scripts/check-role-drift.mjs [--spec <openapi.yaml>] [--union <role.ts>]
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The value following `--flag`, or the default when the flag is absent. */
const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : process.argv[at + 1]
}

const specPath = arg('--spec', join(root, '..', 'openapi.yaml'))
const unionPath = arg('--union', join(root, 'src/domain/role.ts'))

if (specPath === undefined || unionPath === undefined) {
  console.error('--spec and --union each need a file.')
  process.exit(1)
}

const fail = (sentence) => {
  console.error(sentence)
  process.exit(1)
}

/** `'owner'`, `"owner"` and `owner` are the same YAML scalar; quotes must not read as drift. */
const unquoted = (value) => value.replace(/^(['"])(.*)\1$/, '$2')

const read = (path, what) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    fail(`Cannot read the ${what} at ${path}, so the role-drift check can see nothing.`)
  }
}

/**
 * The `Role` schema's enum values, by line-scan.
 *
 * The schema is found by its own key line — `Role:` with nothing after the colon — which
 * distinguishes it from the file's many `role:` properties and `$ref`s to it. Only the schema's
 * **direct children** are read: the first line inside the block fixes their indentation, and an
 * `enum:` any deeper — inside a description, say — is prose, not the contract. The enum itself
 * may be flow style (`enum: [a, b]`, what the file has today) or block style (`- a` items, what
 * a formatter could turn it into).
 */
function rolesFromSpec(yaml) {
  const lines = yaml.split('\n')
  const at = lines.findIndex((line) => /^\s+Role:\s*$/.test(line))
  if (at === -1)
    fail(
      `No \`Role:\` schema in ${specPath}; the role-drift check cannot see the contract's roles.`,
    )

  const indent = lines[at].search(/\S/)
  let childIndent = -1
  const values = []
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue // a comment is not a key
    const depth = line.search(/\S/)
    if (depth <= indent) break // next sibling schema
    if (childIndent === -1) childIndent = depth // the block's own keys sit at this depth
    if (depth !== childIndent) continue // nested under a child: description text, not a key
    const flow = line.match(/^\s+enum:\s*\[([^\]]*)\]\s*$/)
    if (flow !== null) {
      values.push(...flow[1].split(',').map((value) => unquoted(value.trim())))
      break
    }
    if (/^\s+enum:\s*$/.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s+-\s+(\S+)\s*$/)
        if (item === null) break
        values.push(unquoted(item[1]))
      }
      break
    }
  }

  const roles = values.filter((value) => value !== '')
  if (roles.length === 0)
    fail(`The \`Role\` schema in ${specPath} has no enum values this check can read.`)
  return roles
}

/**
 * The `ProjectRole` union's members, every one of which must be a single-quoted string literal.
 *
 * Validating the whole expression rather than harvesting the literals out of it matters: in
 * `'owner' | 'manage' | 'write' | 'read' | string` the four literals all agree with the
 * contract, and the `| string` quietly accepts everything the contract refuses. A member this
 * cannot read as a literal fails the check; it is never skipped.
 *
 * The match is anchored to the start of a line, so a commented-out `// export type ProjectRole`
 * is not a declaration — a stale copy in a comment must never validate the file while the live
 * declaration below it drifts. Two live declarations would make "the union" ambiguous, so that
 * is refused too rather than silently reading the first.
 */
function rolesFromUnion(source) {
  const declarations = [
    ...source.matchAll(/^export type ProjectRole\s*=([^\n]*(?:\n\s*\|[^\n]*)*)/gm),
  ]
  if (declarations.length === 0)
    fail(
      `No \`ProjectRole\` declaration in ${unionPath}; the role-drift check cannot see the union.`,
    )
  if (declarations.length > 1)
    fail(
      `More than one \`ProjectRole\` declaration in ${unionPath}; the role-drift check cannot tell which is live.`,
    )
  const declaration = declarations[0]

  const members = declaration[1]
    .split('|')
    .map((member) => member.trim())
    .filter((member) => member !== '')
  if (members.length === 0)
    fail(`\`ProjectRole\` in ${unionPath} has no members this check can read.`)

  const nonLiteral = members.filter((member) => !/^'[^']+'$/.test(member))
  if (nonLiteral.length > 0)
    fail(
      `\`ProjectRole\` in ${unionPath} is not a union of single-quoted string literals — [${nonLiteral.join(', ')}] would admit values the contract's Role enum refuses.`,
    )

  return members.map((member) => member.slice(1, -1))
}

const contract = rolesFromSpec(read(specPath, 'contract'))
const union = rolesFromUnion(read(unionPath, 'union'))

const missing = contract.filter((role) => !union.includes(role))
const extra = union.filter((role) => !contract.includes(role))

if (missing.length > 0 || extra.length > 0) {
  const sides = []
  if (missing.length > 0)
    sides.push(
      `[${missing.join(', ')}] in the contract (${specPath}) but not the union (${unionPath})`,
    )
  if (extra.length > 0)
    sides.push(
      `[${extra.join(', ')}] in the union (${unionPath}) but not the contract (${specPath})`,
    )
  fail(
    `ProjectRole has drifted from the contract's Role enum: ${sides.join(', and ')} — change one, change the other (src/domain/role.ts says why both exist).`,
  )
}

console.log(`role drift: ok (${union.join(', ')} in both the union and the contract's Role enum)`)
