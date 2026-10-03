import { describe, expect, it } from 'vitest'
import { accessValidator } from '../../src/projects/design-docs.js'

type Validate = (
  newDoc: Record<string, unknown>,
  oldDoc: Record<string, unknown> | undefined,
  userCtx: { name: string; roles: string[] },
  secObj: Record<string, unknown>,
) => void

/** The shipped function source, evaluated the way CouchDB's JS engine would hold it. */
const validate = new Function(`return (${accessValidator()})`)() as Validate

const NO_PLAN = 'Your plan does not include synchronized projects.'
const READ_ONLY = 'You have read-only access to this project.'

const secObj = {
  members: { names: ['olga', 'wanda', 'rita'], roles: [] },
  writers: { names: ['olga', 'wanda'] },
  owners: { names: ['olga'] },
}
const doc = { type: 'matter', name: 'x' }
const deletion = { _id: 'matter:1', _rev: '1-a', _deleted: true }

/** Runs the validator and returns what it threw, or `undefined` when the write is allowed. */
function attempt(
  newDoc: Record<string, unknown>,
  name: string,
  roles: string[],
  sec: Record<string, unknown> = secObj,
): unknown {
  try {
    validate(newDoc, undefined, { name, roles }, sec)
    return undefined
  } catch (thrown) {
    return thrown
  }
}

describe('the access validator and the owner plan rule', () => {
  it.each([
    ['owner with no roles', 'olga', [], { forbidden: NO_PLAN }],
    ['owner with only free', 'olga', ['free'], { forbidden: NO_PLAN }],
    ['owner with member', 'olga', ['member'], undefined],
    ['owner with pro', 'olga', ['pro'], undefined],
    ['invited writer with no roles', 'wanda', [], undefined],
    ['reader with member', 'rita', ['member'], { forbidden: READ_ONLY }],
    ['reader with no roles', 'rita', [], { forbidden: READ_ONLY }],
    ['server admin with no plan', 'olga', ['_admin'], undefined],
  ])('%s', (_label, name, roles, expected) => {
    expect(attempt(doc, name, roles)).toEqual(expected)
  })

  it('refuses a deletion by an owner without a paying plan', () => {
    expect(attempt(deletion, 'olga', [])).toEqual({ forbidden: NO_PLAN })
  })

  it('allows a deletion by an owner with a paying plan', () => {
    expect(attempt(deletion, 'olga', ['member'])).toBeUndefined()
  })

  it('is inert when _security carries no owners key', () => {
    const { owners: _owners, ...withoutOwners } = secObj
    expect(attempt(doc, 'olga', [], withoutOwners)).toBeUndefined()
  })
})

/** As {@link attempt}, for a write that replaces or deletes an existing revision. */
function attemptOver(
  newDoc: Record<string, unknown>,
  oldDoc: Record<string, unknown>,
  name: string,
  roles: string[],
  sec: Record<string, unknown> = secObj,
): unknown {
  try {
    validate(newDoc, oldDoc, { name, roles }, sec)
    return undefined
  } catch (thrown) {
    return thrown
  }
}

describe('the access validator and the project document', () => {
  const SERVICE_ONLY = 'Only the service may change the project document.'
  const projectDoc = { _id: 'project', type: 'project', name: 'Home', serverDb: 'project_x' }
  const stored = { ...projectDoc, _rev: '1-a' }

  it.each([
    ['an owner with a paying plan', 'olga', ['member']],
    ['an invited writer', 'wanda', []],
  ])('refuses %s creating it', (_label, name, roles) => {
    expect(attempt(projectDoc, name, roles)).toEqual({ forbidden: SERVICE_ONLY })
  })

  it('refuses an owner with a paying plan renaming it', () => {
    expect(attemptOver({ ...stored, name: 'Elsewhere' }, stored, 'olga', ['member'])).toEqual({
      forbidden: SERVICE_ONLY,
    })
  })

  it('refuses an owner with a paying plan deleting it', () => {
    // A deletion carries `_id`, so the id alone would catch it; the old revision is checked as
    // well so the rule does not depend on what a deletion happens to carry.
    const remove = { _id: 'project', _rev: '1-a', _deleted: true }
    expect(attemptOver(remove, stored, 'olga', ['member'])).toEqual({ forbidden: SERVICE_ONLY })
  })

  it('lets the server admin write it', () => {
    expect(
      attemptOver({ ...stored, name: 'Elsewhere' }, stored, 'olga', ['_admin']),
    ).toBeUndefined()
  })

  it('leaves every other document to the other rules', () => {
    expect(attempt({ _id: 'matter:1', type: 'matter' }, 'olga', ['member'])).toBeUndefined()
  })
})
