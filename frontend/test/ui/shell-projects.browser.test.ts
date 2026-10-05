import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/card/card.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import { fixture, fixtureCleanup, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedProfile, LocalProjectEntry } from '../../src/data/index.js'
import type { AppShell } from '../../src/ui/app-shell.js'
import '../../src/ui/app-shell.js'
import { CURRENT_PROJECT_KEY, writeCurrentProjectId } from '../../src/ui/current-project.js'
import {
  currentProjectDatabaseName,
  projectIsEditable,
  useProjectDatabase,
} from '../../src/ui/db/project-database.js'
import type { LocalProjectDependencies } from '../../src/ui/local-projects.js'
import { beginProjectAction, projectActionRunning } from '../../src/ui/project-busy.js'
import type { Project } from '../../src/ui/projects.js'
import type { SyncableProject } from '../../src/ui/sync/manager.js'
import type { ProjectsView } from '../../src/ui/views/projects.js'
import { refresherNeverAnswering, refresherReporting } from './refresher-stub.js'
import { destroyProjectStores, isolatedProjectStore } from './support/project-store.js'

/**
 * Phase C, task 8: the shell lands on the projects page and hands it everything it needs, and
 * the header and menu carry the account — email, network, sign-out, upgrade.
 *
 * Every outward reach is injected, the local index included: each test gets its own `mm-local`
 * and its own project databases, so nothing here touches what the application keeps.
 */

const entry = (over: Partial<LocalProjectEntry> = {}): LocalProjectEntry => ({
  dbName: 'project_local_a',
  name: 'Alpha',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

const copy = entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1', role: 'owner' })

const project = (over: Partial<Project> = {}): Project => ({
  projectId: 'p1',
  dbName: 'project_p1',
  name: 'Beta',
  role: 'owner',
  owner: { ownerType: 'user', ownerId: 'u1' },
  archived: false,
  ...over,
})

const profile = (over: Partial<CachedProfile> = {}): CachedProfile => ({
  sub: 'google|1',
  email: 'ada@example.org',
  plan: 'member',
  projectLimit: 5,
  fetchedAt: '2026-10-03T08:00:00.000Z',
  ...over,
})

/** A network a test can take away. */
function fakeNetwork(onLine = true) {
  const listeners = new Map<string, Set<() => void>>()
  return {
    onLine,
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener)
    },
    go(online: boolean) {
      this.onLine = online
      for (const listener of listeners.get(online ? 'online' : 'offline') ?? []) listener()
    },
  }
}

/** A replication manager that records every list it is handed. */
function recordingSync(
  push: (projectId: string, signal?: AbortSignal) => Promise<void> = async () => {},
) {
  const sets: (readonly SyncableProject[])[] = []
  const pushes: string[] = []
  const manager = {
    set: (projects: readonly SyncableProject[]) => void sets.push(projects),
    running: () => [],
    stateOf: () => undefined,
    stop: () => {},
    pushNow: async (projectId: string, options?: { signal?: AbortSignal }) => {
      pushes.push(projectId)
      await push(projectId, options?.signal)
    },
    suspend: () => {},
    resume: () => {},
    stopAll: () => {},
  }
  return { manager, sets, pushes }
}

interface Options {
  readonly session?: 'signed-in' | 'signed-out' | 'expired' | 'unanswered'
  readonly local?: readonly LocalProjectEntry[]
  readonly cachedProfile?: CachedProfile
  readonly list?: () => Promise<readonly Project[]>
  readonly network?: ReturnType<typeof fakeNetwork>
  readonly followLocale?: unknown
  readonly signOutOf?: unknown
  readonly store?: LocalProjectDependencies
  /** What each push does; succeeds by default. */
  readonly push?: (projectId: string, signal?: AbortSignal) => Promise<void>
  /** How long signing out waits for each push. */
  readonly signOutPushTimeoutMs?: number
}

/** The shell, wired to fakes, settled past its first refresh. */
async function mount(options: Options = {}) {
  const store = options.store ?? isolatedProjectStore()
  for (const indexed of options.local ?? []) await store.cache().addLocalProject(indexed)
  if (options.cachedProfile !== undefined) await store.cache().writeProfile(options.cachedProfile)
  const sync = recordingSync(options.push)
  const list = vi.fn(options.list ?? (async () => [] as readonly Project[]))
  const signOutOf = options.signOutOf ?? vi.fn(async () => [])
  await Promise.all(
    ['wa-page', 'wa-button', 'wa-tag'].map((name) => customElements.whenDefined(name)),
  )
  const element = (await fixture(html`
    <app-shell
      .refresher=${
        options.session === 'unanswered'
          ? refresherNeverAnswering
          : refresherReporting(options.session ?? 'signed-in')
      }
      .connectivity=${options.network ?? fakeNetwork(true)}
      .followLocale=${options.followLocale ?? (async () => undefined)}
      .listProjects=${list}
      .makeSync=${() => sync.manager}
      .signOutOf=${signOutOf}
      .signIn=${() => {}}
      .projectStore=${store}
      .signOutPushTimeoutMs=${options.signOutPushTimeoutMs}
    ></app-shell>
  `)) as AppShell
  await element.updateComplete
  return { element, sync, list, store, signOutOf }
}

const projectsView = (element: Element) =>
  element.querySelector('projects-view') as ProjectsView | null

/** Waits until the projects page has been handed an input satisfying `ready`. */
async function inputSettles(
  element: Element,
  ready: (input: ProjectsView['input']) => boolean,
  message: string,
): Promise<ProjectsView['input']> {
  await waitUntil(() => {
    const view = projectsView(element)
    return view !== null && ready(view.input)
  }, message)
  return (projectsView(element) as ProjectsView).input
}

const text = (element: Element | null): string =>
  element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

beforeEach(() => {
  window.location.hash = '#/'
  localStorage.removeItem(CURRENT_PROJECT_KEY)
  useProjectDatabase('project_local')
})

afterEach(async () => {
  // Disconnected, so no earlier test's shell answers a later test's refresh or idle signal.
  fixtureCleanup()
  window.location.hash = ''
  localStorage.removeItem(CURRENT_PROJECT_KEY)
  useProjectDatabase('project_local')
  await destroyProjectStores()
})

describe('routing', () => {
  it('lands on the projects page', async () => {
    const { element } = await mount()
    expect(projectsView(element)).not.toBeNull()
    expect(element.querySelector('device-list-view')).toBeNull()
  })

  it('shows the device list at #/devices', async () => {
    window.location.hash = '#/devices'
    const { element } = await mount()
    expect(element.querySelector('device-list-view')).not.toBeNull()
  })
})

describe('what the projects page is given', () => {
  it('the local index, the fresh server list and the cached plan', async () => {
    const { element } = await mount({
      local: [entry(), copy],
      cachedProfile: profile({ plan: 'pro', projectLimit: -1 }),
      list: async () => [project()],
    })

    const input = await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    expect(input.local.map((e) => e.dbName).sort()).toEqual(['project_local_a', 'project_p1'])
    expect(input.server?.map((p) => p.projectId)).toEqual(['p1'])
    expect(input.serverStale).toBe(false)
    expect(input).toMatchObject({
      plan: 'pro',
      reportedLimit: -1,
      session: 'signed-in',
      online: true,
    })
  })

  it('the last list heard, flagged stale, when the list cannot be fetched', async () => {
    // Ruling C-R5: an offline page still knows its counts, roles and archives.
    const store = isolatedProjectStore()
    await store
      .cache()
      .writeProjects(
        [{ projectId: 'p1', dbName: 'project_p1', name: 'Beta', role: 'owner', archived: true }],
        'then',
      )

    const { element } = await mount({
      store,
      list: async () => {
        throw new TypeError('Failed to fetch')
      },
    })

    const input = await inputSettles(element, (i) => i.server !== undefined, 'no list at all')
    expect(input.serverStale).toBe(true)
    expect(input.server).toMatchObject([{ projectId: 'p1', archived: true }])
  })

  it('remembers every list it fetches, for the next time it cannot', async () => {
    const { store } = await mount({ list: async () => [project({ client: 'Acme' })] })
    await waitUntil(async () => (await store.cache().readProjects()).length > 0, 'not remembered')
    expect(await store.cache().readProjects()).toMatchObject([{ projectId: 'p1', client: 'Acme' }])
  })

  it('the shell’s replication, for the actions that push and hold', async () => {
    const { element, sync } = await mount()
    await waitUntil(() => projectsView(element)?.sync !== undefined, 'no replication given')
    const handed = projectsView(element)?.sync
    handed?.set([{ projectId: 'p9', dbName: 'project_p9' }])
    expect(sync.sets.at(-1)).toEqual([{ projectId: 'p9', dbName: 'project_p9' }])
  })

  it('a refresh that fetches the list again', async () => {
    const { element, list } = await mount({ list: async () => [project()] })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    const calls = list.mock.calls.length

    await projectsView(element)?.refresh?.()

    expect(list.mock.calls.length).toBe(calls + 1)
  })
})

describe('what replicates', () => {
  it('only the copies indexed on this device, never every server project', async () => {
    // A server project with no copy here is not downloaded, and replicating it would download
    // it — including one whose copy the reader has just removed.
    const { sync } = await mount({
      local: [entry(), copy],
      cachedProfile: profile(),
      list: async () => [project(), project({ projectId: 'p2', dbName: 'project_p2' })],
    })

    await waitUntil(() => sync.sets.some((s) => s.length > 0), 'nothing replicated')
    expect(sync.sets.at(-1)).toEqual([{ projectId: 'p1', dbName: 'project_p1' }])
  })

  it('not an archived project’s copy', async () => {
    const { element, sync } = await mount({
      local: [copy],
      cachedProfile: profile(),
      list: async () => [project({ archived: true })],
    })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    await waitUntil(() => sync.sets.length > 0, 'replication never set')
    expect(sync.sets.at(-1)).toEqual([])
  })
})

describe('a project the server refuses', () => {
  it('stops being reported once it is no longer replicated', async () => {
    // A copy removed while it was denied must not hold the status bar at "No permission to sync".
    let report: (projectId: string, state: string) => void = () => {}
    const sync = recordingSync()
    const store = isolatedProjectStore()
    await store.cache().addLocalProject(copy)
    await store.cache().writeProfile(profile())
    const element = (await fixture(html`
      <app-shell
        .refresher=${refresherReporting('signed-in')}
        .connectivity=${fakeNetwork(true)}
        .followLocale=${async () => undefined}
        .listProjects=${async () => [project()]}
        .makeSync=${(onState: (projectId: string, state: string) => void) => {
          report = onState
          return sync.manager
        }}
        .projectStore=${store}
      ></app-shell>
    `)) as AppShell
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    report('p1', 'denied')
    await waitUntil(
      () => element.querySelector('[data-sync-status="denied"]') !== null,
      'the refusal was not shown',
    )

    await store.cache().removeLocalProject(copy.dbName)
    await projectsView(element)?.refresh?.()
    await element.updateComplete

    expect(element.querySelector('[data-sync-status="denied"]')).toBeNull()
  })

  /** The shell with one synchronized copy, and the replication's reporting line. */
  async function deniedShell(pushNow: () => Promise<void> = async () => {}) {
    const stopped: string[] = []
    let report: (projectId: string, state: string) => void = () => {}
    const store = isolatedProjectStore()
    await store.cache().addLocalProject(copy)
    await store.cache().writeProfile(profile())
    const element = (await fixture(html`
      <app-shell
        .refresher=${refresherReporting('signed-in')}
        .connectivity=${fakeNetwork(true)}
        .followLocale=${async () => undefined}
        .listProjects=${async () => [project()]}
        .makeSync=${(onState: (projectId: string, state: string) => void) => {
          report = onState
          return {
            ...recordingSync().manager,
            pushNow,
            stop: (projectId: string) => {
              stopped.push(projectId)
              onState(projectId, 'stopped')
            },
          }
        }}
        .projectStore=${store}
      ></app-shell>
    `)) as AppShell
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    return { element, stopped, report: (state: string) => report('p1', state) }
  }

  it('keeps replicating it, and keeps saying why whatever it reports next', async () => {
    // Ruling C-R12: pulls are still valid, so live sync keeps running; but a refusal is not
    // healed by the next `active` or `idle`, and the page must not say it is.
    const { element, stopped, report } = await deniedShell()

    report('denied')
    report('active')
    report('idle')
    await projectsView(element)?.refresh?.()
    await element.updateComplete

    expect(stopped).toEqual([])
    expect(projectsView(element)?.input.syncStates('p1')).toBe('denied')
    expect(text(element.querySelector('footer [data-sync-status="denied"]'))).toBe(
      'Beta: No permission to sync',
    )
  })

  it('stops saying it once a push of it succeeds', async () => {
    const { element, report } = await deniedShell()
    report('denied')
    report('idle')
    await element.updateComplete

    await projectsView(element)?.sync?.pushNow('p1')
    await element.updateComplete

    expect(projectsView(element)?.input.syncStates('p1')).toBe('idle')
    expect(element.querySelector('[data-sync-status]')?.getAttribute('data-sync-status')).toBe(
      'synced',
    )
  })

  it('keeps saying it when a push of it fails', async () => {
    const { element, report } = await deniedShell(async () => {
      throw new Error('refused')
    })
    report('denied')

    await expect(projectsView(element)?.sync?.pushNow('p1')).rejects.toThrow('refused')
    await element.updateComplete

    expect(projectsView(element)?.input.syncStates('p1')).toBe('denied')
  })
})

describe('the first run', () => {
  it('adopts the catalogue on this device, so there is a project to name', async () => {
    // Ruling C-R7.
    const { element, store } = await mount({ session: 'signed-out' })

    await waitUntil(() => element.querySelector('[data-name-project]') !== null, 'nothing to name')
    expect(await store.cache().readLocalProjects()).toMatchObject([
      { dbName: 'project_local', name: '' },
    ])
  })

  it('is not a member removing their last local copy', async () => {
    // Ruling C-R7, refined: their projects are on the server, and an empty project nobody
    // made would count against their plan.
    const store = isolatedProjectStore()
    await store
      .cache()
      .writeProjects(
        [{ projectId: 'p1', dbName: 'project_p1', name: 'Beta', role: 'owner' }],
        'then',
      )

    const { element } = await mount({
      store,
      cachedProfile: profile(),
      list: async () => [project()],
    })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')

    expect(await store.cache().readLocalProjects()).toEqual([])
    expect(element.querySelector('[data-name-project]')).toBeNull()
  })
})

describe('while a project action runs', () => {
  it('a refresh neither reopens the project nor hands replication a list; the end applies', async () => {
    // The shape of a promotion half way: the source's entry records the new id, the views have
    // moved to the survivor, and replication was handed the survivor — none of which the index
    // says yet. A refresh landing now (the profile, a reconnection) must not undo any of it.
    const source = entry()
    const { element, store, sync } = await mount({
      local: [source],
      cachedProfile: profile(),
      list: async () => [project()],
    })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')

    const end = beginProjectAction()
    try {
      await store.cache().updateLocalProject(source.dbName, { projectId: 'p1' })
      writeCurrentProjectId(() => localStorage, 'p1')
      useProjectDatabase('project_p1', true)
      sync.manager.set([{ projectId: 'p1', dbName: 'project_p1' }])
      const handed = sync.sets.length

      await projectsView(element)?.refresh?.()

      expect(currentProjectDatabaseName()).toBe('project_p1')
      expect(sync.sets.length).toBe(handed)

      // The action finishes: the survivor listed, the source gone.
      await store.cache().addLocalProject(copy)
      await store.cache().removeLocalProject(source.dbName)
    } finally {
      end()
    }

    await waitUntil(
      () =>
        JSON.stringify(sync.sets.at(-1)) ===
        JSON.stringify([{ projectId: 'p1', dbName: 'project_p1' }]),
      'the end was not applied',
    )
    await inputSettles(
      element,
      (i) => i.local.length === 1 && i.local[0]?.dbName === 'project_p1',
      'index not re-read',
    )
    expect(currentProjectDatabaseName()).toBe('project_p1')
  })
})

describe('a read that spans a project action', () => {
  /**
   * Starts a read that holds the index with the copy in it and waits on the profile, runs an
   * action around it that removes the copy, and lets the read finish only after the action has
   * let go. Returns every list replication was handed after the removal.
   */
  async function spanningRead(readStarts: 'before the action' | 'during the action') {
    const base = isolatedProjectStore()
    let hold: Promise<void> | undefined
    const store: LocalProjectDependencies = {
      ...base,
      cache: () => ({
        ...base.cache(),
        readProfile: async () => {
          const profile = await base.cache().readProfile()
          await hold
          return profile
        },
      }),
    }
    const { element, sync } = await mount({
      store,
      local: [copy],
      cachedProfile: profile(),
      list: async () => [project()],
    })
    await waitUntil(
      () =>
        JSON.stringify(sync.sets.at(-1)) ===
        JSON.stringify([{ projectId: 'p1', dbName: 'project_p1' }]),
      'never replicated',
    )

    let release = () => {}
    hold = new Promise((resolve) => {
      release = resolve
    })
    const startRead = async () => {
      const read = projectsView(element)?.refresh?.()
      // The read has the index (with the copy) and is waiting on the profile.
      await new Promise((resolve) => setTimeout(resolve, 50))
      // Wrapped: an async function returning the promise itself would wait for it.
      return { read }
    }

    const before = readStarts === 'before the action' ? await startRead() : undefined
    const end = beginProjectAction()
    const during = readStarts === 'during the action' ? await startRead() : undefined
    await store.cache().removeLocalProject(copy.dbName)
    sync.manager.set([])
    const removedAt = sync.sets.length
    end()
    hold = undefined
    release()
    await (before ?? during)?.read

    await inputSettles(element, (i) => i.local.length === 0, 'the idle refresh never read')
    await element.updateComplete
    return sync.sets.slice(removedAt)
  }

  it('begun before the action, is not applied, so it cannot resurrect a removed copy', async () => {
    // Finishing after the action let go, it would hand replication the copy just removed —
    // downloading it again. The idle refresh after the action applies fresh facts instead.
    const handed = await spanningRead('before the action')
    expect(handed.some((set) => set.length > 0)).toBe(false)
  })

  it('begun during the action and finished after it, is not applied either', async () => {
    const handed = await spanningRead('during the action')
    expect(handed.some((set) => set.length > 0)).toBe(false)
  })
})

describe('the session before its first answer', () => {
  it('is told to the page as being checked, not as signed out', async () => {
    const { element } = await mount({ session: 'unanswered' })
    const input = await inputSettles(element, () => true, 'no page')
    expect(input.session).toBe('checking')
    expect(element.querySelector('[data-hint="signed-out"]')).toBeNull()
  })
})

describe('which project is open', () => {
  it('the one stored, by its project id', async () => {
    localStorage.setItem(CURRENT_PROJECT_KEY, 'p1')
    await mount({ local: [entry(), copy], cachedProfile: profile(), list: async () => [project()] })
    await waitUntil(() => currentProjectDatabaseName() === 'project_p1', 'not opened')
    expect(projectIsEditable()).toBe(true)
  })

  it('the first local project when the stored one is not on this device', async () => {
    localStorage.setItem(CURRENT_PROJECT_KEY, 'gone')
    await mount({ local: [copy, entry()], cachedProfile: profile() })
    await waitUntil(() => currentProjectDatabaseName() === 'project_local_a', 'no fallback')
  })

  it('a lapsed owner’s server project, read-only', async () => {
    localStorage.setItem(CURRENT_PROJECT_KEY, 'p1')
    await mount({
      local: [copy],
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      list: async () => [project()],
    })
    await waitUntil(() => currentProjectDatabaseName() === 'project_p1', 'not opened')
    await waitUntil(() => !projectIsEditable(), 'still editable')
  })
})

describe('the header', () => {
  it('shows the signed-in email top right', async () => {
    const { element } = await mount({ cachedProfile: profile() })
    await waitUntil(() => element.querySelector('[data-user-email]') !== null, 'no email')
    expect(text(element.querySelector('header [data-user-email]'))).toBe('ada@example.org')
    expect(element.querySelector('[data-sign-in]')).toBeNull()
  })

  it('moves the email into the drawer at phone width, above Sign out', async () => {
    const { element } = await mount({ cachedProfile: profile() })
    await waitUntil(() => element.querySelector('nav [data-nav-email]') !== null, 'not in the menu')
    const inNav = element.querySelector('nav [data-nav-email]') as HTMLElement
    expect(text(inNav)).toBe('ada@example.org')
    expect(inNav.classList.contains('wa-mobile-only')).toBe(true)
    expect(inNav.nextElementSibling?.matches('[data-sign-out]')).toBe(true)
    expect(element.querySelector('header [data-user-email]')?.classList).toContain(
      'wa-desktop-only',
    )
  })

  it('shows the email the profile brings, once it arrives', async () => {
    const store = isolatedProjectStore()
    const { element } = await mount({
      store,
      followLocale: async (_onLocale: unknown, onProfile?: () => void) => {
        // As `resolveProfileLocale` does: the cache first, then the word.
        await store.cache().writeProfile(profile({ email: 'grace@example.org' }))
        onProfile?.()
      },
    })
    await waitUntil(
      () => text(element.querySelector('[data-user-email]')) === 'grace@example.org',
      'the fetched email never showed',
    )
  })

  it('offers Sign in, and no email, when signed out', async () => {
    const { element } = await mount({ session: 'signed-out', cachedProfile: profile() })
    await waitUntil(() => element.querySelector('header [data-sign-in]') !== null, 'no sign-in')
    expect(element.querySelector('[data-user-email]')).toBeNull()
  })

  it('carries no network or sync status: the status bar in the footer does', async () => {
    const { element } = await mount({ local: [copy], list: async () => [project()] })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    const header = element.querySelector('header') as HTMLElement
    expect(header.querySelector('[data-online], [data-offline], [data-sync-status]')).toBeNull()
  })

  it('has no project switcher: the projects page replaces it', async () => {
    const { element } = await mount({ local: [entry(), copy], list: async () => [project()] })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    expect(element.querySelector('[data-project-switcher]')).toBeNull()
  })
})

describe('the status bar', () => {
  /** The shell with a local project and a synchronized copy, and replication's reporting line. */
  async function statusShell(
    options: {
      network?: ReturnType<typeof fakeNetwork>
      session?: 'signed-in' | 'signed-out'
    } = {},
  ) {
    let report: (projectId: string, state: string) => void = () => {}
    const store = isolatedProjectStore()
    await store.cache().addLocalProject(entry())
    await store.cache().addLocalProject(copy)
    await store.cache().writeProfile(profile())
    writeCurrentProjectId(() => localStorage, 'p1')
    const element = (await fixture(html`
      <app-shell
        .refresher=${refresherReporting(options.session ?? 'signed-in')}
        .connectivity=${options.network ?? fakeNetwork(true)}
        .followLocale=${async () => undefined}
        .listProjects=${async () => [project()]}
        .makeSync=${(onState: (projectId: string, state: string) => void) => {
          report = onState
          return recordingSync().manager
        }}
        .projectStore=${store}
      ></app-shell>
    `)) as AppShell
    if (options.session !== 'signed-out') {
      await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    }
    await waitUntil(() => currentProjectDatabaseName() === copy.dbName, 'the copy never opened')
    await waitUntil(() => status(element) !== null, 'no sync status')
    return { element, report: (state: string) => report('p1', state) }
  }

  const status = (element: Element) => element.querySelector('footer [data-sync-status]')
  const statusOf = (element: Element) => status(element)?.getAttribute('data-sync-status')
  const announced = (element: Element) => text(element.querySelector('[data-status-announcement]'))

  /** Reports a state and waits for the shell to have rendered it. */
  async function reportAndRender(
    element: AppShell,
    report: (state: string) => void,
    state: string,
  ): Promise<void> {
    report(state)
    await element.updateComplete
  }

  it('sits in the footer beside the website links, which stay', async () => {
    const { element } = await statusShell()
    const footer = element.querySelector('footer[slot="footer"]') as HTMLElement
    expect(footer.querySelector('[data-online]')).not.toBeNull()
    expect(footer.querySelector('[data-sync-status]')).not.toBeNull()
    const links = [...footer.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(links).toEqual([
      'https://www.matter-manager.io/',
      'https://www.matter-manager.io/privacy',
      'https://www.matter-manager.io/tos',
    ])
  })

  it('says Online with a success colour, and nothing about being offline', async () => {
    const { element } = await statusShell()
    const tag = element.querySelector('footer [data-online]')
    expect(text(tag)).toBe('Online')
    expect(tag?.getAttribute('variant')).toBe('success')
    expect(element.querySelector('[data-offline]')).toBeNull()
  })

  it('says Offline as neutral on the same element, and announces it once', async () => {
    const network = fakeNetwork(true)
    const { element } = await statusShell({ network })
    const before = element.querySelector('footer [data-network]')
    expect(announced(element)).toBe('')

    network.go(false)
    await element.updateComplete

    const tag = element.querySelector('footer [data-offline]')
    expect(tag).toBe(before)
    expect(text(tag)).toBe('Offline')
    expect(tag?.getAttribute('variant')).toBe('neutral')
    expect(element.querySelector('[data-online]')).toBeNull()
    expect(announced(element)).toBe('Offline')

    network.go(true)
    await element.updateComplete
    expect(announced(element)).toBe('Online')
  })

  it('says Sync pending for the open copy until it is caught up, then Synced', async () => {
    const { element, report } = await statusShell()
    // No state reported yet: not caught up as far as anybody knows.
    expect(statusOf(element)).toBe('pending')
    expect(status(element)?.getAttribute('variant')).toBe('warning')

    for (const state of ['active', 'offline', 'stopped']) {
      await reportAndRender(element, report, state)
      expect(statusOf(element), state).toBe('pending')
      expect(text(status(element))).toBe('Beta: Sync pending')
    }

    await reportAndRender(element, report, 'idle')
    expect(statusOf(element)).toBe('synced')
    expect(text(status(element))).toBe('Beta: Synced')
    expect(status(element)?.getAttribute('variant')).toBe('success')
    // Pending and synced trade places all the time: nothing is announced for it.
    expect(announced(element)).toBe('')
  })

  it('names the project for assistive technology only', async () => {
    const { element } = await statusShell()
    const name = status(element)?.querySelector('.wa-visually-hidden')
    expect(text(name ?? null)).toBe('Beta:')
  })

  it('says No permission to sync, as danger, and announces it starting and ending', async () => {
    const { element, report } = await statusShell()
    await reportAndRender(element, report, 'denied')
    expect(statusOf(element)).toBe('denied')
    expect(status(element)?.getAttribute('variant')).toBe('danger')
    expect(announced(element)).toBe('Beta: No permission to sync')

    // A successful push is the one proof a refusal is over (ruling C-R12).
    await projectsView(element)?.sync?.pushNow('p1')
    await reportAndRender(element, report, 'idle')
    expect(statusOf(element)).toBe('synced')
    expect(announced(element)).toBe('Beta: Synced')
  })

  it('says Sync paused when nobody is signed in', async () => {
    const { element } = await statusShell({ session: 'signed-out' })
    await waitUntil(() => statusOf(element) === 'paused', 'never paused')
    expect(text(status(element))).toBe('Beta: Sync paused – signed out')
    expect(status(element)?.getAttribute('variant')).toBe('neutral')
  })

  it('follows the open project: Local for one only on this device', async () => {
    const { element, report } = await statusShell()
    await reportAndRender(element, report, 'idle')
    expect(statusOf(element)).toBe('synced')

    // Opened from the projects page, which points the views at it and says so.
    useProjectDatabase(entry().dbName)
    await element.updateComplete

    expect(statusOf(element)).toBe('local')
    expect(text(status(element))).toBe('Alpha: Local')
    expect(status(element)?.getAttribute('variant')).toBe('neutral')
  })

  it('has one live region, and tags that are neither live nor controls', async () => {
    const { element } = await statusShell()
    const bar = element.querySelector('[data-status-bar]') as HTMLElement
    expect(bar.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(1)
    expect(bar.querySelector('[data-status-announcement]')?.getAttribute('role')).toBe('status')
    const tags = [...bar.querySelectorAll('wa-tag')]
    expect(tags).toHaveLength(2)
    for (const tag of tags) {
      expect(tag.hasAttribute('role')).toBe(false)
      expect(tag.hasAttribute('tabindex')).toBe(false)
      expect(tag.hasAttribute('with-remove')).toBe(false)
      // Nothing inside it takes focus either: a tag without `with-remove` has no button.
      expect(tag.shadowRoot?.querySelector('button, wa-button, [tabindex]')).toBeNull()
      expect(tag.querySelector('wa-icon')).not.toBeNull()
    }
  })
})

describe('signing out from the menu', () => {
  it('is the last item in the navigation, and still asks first', async () => {
    const { element, signOutOf } = await mount({ cachedProfile: profile() })
    await waitUntil(() => element.querySelector('nav [data-sign-out]') !== null, 'not in the menu')

    const nav = element.querySelector('nav') as HTMLElement
    expect(nav.lastElementChild?.matches('[data-sign-out]')).toBe(true)
    expect(element.querySelector('header [data-sign-out]')).toBeNull()

    ;(element.querySelector('nav [data-sign-out]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-confirm-sign-out]') !== null, 'no dialog')
    expect(signOutOf).not.toHaveBeenCalled()
    ;(element.querySelector('[data-confirm-sign-out]') as HTMLElement).click()
    await waitUntil(
      () => (signOutOf as ReturnType<typeof vi.fn>).mock.calls.length > 0,
      'never signed out',
    )
  })

  /** Opens the dialog from the menu and confirms its first step. */
  async function askAndConfirm(element: Element): Promise<void> {
    await waitUntil(() => element.querySelector('nav [data-sign-out]') !== null, 'not in the menu')
    ;(element.querySelector('nav [data-sign-out]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-confirm-sign-out]') !== null, 'no dialog')
    ;(element.querySelector('[data-confirm-sign-out]') as HTMLElement).click()
  }

  const calls = (signOutOf: unknown) => (signOutOf as ReturnType<typeof vi.fn>).mock.calls

  const synced = { local: [copy], cachedProfile: profile(), list: async () => [project()] }

  it('says "projects" in its checkbox, not devices', async () => {
    const { element } = await mount({ cachedProfile: profile() })
    await waitUntil(() => element.querySelector('nav [data-sign-out]') !== null, 'not in the menu')
    ;(element.querySelector('nav [data-sign-out]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-remove-local]') !== null, 'no checkbox')
    expect(text(element.querySelector('[data-remove-local]'))).toBe(
      'Also remove projects stored only on this device',
    )
  })

  it('pushes every synchronized copy first, and goes straight on when all got through', async () => {
    // Ruling C-R10.
    const { element, sync, signOutOf } = await mount(synced)
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')

    await askAndConfirm(element)

    await waitUntil(() => calls(signOutOf).length > 0, 'never signed out')
    expect(sync.pushes).toEqual(['p1'])
    expect(calls(signOutOf)[0]).toEqual([false])
    expect(element.querySelector('[data-unpushed]')).toBeNull()
  })

  it('names the copies a push could not empty, and keeps everything on cancel', async () => {
    const { element, store, signOutOf } = await mount({
      ...synced,
      push: async () => {
        throw new Error('the server refused')
      },
    })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')

    await askAndConfirm(element)

    await waitUntil(() => element.querySelector('[data-unpushed]') !== null, 'no second step')
    expect(text(element.querySelector('[data-sign-out-dialog]'))).toContain(
      'These projects may have changes that are not on the server. Signing out removes them from this device.',
    )
    expect(text(element.querySelector('[data-unpushed]'))).toBe('Beta')
    expect(calls(signOutOf)).toHaveLength(0)

    ;(element.querySelector('[data-cancel-sign-out]') as HTMLElement).click()
    await element.updateComplete

    expect(element.querySelector('[data-sign-out-dialog]')).toBeNull()
    expect(calls(signOutOf)).toHaveLength(0)
    expect(await store.cache().readLocalProjects()).toEqual([copy])
    expect(element.querySelector('nav [data-sign-out]')).not.toBeNull()
  })

  it('signs out, as first asked, once the second step is confirmed', async () => {
    const { element, signOutOf } = await mount({
      ...synced,
      push: async () => {
        throw new Error('the server refused')
      },
    })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    await waitUntil(() => element.querySelector('nav [data-sign-out]') !== null, 'not in the menu')
    ;(element.querySelector('nav [data-sign-out]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-remove-local]') !== null, 'no dialog')
    ;(element.querySelector('[data-remove-local]') as HTMLElement & { checked: boolean }).checked =
      true
    ;(element.querySelector('[data-confirm-sign-out]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-unpushed]') !== null, 'no second step')

    ;(element.querySelector('[data-confirm-unpushed]') as HTMLElement).click()

    await waitUntil(() => calls(signOutOf).length > 0, 'never signed out')
    expect(calls(signOutOf)[0]).toEqual([true])
  })

  it('asks the second question offline without trying to push', async () => {
    const { element, sync, signOutOf } = await mount({ ...synced, network: fakeNetwork(false) })
    await inputSettles(element, (i) => i.local.length === 1, 'no index')

    await askAndConfirm(element)

    await waitUntil(() => element.querySelector('[data-unpushed]') !== null, 'no second step')
    expect(sync.pushes).toEqual([])
    expect(calls(signOutOf)).toHaveLength(0)
  })

  it('holds the busy registry while it works', async () => {
    // Important 2: a refresh landing mid-sign-out (the profile, a reconnection) must not reopen
    // a copy about to be destroyed or hand replication a list.
    const seen: boolean[] = []
    const { element, signOutOf } = await mount({
      ...synced,
      push: async () => void seen.push(projectActionRunning()),
      signOutOf: vi.fn(async () => {
        seen.push(projectActionRunning())
        return []
      }),
    })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')

    await askAndConfirm(element)

    await waitUntil(() => calls(signOutOf).length > 0, 'never signed out')
    await waitUntil(() => !projectActionRunning(), 'never let go')
    expect(seen).toEqual([true, true])
  })

  it('names an archived project’s copy without trying to push it', async () => {
    // Re-review A: archived elsewhere, its copy may hold edits that never left, and the server
    // refuses every write now — so it cannot be pushed, only named.
    const { element, sync, signOutOf } = await mount({
      ...synced,
      list: async () => [project({ archived: true })],
    })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')

    await askAndConfirm(element)

    await waitUntil(() => element.querySelector('[data-unpushed]') !== null, 'no second step')
    expect(text(element.querySelector('[data-unpushed]'))).toBe('Beta')
    expect(sync.pushes).toEqual([])
    expect(calls(signOutOf)).toHaveLength(0)
  })

  it('names a copy the server no longer lists', async () => {
    const { element, sync } = await mount({ ...synced, list: async () => [] })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')

    await askAndConfirm(element)

    await waitUntil(() => element.querySelector('[data-unpushed]') !== null, 'no second step')
    expect(text(element.querySelector('[data-unpushed]'))).toBe('Beta')
    expect(sync.pushes).toEqual([])
  })

  it('reads the index afresh, so a copy listed since the last refresh is pushed too', async () => {
    const { element, store, sync, signOutOf } = await mount({
      cachedProfile: profile(),
      list: async () => [project()],
    })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    await store.cache().addLocalProject(copy)

    await askAndConfirm(element)

    await waitUntil(() => calls(signOutOf).length > 0, 'never signed out')
    expect(sync.pushes).toEqual(['p1'])
  })

  it('asks the second question when the index cannot be read', async () => {
    const base = isolatedProjectStore()
    let unreadable = false
    const store: LocalProjectDependencies = {
      ...base,
      cache: () => ({
        ...base.cache(),
        readLocalProjects: async () => {
          if (unreadable) throw new Error('the index is gone')
          return base.cache().readLocalProjects()
        },
      }),
    }
    const { element, signOutOf } = await mount({ ...synced, store })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    unreadable = true

    await askAndConfirm(element)

    await waitUntil(() => element.querySelector('[data-unreadable]') !== null, 'no second step')
    expect(calls(signOutOf)).toHaveLength(0)
  })

  it('names a copy whose push did not finish in time', async () => {
    const { element, signOutOf } = await mount({
      ...synced,
      signOutPushTimeoutMs: 50,
      push: (_projectId, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason))
        }),
    })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')

    await askAndConfirm(element)

    await waitUntil(() => element.querySelector('[data-unpushed]') !== null, 'no second step')
    expect(text(element.querySelector('[data-unpushed]'))).toBe('Beta')
    expect(calls(signOutOf)).toHaveLength(0)
  })

  /** Mounts with pushes that wait for `release`, confirms, and waits for them to start. */
  async function pushesHeld() {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const mounted = await mount({ ...synced, push: () => held })
    await inputSettles(mounted.element, (i) => i.server !== undefined, 'no list arrived')
    await askAndConfirm(mounted.element)
    await waitUntil(() => mounted.sync.pushes.length > 0, 'never pushed')
    return { ...mounted, release }
  }

  it('does not sign out when pushes finish after Cancel', async () => {
    const { element, signOutOf, release } = await pushesHeld()

    ;(element.querySelector('[data-cancel-sign-out]') as HTMLElement).click()
    await element.updateComplete
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await element.updateComplete

    expect(calls(signOutOf)).toHaveLength(0)
    expect(element.querySelector('[data-sign-out-dialog]')).toBeNull()
  })

  it('cancels when the dialog itself is closed (Escape, its X)', async () => {
    const { element, signOutOf, release } = await pushesHeld()

    const dialog = element.querySelector('[data-sign-out-dialog]') as HTMLElement & {
      open: boolean
    }
    dialog.open = false
    await waitUntil(
      () => element.querySelector('[data-sign-out-dialog]') === null,
      'the closed dialog was not cancelled',
    )
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await element.updateComplete

    expect(calls(signOutOf)).toHaveLength(0)
    expect(element.querySelector('[data-sign-out-dialog]')).toBeNull()
  })

  it('cancels when the second step’s dialog itself is closed', async () => {
    const { element, signOutOf } = await mount({
      ...synced,
      push: async () => {
        throw new Error('the server refused')
      },
    })
    await inputSettles(element, (i) => i.server !== undefined, 'no list arrived')
    await askAndConfirm(element)
    await waitUntil(() => element.querySelector('[data-unpushed]') !== null, 'no second step')

    ;(element.querySelector('[data-sign-out-dialog]') as HTMLElement & { open: boolean }).open =
      false

    await waitUntil(
      () => element.querySelector('[data-sign-out-dialog]') === null,
      'the closed dialog was not cancelled',
    )
    expect(calls(signOutOf)).toHaveLength(0)
  })

  it('is not in the menu while signed out', async () => {
    const { element } = await mount({ session: 'signed-out' })
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in')
    expect(element.querySelector('[data-sign-out]')).toBeNull()
  })
})

describe('upgrading', () => {
  it('offers an upgrade that says what there is to say', async () => {
    const { element } = await mount({ cachedProfile: profile({ plan: 'free', projectLimit: 1 }) })
    await waitUntil(() => element.querySelector('[data-upgrade]') !== null, 'no upgrade')

    ;(element.querySelector('[data-upgrade]') as HTMLElement).click()
    await waitUntil(
      () => element.querySelector('[data-upgrade-dialog][open]') !== null,
      'no dialog',
    )

    expect(text(element.querySelector('[data-upgrade-dialog]'))).toContain(
      "It's just alpha — coming soon",
    )
  })

  it('is not offered on the top plan', async () => {
    const { element } = await mount({ cachedProfile: profile({ plan: 'pro', projectLimit: -1 }) })
    await inputSettles(element, (i) => i.plan === 'pro', 'plan never read')
    await element.updateComplete
    expect(element.querySelector('[data-upgrade]')).toBeNull()
  })
})
