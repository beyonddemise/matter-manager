// The theme and the application's stylesheet, as `main.ts` loads them. Without them the
// `wa-desktop-only` / `wa-mobile-only` switch is no rule at all, and a test of what is shown at
// 360px or at 1280px would pass whichever layout the dialog drew.
import '@awesome.me/webawesome-pro/dist/styles/webawesome.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/glossy.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/anodized.css'
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
import { page, userEvent } from 'vitest/browser'
import type { CachedProfile, LocalProjectEntry } from '../../src/data/index.js'
import { PROJECT_DOCUMENT_ID } from '../../src/domain/documents/project.js'
import type { Plan } from '../../src/domain/plan.js'
import type { AppShell } from '../../src/ui/app-shell.js'
import '../../src/ui/app-shell.js'
import {
  CURRENT_PROJECT_KEY,
  PROJECT_DATA_CHANGED,
  writeCurrentProjectId,
} from '../../src/ui/current-project.js'
import {
  currentProjectDatabaseName,
  projectIsEditable,
  useProjectDatabase,
} from '../../src/ui/db/project-database.js'
import { SOURCE_LOCALE } from '../../src/ui/i18n/locale.js'
import { activateLocale } from '../../src/ui/i18n/localization.js'
import type { LocalProjectDependencies } from '../../src/ui/local-projects.js'
import type { PlanMatrix, PlansApi } from '../../src/ui/plans.js'
import { beginProjectAction, projectActionRunning } from '../../src/ui/project-busy.js'
import type { Project } from '../../src/ui/projects.js'
import type { SyncableProject } from '../../src/ui/sync/manager.js'
import '../../src/ui/styles/app.css'
import type { Profile } from '../../src/ui/profile.js'
import type { ProjectsView } from '../../src/ui/views/projects.js'
import type { WaitlistApi, WaitlistOutcome } from '../../src/ui/waitlist.js'
import {
  noEscrow,
  refresherNeverAnswering,
  refresherReporting,
  refresherUnreachable,
} from './refresher-stub.js'
import {
  destroyProjectStores,
  isolatedProjectStore,
  mintDeviceKeyUpFront,
} from './support/project-store.js'

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

/** The profile as the server answers it, for a fake waitlist to return. */
const serverProfile = (over: Partial<Profile> = {}): Profile => ({
  sub: 'google|1',
  email: 'ada@example.org',
  displayName: 'Ada',
  locale: 'auto',
  plan: 'free',
  projectLimit: 1,
  ...over,
})

type WaitlistCall = { readonly kind: 'join'; readonly plan: Plan } | { readonly kind: 'leave' }

/** A waitlist API answering every call from `answer`, recording each one. */
function fakeWaitlist(answer: (call: WaitlistCall) => Promise<WaitlistOutcome> | WaitlistOutcome) {
  const calls: WaitlistCall[] = []
  const api: WaitlistApi = {
    join: async (plan) => {
      const call = { kind: 'join', plan } as const
      calls.push(call)
      return answer(call)
    },
    leave: async () => {
      const call = { kind: 'leave' } as const
      calls.push(call)
      return answer(call)
    },
  }
  return { api, calls }
}

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

/** A replication manager that records every list it is handed, and every push and pull. */
function recordingSync(
  push: (projectId: string, signal?: AbortSignal) => Promise<void> = async () => {},
  pull: (projectId: string) => Promise<void> = async () => {},
  running: readonly string[] = [],
) {
  const sets: (readonly SyncableProject[])[] = []
  const pushes: string[] = []
  const pulls: string[] = []
  const manager = {
    set: (projects: readonly SyncableProject[]) => void sets.push(projects),
    running: () => running,
    stateOf: () => undefined,
    stop: () => {},
    pushNow: async (projectId: string, options?: { signal?: AbortSignal }) => {
      pushes.push(projectId)
      await push(projectId, options?.signal)
    },
    pullNow: async (projectId: string) => {
      pulls.push(projectId)
      await pull(projectId)
    },
    suspend: () => {},
    resume: () => {},
    stopAll: () => {},
  }
  return { manager, sets, pushes, pulls }
}

interface Options {
  /**
   * `unreachable`: the refresher answers only that, as it does when the app opens offline with
   * nothing stored. `unreachable-held`: the same outage with a refresh token stored, which the
   * shell reads as `offline-held` (#215).
   */
  readonly session?:
    | 'signed-in'
    | 'signed-out'
    | 'expired'
    | 'unanswered'
    | 'unreachable'
    | 'unreachable-held'
  readonly local?: readonly LocalProjectEntry[]
  readonly cachedProfile?: CachedProfile
  readonly list?: () => Promise<readonly Project[]>
  readonly network?: ReturnType<typeof fakeNetwork>
  readonly followLocale?: unknown
  readonly signOutOf?: unknown
  readonly store?: LocalProjectDependencies
  /** What each push does; succeeds by default. */
  readonly push?: (projectId: string, signal?: AbortSignal) => Promise<void>
  /** What each pull does; succeeds by default. */
  readonly pull?: (projectId: string) => Promise<void>
  /** The projects the fake replication reports as running; none by default. */
  readonly running?: readonly string[]
  /** How long signing out waits for each push. */
  readonly signOutPushTimeoutMs?: number
  /** The waitlist API; one that is never expected to be called by default. */
  readonly waitlist?: WaitlistApi
  /** The plan matrix API; nothing published by default, so the built-in tables render. */
  readonly plans?: PlansApi
  /** What "Sign in" does; nothing by default. */
  readonly signIn?: () => void
  /** What the server answers for the profile; nothing (no token) by default. */
  readonly readProfile?: () => Promise<Profile | undefined>
}

/** The shell, wired to fakes, settled past its first refresh. */
async function mount(options: Options = {}) {
  const store = options.store ?? isolatedProjectStore()
  for (const indexed of options.local ?? []) await store.cache().addLocalProject(indexed)
  if (options.cachedProfile !== undefined) await store.cache().writeProfile(options.cachedProfile)
  const sync = recordingSync(options.push, options.pull, options.running)
  // The manager's `onIncoming`, as the controller hands it over; a test calls it to stand in
  // for documents arriving.
  let incoming: (projectId: string) => void = () => {}
  // Injected so a signed-in shell never builds the real backfill, which would read the open
  // project's devices and ask the real API about them: a test must not depend on either.
  const backfill = { trigger: vi.fn(), stop: vi.fn(), idle: async () => {} }
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
          : options.session === 'unreachable' || options.session === 'unreachable-held'
            ? refresherUnreachable(options.session === 'unreachable-held')
            : refresherReporting(options.session ?? 'signed-in')
      }
      .escrow=${noEscrow}
      .connectivity=${options.network ?? fakeNetwork(true)}
      .followLocale=${options.followLocale ?? (async () => undefined)}
      .listProjects=${list}
      .makeSync=${(_onState: unknown, onIncoming: (projectId: string) => void) => {
        incoming = onIncoming
        return sync.manager
      }}
      .signOutOf=${signOutOf}
      .signIn=${options.signIn ?? (() => {})}
      .waitlist=${options.waitlist}
      .plans=${options.plans ?? { read: async () => undefined }}
      .readProfile=${options.readProfile ?? (async () => undefined)}
      .backfill=${backfill}
      .projectStore=${store}
      .signOutPushTimeoutMs=${options.signOutPushTimeoutMs}
    ></app-shell>
  `)) as AppShell
  await element.updateComplete
  return {
    element,
    sync,
    list,
    store,
    signOutOf,
    backfill,
    incoming: (projectId: string) => incoming(projectId),
  }
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

// See `mintDeviceKeyUpFront` (#332): the cold keygen must not land in a `waitUntil` budget.
mintDeviceKeyUpFront()

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

describe('the catalogue backfill', () => {
  it('is the one injected, so these fixtures never build a real one', async () => {
    const { element, backfill } = await mount()
    await inputSettles(element, (input) => input.session === 'signed-in', 'never signed in')

    await waitUntil(
      () => backfill.trigger.mock.calls.length > 0,
      'the injected backfill was not used',
    )
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
        .escrow=${noEscrow}
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
        .escrow=${noEscrow}
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

  it('a fallback while the account is unknown, without forgetting the stored choice', async () => {
    // Signed in with no profile cached yet - a new token forgets it - so the stored project,
    // stamped for an account, is hidden until the profile says whose this session is. The
    // fallback opens meanwhile; writing it over the choice would lose that choice for good.
    localStorage.setItem(CURRENT_PROJECT_KEY, 'p1')
    const store = { ...isolatedProjectStore(), signedIn: async () => true }
    await mount({ store, local: [entry(), { ...copy, account: 'google|1' }] })
    await waitUntil(() => currentProjectDatabaseName() === 'project_local_a', 'no fallback')
    expect(localStorage.getItem(CURRENT_PROJECT_KEY)).toBe('p1')
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

describe('a project the server deleted for good (#290)', () => {
  it('detaches the owner’s copy into a plain local project, and keeps it open', async () => {
    localStorage.setItem(CURRENT_PROJECT_KEY, 'p1')
    const store = isolatedProjectStore()
    const source = store.database('project_p1')
    // As replication left the copy: the service's project document, plus this device's edits.
    await source.put({
      _id: PROJECT_DOCUMENT_ID,
      type: 'project',
      name: 'Beta',
      serverDb: 'project_p1',
    })
    await source.put({ _id: 'device:one', type: 'device', name: 'One' })

    await mount({ store, local: [copy], cachedProfile: profile(), list: async () => [] })

    let detached: LocalProjectEntry | undefined
    await waitUntil(
      async () => {
        detached = (await store.cache().readLocalProjects()).find((candidate) =>
          candidate.dbName.startsWith('project_local_'),
        )
        return detached !== undefined
      },
      'the copy was never detached',
      { timeout: 4000 },
    )
    if (detached === undefined) throw new Error('the copy was never detached')
    expect(detached).toMatchObject({ name: 'Beta' })
    expect(detached.projectId).toBeUndefined()
    expect(detached.role).toBeUndefined()
    // The data moved; the pointer at the server database did not.
    await expect(store.database(detached.dbName).get('device:one')).resolves.toMatchObject({
      name: 'One',
    })
    const document = await store.database(detached.dbName).get(PROJECT_DOCUMENT_ID)
    expect('serverDb' in document).toBe(false)
    const entries = await store.cache().readLocalProjects()
    expect(entries.some((candidate) => candidate.dbName === 'project_p1')).toBe(false)
    // The open project follows its data, editable again.
    const dbName = detached.dbName
    await waitUntil(() => currentProjectDatabaseName() === dbName, 'not kept open')
    expect(projectIsEditable()).toBe(true)
    expect(localStorage.getItem(CURRENT_PROJECT_KEY)).toBe(dbName)
  })

  it('retries a failed detach only when the next fresh list arrives', async () => {
    // A detach ends like any project action, and the idle refresh that follows re-reads the
    // index — where a *failed* detach still sits as an orphan. Retrying it there would loop on
    // every idle transition; the promised retry is the next fresh list.
    const base = isolatedProjectStore()
    let attempts = 0
    const store: LocalProjectDependencies = {
      ...base,
      database: (dbName) => {
        const real = base.database(dbName)
        if (dbName !== 'project_p1') return real
        const broken = Object.create(real) as PouchDB.Database
        Object.defineProperty(broken, 'replicate', {
          value: {
            to: async () => {
              attempts += 1
              throw new Error('the copy keeps failing')
            },
          },
        })
        return broken
      },
    }
    const { element } = await mount({
      store,
      local: [copy],
      cachedProfile: profile(),
      list: async () => [],
    })
    await waitUntil(() => attempts >= 1, 'the detach was never tried')

    // Idle transitions — an action beginning and ending — refresh the page, but must not retry.
    for (let i = 0; i < 2; i += 1) {
      beginProjectAction()()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(attempts).toBe(1)
    // The orphan is still here, untouched.
    expect(await store.cache().readLocalProjects()).toMatchObject([{ dbName: 'project_p1' }])

    // The header's Refresh fetches the list again: the next fresh list, the promised retry.
    await projectsView(element)?.refresh?.()
    await waitUntil(() => attempts === 2, 'never retried on a fresh list')
  })

  it('leaves a collaborator’s copy alone: their access went, not the project', async () => {
    const store = isolatedProjectStore()
    const { element } = await mount({
      store,
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1', role: 'read' })],
      cachedProfile: profile(),
      list: async () => [],
    })

    await inputSettles(
      element,
      (i) => i.server !== undefined && i.serverStale === false,
      'no fresh list arrived',
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await store.cache().readLocalProjects()).toMatchObject([
      { dbName: 'project_p1', projectId: 'p1', role: 'read' },
    ])
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

/**
 * The header's Refresh: the project list fetched again, the open project pulled once when it is
 * a server project being replicated, and the views told to re-read (`PROJECT_DATA_CHANGED`).
 */
describe('refreshing', () => {
  /** How many times the views were told to re-read since the test began. */
  let announced = 0
  const count = (): void => {
    announced += 1
  }

  beforeEach(() => {
    announced = 0
    window.addEventListener(PROJECT_DATA_CHANGED, count)
  })

  afterEach(() => {
    window.removeEventListener(PROJECT_DATA_CHANGED, count)
  })

  type Button = HTMLElement & { loading?: boolean }
  const refreshButton = (element: Element) => element.querySelector('[data-refresh]') as Button

  /** The shell with the server project `p1` open and settled, replicating unless told not to. */
  async function openOnServer(options: Options = {}) {
    localStorage.setItem(CURRENT_PROJECT_KEY, 'p1')
    const mounted = await mount({
      local: [copy],
      cachedProfile: profile(),
      list: async () => [project()],
      running: ['p1'],
      ...options,
    })
    await waitUntil(() => currentProjectDatabaseName() === 'project_p1', 'p1 never opened')
    await inputSettles(mounted.element, (i) => i.server !== undefined, 'no list arrived')
    await waitUntil(() => refreshButton(mounted.element) !== null, 'no Refresh button')
    return mounted
  }

  /** Presses Refresh and waits for it to finish. */
  async function refresh(element: AppShell): Promise<void> {
    const before = announced
    refreshButton(element).click()
    await waitUntil(() => announced > before, 'Refresh never told the views to re-read')
    await waitUntil(() => refreshButton(element).loading !== true, 'Refresh never finished')
  }

  it('sits in the header, before Upgrade, labelled for a screen reader', async () => {
    const { element } = await mount({ cachedProfile: profile({ plan: 'member', projectLimit: 5 }) })
    await waitUntil(() => element.querySelector('[data-upgrade]') !== null, 'no Upgrade')

    const button = refreshButton(element)
    expect(button.closest('.app-header-actions')).not.toBeNull()
    const upgrade = element.querySelector('[data-upgrade]') as Element
    expect(button.compareDocumentPosition(upgrade) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(button.querySelector('wa-icon')?.getAttribute('label')).toBe('Refresh')
  })

  it('is there signed out too, where it re-reads what this device holds', async () => {
    const { element } = await mount({ session: 'signed-out' })
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in')
    expect(refreshButton(element)).not.toBeNull()
  })

  it('fetches the project list, pulls the open project and tells the views', async () => {
    const { element, list, sync } = await openOnServer()
    const fetched = list.mock.calls.length

    await refresh(element)

    expect(list.mock.calls.length).toBeGreaterThan(fetched)
    expect(sync.pulls).toEqual(['p1'])
    expect(announced).toBe(1)
  })

  it('pulls nothing offline, and still tells the views', async () => {
    const network = fakeNetwork(true)
    const { element, sync } = await openOnServer({ network })
    network.go(false)
    await element.updateComplete

    await refresh(element)

    expect(sync.pulls).toEqual([])
    expect(announced).toBe(1)
  })

  it('pulls nothing for a project that is not replicating', async () => {
    // A suspended or refused project: pulling it behind the live sync's back would undo the
    // reason it was stopped.
    const { element, sync } = await openOnServer({ running: [] })

    await refresh(element)

    expect(sync.pulls).toEqual([])
    expect(announced).toBe(1)
  })

  it('pulls nothing for a project with no server copy', async () => {
    useProjectDatabase('project_local')
    const { element, sync } = await mount({
      local: [entry()],
      cachedProfile: profile(),
      running: ['p1'],
    })
    await waitUntil(() => currentProjectDatabaseName() === 'project_local_a', 'not opened')
    await waitUntil(() => refreshButton(element) !== null, 'no Refresh button')

    await refresh(element)

    expect(sync.pulls).toEqual([])
    expect(announced).toBe(1)
  })

  it('finishes, and still tells the views, when the pull fails', async () => {
    // The status bar says when a project is not syncing; a Refresh that threw would leave the
    // button spinning.
    const { element, sync } = await openOnServer({
      pull: async () => Promise.reject(new Error('unreachable')),
    })

    await refresh(element)

    expect(sync.pulls).toEqual(['p1'])
    expect(announced).toBe(1)
    expect(refreshButton(element).loading).toBe(false)
  })

  it('finishes, and still pulls and tells the views, when re-reading the list fails', async () => {
    // The pull and the re-read do not depend on the list: a fault there must not skip them, nor
    // escape the click handler as an unhandled rejection.
    //
    // Exactly one read fails, and it is Refresh's own: the press reaches the cache before its
    // first await. A store left broken would also fail whichever background refresh ran next,
    // as an unhandled rejection that names this test (seen on CI).
    const real = isolatedProjectStore()
    let failures = 0
    const store: LocalProjectDependencies = {
      ...real,
      cache: () => {
        if (failures > 0) {
          failures -= 1
          throw new Error('the cache is gone')
        }
        return real.cache()
      },
    }
    const { element, sync } = await openOnServer({ store })
    failures = 1

    const pressed = refresh(element)
    expect(failures).toBe(0)
    await pressed

    expect(sync.pulls).toEqual(['p1'])
    expect(announced).toBe(1)
    expect(refreshButton(element).loading).toBe(false)
  })

  it('shows it is working, and ignores a second press meanwhile', async () => {
    let release: () => void = () => {}
    const { element, sync } = await openOnServer({
      pull: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    })

    refreshButton(element).click()
    await waitUntil(() => sync.pulls.length === 1, 'the pull never started')
    await element.updateComplete
    expect(refreshButton(element).loading).toBe(true)
    refreshButton(element).click()
    await element.updateComplete

    release()
    await waitUntil(() => refreshButton(element).loading === false, 'Refresh never finished')
    expect(sync.pulls).toEqual(['p1'])
    expect(announced).toBe(1)
  })
})

describe('documents arriving by replication', () => {
  let announced = 0
  const count = (): void => {
    announced += 1
  }

  beforeEach(() => {
    announced = 0
    window.addEventListener(PROJECT_DATA_CHANGED, count)
  })

  afterEach(() => {
    window.removeEventListener(PROJECT_DATA_CHANGED, count)
  })

  async function openP1() {
    localStorage.setItem(CURRENT_PROJECT_KEY, 'p1')
    const mounted = await mount({
      local: [copy, entry({ dbName: 'project_p2', name: 'Gamma', projectId: 'p2' })],
      cachedProfile: profile(),
      list: async () => [project(), project({ projectId: 'p2', dbName: 'project_p2' })],
    })
    await waitUntil(() => currentProjectDatabaseName() === 'project_p1', 'p1 never opened')
    await inputSettles(mounted.element, (i) => i.server !== undefined, 'no list arrived')
    return mounted
  }

  it('tells the views when they arrived in the open project', async () => {
    const { incoming } = await openP1()

    incoming('p1')

    expect(announced).toBe(1)
  })

  it('says nothing about another project', async () => {
    // A re-read of the page would show nothing new, and in the device form would cost nothing
    // only because the forms do not listen; better not to ask.
    const { incoming } = await openP1()

    incoming('p2')

    expect(announced).toBe(0)
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
        .escrow=${noEscrow}
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

  it('names a collaborator’s copy the server no longer lists', async () => {
    // An owner's such copy does not get here: a fresh list detaches it into a local project
    // (#290), which the sign-out keeps. A collaborator's cannot be pushed — it is not theirs to
    // write any more — so it is named without trying.
    const { element, sync } = await mount({
      local: [{ ...copy, role: 'write' as const }],
      cachedProfile: profile(),
      list: async () => [],
    })
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

/** Opens the upgrade dialog from the header and waits for it. */
async function openUpgrade(element: AppShell): Promise<HTMLElement> {
  await waitUntil(() => element.querySelector('[data-upgrade]') !== null, 'no upgrade')
  ;(element.querySelector('[data-upgrade]') as HTMLElement).click()
  await waitUntil(() => element.querySelector('[data-upgrade-dialog][open]') !== null, 'no dialog')
  return element.querySelector('[data-upgrade-dialog]') as HTMLElement
}

/** Waits for `<wa-page>` to settle on a layout after the viewport changed. */
const pageView = (element: Element, view: 'desktop' | 'mobile') =>
  waitUntil(
    () => element.querySelector('wa-page')?.getAttribute('view') === view,
    `the page never became ${view}`,
  )

/** The trimmed text of each element matching `selector` inside `root`. */
const texts = (root: Element, selector: string): string[] =>
  [...root.querySelectorAll(selector)].map((each) => text(each))

describe('upgrading', () => {
  afterEach(async () => {
    // Vitest's default browser viewport; one test's size must not leak into the next file.
    await page.viewport(414, 896)
    await activateLocale(SOURCE_LOCALE)
  })

  it('compares the three plans in upgrade order, the account’s own highlighted', async () => {
    await page.viewport(1280, 800)
    const { element } = await mount({ cachedProfile: profile({ plan: 'member', projectLimit: 5 }) })
    await inputSettles(element, (i) => i.plan === 'member', 'plan never read')
    await pageView(element, 'desktop')
    const dialog = await openUpgrade(element)
    const table = dialog.querySelector('[data-plan-table]') as HTMLElement

    expect(getComputedStyle(table).display).not.toBe('none')
    // One layout per width: the cards are not displayed, so assistive technology reads the table only.
    expect(getComputedStyle(dialog.querySelector('[data-plan-cards]') as HTMLElement).display).toBe(
      'none',
    )
    expect(
      [...table.querySelectorAll('th[data-plan-column]')].map((th) =>
        th.getAttribute('data-plan-column'),
      ),
    ).toEqual(['free', 'member', 'pro'])
    expect(texts(table, 'th[data-plan-column]')).toEqual(['Free', 'Home Your plan', 'Pro'])
    expect(
      [...table.querySelectorAll('.app-plan-current')].every(
        (cell) =>
          cell.getAttribute('data-plan') === 'member' ||
          cell.getAttribute('data-plan-column') === 'member',
      ),
    ).toBe(true)
    expect(table.querySelectorAll('.app-plan-current')).toHaveLength(5)
    expect(table.querySelectorAll('[data-your-plan]')).toHaveLength(1)

    // No projects row without a matrix: how many projects a plan includes is the published
    // matrix's alone (ADR 0020), and the built-in tables have no number to put in its place.
    expect(table.querySelector('[data-row="projects"]')).toBeNull()
    expect(texts(table, '[data-row="price"] td')).toEqual([
      'Free',
      'To be announced',
      'To be announced',
    ])
    const labels = (row: string) =>
      [...table.querySelectorAll(`[data-row="${row}"] td wa-icon`)].map((icon) =>
        icon.getAttribute('label'),
      )
    expect(labels('sync')).toEqual(['Not included', 'Included', 'Included'])
    expect(labels('client-name')).toEqual(['Not included', 'Not included', 'Included'])
    expect(labels('transfer')).toEqual(['Not included', 'Not included', 'Included'])

    expect(text(dialog.querySelector('[data-waitlist-statement]'))).toBe(
      'Under heavy development. Join the waitlist for free.',
    )
  })

  it('stacks one card per plan at 360 px, with nothing to scroll sideways', async () => {
    await page.viewport(360, 740)
    const { element } = await mount({ cachedProfile: profile({ plan: 'free', projectLimit: 1 }) })
    await pageView(element, 'mobile')
    const dialog = await openUpgrade(element)

    const table = dialog.querySelector('[data-plan-table]') as HTMLElement
    expect(getComputedStyle(table).display).toBe('none')
    const cards = [...dialog.querySelectorAll('wa-card[data-plan-card]')] as HTMLElement[]
    expect(cards.map((card) => card.getAttribute('data-plan-card'))).toEqual([
      'free',
      'member',
      'pro',
    ])
    expect(cards[0]?.classList.contains('app-plan-current')).toBe(true)
    expect(cards[0]?.querySelector('[data-your-plan]')).not.toBeNull()
    expect(cards[2]?.querySelector('[data-row="price"]')?.textContent).toContain('To be announced')

    for (const card of cards) {
      expect(card.getBoundingClientRect().width).toBeGreaterThan(0)
      expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
    }
    const body = dialog.shadowRoot?.querySelector('[part~="body"]') as HTMLElement
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth)
  })

  it('speaks German, formally', async () => {
    await activateLocale('de')
    const { element } = await mount({ cachedProfile: profile({ plan: 'member', projectLimit: 5 }) })
    await inputSettles(element, (i) => i.plan === 'member', 'plan never read')
    const dialog = await openUpgrade(element)

    expect(text(dialog)).toContain('Ihr Plan')
    expect(text(dialog)).toContain('Home')
    expect(text(dialog)).toContain('Wird noch bekannt gegeben')
    expect(text(dialog)).toContain('Synchronisation und Teilen')
    expect(text(dialog.querySelector('[data-waitlist-statement]'))).toBe(
      'In intensiver Entwicklung. Setzen Sie sich kostenlos auf die Warteliste.',
    )
  })

  it('is not offered on the top plan', async () => {
    const { element } = await mount({ cachedProfile: profile({ plan: 'pro', projectLimit: -1 }) })
    await inputSettles(element, (i) => i.plan === 'pro', 'plan never read')
    await element.updateComplete
    expect(element.querySelector('[data-upgrade]')).toBeNull()
  })

  /** The backend's own `/plans` fixture, pivoted: marketing keys, values as display copy. */
  const MATRIX: PlanMatrix = {
    free: { Projects: 1, Price: 'Free forever' },
    home: { Projects: 3, Price: 'Announced at launch' },
    pro: { Projects: 'Unlimited*', Price: 'Announced at launch' },
  }
  const publishing = (matrix: PlanMatrix): PlansApi => ({ read: async () => matrix })

  it('compares the published plans in the server’s order, values verbatim', async () => {
    await page.viewport(1280, 800)
    // A marketing plan this build has no tier for still compares; it just belongs to nobody.
    const matrix: PlanMatrix = { ...MATRIX, beyond: { Projects: 'Teams', Price: 'On request' } }
    const { element } = await mount({
      cachedProfile: profile({ plan: 'member', projectLimit: 5 }),
      plans: publishing(matrix),
    })
    await inputSettles(element, (i) => i.plan === 'member', 'plan never read')
    await pageView(element, 'desktop')
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-plan-column="home"]') !== null, 'no matrix')
    const table = dialog.querySelector('[data-plan-table]') as HTMLElement

    expect(
      [...table.querySelectorAll('th[data-plan-column]')].map((th) =>
        th.getAttribute('data-plan-column'),
      ),
    ).toEqual(['free', 'home', 'pro', 'beyond'])
    // "Your plan" sits on the marketing column whose tier is the account's: `home` is `member`.
    expect(texts(table, 'th[data-plan-column]')).toEqual([
      'free',
      'home Your plan',
      'pro',
      'beyond',
    ])
    // The lowercase marketing key is capitalized for display by CSS, verbatim in the DOM.
    expect(
      getComputedStyle(
        table.querySelector('[data-plan-column="home"] .app-plan-marketing') as Element,
      ).textTransform,
    ).toBe('capitalize')
    // The operator's rows in document order, every value verbatim — and no icons: the matrix
    // carries display text, not booleans.
    expect(texts(table, 'tbody th[scope="row"]')).toEqual(['Projects', 'Price'])
    expect(texts(table, '[data-row="Projects"] td')).toEqual(['1', '3', 'Unlimited*', 'Teams'])
    expect(texts(table, '[data-row="Price"] td')).toEqual([
      'Free forever',
      'Announced at launch',
      'Announced at launch',
      'On request',
    ])
    expect(table.querySelectorAll('td wa-icon')).toHaveLength(0)
    // The highlight attaches to the resolved column only, and to no unknown one.
    expect(
      [...table.querySelectorAll('.app-plan-current')].every(
        (cell) =>
          cell.getAttribute('data-plan') === 'home' ||
          cell.getAttribute('data-plan-column') === 'home',
      ),
    ).toBe(true)
    expect(table.querySelectorAll('[data-your-plan]')).toHaveLength(1)
    // The waitlist stays tier-driven (ADR 0009): a member account can still only wait for pro.
    expect(
      [...dialog.querySelectorAll('[data-join]')].map((button) => button.getAttribute('data-join')),
    ).toEqual(['pro'])
  })

  it('renders the cache’s last good matrix when the server has nothing', async () => {
    await page.viewport(1280, 800)
    const store = isolatedProjectStore()
    await store.cache().writePlanMatrix({ matrix: MATRIX, fetchedAt: '2026-10-11T00:00:00.000Z' })
    const { element } = await mount({
      store,
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      plans: { read: async () => undefined },
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    await pageView(element, 'desktop')
    const dialog = await openUpgrade(element)

    await waitUntil(
      () => dialog.querySelector('[data-plan-column="home"]') !== null,
      'no cached matrix',
    )
    const table = dialog.querySelector('[data-plan-table]') as HTMLElement
    expect(texts(table, '[data-row="Projects"] td')).toEqual(['1', '3', 'Unlimited*'])
  })

  it('corrects an open dialog when the server’s answer differs from the cache', async () => {
    const store = isolatedProjectStore()
    await store.cache().writePlanMatrix({ matrix: MATRIX, fetchedAt: '2026-10-11T00:00:00.000Z' })
    const changed: PlanMatrix = {
      ...MATRIX,
      pro: { Projects: 'Unlimited', Price: 'Announced at launch' },
    }
    const { element } = await mount({
      store,
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      plans: publishing(changed),
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)

    // The corrected value in the matrix's own cell, not anywhere in the dialog: the built-in
    // fallback that renders for an instant before the cache is read also says "Unlimited", and
    // matching it would read the cache below before the correction was written.
    await waitUntil(() => {
      const cell = dialog.querySelector('[data-row="Projects"] td[data-plan="pro"]')
      return cell !== null && text(cell) === 'Unlimited'
    }, 'the dialog never heard the correction')
    // And the cache holds the correction, so the next offline open shows it too. The resolver
    // writes before it calls back, so a corrected dialog means a corrected cache.
    expect((await store.cache().readPlanMatrix())?.matrix).toEqual(changed)
  })

  it('a close and reopen joins the load in flight instead of racing a second fetch', async () => {
    // Two overlapping fetches could land out of order, the older answer overwriting the newer
    // in the cache and on the open dialog; single-flight makes the order unaskable.
    let reads = 0
    let release: (matrix: PlanMatrix) => void = () => {}
    const plans: PlansApi = {
      read: () => {
        reads += 1
        return new Promise((resolve) => {
          release = resolve
        })
      },
    }
    const { element } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      plans,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')

    const dialog = await openUpgrade(element)
    ;(dialog.querySelector('[data-close-upgrade]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-upgrade-dialog]') === null, 'still open')
    const reopened = await openUpgrade(element)

    expect(reads).toBe(1)
    release(MATRIX)
    await waitUntil(
      () => reopened.querySelector('[data-plan-column="home"]') !== null,
      'the joined load never reached the reopened dialog',
    )
  })

  it('stacks one card per published plan at 360 px, nothing scrolling sideways', async () => {
    await page.viewport(360, 740)
    const { element } = await mount({
      cachedProfile: profile({ plan: 'member', projectLimit: 5 }),
      plans: publishing(MATRIX),
    })
    await inputSettles(element, (i) => i.plan === 'member', 'plan never read')
    await pageView(element, 'mobile')
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-plan-card="home"]') !== null, 'no cards')

    const cards = [...dialog.querySelectorAll('wa-card[data-plan-card]')] as HTMLElement[]
    expect(cards.map((card) => card.getAttribute('data-plan-card'))).toEqual([
      'free',
      'home',
      'pro',
    ])
    expect(cards[1]?.querySelector('[data-your-plan]')).not.toBeNull()
    expect(cards[2]?.querySelector('[data-row="Projects"]')?.textContent).toContain('Unlimited*')
    for (const card of cards) {
      expect(card.getBoundingClientRect().width).toBeGreaterThan(0)
      expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
    }
    const body = dialog.shadowRoot?.querySelector('[part~="body"]') as HTMLElement
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth)
  })

  it('keeps the dialog’s own words German while the matrix copy stays as published', async () => {
    await activateLocale('de')
    const { element } = await mount({
      cachedProfile: profile({ plan: 'member', projectLimit: 5 }),
      plans: publishing(MATRIX),
    })
    await inputSettles(element, (i) => i.plan === 'member', 'plan never read')
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-plan-card="home"]') !== null, 'no matrix')

    // The chrome is localized; the matrix is the operator's published copy, shown verbatim.
    expect(text(dialog)).toContain('Ihr Plan')
    expect(text(dialog)).toContain('Announced at launch')
    expect(text(dialog.querySelector('[data-waitlist-statement]'))).toBe(
      'In intensiver Entwicklung. Setzen Sie sich kostenlos auf die Warteliste.',
    )
  })

  // Midday UTC, so the date reads the same in every time zone a test machine might run in.
  const AT = '2026-10-09T12:00:00.000Z'
  const joinButtons = (dialog: Element) =>
    [...dialog.querySelectorAll('[data-join]')].map((button) => button.getAttribute('data-join'))
  /** The loud brand buttons in the dialog: brand, in the default `accent` appearance. */
  const filledBrand = (dialog: Element) =>
    (
      [...dialog.querySelectorAll('wa-button')] as Array<
        HTMLElement & { variant: string; appearance: string }
      >
    ).filter((button) => button.variant === 'brand' && button.appearance === 'accent')

  it('asks a signed-out reader to sign in first, and still compares the plans', async () => {
    const signIn = vi.fn()
    const { element } = await mount({ session: 'signed-out', signIn })
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in')
    const dialog = await openUpgrade(element)

    expect(dialog.querySelector('[data-plan-cards]')).not.toBeNull()
    expect(joinButtons(dialog)).toEqual([])
    const button = dialog.querySelector('[data-sign-in-waitlist]') as HTMLElement
    expect(text(button)).toBe('Sign in to join the waitlist')
    button.click()
    // Signing in is a method chooser now: the button opens it rather than leaving for Google.
    await waitUntil(
      () => element.querySelector('[data-sign-in-dialog][open]') !== null,
      'no chooser',
    )
    expect(signIn).not.toHaveBeenCalled()
    ;(element.querySelector('[data-google-sign-in]') as HTMLElement).click()
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('offers to join only the plans above a free account’s', async () => {
    const { element } = await mount({ cachedProfile: profile({ plan: 'free', projectLimit: 1 }) })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)

    expect(joinButtons(dialog)).toEqual(['member', 'pro'])
    expect(texts(dialog, '[data-join]')).toEqual([
      'Join the waitlist for Home',
      'Join the waitlist for Pro',
    ])
    expect(dialog.querySelector('[data-leave-waitlist]')).toBeNull()
  })

  it('offers no join for the plan a member has, or below it', async () => {
    const { element } = await mount({ cachedProfile: profile({ plan: 'member', projectLimit: 5 }) })
    await inputSettles(element, (i) => i.plan === 'member', 'plan never read')
    const dialog = await openUpgrade(element)

    expect(joinButtons(dialog)).toEqual(['pro'])
  })

  it('fills only the next plan up’s join in brand, and nothing while waiting', async () => {
    // DESIGN.md's Commissioning Blue Rule: one loud brand action in view, at most.
    const free = await mount({ cachedProfile: profile({ plan: 'free', projectLimit: 1 }) })
    await inputSettles(free.element, (i) => i.plan === 'free', 'plan never read')
    let dialog = await openUpgrade(free.element)
    expect(filledBrand(dialog).map((button) => button.getAttribute('data-join'))).toEqual([
      'member',
    ])
    fixtureCleanup()

    const member = await mount({ cachedProfile: profile({ plan: 'member', projectLimit: 5 }) })
    await inputSettles(member.element, (i) => i.plan === 'member', 'plan never read')
    dialog = await openUpgrade(member.element)
    expect(filledBrand(dialog).map((button) => button.getAttribute('data-join'))).toEqual(['pro'])
    fixtureCleanup()

    const signedOut = await mount({ session: 'signed-out' })
    await waitUntil(() => signedOut.element.querySelector('[data-sign-in]') !== null, 'no sign-in')
    dialog = await openUpgrade(signedOut.element)
    expect(filledBrand(dialog)).toHaveLength(1)
    expect(filledBrand(dialog)[0]?.hasAttribute('data-sign-in-waitlist')).toBe(true)
    fixtureCleanup()

    const waiting = await mount({
      cachedProfile: profile({
        plan: 'free',
        projectLimit: 1,
        planRequested: 'pro',
        requestedAt: AT,
      }),
    })
    dialog = await openUpgrade(waiting.element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')
    expect(filledBrand(dialog)).toHaveLength(0)
  })

  it('says what a waiting account waits for and since when, and offers change and leave', async () => {
    const { element } = await mount({
      cachedProfile: profile({
        plan: 'free',
        projectLimit: 1,
        planRequested: 'pro',
        requestedAt: AT,
      }),
    })
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')

    expect(text(dialog.querySelector('[data-waiting]'))).toBe(
      'You are on the waitlist for Pro (since Oct 9, 2026).',
    )
    expect(joinButtons(dialog)).toEqual(['member'])
    expect(texts(dialog, '[data-join]')).toEqual(['Change to Home'])
    expect(text(dialog.querySelector('[data-leave-waitlist]'))).toBe('Leave the waitlist')
    // Not focusable until a change lands on it: the dialog's own first focus must not pick it.
    expect(dialog.querySelector('[data-waiting]')?.hasAttribute('tabindex')).toBe(false)
  })

  it('still lets an account leave a waitlist for a plan it now has', async () => {
    // An operator set the plan after the request: the request stays until the user leaves.
    const { element } = await mount({
      cachedProfile: profile({
        plan: 'member',
        projectLimit: 5,
        planRequested: 'member',
        requestedAt: AT,
      }),
    })
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')

    expect(joinButtons(dialog)).toEqual(['pro'])
    expect(dialog.querySelector('[data-leave-waitlist]')).not.toBeNull()
  })

  it('offers Upgrade on the top plan while a request is pending, so it can be left', async () => {
    // Raised to the top plan after asking for it: nothing to upgrade to, but a request to leave.
    const waitlist = fakeWaitlist(() => ({
      kind: 'done',
      profile: serverProfile({ plan: 'pro', projectLimit: -1 }),
    }))
    const { element } = await mount({
      cachedProfile: profile({
        plan: 'pro',
        projectLimit: -1,
        planRequested: 'pro',
        requestedAt: AT,
      }),
      waitlist: waitlist.api,
    })
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')

    expect(joinButtons(dialog)).toEqual([])
    ;(dialog.querySelector('[data-leave-waitlist]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-upgrade]') === null, 'Upgrade stayed')
    expect(waitlist.calls).toEqual([{ kind: 'leave' }])
  })

  it('shows a date it cannot read as it is', async () => {
    const { element } = await mount({
      cachedProfile: profile({
        plan: 'free',
        projectLimit: 1,
        planRequested: 'pro',
        requestedAt: 'soon',
      }),
    })
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')

    expect(text(dialog.querySelector('[data-waiting]'))).toBe(
      'You are on the waitlist for Pro (since soon).',
    )
  })

  it('disables everything that needs the server while offline, and says why', async () => {
    const { element } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      network: fakeNetwork(false),
    })
    await inputSettles(element, (i) => i.online === false, 'never offline')
    const dialog = await openUpgrade(element)

    expect(dialog.querySelector('[data-plan-cards]')).not.toBeNull()
    const buttons = [...dialog.querySelectorAll('[data-join]')] as Array<
      HTMLElement & { disabled: boolean }
    >
    expect(buttons).toHaveLength(2)
    expect(buttons.every((button) => button.disabled)).toBe(true)
    expect(text(dialog.querySelector('[data-needs-connection]'))).toBe('Needs a connection')
  })

  it('disables signing in while offline too', async () => {
    // The header offers no Sign in offline (#215's rule), so the session settling is read from
    // the shell itself; the dialog's own sign-in action stays, disabled, saying why (#224).
    const { element } = await mount({ session: 'signed-out', network: fakeNetwork(false) })
    await waitUntil(() => element.session === 'signed-out', 'never signed out')
    const dialog = await openUpgrade(element)

    expect(
      (dialog.querySelector('[data-sign-in-waitlist]') as HTMLElement & { disabled: boolean })
        .disabled,
    ).toBe(true)
    expect(dialog.querySelector('[data-needs-connection]')).not.toBeNull()
  })

  it('shows a waiting account its request when it opens offline', async () => {
    // The refresher cannot reach the server, so the session is merely held for the whole outage
    // (`offline-held`, #215: a refresh token is stored); the cache still knows the account and
    // what it waits for.
    const { element } = await mount({
      session: 'unreachable-held',
      network: fakeNetwork(false),
      cachedProfile: profile({
        plan: 'free',
        projectLimit: 1,
        planRequested: 'pro',
        requestedAt: AT,
      }),
    })
    await inputSettles(element, (i) => i.online === false, 'never offline')
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')

    expect(element.session).toBe('offline-held')
    expect(text(dialog.querySelector('[data-waiting]'))).toBe(
      'You are on the waitlist for Pro (since Oct 9, 2026).',
    )
    expect(dialog.querySelector('[data-sign-in-waitlist]')).toBeNull()
    const actions = [...dialog.querySelectorAll('[data-join], [data-leave-waitlist]')] as Array<
      HTMLElement & { disabled: boolean }
    >
    expect(actions.map((button) => button.getAttribute('data-join') ?? 'leave')).toEqual([
      'member',
      'leave',
    ])
    expect(actions.every((button) => button.disabled)).toBe(true)
    expect(text(dialog.querySelector('[data-needs-connection]'))).toBe('Needs a connection')
  })

  it('keeps speaking to the cached account when the server is unwell while online', async () => {
    // `/auth/token` answering 502 while the browser reports online lands in `offline-held` too
    // (#215): the stored session is unconfirmed, not absent. Offering an enabled "Sign in to
    // join the waitlist" would be wrong about the session, so the dialog speaks to the cached
    // account and keeps the server-dependent actions unavailable until the session is confirmed
    // (PR #314 review).
    const { element } = await mount({
      session: 'unreachable-held',
      network: fakeNetwork(true),
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
    })
    await waitUntil(() => element.session === 'offline-held', 'the session never held')
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-join]') !== null, 'no joins')

    expect(dialog.querySelector('[data-sign-in-waitlist]')).toBeNull()
    const buttons = [...dialog.querySelectorAll('[data-join]')] as Array<
      HTMLElement & { disabled: boolean }
    >
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.every((button) => button.disabled)).toBe(true)
  })

  it('offers a known account its joins, disabled, when it opens offline', async () => {
    const { element } = await mount({
      session: 'unreachable',
      network: fakeNetwork(false),
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
    })
    await inputSettles(element, (i) => i.online === false, 'never offline')
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-join]') !== null, 'no joins')

    expect(dialog.querySelector('[data-sign-in-waitlist]')).toBeNull()
    expect(joinButtons(dialog)).toEqual(['member', 'pro'])
    const buttons = [...dialog.querySelectorAll('[data-join]')] as Array<
      HTMLElement & { disabled: boolean }
    >
    expect(buttons.every((button) => button.disabled)).toBe(true)
    expect(text(dialog.querySelector('[data-needs-connection]'))).toBe('Needs a connection')
  })

  it('corrects the plan it shows when the server says the plan is already held', async () => {
    // The cache still says free; the server knows better, and its profile is read again.
    const waitlist = fakeWaitlist(() => ({ kind: 'already-on-plan' }))
    const readProfile = vi.fn(async () => serverProfile({ plan: 'member', projectLimit: 5 }))
    const { element, store } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
      readProfile,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)
    const current = () =>
      [...dialog.querySelectorAll('[data-plan-card].app-plan-current')].map((card) =>
        card.getAttribute('data-plan-card'),
      )
    expect(current()).toEqual(['free'])

    ;(dialog.querySelector('[data-join="member"]') as HTMLElement).click()
    await waitUntil(() => current()[0] === 'member', 'the highlight never moved')

    expect(readProfile).toHaveBeenCalledTimes(1)
    expect(text(dialog.querySelector('[data-waitlist-problem]'))).toBe(
      'You already have this plan.',
    )
    expect(await store.cache().readProfile()).toMatchObject({ plan: 'member' })
  })

  it('keeps the problem, and stays quiet, when that read fails', async () => {
    const waitlist = fakeWaitlist(() => ({ kind: 'already-on-plan' }))
    const readProfile = vi.fn(async () => {
      throw new Error('offline')
    })
    const { element } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
      readProfile,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)

    ;(dialog.querySelector('[data-join="member"]') as HTMLElement).click()
    await waitUntil(() => readProfile.mock.calls.length === 1, 'never read again')
    await waitUntil(() => !element.waitlistBusy, 'still busy')

    expect(text(dialog.querySelector('[data-waitlist-problem]'))).toBe(
      'You already have this plan.',
    )
    expect(element.querySelector('[data-plan-card="free"].app-plan-current')).not.toBeNull()
  })

  it('drops a re-read that a later change overtook', async () => {
    // The 409's profile read is slow; a join that succeeds meanwhile must not be overwritten.
    let readArrives: (fresh: Profile) => void = () => {}
    const readProfile = vi.fn(
      () =>
        new Promise<Profile | undefined>((resolve) => {
          readArrives = resolve
        }),
    )
    const waitlist = fakeWaitlist((call) =>
      call.kind === 'join' && call.plan === 'member'
        ? { kind: 'already-on-plan' }
        : { kind: 'done', profile: serverProfile({ planRequested: 'pro', requestedAt: AT }) },
    )
    const { element, store } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
      readProfile,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)

    ;(dialog.querySelector('[data-join="member"]') as HTMLElement).click()
    await waitUntil(() => readProfile.mock.calls.length === 1, 'never read again')
    await waitUntil(() => !element.waitlistBusy, 'still busy')
    ;(dialog.querySelector('[data-join="pro"]') as HTMLElement).click()
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'the join never showed')

    readArrives(serverProfile())
    await element.updateComplete
    await new Promise((settle) => setTimeout(settle, 50))

    expect(await store.cache().readProfile()).toMatchObject({ planRequested: 'pro' })
    expect(dialog.querySelector('[data-waiting]')).not.toBeNull()
  })

  it('caches nothing a change brings back after the account signed out', async () => {
    let answer: (outcome: WaitlistOutcome) => void = () => {}
    const waitlist = fakeWaitlist(
      () =>
        new Promise<WaitlistOutcome>((resolve) => {
          answer = resolve
        }),
    )
    const { element, store } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)
    ;(dialog.querySelector('[data-join="member"]') as HTMLElement).click()
    await waitUntil(() => waitlist.calls.length === 1, 'never asked')

    await waitUntil(() => element.querySelector('nav [data-sign-out]') !== null, 'not in the menu')
    ;(element.querySelector('nav [data-sign-out]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-confirm-sign-out]') !== null, 'no dialog')
    ;(element.querySelector('[data-confirm-sign-out]') as HTMLElement).click()
    await waitUntil(() => element.session === 'signed-out', 'never signed out')

    answer({ kind: 'done', profile: serverProfile({ planRequested: 'member', requestedAt: AT }) })
    await waitUntil(() => !element.waitlistBusy, 'still busy')

    expect(await store.cache().readProfile()).not.toHaveProperty('planRequested')
  })

  it('says it left the waitlist in the dialog when the dialog stays open', async () => {
    const waitlist = fakeWaitlist(() => ({ kind: 'done', profile: serverProfile() }))
    const { element } = await mount({
      cachedProfile: profile({
        plan: 'free',
        projectLimit: 1,
        planRequested: 'pro',
        requestedAt: AT,
      }),
      waitlist: waitlist.api,
    })
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')
    const status = dialog.querySelector('[data-waitlist-status]') as HTMLElement

    ;(dialog.querySelector('[data-leave-waitlist]') as HTMLElement).click()
    await waitUntil(() => dialog.querySelector('[data-waiting]') === null, 'never left')

    expect(dialog.querySelector('[data-waitlist-status]')).toBe(status)
    expect(text(status)).toBe('You left the waitlist.')
    // Said once: the shell's region speaks only when the dialog goes away.
    expect(text(element.querySelector('[data-status-announcement]'))).toBe('')

    // The same words as the shell's own announcement, in German too.
    await activateLocale('de')
    await element.updateComplete
    expect(text(status)).toBe('Sie haben die Warteliste verlassen.')
  })

  it('joins, then shows the request and caches it', async () => {
    const waitlist = fakeWaitlist(() => ({
      kind: 'done',
      profile: serverProfile({ planRequested: 'member', requestedAt: AT }),
    }))
    const { element, store } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)

    ;(dialog.querySelector('[data-join="member"]') as HTMLElement).click()
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'the join never showed')

    expect(waitlist.calls).toEqual([{ kind: 'join', plan: 'member' }])
    expect(text(dialog.querySelector('[data-waiting]'))).toContain('Home')
    // Focus lands on what changed, not on the page behind the dialog (WCAG 2.4.3). Waited for:
    // the line renders a moment before the shell moves focus to it.
    await waitUntil(
      () => document.activeElement === dialog.querySelector('[data-waiting]'),
      'focus never reached the waiting line',
    )
    expect(await store.cache().readProfile()).toMatchObject({
      planRequested: 'member',
      requestedAt: AT,
    })
  })

  it('leaves, then offers joining again and forgets the request', async () => {
    const waitlist = fakeWaitlist(() => ({ kind: 'done', profile: serverProfile() }))
    const { element, store } = await mount({
      cachedProfile: profile({
        plan: 'free',
        projectLimit: 1,
        planRequested: 'pro',
        requestedAt: AT,
      }),
      waitlist: waitlist.api,
    })
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')

    ;(dialog.querySelector('[data-leave-waitlist]') as HTMLElement).click()
    await waitUntil(() => dialog.querySelector('[data-waiting]') === null, 'never left')

    expect(waitlist.calls).toEqual([{ kind: 'leave' }])
    expect(joinButtons(dialog)).toEqual(['member', 'pro'])
    expect(await store.cache().readProfile()).not.toHaveProperty('planRequested')
  })

  it.each([
    ['already-on-plan', 'You already have this plan.'],
    ['unavailable', 'The waitlist could not be reached. Please try again.'],
    ['signed-out', 'Your session has ended. Please sign in again.'],
  ] as const)('says so inline when the answer is %s', async (kind, words) => {
    const waitlist = fakeWaitlist(() => ({ kind }))
    const { element } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)

    ;(dialog.querySelector('[data-join="pro"]') as HTMLElement).click()
    await waitUntil(
      () => dialog.querySelector('[data-waitlist-problem]') !== null,
      'no problem shown',
    )

    const callout = dialog.querySelector('[data-waitlist-problem]') as HTMLElement
    expect(callout.getAttribute('variant')).toBe('danger')
    expect(text(callout)).toBe(words)
    expect(dialog.querySelector('[data-waiting]')).toBeNull()
  })

  it('wraps the waitlist’s words at 360 px instead of clipping them', async () => {
    // The dialog is rendered inside the header's actions, which never wrap: it must not inherit that.
    await page.viewport(360, 740)
    await activateLocale('de')
    const waitlist = fakeWaitlist(() => ({ kind: 'unavailable' }))
    const { element } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
    })
    await pageView(element, 'mobile')
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)
    ;(dialog.querySelector('[data-join="pro"]') as HTMLElement).click()
    await waitUntil(
      () => dialog.querySelector('[data-waitlist-problem]') !== null,
      'no problem shown',
    )
    await (
      dialog.querySelector('[data-waitlist-problem]') as HTMLElement & {
        updateComplete: Promise<unknown>
      }
    ).updateComplete

    const callout = dialog.querySelector('[data-waitlist-problem]') as HTMLElement
    const message = callout.shadowRoot?.querySelector('[part~="message"]') as HTMLElement
    expect(message.scrollWidth).toBeLessThanOrEqual(message.clientWidth)
    for (const button of dialog.querySelectorAll('[data-join]')) {
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
    }
    const body = dialog.shadowRoot?.querySelector('[part~="body"]') as HTMLElement
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth)
  })

  /** Fails when anything in the open dialog reaches past the viewport or scrolls sideways. */
  const fitsAt360 = (dialog: Element) => {
    for (const button of dialog.querySelectorAll('wa-button')) {
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
    }
    const body = dialog.shadowRoot?.querySelector('[part~="body"]') as HTMLElement
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth)
  }

  it('lists the account in the German navigation at 360 px', async () => {
    await page.viewport(360, 740)
    await activateLocale('de')
    const { element } = await mount({ session: 'signed-in' })
    await waitUntil(() => element.querySelector('nav a[href="#/account"]') !== null, 'no entry')

    const entry = element.querySelector('nav a[href="#/account"]') as HTMLElement
    expect(text(entry)).toBe('Konto')
  })

  it('wraps the German sign-in button at 360 px', async () => {
    await page.viewport(360, 740)
    await activateLocale('de')
    const { element } = await mount({ session: 'signed-out' })
    await pageView(element, 'mobile')
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in')
    const dialog = await openUpgrade(element)
    await (
      dialog.querySelector('[data-sign-in-waitlist]') as HTMLElement & {
        updateComplete: Promise<unknown>
      }
    ).updateComplete

    expect(text(dialog.querySelector('[data-sign-in-waitlist]'))).toBe(
      'Melden Sie sich an, um sich auf die Warteliste zu setzen',
    )
    fitsAt360(dialog)
  })

  it('wraps the German change and leave buttons at 360 px', async () => {
    await page.viewport(360, 740)
    await activateLocale('de')
    const { element } = await mount({
      cachedProfile: profile({
        plan: 'free',
        projectLimit: 1,
        planRequested: 'pro',
        requestedAt: AT,
      }),
    })
    await pageView(element, 'mobile')
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')

    expect(texts(dialog, '[data-join]')).toEqual(['Zu Home wechseln'])
    expect(text(dialog.querySelector('[data-leave-waitlist]'))).toBe('Warteliste verlassen')
    fitsAt360(dialog)
  })

  it('says what changed in one status region that was there before the change', async () => {
    const waitlist = fakeWaitlist(() => ({
      kind: 'done',
      profile: serverProfile({ planRequested: 'member', requestedAt: AT }),
    }))
    const { element } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)
    const status = dialog.querySelector('[data-waitlist-status]')
    expect(status?.getAttribute('role')).toBe('status')

    ;(dialog.querySelector('[data-join="member"]') as HTMLElement).click()
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'the join never showed')

    // The same element: a live region created with its content is not announced.
    expect(dialog.querySelector('[data-waitlist-status]')).toBe(status)
    expect(status?.querySelector('[data-waiting]')).not.toBeNull()
  })

  it('puts a problem in the status region and focus back on an action', async () => {
    const waitlist = fakeWaitlist(() => ({ kind: 'unavailable' }))
    const { element } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)

    ;(dialog.querySelector('[data-join="pro"]') as HTMLElement).click()
    await waitUntil(
      () => dialog.querySelector('[data-waitlist-problem]') !== null,
      'no problem shown',
    )
    // The dialog holds focus from the moment it opens, so wait for the action, not the dialog.
    await waitUntil(
      () => document.activeElement?.hasAttribute('data-join') === true,
      'focus never returned to an action',
    )

    const status = dialog.querySelector('[data-waitlist-status]') as HTMLElement
    expect(status.getAttribute('role')).toBe('status')
    expect(status.querySelector('[data-waitlist-problem]')).not.toBeNull()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('announces leaving when it takes the dialog away', async () => {
    const waitlist = fakeWaitlist(() => ({
      kind: 'done',
      profile: serverProfile({ plan: 'pro', projectLimit: -1 }),
    }))
    const { element } = await mount({
      cachedProfile: profile({
        plan: 'pro',
        projectLimit: -1,
        planRequested: 'pro',
        requestedAt: AT,
      }),
      waitlist: waitlist.api,
    })
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')

    ;(dialog.querySelector('[data-leave-waitlist]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-upgrade-dialog]') === null, 'dialog stayed')

    expect(text(element.querySelector('[data-status-announcement]'))).toBe('You left the waitlist.')
    // Upgrade went with the dialog, so focus goes to the control that took its place in the
    // header, not to the page (WCAG 2.4.3), and the announcement is still there to be heard.
    await waitUntil(
      () => document.activeElement === element.querySelector('[data-scheme-toggle]'),
      'focus was lost',
    )
    expect(text(element.querySelector('[data-status-announcement]'))).toBe('You left the waitlist.')
  })

  it('returns focus to Upgrade when the dialog is closed', async () => {
    const { element } = await mount({ cachedProfile: profile({ plan: 'free', projectLimit: 1 }) })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)

    ;(dialog.querySelector('[data-close-upgrade]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-upgrade-dialog]') === null, 'still open')
    await waitUntil(
      () => document.activeElement === element.querySelector('[data-upgrade]'),
      'focus was lost',
    )
  })

  it('returns focus to Upgrade when the dialog is dismissed with Escape', async () => {
    const { element } = await mount({ cachedProfile: profile({ plan: 'free', projectLimit: 1 }) })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.contains(document.activeElement), 'the dialog never took focus')

    await userEvent.keyboard('{Escape}')
    await waitUntil(() => element.querySelector('[data-upgrade-dialog]') === null, 'still open')
    await waitUntil(
      () => document.activeElement === element.querySelector('[data-upgrade]'),
      'focus was lost',
    )
  })

  it('says so when the server took the change but this device could not store it', async () => {
    const waitlist = fakeWaitlist(() => ({
      kind: 'done',
      profile: serverProfile({ planRequested: 'member', requestedAt: AT }),
    }))
    const { element, store } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)
    // Refused only from here on: `mount` wrote the profile above through the same cache.
    const cache = store.cache() as { writeProfile: (...args: unknown[]) => Promise<void> }
    cache.writeProfile = () => Promise.reject(new Error('QuotaExceededError'))

    ;(dialog.querySelector('[data-join="member"]') as HTMLElement).click()
    await waitUntil(() => dialog.querySelector('[data-waitlist-problem]') !== null, 'no notice')

    const notice = dialog.querySelector('[data-waitlist-problem]') as HTMLElement
    expect(text(notice)).toBe('Saved, but this device could not store it. Reload to see it.')
    expect(notice.closest('[data-waitlist-status]')).not.toBeNull()
    await waitUntil(() => !element.waitlistBusy, 'still busy')
    const buttons = [...dialog.querySelectorAll('[data-join]')] as Array<
      HTMLElement & { disabled: boolean }
    >
    expect(buttons.some((button) => button.disabled)).toBe(false)
  })

  it('closes, and stays closed, when a background refresh takes the request away', async () => {
    // The profile is fetched again behind the dialog, and the operator's plan change lands.
    let profileArrived: () => void = () => {}
    const store = isolatedProjectStore()
    const { element } = await mount({
      store,
      cachedProfile: profile({
        plan: 'pro',
        projectLimit: -1,
        planRequested: 'pro',
        requestedAt: AT,
      }),
      followLocale: async (_onLocale: unknown, onProfile?: () => void) => {
        profileArrived = () => onProfile?.()
      },
    })
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')

    await store.cache().writeProfile(profile({ plan: 'pro', projectLimit: -1 }))
    profileArrived()
    await waitUntil(() => element.querySelector('[data-upgrade]') === null, 'Upgrade stayed')
    expect(element.upgrading).toBe(false)

    // A later request brings the button back, and only the button.
    await store
      .cache()
      .writeProfile(
        profile({ plan: 'pro', projectLimit: -1, planRequested: 'pro', requestedAt: AT }),
      )
    profileArrived()
    await waitUntil(() => element.querySelector('[data-upgrade]') !== null, 'no Upgrade')
    expect(element.querySelector('[data-upgrade-dialog]')).toBeNull()
  })

  it('says it is waiting, and what went wrong, in German', async () => {
    await activateLocale('de')
    const waitlist = fakeWaitlist(() => ({ kind: 'already-on-plan' }))
    const { element } = await mount({
      cachedProfile: profile({
        plan: 'free',
        projectLimit: 1,
        planRequested: 'pro',
        requestedAt: AT,
      }),
      waitlist: waitlist.api,
    })
    const dialog = await openUpgrade(element)
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'not waiting')

    expect(text(dialog.querySelector('[data-waiting]'))).toBe(
      'Sie stehen auf der Warteliste für Pro (seit 09.10.2026).',
    )
    ;(dialog.querySelector('[data-join="member"]') as HTMLElement).click()
    await waitUntil(
      () => dialog.querySelector('[data-waitlist-problem]') !== null,
      'no problem shown',
    )
    expect(text(dialog.querySelector('[data-waitlist-problem]'))).toBe(
      'Sie haben diesen Plan bereits.',
    )
  })

  it('sends one request for two quick clicks, and holds every action until it answers', async () => {
    let release: (outcome: WaitlistOutcome) => void = () => {}
    const waitlist = fakeWaitlist(
      () =>
        new Promise<WaitlistOutcome>((resolve) => {
          release = resolve
        }),
    )
    const { element } = await mount({
      cachedProfile: profile({ plan: 'free', projectLimit: 1 }),
      waitlist: waitlist.api,
    })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)

    const member = dialog.querySelector('[data-join="member"]') as HTMLElement
    member.click()
    member.click()
    await element.updateComplete

    expect(waitlist.calls).toHaveLength(1)
    const buttons = [...dialog.querySelectorAll('[data-join]')] as Array<
      HTMLElement & { disabled: boolean }
    >
    expect(buttons.every((button) => button.disabled)).toBe(true)

    release({ kind: 'done', profile: serverProfile({ planRequested: 'member', requestedAt: AT }) })
    await waitUntil(() => dialog.querySelector('[data-waiting]') !== null, 'never answered')
  })

  it('offers the waitlist in German, formally', async () => {
    await activateLocale('de')
    const { element } = await mount({ cachedProfile: profile({ plan: 'free', projectLimit: 1 }) })
    await inputSettles(element, (i) => i.plan === 'free', 'plan never read')
    const dialog = await openUpgrade(element)

    expect(texts(dialog, '[data-join]')).toEqual([
      'Auf die Warteliste für Home',
      'Auf die Warteliste für Pro',
    ])
  })
})

describe('the account page plans (#263)', () => {
  /** The backend's own `/plans` fixture, pivoted — Home includes 3 projects today. */
  const MATRIX: PlanMatrix = {
    free: { Projects: 1, Price: 'Free forever' },
    home: { Projects: 3, Price: 'Announced at launch' },
    pro: { Projects: 'Unlimited*', Price: 'Announced at launch' },
  }

  it('rereads the profile behind the matrix, so the legacy line compares like with like', async () => {
    // The cached profile predates the operator lowering Home to 3: it still says the plan
    // includes 5, so no divergence is visible from the cache alone. Loading the account page
    // fetches the matrix and must bring the profile up to date behind it (`GET /profile`
    // recomputes `planProjectLimit` on every answer, ADR 0020) — only then can the page say
    // "Projects your plan includes: 3. Yours: 5 (legacy plan)."
    window.location.hash = '#/account'
    const readProfile = vi.fn(async () =>
      serverProfile({ plan: 'member', projectLimit: 5, planProjectLimit: 3 }),
    )
    const { element } = await mount({
      cachedProfile: profile({ plan: 'member', projectLimit: 5, planProjectLimit: 5 }),
      plans: { read: async () => MATRIX },
      readProfile,
    })
    await waitUntil(
      () => element.querySelector('account-view [data-legacy-plan]') !== null,
      'the legacy line never appeared — the profile was not reread behind the matrix',
    )
    expect(text(element.querySelector('account-view [data-legacy-plan]'))).toBe(
      'Projects your plan includes: 3. Yours: 5 (legacy plan).',
    )
    expect(readProfile).toHaveBeenCalled()
  })
})
