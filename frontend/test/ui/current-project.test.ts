import { describe, expect, it } from 'vitest'
import type { LocalProjectEntry } from '../../src/data/index.js'
import {
  CURRENT_PROJECT_KEY,
  LOCAL_DATABASE_NAME,
  LOCAL_PROJECT_ID,
  readCurrentProjectId,
  resolveCurrentProject,
  writeCurrentProjectId,
} from '../../src/ui/current-project.js'
import type { Project } from '../../src/ui/projects.js'
import { type ProjectsInput, projectsModel } from '../../src/ui/projects-model.js'

/**
 * Which project is open: the stored choice, matched against what this device holds.
 *
 * The decisions worth pinning here are all about what happens when the stored choice and the
 * projects on this device disagree — which is the ordinary case, not an edge one: a copy is
 * removed, a project is archived, somebody signs out, or an older build stored another kind of
 * id.
 */

const storage = (seed: Record<string, string> = {}) => {
  const held = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    held,
  }
}

const entry = (over: Partial<LocalProjectEntry> = {}): LocalProjectEntry => ({
  dbName: 'project_local_a',
  name: 'Alpha',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

const project = (over: Partial<Project> = {}): Project => ({
  projectId: 'p1',
  dbName: 'project_p1',
  name: 'Musterstraße 12',
  role: 'owner',
  owner: { ownerType: 'user', ownerId: 'u1' },
  archived: false,
  ...over,
})

const model = (over: Partial<ProjectsInput> = {}) =>
  projectsModel({
    local: [],
    server: undefined,
    plan: 'member',
    session: 'signed-in',
    online: true,
    syncStates: () => undefined,
    ...over,
  })

const synced = entry({ dbName: 'project_p1', name: 'Musterstraße 12', projectId: 'p1' })

describe('remembering which one is open', () => {
  it('starts on the local catalogue', () => {
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

  it('stores under the key the page and the shell share', () => {
    const local = storage()
    writeCurrentProjectId(() => local, 'project_local_a')
    expect(local.held.get(CURRENT_PROJECT_KEY)).toBe('project_local_a')
  })
})

describe('which project the views open', () => {
  it('opens a synchronized project stored by its project id', () => {
    const current = resolveCurrentProject('p1', model({ local: [entry(), synced] }))
    expect(current).toEqual({ dbName: 'project_p1', id: 'p1', editable: true })
  })

  it('opens a local-only project stored by its database name', () => {
    // Open remembers `projectId ?? dbName`: a local-only project has no other name.
    const current = resolveCurrentProject('project_local_a', model({ local: [entry(), synced] }))
    expect(current).toEqual({ dbName: 'project_local_a', id: 'project_local_a', editable: true })
  })

  it('finds a promoted project stored by the database name it had before', () => {
    // Stored while local-only, then promoted on another tab: the name has gone, the id has not.
    const current = resolveCurrentProject('project_p1', model({ local: [synced] }))
    expect(current.dbName).toBe('project_p1')
  })

  it('never reopens the source of a promotion by its new project id', () => {
    // Mid-promotion the source is a local-only database whose entry already records the server
    // id, and the stored choice is that id (the views were moved to the survivor). Matching the
    // source by id would put this tab's next write into a database about to be destroyed.
    const source = entry({ projectId: 'p1' })
    const current = resolveCurrentProject('p1', model({ local: [source, synced] }))
    expect(current.dbName).toBe('project_p1')
  })

  it('prefers the database named over a project id that happens to match it', () => {
    // Mid-promotion: only the source is indexed, and it records the new id.
    const source = entry({ projectId: 'p1' })
    const current = resolveCurrentProject('project_local_a', model({ local: [source] }))
    expect(current.dbName).toBe('project_local_a')
  })

  it('opens the copy, not the leftover source, of a promotion whose last destroy failed', () => {
    // Both are indexed under one id; the model shows only the copy, so the source is no
    // candidate even when the choice still names it.
    const source = entry({ projectId: 'p1' })
    const current = resolveCurrentProject('project_local_a', model({ local: [source, synced] }))
    expect(current.dbName).toBe('project_p1')
  })

  it('reads the legacy "local" choice as the first-run catalogue', () => {
    const legacy = entry({ dbName: LOCAL_DATABASE_NAME, name: 'Home' })
    const current = resolveCurrentProject(LOCAL_PROJECT_ID, model({ local: [synced, legacy] }))
    expect(current.dbName).toBe(LOCAL_DATABASE_NAME)
  })

  it('falls back to the first local project when the choice is not on this device', () => {
    // A copy removed, signed out, or an id from a build that named them differently. A view
    // handed no database shows an empty catalogue, which looks exactly like losing everything.
    const current = resolveCurrentProject(
      'gone',
      model({ local: [synced, entry({ dbName: 'project_local_b', name: 'Beta' })] }),
    )
    expect(current).toEqual({ dbName: 'project_local_b', id: 'project_local_b', editable: true })
  })

  it('falls back to a copy when there is no local-only project', () => {
    const current = resolveCurrentProject('gone', model({ local: [synced] }))
    expect(current.dbName).toBe('project_p1')
  })

  it('never opens a project that is only on the server', () => {
    // A server-only row has no database here; opening it would show an empty catalogue.
    const current = resolveCurrentProject('p1', model({ local: [entry()], server: [project()] }))
    expect(current.dbName).toBe('project_local_a')
  })

  it('opens the first-run catalogue when nothing is indexed at all', () => {
    expect(resolveCurrentProject('gone', model())).toEqual({
      dbName: LOCAL_DATABASE_NAME,
      id: LOCAL_DATABASE_NAME,
      editable: true,
    })
  })

  it('opens a lapsed owner’s server project read-only', () => {
    // The plan no longer syncs, so CouchDB would refuse the writes; the model says so.
    const current = resolveCurrentProject(
      'p1',
      model({ plan: 'free', local: [synced], server: [project()] }),
    )
    expect(current).toEqual({ dbName: 'project_p1', id: 'p1', editable: false })
  })

  it('opens an archived project’s copy read-only', () => {
    const current = resolveCurrentProject(
      'p1',
      model({ local: [synced], server: [project({ archived: true })] }),
    )
    expect(current.editable).toBe(false)
  })
})
