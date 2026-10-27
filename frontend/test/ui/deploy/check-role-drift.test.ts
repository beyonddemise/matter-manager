import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const checker = join(packageRoot, 'scripts/check-role-drift.mjs')

/**
 * A contract fixture with the shape the real `openapi.yaml` has around its `Role` schema.
 *
 * The `Principal` schema above it is not decoration: its `enum: [user, org]` is a decoy. A
 * parser that grabbed "the first enum in the file" would read that one and never fail these
 * tests honestly, so the fixture plants it to prove the checker finds the `Role` schema
 * specifically.
 */
const spec = (roles: string) => `openapi: 3.1.0
info:
  title: Fixture
components:
  schemas:
    Principal:
      type: object
      properties:
        ownerType: { type: string, enum: [user, org] }
    Role:
      type: string
      enum: [${roles}]
      description: |
        What a participant may do in a project.
    Device:
      type: object
`

const union = (members: string[]) =>
  `export type ProjectRole = ${members.map((m) => `'${m}'`).join(' | ')}\n`

const AGREED_SPEC = spec('owner, manage, write, read')
const AGREED_UNION = union(['owner', 'manage', 'write', 'read'])

/** Runs the check over throwaway copies of the two files, as the other checker tests do. */
function check(files: { spec?: string; union?: string }): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'check-role-drift-test-'))
  try {
    const args = [checker]
    if (files.spec !== undefined) {
      writeFileSync(join(dir, 'openapi.yaml'), files.spec)
      args.push('--spec', join(dir, 'openapi.yaml'))
    }
    if (files.union !== undefined) {
      writeFileSync(join(dir, 'role.ts'), files.union)
      args.push('--union', join(dir, 'role.ts'))
    }
    const result = spawnSync('node', args, { encoding: 'utf8' })
    return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the role-drift check', () => {
  it('accepts a union and a contract enum that agree', () => {
    const { code, output } = check({ spec: AGREED_SPEC, union: AGREED_UNION })
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('accepts the files this repository actually has', () => {
    // The positive control that matters: the parser recognises the real `openapi.yaml` and the
    // real `src/domain/role.ts`, not just fixtures shaped by the same hand that wrote it.
    const result = spawnSync('node', [checker], { encoding: 'utf8' })
    const output = `${result.stdout}${result.stderr}`
    expect(output).toContain('ok')
    expect(result.status).toBe(0)
  })

  it('accepts a contract that writes the enum in block style', () => {
    // The real file uses flow style today; a formatter could legitimately rewrite it.
    const blockSpec = AGREED_SPEC.replace(
      'enum: [owner, manage, write, read]',
      'enum:\n        - owner\n        - manage\n        - write\n        - read',
    )
    const { code, output } = check({ spec: blockSpec, union: AGREED_UNION })
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('accepts a contract whose flow enum quotes its values', () => {
    // `enum: ['owner', 'manage', …]` is the same YAML document as the unquoted spelling; the
    // quotes must not read as drift.
    const { code, output } = check({
      spec: spec("'owner', 'manage', 'write', 'read'"),
      union: AGREED_UNION,
    })
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('accepts a Role schema that opens with a comment line', () => {
    // A YAML comment sits at whatever indent its author liked; it must not be mistaken for the
    // block's first key and fix the child indentation the real keys then fail to match.
    const { code, output } = check({
      spec: AGREED_SPEC.replace(
        '    Role:\n',
        '    Role:\n        # What a participant may do; see ADR 0017.\n',
      ),
      union: AGREED_UNION,
    })
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('fails when the contract has a role the union lacks, naming it and both files', () => {
    const { code, output } = check({
      spec: spec('owner, manage, write, read, audit'),
      union: AGREED_UNION,
    })
    expect(code).toBe(1)
    expect(output).toContain('audit')
    expect(output).toContain('openapi.yaml')
    expect(output).toContain('role.ts')
  })

  it('fails when the union has a role the contract lacks, naming it and both files', () => {
    const { code, output } = check({
      spec: AGREED_SPEC,
      union: union(['owner', 'manage', 'write', 'read', 'comment']),
    })
    expect(code).toBe(1)
    expect(output).toContain('comment')
    expect(output).toContain('openapi.yaml')
    expect(output).toContain('role.ts')
  })

  it('refuses a contract with no Role schema, rather than calling the union drifted or fine', () => {
    // An empty extraction is the harness failing, not the subject passing (lessons.md L3). A
    // renamed schema must turn this check red, never let it report ok against nothing.
    const { code, output } = check({
      spec: AGREED_SPEC.replace('    Role:', '    ParticipantRole:'),
      union: AGREED_UNION,
    })
    expect(code).toBe(1)
    expect(output).toContain('Role')
  })

  it('refuses a Role schema that carries no enum', () => {
    const { code, output } = check({
      spec: AGREED_SPEC.replace('enum: [owner, manage, write, read]', 'format: role'),
      union: AGREED_UNION,
    })
    expect(code).toBe(1)
    expect(output).toContain('enum')
  })

  it('refuses a role module with no ProjectRole union', () => {
    const { code, output } = check({
      spec: AGREED_SPEC,
      union: 'export type Something = 1 | 2\n',
    })
    expect(code).toBe(1)
    expect(output).toContain('ProjectRole')
  })

  it('refuses a ProjectRole that is no longer a union of string literals', () => {
    const { code, output } = check({
      spec: AGREED_SPEC,
      union: 'export type ProjectRole = string\n',
    })
    expect(code).toBe(1)
    expect(output).toContain('ProjectRole')
  })

  it('refuses a union that mixes the agreed literals with a non-literal member', () => {
    // The dangerous shape: the four literals are all present and all agree, but `| string`
    // makes the type accept anything. Extracting only the literals would call this ok.
    const { code, output } = check({
      spec: AGREED_SPEC,
      union: "export type ProjectRole = 'owner' | 'manage' | 'write' | 'read' | string\n",
    })
    expect(code).toBe(1)
    expect(output).toContain('ProjectRole')
    expect(output).toContain('string')
  })

  it('does not let an enum nested deeper in the Role schema stand in for its own', () => {
    // The Role schema's own enum is gone; a line inside its description still spells one out.
    // Only a direct child of `Role:` is the contract — anything deeper is prose.
    const { code, output } = check({
      spec: AGREED_SPEC.replace(
        '      enum: [owner, manage, write, read]\n      description: |\n        What a participant may do in a project.',
        '      description: |\n        Historically:\n          enum: [owner, manage, write, read]',
      ),
      union: AGREED_UNION,
    })
    expect(code).toBe(1)
    expect(output).toContain('enum')
  })

  it('reads the live declaration, not a commented-out one above it', () => {
    // A stale `// export type ProjectRole = …` that still agrees with the contract must not
    // validate the file while the live declaration below it has drifted.
    const { code, output } = check({
      spec: AGREED_SPEC,
      union:
        "// export type ProjectRole = 'owner' | 'manage' | 'write' | 'read'\n" +
        "export type ProjectRole = 'owner' | 'manage' | 'write' | 'read' | 'comment'\n",
    })
    expect(code).toBe(1)
    expect(output).toContain('comment')
  })

  it('fails a multiline union whose extra member hides on the next line', () => {
    // The finding: a trailing `|` continues the type onto the next line, so a match that stops
    // at end-of-line sees four agreeing literals and never the fifth.
    const { code, output } = check({
      spec: AGREED_SPEC,
      union: "export type ProjectRole = 'owner' | 'manage' | 'write' | 'read' |\n  'audit'\n",
    })
    expect(code).toBe(1)
    expect(output).toContain('audit')
  })

  it('accepts a multiline union, in trailing-pipe and leading-pipe style', () => {
    // Both legitimate spellings of the same type, the second being what a formatter writes
    // once the union grows.
    const trailing = check({
      spec: AGREED_SPEC,
      union: "export type ProjectRole =\n  'owner' |\n  'manage' |\n  'write' |\n  'read'\n",
    })
    expect(trailing.output).toContain('ok')
    expect(trailing.code).toBe(0)

    const leading = check({
      spec: AGREED_SPEC,
      union: "export type ProjectRole =\n  | 'owner'\n  | 'manage'\n  | 'write'\n  | 'read'\n",
    })
    expect(leading.output).toContain('ok')
    expect(leading.code).toBe(0)
  })

  it('refuses a declaration left dangling on a pipe, rather than reading it as drift', () => {
    const { code, output } = check({
      spec: AGREED_SPEC,
      union: "export type ProjectRole = 'owner' | 'manage' |\n",
    })
    expect(code).toBe(1)
    expect(output).toContain('dangling')
  })

  it('refuses a module where ProjectRole survives only in a comment', () => {
    const { code, output } = check({
      spec: AGREED_SPEC,
      union:
        "// export type ProjectRole = 'owner' | 'manage' | 'write' | 'read'\n" +
        'export type Something = 1\n',
    })
    expect(code).toBe(1)
    expect(output).toContain('No `ProjectRole` declaration')
  })

  it('says so when the contract file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-role-drift-test-'))
    try {
      writeFileSync(join(dir, 'role.ts'), AGREED_UNION)
      const result = spawnSync(
        'node',
        [checker, '--spec', join(dir, 'openapi.yaml'), '--union', join(dir, 'role.ts')],
        { encoding: 'utf8' },
      )
      expect(result.status).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain('openapi.yaml')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
