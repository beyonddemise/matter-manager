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
  // Downloaded from a share: the index remembers the role for when no server list is to hand.
  local({ dbName: 'project_foxtrot', name: 'Foxtrot', projectId: 'foxtrot', role: 'read' }),
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
/** This session's answer, the last one cached, or none ever heard. */
const LISTS = ['fresh', 'stale', 'unheard'] as const

describe('the page for every plan × session × connection × server list × location', () => {
  for (const plan of PLANS) {
    for (const session of SESSIONS) {
      for (const online of CONNECTIONS) {
        for (const list of LISTS) {
          const signedIn = session === 'signed-in'
          const heard = list !== 'unheard'
          const model = projectsModel(
            input({
              plan,
              session,
              online,
              server: heard ? SERVER : undefined,
              serverStale: list === 'stale',
            }),
          )
          const syncs = plan !== 'free'
          const limit = { free: 1, member: 5, pro: Number.POSITIVE_INFINITY }[plan]
          // The refusal any server action gets before plan or role is asked.
          const server = (): Permission | undefined =>
            !signedIn
              ? no('signed-out')
              : !online
                ? no('offline')
                : list !== 'fresh'
                  ? no('stale')
                  : undefined
          const label = `${plan}, ${session}, ${online ? 'online' : 'offline'}, ${list} list`

          it(`${label}: a local-only project is always editable and can always be deleted`, () => {
            const row = byKey(model, 'project_local_alpha')
            expect(row).toMatchObject({ location: 'local', editable: true, archived: false })
            expect(row.role).toBeUndefined()
            expect(row.actions).toEqual<RowActions>({
              open: ok,
              rename: ok,
              // Three owned projects are within every plan that syncs.
              promote: server() ?? (syncs ? ok : no('plan')),
              download: na,
              removeLocal: na,
              deleteLocal: ok,
              removeServer: na,
            })
          })

          it(`${label}: an owned synchronized project`, () => {
            const row = byKey(model, 'project_bravo')
            expect(row).toMatchObject({
              location: 'synced',
              projectId: 'bravo',
              role: 'owner',
              editable: syncs,
            })
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

          it(`${label}: a project shared for reading is shared and never editable`, () => {
            const row = byKey(model, 'project_foxtrot')
            expect(model.shared).toContain(row)
            expect(row).toMatchObject({ location: 'synced', role: 'read', editable: false })
            expect(row.actions.removeLocal).toEqual(server() ?? ok)
            expect(row.actions.removeServer).toEqual(server() ?? no('role'))
          })

          it(`${label}: counts owned projects once wherever they live, never shared or archived`, () => {
            expect(model.ownedCount).toBe(3)
            expect(model.shared.map((row) => row.name)).toEqual(
              heard ? ['Echo', 'Foxtrot'] : ['Foxtrot'],
            )
          })

          it(`${label}: creation, its target and its refusal`, () => {
            const target = signedIn && online && syncs ? 'synced' : 'local'
            expect(model.createTarget).toBe(target)
            expect(model.canCreate).toEqual(
              !signedIn
                ? no('signed-out')
                : 3 >= limit
                  ? no('limit')
                  : target === 'synced' && list !== 'fresh'
                    ? no('offline-server')
                    : ok,
            )
          })

          it(`${label}: the layout is the plan's`, () => {
            expect(model.layout).toBe(plan)
          })

          if (heard) {
            it(`${label}: an owned server-only project`, () => {
              const row = byKey(model, 'project_charlie')
              expect(row).toMatchObject({ location: 'server', role: 'owner', editable: syncs })
              expect(row.actions).toEqual<RowActions>({
                // "Not available offline": there is nothing on this device to open.
                open: server() ?? ok,
                rename: server() ?? ok,
                promote: na,
                download: server() ?? (syncs ? ok : no('plan')),
                removeLocal: na,
                deleteLocal: na,
                removeServer: server() ?? ok,
              })
            })

            it(`${label}: the copy of an archived project is local, read-only, delete-only`, () => {
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
                open: server() ?? ok,
                rename: server() ?? no('role'),
                promote: na,
                download: server() ?? ok,
                removeLocal: na,
                deleteLocal: na,
                removeServer: server() ?? no('role'),
              })
            })

            it(`${label}: owned lists every owned project, the archived copy included`, () => {
              expect(model.owned.map((row) => row.name)).toEqual([
                'Alpha',
                'Bravo',
                'Charlie',
                'Delta',
              ])
            })
          } else {
            it(`${label}: copies read as synchronized, server-only rows are absent`, () => {
              expect(model.owned.map((row) => [row.name, row.location])).toEqual([
                ['Alpha', 'local'],
                ['Bravo', 'synced'],
                ['Delta', 'synced'],
              ])
              expect(rows(model).some((row) => row.dbName === 'project_charlie')).toBe(false)
            })
          }
        }
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

  it('over the limit, promoting is refused: the server counts only its own active projects', () => {
    // A pro account downgraded to member, keeping six server projects and one local-only one.
    const six = Array.from({ length: 6 }, (_, i) => server(`p${i}`))
    const model = projectsModel(
      input({ local: [local({ dbName: 'project_local_x', name: 'X' })], server: six }),
    )
    expect(model.overLimit).toBe(true)
    expect(byKey(model, 'project_local_x').actions.promote).toEqual(no('limit'))
  })

  it('offline with the last known list: five server projects leave no room for a sixth', () => {
    const five = Array.from({ length: 5 }, (_, i) => server(`p${i}`))
    const model = projectsModel(
      input({ local: [], server: five, serverStale: true, online: false }),
    )
    expect(model.ownedCount).toBe(5)
    expect(model.createTarget).toBe('local')
    expect(model.canCreate).toEqual(no('limit'))
  })

  it('online with only the last known list: a synchronized create waits for a fresh one', () => {
    const model = only([], { serverStale: true })
    expect(model.canCreate).toEqual(no('offline-server'))
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

  it('a copy a fresh list no longer names is local, read-only, delete-only, with a warning', () => {
    const model = projectsModel(input({ server: [] }))
    const row = byKey(model, 'project_bravo')
    expect(row).toMatchObject({ location: 'local', archived: false, editable: false })
    expect(row.actions.deleteLocal).toEqual({ allowed: true, warn: 'unpushed-may-be-lost' })
    expect(row.actions.rename).toEqual(no('read-only'))
    expect(row.actions.removeLocal).toEqual(na)
    // Gone from the server's count, so gone from the page's.
    expect(model.ownedCount).toBe(1)
  })

  it('a stale list is never proof that a copy is gone', () => {
    const model = projectsModel(input({ server: [], serverStale: true, online: false }))
    const row = byKey(model, 'project_bravo')
    expect(row).toMatchObject({ location: 'synced', editable: true })
    expect(row.actions.deleteLocal).toEqual(na)
    expect(row.actions.removeLocal).toEqual(no('offline'))
  })

  it('a copy of an archived project in the last known list is local and read-only', () => {
    const model = projectsModel(input({ serverStale: true, online: false }))
    const row = byKey(model, 'project_delta')
    expect(row).toMatchObject({ location: 'local', archived: true, editable: false })
    expect(row.actions.deleteLocal).toEqual(ok)
  })

  it('with no server list, a copy takes the role its index entry recorded', () => {
    const model = projectsModel(
      input({
        server: undefined,
        online: false,
        local: [
          local({ dbName: 'project_w', projectId: 'w', role: 'write' }),
          local({ dbName: 'project_m', projectId: 'm', role: 'manage' }),
        ],
      }),
    )
    expect(model.ownedCount).toBe(0)
    expect(model.shared.map((row) => [row.dbName, row.role, row.editable])).toEqual([
      ['project_m', 'manage', true],
      ['project_w', 'write', true],
    ])
  })

  it('a copy that recorded no role is the owner’s: the reading that never over-creates', () => {
    const model = projectsModel(
      input({ server: undefined, local: [local({ dbName: 'project_o', projectId: 'o' })] }),
    )
    expect(model.owned.map((row) => row.role)).toEqual(['owner'])
    expect(model.ownedCount).toBe(1)
  })

  it('the server list’s role wins over the one the index recorded', () => {
    const model = projectsModel(
      input({
        local: [local({ dbName: 'project_x', projectId: 'x', role: 'read' })],
        server: [server('x', { role: 'manage' })],
      }),
    )
    expect(byKey(model, 'project_x').role).toBe('manage')
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
    // Asked once for every project with a server side, and never for the local-only one.
    expect(asked.sort()).toEqual(['bravo', 'charlie', 'delta', 'echo', 'foxtrot'])
  })

  it('keys every row by its database name', () => {
    expect(rows(projectsModel(input())).map((row) => row.key)).toEqual(
      rows(projectsModel(input())).map((row) => row.dbName),
    )
  })
})

describe('the first-run name', () => {
  it('asks for one when an owned local-only project has none', () => {
    const model = projectsModel(
      input({ local: [local({ dbName: 'project_local', name: '  ' })], server: [] }),
    )
    expect(model.needsName?.dbName).toBe('project_local')
  })

  it('does not ask when every project is named', () => {
    expect(projectsModel(input()).needsName).toBeUndefined()
  })

  it('does not ask about a server project, whose name the service owns', () => {
    const model = projectsModel(
      input({
        local: [local({ dbName: 'project_bravo', name: '', projectId: 'bravo' })],
        server: undefined,
      }),
    )
    expect(model.needsName).toBeUndefined()
  })
})

describe('a promotion that stopped half way', () => {
  // `POST /projects` answered and the index entry recorded the id, but the data has not moved
  // yet: the database is still the local-only one, and it is the only place the data is.
  const halfway = local({ dbName: 'project_local_hotel', name: 'Hotel', projectId: 'hotel' })
  const list = [server('hotel', { name: 'Hotel' })]

  it('stays local and editable, and offers promote again to finish it', () => {
    const model = projectsModel(input({ local: [halfway], server: list }))
    const row = byKey(model, 'project_local_hotel')
    expect(row).toMatchObject({ location: 'local', projectId: 'hotel', editable: true })
    expect(row.actions).toEqual<RowActions>({
      open: ok,
      // The name now lives on the server too; changing one side only would split it.
      rename: na,
      promote: ok,
      download: na,
      removeLocal: na,
      deleteLocal: ok,
      removeServer: na,
    })
  })

  it('counts once, with its server project, and lists no second row for it', () => {
    const model = projectsModel(input({ local: [halfway], server: list }))
    expect(rows(model)).toHaveLength(1)
    expect(model.ownedCount).toBe(1)
  })

  it('finishes even over the limit: the server project already exists', () => {
    const model = projectsModel(input({ local: [halfway], server: list, reportedLimit: 0 }))
    expect(byKey(model, 'project_local_hotel').actions.promote).toEqual(ok)
  })

  it('needs the server to finish, and a plan that syncs', () => {
    expect(
      byKey(
        projectsModel(input({ local: [halfway], server: list, online: false })),
        'project_local_hotel',
      ).actions.promote,
    ).toEqual(no('offline'))
    expect(
      byKey(
        projectsModel(input({ local: [halfway], server: list, plan: 'free' })),
        'project_local_hotel',
      ).actions.promote,
    ).toEqual(no('plan'))
  })

  it('is never an orphan, even when a fresh list does not name it', () => {
    const row = byKey(projectsModel(input({ local: [halfway], server: [] })), 'project_local_hotel')
    expect(row).toMatchObject({ location: 'local', editable: true })
    expect(row.actions.deleteLocal).toEqual(ok)
  })
})
