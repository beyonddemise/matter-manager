/**
 * The OpenAPI contract, and enough of a JSON Schema validator to check a response against it.
 *
 * Hand-rolled, and the reasoning is the same as the PDF text extractor's: a general JSON Schema
 * validator is a large problem, and this one only has to check documents *this contract*
 * describes — objects, a handful of scalar types, `required`, `const`, `enum` and `format`. Ajv
 * arrives transitively under Fastify but is not a declared dependency of anything here, and
 * declaring one for a forty-line job is a dependency-policy conversation (ADR 0013).
 *
 * The risk of a hand-rolled validator is that it is too lenient and reports nothing — which is
 * exactly the failure mode #39 says to guard against by breaking the check on purpose. See
 * `openapi-drift.test.ts`, which does that in both directions and keeps the proof.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))

/** The contract, parsed. `unknown`-typed on purpose: it is a document, not an API. */
export function loadContract(
  path = join(here, '../../../../openapi/matter-manager.yaml'),
): Record<string, unknown> {
  return parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** One operation the contract describes. */
export interface Operation {
  /** Upper-case, as Fastify reports methods. */
  readonly method: string
  /** As written in the contract, with `{braces}` intact. */
  readonly path: string
  /** Response schemas by status code, where the contract gives a JSON body. */
  readonly responses: Readonly<Record<string, unknown>>
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const

/** Every operation in the contract, in document order. */
export function operationsOf(contract: Record<string, unknown>): Operation[] {
  const paths = (contract.paths ?? {}) as Record<string, Record<string, unknown>>
  const found: Operation[] = []

  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const operation = item[method] as Record<string, unknown> | undefined
      if (operation === undefined) continue

      const responses = (operation.responses ?? {}) as Record<string, Record<string, unknown>>
      const schemas: Record<string, unknown> = {}
      for (const [status, response] of Object.entries(responses)) {
        const content = (response.content ?? {}) as Record<string, { schema?: unknown }>
        const json = content['application/json']
        if (json?.schema !== undefined) schemas[status] = json.schema
      }

      found.push({ method: method.toUpperCase(), path, responses: schemas })
    }
  }
  return found
}

/**
 * A contract path as Fastify writes it: `{projectId}` becomes `:projectId`.
 *
 * Compared in this direction rather than the other because Fastify's form is the one that can
 * be produced mechanically without ambiguity — a `:param` back to `{param}` is the same
 * translation, but doing it on the contract keeps the contract the thing being read.
 */
export function toFastifyPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1')
}

/** Where in a document a problem was found, and what it was. */
export interface SchemaProblem {
  readonly at: string
  readonly says: string
}

/**
 * Checks a value against the subset of JSON Schema this contract uses.
 *
 * Reports **every** problem rather than the first: a response with three wrong fields should
 * take one run to fix, not three.
 *
 * Unknown keywords are ignored, which is the honest behaviour for a partial validator — but it
 * is also how a partial validator becomes a validator that checks nothing, so
 * {@link assertSchemaIsSupported} refuses a contract that uses one.
 */
export function validate(value: unknown, schema: unknown, at = '$'): SchemaProblem[] {
  if (typeof schema !== 'object' || schema === null) return []
  const rules = schema as Record<string, unknown>
  const problems: SchemaProblem[] = []

  if (typeof rules.const === 'string' && value !== rules.const) {
    problems.push({
      at,
      says: `must be ${JSON.stringify(rules.const)}, got ${JSON.stringify(value)}`,
    })
  }

  if (Array.isArray(rules.enum) && !rules.enum.includes(value)) {
    problems.push({
      at,
      says: `must be one of ${JSON.stringify(rules.enum)}, got ${JSON.stringify(value)}`,
    })
  }

  const type = rules.type
  if (typeof type === 'string' && !matchesType(value, type)) {
    problems.push({ at, says: `must be ${type}, got ${describe(value)}` })
    // No point checking an object's properties when it is not an object.
    return problems
  }

  if (type === 'object' || (type === undefined && rules.properties !== undefined)) {
    const object = (value ?? {}) as Record<string, unknown>
    for (const key of (rules.required ?? []) as string[]) {
      if (!(key in object)) problems.push({ at: `${at}.${key}`, says: 'is required and missing' })
    }
    const properties = (rules.properties ?? {}) as Record<string, unknown>
    for (const [key, sub] of Object.entries(properties)) {
      if (key in object) problems.push(...validate(object[key], sub, `${at}.${key}`))
    }
  }

  if (type === 'array' && Array.isArray(value) && rules.items !== undefined) {
    value.forEach((entry, index) => {
      problems.push(...validate(entry, rules.items, `${at}[${index}]`))
    })
  }

  return problems
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

const describe = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

/** Keywords {@link validate} understands. Anything else in the contract is a silent gap. */
const SUPPORTED = new Set([
  'type',
  'properties',
  'required',
  'items',
  'const',
  'enum',
  'description',
  'title',
  'example',
  'examples',
  'default',
  'format',
  'nullable',
  'readOnly',
  'writeOnly',
  'deprecated',
  '$ref',
])

/**
 * Every schema keyword the contract uses that this validator does not understand.
 *
 * The point of a partial validator is that it is honest about being partial. The point of *this*
 * function is that "partial" must not quietly become "checks nothing": if someone adds a
 * `oneOf` or a `pattern` to the contract, the validator would ignore it and report success, and
 * the drift check would go on passing while checking less than it used to.
 */
export function unsupportedKeywords(schema: unknown, seen = new Set<string>()): Set<string> {
  if (typeof schema !== 'object' || schema === null) return seen

  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!SUPPORTED.has(key)) seen.add(key)

    // `properties` maps *names* to schemas. Recursing into it as though it were a schema
    // reports every field in the contract as an unknown keyword — which is what the first
    // version did, and what the guard above caught on its first run.
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      for (const property of Object.values(value as Record<string, unknown>)) {
        unsupportedKeywords(property, seen)
      }
      continue
    }

    if (key === 'items') unsupportedKeywords(value, seen)
  }
  return seen
}
