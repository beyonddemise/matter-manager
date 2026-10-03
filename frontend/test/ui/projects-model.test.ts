import { describe, expect, it } from 'vitest'
import type { LocalProjectEntry } from '../../src/data/index.js'
import type { Plan } from '../../src/domain/plan.js'
import type { Project } from '../../src/ui/projects.js'
import {
  type Permission,
  type ProjectsInput,
  projectsModel,
  type Row,
  type RowActions,
  type Session,
} from '../../src/ui/projects-model.js'
import type { SyncState } from '../../src/ui/sync/replication.js'

/**
 * Phase C: what the projects page shows and allows, for every plan, session and connection.
 *
 * The oracle below is the spec's "Actions" and "Cross-cutting states" tables restated, with the
 * plans named as literals on purpose: the source may not branch on a tier (ADR 0009), so a test
 * that names them is an independent reading rather than a copy of the implementation's lookups.
 */

const CREATED = '2026-10-01T00:00:00.000Z'

const local = (over: Partial<LocalProjectEntry> & Pick<LocalProjectEntry, 'dbName'>) =>
  ({ name: over.dbName, createdAt: CREATED, ...over }) satisfies LocalProjectEntry

const server = (projectId: string, over: Partial<Project> = {}): Project => ({
  projectId,
  dbName: `project_${projectId}`,
  name: projectId,
  role: 'owner',
  owner: { ownerType: 'user', ownerId: 'me' },
  archived: false,
  ...over,
})

/** One project of every kind the join can produce. */
const LOCAL: readonly LocalProjectEntry[] = [
  local({ dbName: 'project_local_alpha', name: 'Alpha', client: 'Acme' }),
  local({ dbName: 'project_bravo', name: 'Bravo', projectId: 'bravo' }),
  local({ dbName: 'project_delta', name: 'Delta', projectId: 'delta' }),
  local({ dbName: 'project_foxtrot', name: 'Foxtrot', projectId: 'foxtrot' }),
]

const SERVER: readonly Project[] = [
  server('bravo', { name: 'Bravo' }),
  server('charlie', { name: 'Charlie' }),
  server('delta', { name: 'Delta', archived: true, archivedAt: '2026-10-02T00:00:00.000Z' }),
  server('echo', { name: 'Echo', role: 'write', owner: { ownerType: 'user', ownerId: 'them' } }),
  server('foxtrot', {
    name: 'Foxtrot',
    role: 'read',
    owner: { ownerType: 'user', ownerId: 'them' },
  }),
  // Archived, with no local copy: dropped from the page entirely.
  server('golf', { name: 'Golf', archived: true }),
]

const input = (over: Partial<ProjectsInput> = {}): ProjectsInput => ({
  local: LOCAL,
  server: SERVER,
  plan: 'member',
  session: 'signed-in',
  online: true,
  syncStates: () => undefined,
  ...over,
})

const rows = (model: { owned: readonly Row[]; shared: readonly Row[] }) => [
  ...model.owned,
  ...model.shared,
]

const byKey = (model: { owned: readonly Row[]; shared: readonly Row[] }, dbName: string) => {
  const row = rows(model).find((candidate) => candidate.dbName === dbName)
  if (row === undefined) throw new Error(`no row for ${dbName}`)
  return row
}

const ok: Permission = { allowed: true }
const no = <R extends string>(reason: R): Permission<R> => ({ allowed: false, reason })
const na = no('not-applicable')

const PLANS: readonly Plan[] = ['free', 'member', 'pro']
const SESSIONS: readonly Session[] = ['signed-in', 'signed-out', 'expired']
const CONNECTIONS = [true, false] as const

describe('the page for every plan × session × connection × location', () => {
  for (const plan of PLANS) {
    for (const session of SESSIONS) {
      for (const online of CONNECTIONS) {
        const signedIn = session === 'signed-in'
        // The server list is only ever heard while signed in; offline it is the last one heard.
        const model = projectsModel(
          input({ plan, session, online, server: signedIn ? SERVER : undefined }),
        )
        const syncs = plan !== 'free'
        // The refusal any server action gets before plan or role is asked.
        const server = (): Permission | undefined =>
          !signedIn ? no('signed-out') : !online ? no('offline') : undefined
        const label = `${plan}, ${session}, ${online ? 'online' : 'offline'}`

        it(`${label}: a local-only project is always editable and can always be deleted`, () => {
          const row = byKey(model, 'project_local_alpha')
          expect(row).toMatchObject({ location: 'local', editable: true, archived: false })
          expect(row.actions).toEqual<RowActions>({
            open: ok,
            rename: ok,
            promote: server() ?? (syncs ? ok : no('plan')),
            download: na,
            removeLocal: na,
            deleteLocal: ok,
            removeServer: na,
          })
        })

        it(`${label}: an owned synchronized project`, () => {
          const row = byKey(model, 'project_bravo')
          expect(row).toMatchObject({ location: 'synced', projectId: 'bravo', editable: syncs })
          expect(row.actions).toEqual<RowActions>({
            open: ok,
            rename: server() ?? ok,
            promote: na,
            download: na,
            removeLocal: server() ?? ok,
            deleteLocal: na,
            removeServer: server() ?? ok,
          })
        })

        if (signedIn) {
          it(`${label}: an owned server-only project`, () => {
            const row = byKey(model, 'project_charlie')
            expect(row).toMatchObject({ location: 'server', role: 'owner', editable: syncs })
            expect(row.actions).toEqual<RowActions>({
              // "Not available offline": there is nothing on this device to open.
              open: online ? ok : no('offline'),
              rename: server() ?? ok,
              promote: na,
              download: server() ?? (syncs ? ok : no('plan')),
              removeLocal: na,
              deleteLocal: na,
              removeServer: server() ?? ok,
            })
          })

          it(`${label}: the local copy of an archived project is local, read-only, delete-only`, () => {
            const row = byKey(model, 'project_delta')
            expect(row).toMatchObject({ location: 'local', archived: true, editable: false })
            expect(row.actions).toEqual<RowActions>({
              open: ok,
              rename: no('read-only'),
              promote: na,
              download: na,
              removeLocal: na,
              deleteLocal: ok,
              removeServer: na,
            })
          })

          it(`${label}: a project shared for writing downloads on any plan`, () => {
            const row = byKey(model, 'project_echo')
            expect(model.shared).toContain(row)
            expect(row).toMatchObject({ location: 'server', role: 'write', editable: true })
            expect(row.actions).toEqual<RowActions>({
              open: online ? ok : no('offline'),
              rename: server() ?? no('role'),
              promote: na,
              download: server() ?? ok,
              removeLocal: na,
              deleteLocal: na,
              removeServer: server() ?? no('role'),
            })
          })

          it(`${label}: a project shared for reading is never editable`, () => {
            const row = byKey(model, 'project_foxtrot')
            expect(model.shared).toContain(row)
            expect(row).toMatchObject({ location: 'synced', role: 'read', editable: false })
            expect(row.actions.removeLocal).toEqual(server() ?? ok)
            expect(row.actions.removeServer).toEqual(server() ?? no('role'))
          })

          it(`${label}: counts owned projects once wherever they live, never shared or archived`, () => {
            expect(model.owned.map((row) => row.name)).toEqual([
              'Alpha',
              'Bravo',
              'Charlie',
              'Delta',
            ])
            expect(model.shared.map((row) => row.name)).toEqual(['Echo', 'Foxtrot'])
            expect(model.ownedCount).toBe(3)
          })
        } else {
          it(`${label}: unheard server: copies read as synchronized, server-only rows are absent`, () => {
            expect(rows(model).map((row) => row.location)).toEqual([
              'local',
              'synced',
              'synced',
              'synced',
            ])
            expect(rows(model).some((row) => row.dbName === 'project_charlie')).toBe(false)
          })
        }

        it(`${label}: creation and its target`, () => {
          expect(model.createTarget).toBe(signedIn && online && syncs ? 'synced' : 'local')
          if (!signedIn) expect(model.canCreate).toEqual(no('signed-out'))
        })

        it(`${label}: the layout is the plan's`, () => {
          expect(model.layout).toBe(plan)
        })
      }
    }
  }
})

describe('the limit', () => {
  const only = (entries: readonly LocalProjectEntry[], over: Partial<ProjectsInput> = {}) =>
    projectsModel(input({ local: entries, server: [], ...over }))
  const one = [local({ dbName: 'project_local_one', name: 'One' })]

  it('is the plan table entry until the server reports one', () => {
    expect(only([]).limit).toBe(5)
    expect(only([], { reportedLimit: 2 }).limit).toBe(2)
  })

  it('free may create its one project, then no more', () => {
    expect(only([], { plan: 'free' }).canCreate).toEqual(ok)
    expect(only(one, { plan: 'free' }).canCreate).toEqual(no('limit'))
  })

  it('pro is never at its limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => local({ dbName: `project_local_${i}` }))
    expect(only(many, { plan: 'pro' }).canCreate).toEqual(ok)
    expect(only(many, { plan: 'pro' }).overLimit).toBe(false)
  })

  it('over the limit after a downgrade: everything listed and usable, creation refused', () => {
    // Three owned projects (local, synced, server-only) on a plan that now allows one.
    const model = projectsModel(input({ plan: 'free' }))
    expect(model.ownedCount).toBe(3)
    expect(model.overLimit).toBe(true)
    expect(model.canCreate).toEqual(no('limit'))
    expect(model.owned.map((row) => row.actions.open.allowed)).toEqual([true, true, true, true])
  })

  it('at the limit is not over it', () => {
    const model = only(one, { plan: 'free' })
    expect(model.overLimit).toBe(false)
  })

  it('shared projects never count against it', () => {
    const shared = [server('s1', { role: 'write' }), server('s2', { role: 'manage' })]
    const model = projectsModel(input({ plan: 'free', local: [], server: shared }))
    expect(model.ownedCount).toBe(0)
    expect(model.canCreate).toEqual(ok)
  })

  it('offline, a member still creates — locally, counted against the same total', () => {
    expect(only([], { online: false }).canCreate).toEqual(ok)
    expect(only([], { online: false }).createTarget).toBe('local')
  })

  it('online but the server list was not heard: a synchronized create is refused', () => {
    const model = only([], { server: undefined })
    expect(model.createTarget).toBe('synced')
    expect(model.canCreate).toEqual(no('offline-server'))
  })

  it('a free account does not need the server list to create locally', () => {
    expect(only([], { plan: 'free', server: undefined }).canCreate).toEqual(ok)
  })

  it('an expired session creates nothing', () => {
    expect(only([], { session: 'expired' }).canCreate).toEqual(no('signed-out'))
  })
})

describe('the lapsed owner', () => {
  const model = projectsModel(input({ plan: 'free' }))

  it('opens server and synchronized projects read-only', () => {
    expect(byKey(model, 'project_bravo').editable).toBe(false)
    expect(byKey(model, 'project_charlie').editable).toBe(false)
  })

  it('keeps local-only projects editable', () => {
    expect(byKey(model, 'project_local_alpha').editable).toBe(true)
  })

  it('still writes to projects others share, since their owner pays', () => {
    expect(byKey(model, 'project_echo').editable).toBe(true)
  })

  it('may not download their own server project, but may archive it', () => {
    expect(byKey(model, 'project_charlie').actions.download).toEqual(no('plan'))
    expect(byKey(model, 'project_charlie').actions.removeServer).toEqual(ok)
  })
})

describe('joining the local index with the server list', () => {
  it('drops archived server projects with no local copy', () => {
    const model = projectsModel(input())
    expect(rows(model).some((row) => row.dbName === 'project_golf')).toBe(false)
  })

  it('takes the name and client from the server when it has spoken', () => {
    const model = projectsModel(
      input({
        local: [local({ dbName: 'project_bravo', projectId: 'bravo', name: 'Old', client: 'Old' })],
        server: [server('bravo', { name: 'New', client: 'Client' })],
      }),
    )
    expect(byKey(model, 'project_bravo')).toMatchObject({ name: 'New', client: 'Client' })
  })

  it('a copy the server no longer lists at all is local and read-only, delete-only', () => {
    const model = projectsModel(input({ server: [] }))
    const row = byKey(model, 'project_bravo')
    expect(row).toMatchObject({ location: 'local', archived: false, editable: false })
    expect(row.actions.deleteLocal).toEqual(ok)
    expect(row.actions.rename).toEqual(no('read-only'))
    expect(row.actions.removeLocal).toEqual(na)
    // Gone from the server's count, so gone from the page's.
    expect(model.ownedCount).toBe(1)
  })

  it('a copy whose role was never heard counts as owned: the reading that never over-creates', () => {
    const model = projectsModel(input({ server: undefined, online: false }))
    expect(model.owned).toHaveLength(4)
    expect(model.ownedCount).toBe(4)
    expect(byKey(model, 'project_foxtrot').location).toBe('synced')
    expect(byKey(model, 'project_foxtrot').role).toBeUndefined()
  })

  it('a manager renames a shared project; a writer does not', () => {
    const model = projectsModel(
      input({
        local: [],
        server: [server('m', { role: 'manage' }), server('w', { role: 'write' })],
      }),
    )
    expect(byKey(model, 'project_m').actions.rename).toEqual(ok)
    expect(byKey(model, 'project_w').actions.rename).toEqual(no('role'))
    expect(byKey(model, 'project_m').actions.removeServer).toEqual(no('role'))
  })

  it('carries each project’s live sync state, and none for local-only ones', () => {
    const states: Record<string, SyncState> = { bravo: 'denied', charlie: 'offline' }
    const asked: string[] = []
    const model = projectsModel(
      input({
        syncStates: (projectId) => {
          asked.push(projectId)
          return states[projectId]
        },
      }),
    )
    expect(byKey(model, 'project_bravo').syncState).toBe('denied')
    expect(byKey(model, 'project_charlie').syncState).toBe('offline')
    expect(byKey(model, 'project_local_alpha').syncState).toBeUndefined()
    expect(asked).not.toContain(undefined)
  })

  it('keys every row by its database name', () => {
    expect(rows(projectsModel(input())).map((row) => row.key)).toEqual(
      rows(projectsModel(input())).map((row) => row.dbName),
    )
  })
})
