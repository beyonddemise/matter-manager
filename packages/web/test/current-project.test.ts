import { describe, expect, it } from 'vitest'
import {
  CURRENT_PROJECT_KEY,
  canEdit,
  currentDatabaseName,
  LOCAL_DATABASE_NAME,
  LOCAL_PROJECT_ID,
  readCurrentProjectId,
  type SwitchableProject,
  switchableProjects,
  writeCurrentProjectId,
} from '../src/current-project.js'

/**
 * #55: moving between projects, with the current one remembered.
 *
 * The decisions worth pinning here are all about what happens when the stored choice and the
 * available projects disagree — which is the ordinary case, not an edge one: access is revoked,
 * a project is archived, somebody signs out, or a build renames things.
 */

const storage = (seed: Record<string, string> = {}) => {
  const held = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    held,
  }
}

const project = (over: Partial<SwitchableProject> = {}): SwitchableProject => ({
  projectId: 'p1',
  dbName: 'project_p1',
  name: 'Musterstraße 12',
  role: 'owner',
  archived: false,
  ...over,
})

describe('what the switcher offers', () => {
  it('always offers the catalogue that is on this device', () => {
    // It predates accounts, and everything recorded before signing in is in it. Leaving it out
    // would make somebody's devices vanish the moment they signed in.
    const offered = switchableProjects([], 'On this device')
    expect(offered).toHaveLength(1)
    expect(offered[0]?.projectId).toBe(LOCAL_PROJECT_ID)
  })

  it('puts the local catalogue first', () => {
    const offered = switchableProjects([project()], 'On this device')
    expect(offered[0]?.projectId).toBe(LOCAL_PROJECT_ID)
  })

  it('leaves out an archived project, which is what archiving is for', () => {
    const offered = switchableProjects([project({ archived: true })], 'On this device')
    expect(offered.map((p) => p.projectId)).toEqual([LOCAL_PROJECT_ID])
  })

  it('keeps the rest when one is archived', () => {
    const offered = switchableProjects(
      [project(), project({ projectId: 'p2', dbName: 'project_p2', archived: true })],
      'On this device',
    )
    expect(offered.map((p) => p.projectId)).toEqual([LOCAL_PROJECT_ID, 'p1'])
  })
})

describe('remembering which one is open', () => {
  it('starts on the local catalogue', () => {
    // Somebody who has never signed in arrives here, and the honest answer is the catalogue
    // that is definitely on this device.
    expect(readCurrentProjectId(() => storage())).toBe(LOCAL_PROJECT_ID)
  })

  it('reads back what was written', () => {
    const local = storage()
    writeCurrentProjectId(() => local, 'p1')
    expect(readCurrentProjectId(() => local)).toBe('p1')
  })

  it('survives storage that refuses to be read', () => {
    expect(
      readCurrentProjectId(() => {
        throw new DOMException('denied', 'SecurityError')
      }),
    ).toBe(LOCAL_PROJECT_ID)
  })
})

describe('which database the views open', () => {
  it('opens the project that is chosen', () => {
    expect(currentDatabaseName(switchableProjects([project()], 'x'), 'p1')).toBe('project_p1')
  })

  it('falls back when the choice is no longer on offer', () => {
    // Access revoked, project archived, or signed out. A view handed no database shows an
    // empty catalogue, which is indistinguishable from having lost everything - so there is
    // always an answer, and it is the one that is definitely here.
    const stored = storage({ [CURRENT_PROJECT_KEY]: 'gone' })
    const current = readCurrentProjectId(() => stored)
    expect(currentDatabaseName(switchableProjects([project()], 'x'), current)).toBe(
      LOCAL_DATABASE_NAME,
    )
  })

  it('falls back when the chosen project has been archived', () => {
    const offered = switchableProjects([project({ archived: true })], 'x')
    expect(currentDatabaseName(offered, 'p1')).toBe(LOCAL_DATABASE_NAME)
  })
})

describe('whether the open project may be edited', () => {
  it('allows the local catalogue, which is the reader’s own', () => {
    expect(canEdit(switchableProjects([], 'x'), LOCAL_PROJECT_ID)).toBe(true)
  })

  it.each(['owner', 'manage', 'write'] as const)('allows %s', (role) => {
    expect(canEdit(switchableProjects([project({ role })], 'x'), 'p1')).toBe(true)
  })

  it('refuses read', () => {
    expect(canEdit(switchableProjects([project({ role: 'read' })], 'x'), 'p1')).toBe(false)
  })

  it('allows a project it has never heard of, because that is the local catalogue', () => {
    // The fallback above sends an unknown id to the local database, so the two answers have to
    // agree: a view showing the local catalogue must not have its editing controls removed.
    expect(canEdit(switchableProjects([], 'x'), 'gone')).toBe(true)
  })
})
