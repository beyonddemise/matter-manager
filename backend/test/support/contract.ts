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

/**
 * The contract, parsed and with local `$ref`s resolved.
 *
 * Resolved rather than tolerated, and this is not tidiness. `$ref` was on the supported-keyword
 * list, so a response declared as `{ $ref: '#/components/responses/Unauthorized' }` reached the
 * validator as an object with no `type` and no `properties` — which it checks perfectly and
 * finds nothing wrong with. Every `$ref`-shaped response in the contract was being waved
 * through, and the guard against unsupported keywords could not see it because `$ref` was
 * *listed as supported*.
 *
 * Only local pointers (`#/…`) are resolved. A remote one would be a contract this repository
 * does not fully own, which is a different conversation.
 */
export function loadContract(path = join(here, '../../../openapi.yaml')): Record<string, unknown> {
  const document = parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  return resolveRefs(document, document) as Record<string, unknown>
}

/** Follows a local JSON pointer, e.g. `#/components/schemas/Profile`. */
function pointer(document: unknown, ref: string): unknown {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>(
      (node, step) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[decodeURIComponent(step)]
          : undefined,
      document,
    )
}

/**
 * Replaces every local `$ref` with what it points at.
 *
 * `seen` guards a self-referential schema, which would otherwise recurse forever — a contract
 * can legitimately describe a tree, and this file must not be the reason one cannot.
 */
function resolveRefs(node: unknown, document: unknown, seen = new Set<string>()): unknown {
  if (Array.isArray(node)) return node.map((entry) => resolveRefs(entry, document, seen))
  if (typeof node !== 'object' || node === null) return node

  const object = node as Record<string, unknown>
  const ref = object.$ref
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    if (seen.has(ref)) return {}
    const next = new Set(seen)
    next.add(ref)
    return resolveRefs(pointer(document, ref), document, next)
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, resolveRefs(value, document, seen)]),
  )
}

/** One operation the contract describes. */
export interface Operation {
  /** Upper-case, as Fastify reports methods. */
  readonly method: string
  /** As written in the contract, with `{braces}` intact. */
  readonly path: string
  /** Response schemas by status code, where the contract gives a JSON body. */
  readonly responses: Readonly<Record<string, unknown>>
  /**
   * Every status code the contract declares, **including the ones with no body at all**.
   *
   * Separate from {@link responses} because the two answer different questions, and conflating
   * them lets a real disagreement pass. `responses` is "what shape does a 403 have", and it is
   * necessarily silent about a 204 or a 302 — those declare no content, so there is nothing to
   * key. A check that asked only `responses` therefore could not tell "the contract does not
   * describe this status" from "the contract describes it as having no body", and the first of
   * those is drift while the second is the contract working as intended.
   *
   * That distinction is the whole reason a route answering an **undeclared** 401 is now
   * findable: three of them were, and `responses` alone could not have said so.
   */
  readonly declared: readonly string[]
  /**
   * The media type the contract declares per status, where it declares a body.
   *
   * Collected so the check can compare it against what the handler actually sent. Every refusal
   * in this contract is `application/problem+json` and every handler was sending
   * `application/json`, which no assertion anywhere could see — the schemas matched, so the
   * bodies validated, and the label on them was wrong on every error response in the service.
   */
  readonly mediaTypes: Readonly<Record<string, string>>
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
      const mediaTypes: Record<string, string> = {}
      for (const [status, response] of Object.entries(responses)) {
        const content = (response.content ?? {}) as Record<string, { schema?: unknown }>
        // **Both media types**, and the second one is the whole point of reading two.
        //
        // Every refusal in this contract is declared `application/problem+json`, because that
        // is what RFC 9457 problem details are served as. A collector that knew only
        // `application/json` therefore gathered the success responses and silently dropped
        // every 400, 401, 403 and 404 in the file — so no error response had ever been
        // validated by anything. It did not fail: a test that looks a refusal's schema up by
        // status got `undefined`, and `validate(value, undefined)` reports nothing wrong. The
        // check read as thorough and covered only the happy path.
        //
        // `application/json` wins a tie because an operation that declared both would be
        // declaring its ordinary body there; no operation here does.
        const type =
          content['application/json'] !== undefined
            ? 'application/json'
            : content['application/problem+json'] !== undefined
              ? 'application/problem+json'
              : undefined
        const json = type === undefined ? undefined : content[type]
        if (type !== undefined && json?.schema !== undefined) {
          schemas[status] = json.schema
          mediaTypes[status] = type
        }
      }

      found.push({
        method: method.toUpperCase(),
        path,
        responses: schemas,
        declared: Object.keys(responses),
        mediaTypes,
      })
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

  // `oneOf` is JSON Schema's exactly-one: a value two alternatives accept is as wrong as one
  // none accepts, because the contract would then be ambiguous about which shape it promised.
  // When none holds, every alternative's complaint is reported, because the one a reader needs
  // is the alternative they meant.
  if (Array.isArray(rules.oneOf)) {
    const attempts = rules.oneOf.map((branch) => validate(value, branch, at))
    const matching = attempts.filter((attempt) => attempt.length === 0).length
    if (matching === 0) {
      problems.push({
        at,
        says: `matches none of the alternatives: ${attempts
          .map((attempt) => attempt.map((problem) => `${problem.at} ${problem.says}`).join(', '))
          .join(' | ')}`,
      })
    } else if (matching > 1) {
      problems.push({
        at,
        says: `matches ${matching} of the alternatives, but oneOf requires exactly one`,
      })
    }
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
  'oneOf',
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
])

/**
 * Every schema keyword the contract uses that this validator does not understand.
 *
 * The point of a partial validator is that it is honest about being partial. The point of *this*
 * function is that "partial" must not quietly become "checks nothing": if someone adds a
 * `anyOf` or a `pattern` to the contract, the validator would ignore it and report success, and
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

    if (key === 'oneOf' && Array.isArray(value)) {
      for (const branch of value) unsupportedKeywords(branch, seen)
    }
  }
  return seen
}
