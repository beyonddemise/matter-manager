/**
 * The hand-written project roles against `openapi.yaml` (#183).
 *
 * `src/domain/role.ts` derives `ProjectRole` from the `PROJECT_ROLES` tuple, so the compiler
 * guarantees type ≡ tuple; what remains unprovable at compile time is tuple ≡ contract, and
 * that is this file's one job. Like `test/ui/catalog-contract.test.ts`, it reads the vendored
 * `openapi.yaml` — ADR 0017 keeps it byte-identical with the backend's copy, and the backend
 * pins spec-vs-code with its own tests, so agreeing with the vendored contract is agreeing
 * with the server.
 *
 * Four review rounds on the predecessor (a script that text-parsed the TypeScript union)
 * each found another spelling the parse misread. Comparing the runtime tuple ends that class:
 * there is nothing left to parse on the TypeScript side, and the YAML side goes through a real
 * parser. What the predecessor got right is kept: an extraction that comes up empty is a loud
 * error, never a pass (lessons.md L3 — a check that cannot find its subject must not report ok).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { PROJECT_ROLES } from '../../src/domain/role.js'

/** The contract, as far as this test reads it. */
interface Contract {
  readonly components?: {
    readonly schemas?: Readonly<Record<string, { readonly enum?: unknown }>>
  }
}

const contract = parse(
  readFileSync(fileURLToPath(new URL('../../../openapi.yaml', import.meta.url)), 'utf8'),
) as Contract

/** The `Role` schema's enum, or a loud throw — absence must never read as agreement. */
function roleEnum(doc: Contract): readonly string[] {
  const schema = doc.components?.schemas?.Role
  if (schema === undefined)
    throw new Error('openapi.yaml has no Role schema; this check cannot see the contract roles')
  const values = schema.enum
  if (!Array.isArray(values) || values.length === 0)
    throw new Error('the Role schema in openapi.yaml has no enum; this check cannot see its values')
  if (!values.every((value): value is string => typeof value === 'string'))
    throw new Error('the Role schema enum in openapi.yaml holds non-string values')
  return values
}

/** What each side has that the other lacks. Empty both ways is agreement. */
const drift = (contractRoles: readonly string[], union: readonly string[]) => ({
  missing: contractRoles.filter((role) => !union.includes(role)),
  extra: union.filter((role) => !contractRoles.includes(role)),
})

describe('ProjectRole against the vendored contract', () => {
  it('matches the Role enum in both directions', () => {
    const { missing, extra } = drift(roleEnum(contract), PROJECT_ROLES)
    expect(
      missing,
      `in the contract's Role enum (openapi.yaml) but not PROJECT_ROLES (src/domain/role.ts): [${missing.join(', ')}]`,
    ).toEqual([])
    expect(
      extra,
      `in PROJECT_ROLES (src/domain/role.ts) but not the contract's Role enum (openapi.yaml): [${extra.join(', ')}]`,
    ).toEqual([])
  })

  it('would report drift in either direction', () => {
    // The positive control: the same comparison over mutated copies of the real values. A
    // comparison that cannot flag a planted divergence proves nothing about the absence of one.
    const real = roleEnum(contract)
    expect(drift([...real, 'audit'], PROJECT_ROLES).missing).toEqual(['audit'])
    expect(drift(real, [...PROJECT_ROLES, 'comment']).extra).toEqual(['comment'])
  })

  it('refuses a contract with no Role schema, rather than passing on nothing', () => {
    expect(() => roleEnum({})).toThrow(/no Role schema/)
    expect(() => roleEnum({ components: { schemas: {} } })).toThrow(/no Role schema/)
  })

  it('refuses a Role schema without a readable enum', () => {
    expect(() => roleEnum({ components: { schemas: { Role: {} } } })).toThrow(/no enum/)
    expect(() => roleEnum({ components: { schemas: { Role: { enum: [] } } } })).toThrow(/no enum/)
    expect(() => roleEnum({ components: { schemas: { Role: { enum: [1] } } } })).toThrow(
      /non-string/,
    )
  })
})
