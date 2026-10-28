import { ZipError } from '../../../src/domain/archive/zip.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/card/card.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/dropdown/dropdown.js'
import '@awesome.me/webawesome-pro/dist/components/dropdown-item/dropdown-item.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type LocalProjectEntry, ProjectLockedError } from '../../../src/data/index.js'
import { CURRENT_PROJECT_KEY } from '../../../src/ui/current-project.js'
import {
  currentProjectDatabaseName,
  PROJECT_DATABASE_NAME,
  projectIsEditable,
  useProjectDatabase,
} from '../../../src/ui/db/project-database.js'
import { activateLocale } from '../../../src/ui/i18n/localization.js'
import {
  CreatedLocallyError,
  ProjectActionError,
  type ProjectActions,
} from '../../../src/ui/project-actions.js'
import { projectActionRunning } from '../../../src/ui/project-busy.js'
import {
  type NewProject,
  type Project,
  ProjectCreationError,
  type ProjectPatch,
  type ProjectsApi,
  ProjectUpdateError,
} from '../../../src/ui/projects.js'
import type { ProjectsInput, Row } from '../../../src/ui/projects-model.js'
import type { SyncableProject } from '../../../src/ui/sync/manager.js'
import type { ProjectsView } from '../../../src/ui/views/projects.js'
import '../../../src/ui/views/projects.js'

/**
 * The projects page, through what it renders.
 *
 * Every dependency that reaches beyond the page is a fake that records what it was asked: the
 * API, replication, the local projects and navigation. Opening a project is the exception, and
 * deliberately: it goes through the real `useProjectDatabase` and the real `localStorage`,
 * because "Open made this the current project" is a claim about what the rest of the
 * application will read, and a fake would prove only that the fake was called.
 */

/** A local index entry. */
const entry = (over: Partial<LocalProjectEntry> = {}): LocalProjectEntry => ({
  dbName: 'project_local_a',
  name: 'Alpha',
  createdAt: '2026-10-01T09:00:00.000Z',
  ...over,
})

/** A server project. */
const project = (over: Partial<Project> = {}): Project => ({
  projectId: 'p1',
  dbName: 'project_p1',
  name: 'Beta',
  role: 'owner',
  owner: { ownerType: 'user', ownerId: 'user-1' },
  archived: false,
  ...over,
})

/** What every fake recorded. */
interface Recorded {
  readonly created: NewProject[]
  readonly updated: [string, ProjectPatch][]
  readonly synced: (readonly SyncableProject[])[]
  readonly localCreated: { name: string; client?: string }[]
  readonly renamed: [string, string][]
  readonly clients: [string, string | undefined][]
  readonly indexed: Pick<Project, 'projectId' | 'dbName' | 'name'>[]
  /** Whether a project action was held while each server project was indexed. */
  readonly indexedWhileBusy: boolean[]
  readonly navigated: string[]
  /** Every project action the page asked for: which, on which database, and any typed name. */
  readonly acted: [string, string, string?][]
  /** Every synchronized creation the page handed to the actions (#326). */
  readonly syncedCreates: NewProject[]
  refreshed: number
  /** Pushes and patches, in the order they happened, as `push:<id>` and `patch:<id>`. */
  readonly sequence: string[]
}

let recorded: Recorded

/** How the fake API answers `create`: with a project, or by throwing. */
let createAnswer: () => Project

/** How every fake project action ends: resolving by default, or as a test says. */
let actionAnswer: () => Promise<void>

/** How the fake synchronized creation ends: resolving by default, or as a test says. */
let createSyncedAnswer: () => Promise<void>

/** What the fake API's `update` throws, if anything; nothing by default. */
let updateFails: unknown

/** What the fake replication's `pushNow` throws, if anything; nothing by default. */
let pushFails: unknown

/** Project actions that record what they were asked and answer with {@link actionAnswer}. */
const actions: ProjectActions = {
  createSynced: async (_input, request: NewProject) => {
    recorded.syncedCreates.push(request)
    await createSyncedAnswer()
  },
  promote: async (_model, row: Row) => {
    recorded.acted.push(['promote', row.dbName])
    await actionAnswer()
  },
  download: async (_model, row: Row) => {
    recorded.acted.push(['download', row.dbName])
    await actionAnswer()
  },
  removeLocalCopy: async (_model, row: Row) => {
    recorded.acted.push(['removeLocal', row.dbName])
    await actionAnswer()
  },
  deleteLocalProject: async (_model, row: Row, typed: string) => {
    recorded.acted.push(['deleteLocal', row.dbName, typed])
    await actionAnswer()
  },
  removeFromServer: async (_model, row: Row) => {
    recorded.acted.push(['removeServer', row.dbName])
    await actionAnswer()
  },
  restore: async (_model, row: Row) => {
    recorded.acted.push(['restore', row.dbName])
    await actionAnswer()
  },
}

beforeEach(() => {
  recorded = {
    created: [],
    updated: [],
    synced: [],
    localCreated: [],
    renamed: [],
    clients: [],
    indexed: [],
    indexedWhileBusy: [],
    navigated: [],
    acted: [],
    syncedCreates: [],
    refreshed: 0,
    sequence: [],
  }
  pushFails = undefined
  actionAnswer = async () => {}
  createSyncedAnswer = async () => {}
  updateFails = undefined
  createAnswer = () => project({ projectId: 'p-new', dbName: 'project_p-new', name: 'Neu' })
  localStorage.removeItem(CURRENT_PROJECT_KEY)
})

afterEach(async () => {
  await activateLocale('en')
  useProjectDatabase(PROJECT_DATABASE_NAME, true)
  localStorage.removeItem(CURRENT_PROJECT_KEY)
})

const api: ProjectsApi = {
  list: async () => [],
  create: async (request) => {
    recorded.created.push(request)
    return createAnswer()
  },
  update: async (projectId, patch) => {
    recorded.updated.push([projectId, patch])
    recorded.sequence.push(`patch:${projectId}`)
    if (updateFails !== undefined) throw updateFails
    return project({
      projectId,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(typeof patch.client === 'string' ? { client: patch.client } : {}),
    })
  },
}

/** The page, signed in and online on the free plan unless told otherwise. */
async function page(input: Partial<ProjectsInput> = {}): Promise<ProjectsView> {
  const full: ProjectsInput = {
    local: [],
    server: [],
    plan: 'free',
    session: 'signed-in',
    online: true,
    syncStates: () => undefined,
    ...input,
  }
  const element = (await fixture(html`
    <projects-view
      .input=${full}
      .api=${api}
      .sync=${{
        set: (projects: readonly SyncableProject[]) => recorded.synced.push(projects),
        pushNow: async (projectId: string) => {
          recorded.sequence.push(`push:${projectId}`)
          if (pushFails !== undefined) throw pushFails
        },
        suspend: () => {},
        resume: () => {},
      }}
      .localProjects=${{
        create: async (request: { name: string; client?: string }) => {
          recorded.localCreated.push(request)
          return entry({ dbName: 'project_local_new', name: request.name })
        },
        rename: async (dbName: string, name: string) => {
          recorded.renamed.push([dbName, name])
        },
        setClient: async (dbName: string, client: string | undefined) => {
          recorded.clients.push([dbName, client])
        },
        indexServerProject: async (indexed: Project) => {
          recorded.indexed.push(indexed)
          recorded.indexedWhileBusy.push(projectActionRunning())
        },
      }}
      .navigate=${(hash: string) => recorded.navigated.push(hash)}
      .actions=${actions}
      .exportProject=${async (row: Row, password?: string) => {
        recorded.acted.push(
          password === undefined ? ['export', row.dbName] : ['export', row.dbName, password],
        )
        await actionAnswer()
      }}
      .refresh=${async () => {
        recorded.refreshed += 1
      }}
    ></projects-view>
  `)) as ProjectsView
  await element.updateComplete
  return element
}

/** The element a selector names, failing loudly when there is none. */
function find<T extends Element = HTMLElement>(element: Element, selector: string): T {
  const found = element.querySelector(selector)
  if (found === null) throw new Error(`Nothing matches ${selector}`)
  return found as T
}

/** Sets a field's value, as typing would. */
function type(element: Element, selector: string, value: string): void {
  ;(find(element, selector) as HTMLElement & { value: string }).value = value
}

/** Clicks, then waits for whatever the click started to render. */
async function click(view: ProjectsView, selector: string, within: Element = view): Promise<void> {
  find(within, selector).click()
  await view.updateComplete
}

/** Waits until an asynchronous action has finished and the page has rendered its result. */
async function settled(view: ProjectsView): Promise<void> {
  await waitUntil(() => !view.busy, 'the action never finished')
  await view.updateComplete
}

/** A field's current value. */
const fieldOf = (container: Element, field: string): unknown =>
  (find(container, `[data-field="${field}"]`) as HTMLElement & { value: unknown }).value

const text = (element: Element | null): string => element?.textContent?.replace(/\s+/g, ' ') ?? ''

describe('the free plan', () => {
  it('asks to create the first project, and creates it on this device', async () => {
    const view = await page()

    expect(text(find(view, '[data-create-card]'))).toContain('Create your project')
    type(view, '[data-create-card] [data-field="name"]', 'Musterstraße 12')
    await click(view, '[data-create-card] [data-create]')
    await settled(view)

    expect(recorded.localCreated).toEqual([{ name: 'Musterstraße 12' }])
    expect(recorded.created).toEqual([])
    expect(recorded.refreshed).toBe(1)
  })

  it('does not create a project without a name', async () => {
    const view = await page()

    await click(view, '[data-create-card] [data-create]')
    await settled(view)

    expect(recorded.localCreated).toEqual([])
    expect(text(view.querySelector('[data-error]'))).toContain('name')
  })

  it('offers to continue with the one project, and to upgrade', async () => {
    const view = await page({ local: [entry()] })

    expect(text(find(view, '[data-open]'))).toContain('Continue with “Alpha”')
    expect(view.querySelector('[data-upgrade-hint]')).not.toBeNull()
    expect(view.querySelector('[data-create-card]')).toBeNull()
  })

  it('keeps the create card beside the project while a larger free limit has room (ADR 0020)', async () => {
    const view = await page({ local: [entry()], reportedLimit: 2 })

    expect(text(find(view, '[data-open]'))).toContain('Continue with “Alpha”')
    expect(view.querySelector('[data-create-card]')).not.toBeNull()
    // "More than one" would be false for a plan of two.
    expect(text(find(view, '[data-upgrade-hint]')).trim()).toBe(
      'Upgrade to keep your projects in sync across devices.',
    )
  })

  it('asks for a name on first run, when the adopted catalogue has none', async () => {
    const view = await page({ local: [entry({ dbName: PROJECT_DATABASE_NAME, name: '' })] })

    expect(text(find(view, '[data-name-project]'))).toContain('Name your project')
    expect(view.querySelector('[data-open]')).toBeNull()
    type(view, '[data-name-project] [data-field="name"]', 'Zuhause')
    await click(view, '[data-name-project] [data-save]')
    await settled(view)

    expect(recorded.renamed).toEqual([[PROJECT_DATABASE_NAME, 'Zuhause']])
    expect(recorded.refreshed).toBe(1)
  })

  it('renames a local project through the pen', async () => {
    const view = await page({ local: [entry()] })

    await click(view, '[data-rename]')
    type(view, '[data-rename-form] [data-field="name"]', 'Gamma')
    await click(view, '[data-rename-form] [data-save]')
    await settled(view)

    expect(recorded.renamed).toEqual([['project_local_a', 'Gamma']])
    expect(recorded.updated).toEqual([])
  })
})

describe('opening a project', () => {
  it('makes it the current project and goes to its devices', async () => {
    const view = await page({ local: [entry()] })

    await click(view, '[data-open]')

    expect(localStorage.getItem(CURRENT_PROJECT_KEY)).toBe('project_local_a')
    expect(currentProjectDatabaseName()).toBe('project_local_a')
    expect(projectIsEditable()).toBe(true)
    expect(recorded.navigated).toEqual(['#/devices'])
  })

  it('remembers a synchronized project by its id', async () => {
    const view = await page({
      plan: 'member',
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project()],
    })

    await click(view, '[data-row="project_p1"] [data-open]')

    expect(localStorage.getItem(CURRENT_PROJECT_KEY)).toBe('p1')
    expect(currentProjectDatabaseName()).toBe('project_p1')
  })

  it('opens a lapsed owner’s server project read-only', async () => {
    // Downgraded to free: the validator would refuse their writes, so edits made here could
    // never leave this device.
    const view = await page({
      plan: 'free',
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project()],
    })

    await click(view, '[data-open]')

    expect(currentProjectDatabaseName()).toBe('project_p1')
    expect(projectIsEditable()).toBe(false)
  })
})

describe('the member plan', () => {
  const member = (input: Partial<ProjectsInput> = {}) =>
    page({ plan: 'member', reportedLimit: 3, ...input })

  it('shows exactly as many rows as the limit, filled ones first', async () => {
    const view = await member({ local: [entry()] })

    expect(view.querySelectorAll('[data-row]')).toHaveLength(1)
    expect(view.querySelectorAll('[data-slot-empty]')).toHaveLength(2)
  })

  it('shows where each project lives and how its sync is doing', async () => {
    const view = await member({
      local: [entry(), entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project()],
      syncStates: (id) => (id === 'p1' ? 'idle' : undefined),
    })

    expect(text(find(view, '[data-row="project_local_a"] [data-location]'))).toContain(
      'On this device',
    )
    expect(text(find(view, '[data-row="project_p1"] [data-location]'))).toContain('Synchronized')
    // The status bar's words: one vocabulary for sync, wherever it is shown.
    expect(text(find(view, '[data-row="project_p1"] [data-sync]')).trim()).toBe('Synced')
    expect(view.querySelector('[data-row="project_local_a"] [data-sync]')).toBeNull()
  })

  it('shows a waiting sync as pending, never as an error', async () => {
    const view = await member({
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project()],
      syncStates: () => 'offline',
    })

    const tag = find(view, '[data-row="project_p1"] [data-sync]')
    expect(text(tag).trim()).toBe('Sync pending')
    expect(tag.getAttribute('variant')).toBe('warning')
  })

  it('creates a synchronized project through the actions: born here, then promoted (#326)', async () => {
    const view = await member({
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project()],
    })

    const slot = find(view, '[data-slot-empty]')
    type(slot, '[data-field="name"]', 'Neu')
    await click(view, '[data-create]', slot)
    await settled(view)

    expect(recorded.syncedCreates).toEqual([{ name: 'Neu' }])
    // No direct `POST /projects`: the only way to the server is the promotion, which carries
    // the escrow wrap.
    expect(recorded.created).toEqual([])
    expect(recorded.localCreated).toEqual([])
    // The actions re-read the page themselves; the page does not ask twice.
    expect(recorded.refreshed).toBe(0)
    // The slot is reused for the next render; it must not still hold the name just created.
    expect(fieldOf(find(view, '[data-slot-empty]'), 'name')).toBe('')
  })

  it('says a project kept on this device was created, and why it is not on the server (#326)', async () => {
    createSyncedAnswer = async () => {
      throw new CreatedLocallyError(
        entry({ dbName: 'project_local_new', name: 'Neu' }),
        new ProjectCreationError('escrow-unavailable'),
      )
    }
    const view = await member()

    const slot = find(view, '[data-slot-empty]')
    type(slot, '[data-field="name"]', 'Neu')
    await click(view, '[data-create]', slot)
    await settled(view)

    const said = text(find(view, '[data-error]'))
    expect(said).toContain('Created on this device only.')
    expect(said).toContain('The server cannot accept encrypted projects yet.')
    // It exists, so the form does not offer to create it a second time.
    expect(fieldOf(find(view, '[data-slot-empty]'), 'name')).toBe('')
  })

  it('says a promotion cut short in its own words, without claiming the project is only here', async () => {
    createSyncedAnswer = async () => {
      throw new CreatedLocallyError(entry(), new ProjectActionError('unpushed'))
    }
    const view = await member()

    const slot = find(view, '[data-slot-empty]')
    type(slot, '[data-field="name"]', 'Neu')
    await click(view, '[data-create]', slot)
    await settled(view)

    const said = text(find(view, '[data-error]'))
    expect(said).toContain('Not everything could be uploaded')
    expect(said).not.toContain('Created on this device only.')
  })

  it('says a refused sync plainly; an archived copy is only on this device now', async () => {
    const view = await member({
      local: [
        entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' }),
        entry({ dbName: 'project_p2', name: 'Gamma', projectId: 'p2' }),
      ],
      server: [project(), project({ projectId: 'p2', dbName: 'project_p2', archived: true })],
      syncStates: () => 'denied',
    })

    const denied = find(view, '[data-row="project_p1"] [data-sync]')
    expect(text(denied).trim()).toBe('No permission to sync')
    expect(denied.getAttribute('variant')).toBe('danger')
    // The server took the archived project away: what is left is this device's copy, with no
    // sync to report on.
    expect(view.querySelector('[data-row="project_p2"] [data-sync]')).toBeNull()
    expect(text(find(view, '[data-row="project_p2"] [data-location]'))).toContain('On this device')
  })

  it('creates on this device when offline', async () => {
    const view = await member({ online: false, server: [], serverStale: true })

    const slot = find(view, '[data-slot-empty]')
    type(slot, '[data-field="name"]', 'Neu')
    await click(view, '[data-create]', slot)
    await settled(view)

    expect(recorded.localCreated).toEqual([{ name: 'Neu' }])
    expect(recorded.created).toEqual([])
  })

  it('says why nothing was created when it is refused before the local creation', async () => {
    createSyncedAnswer = async () => {
      throw new ProjectCreationError('offline')
    }
    const view = await member()

    const slot = find(view, '[data-slot-empty]')
    type(slot, '[data-field="name"]', 'Neu')
    await click(view, '[data-create]', slot)
    await settled(view)

    expect(text(find(view, '[data-error]'))).toContain('Needs a connection')
    expect(recorded.refreshed).toBe(0)
    // Nothing was created, so what was typed is kept for the next attempt.
    expect(fieldOf(find(view, '[data-slot-empty]'), 'name')).toBe('Neu')
  })

  it('renames a server project on the server, and updates its listing here', async () => {
    const view = await member({
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project()],
    })

    await click(view, '[data-row="project_p1"] [data-rename]')
    type(view, '[data-rename-form] [data-field="name"]', 'Gamma')
    await click(view, '[data-rename-form] [data-save]')
    await settled(view)

    expect(recorded.updated).toEqual([['p1', { name: 'Gamma' }]])
    expect(recorded.indexed).toEqual([expect.objectContaining({ projectId: 'p1', name: 'Gamma' })])
    expect(recorded.renamed).toEqual([])
    expect(recorded.refreshed).toBe(1)
  })

  it('does not save a rename the model refuses since the form opened', async () => {
    const view = await member({
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project()],
    })

    await click(view, '[data-row="project_p1"] [data-rename]')
    // The owner hands the project on while the form is open: the reader may now only write.
    view.input = {
      ...view.input,
      server: [project({ role: 'write', owner: { ownerType: 'user', ownerId: 'them' } })],
    }
    await view.updateComplete
    type(view, '[data-rename-form] [data-field="name"]', 'Gamma')
    await click(view, '[data-rename-form] [data-save]')
    await settled(view)

    expect(recorded.updated).toEqual([])
  })

  it('says over the limit why nothing can be created, and keeps everything listed', async () => {
    const view = await member({
      reportedLimit: 1,
      local: [entry(), entry({ dbName: 'project_local_b', name: 'Bravo' })],
    })

    // Two counts, never "allows 1 projects".
    expect(text(find(view, '[data-over-limit]'))).toContain('Projects your plan allows: 1')
    expect(view.querySelectorAll('[data-row]')).toHaveLength(2)
    expect(view.querySelectorAll('[data-slot-empty]')).toHaveLength(0)
  })
})

describe('the pro plan', () => {
  const pro = (input: Partial<ProjectsInput> = {}) => page({ plan: 'pro', ...input })
  const names = (view: ProjectsView): string[] =>
    [...view.querySelectorAll('[data-row] [data-name]')].map((cell) => text(cell).trim())

  it('lists projects in a table with name, client, location, sync and actions', async () => {
    const view = await pro({ local: [entry({ client: 'Acme' })] })

    const headers = [...view.querySelectorAll('table th')].map((th) => text(th).trim())
    expect(headers).toEqual(['Name', 'Client', 'Location', 'Sync', 'Actions'])
    expect(text(find(view, '[data-row="project_local_a"] [data-client]'))).toContain('Acme')
  })

  it('sorts by name and by client, both ways', async () => {
    const view = await pro({
      local: [
        entry({ dbName: 'project_local_a', name: 'Alpha', client: 'Zeta' }),
        entry({ dbName: 'project_local_b', name: 'Bravo', client: 'Acme' }),
      ],
    })
    expect(names(view)).toEqual(['Alpha', 'Bravo'])

    await click(view, '[data-sort="name"]')
    expect(names(view)).toEqual(['Bravo', 'Alpha'])

    await click(view, '[data-sort="client"]')
    expect(names(view)).toEqual(['Bravo', 'Alpha'])
    expect(find(view, 'th[aria-sort="ascending"]').textContent).toContain('Client')
  })

  it('adds a project with a client through a dialog', async () => {
    const view = await pro()

    await click(view, '[data-add-project]')
    const dialog = find(view, '[data-add-dialog]')
    expect(dialog.hasAttribute('open')).toBe(true)
    type(dialog, '[data-field="name"]', 'Neu')
    type(dialog, '[data-field="client"]', 'Acme')
    await click(view, '[data-create]', dialog)
    await settled(view)

    expect(recorded.syncedCreates).toEqual([{ name: 'Neu', client: 'Acme' }])
    expect(view.querySelector('[data-add-dialog][open]')).toBeNull()

    // Opened again, it must not offer to create the same project a second time.
    await click(view, '[data-add-project]')
    expect(fieldOf(dialog, 'name')).toBe('')
    expect(fieldOf(dialog, 'client')).toBe('')
  })

  it('closes the dialog on a project kept on this device, and says so on the page (#326)', async () => {
    createSyncedAnswer = async () => {
      throw new CreatedLocallyError(entry(), new ProjectCreationError('escrow-unavailable'))
    }
    const view = await pro()

    await click(view, '[data-add-project]')
    const dialog = find(view, '[data-add-dialog]')
    type(dialog, '[data-field="name"]', 'Neu')
    await click(view, '[data-create]', dialog)
    await settled(view)

    expect(view.querySelector('[data-add-dialog][open]')).toBeNull()
    expect(text(find(view, '[data-error]'))).toContain('Created on this device only.')
  })

  it('edits name and client of a local project with the pen', async () => {
    const view = await pro({ local: [entry({ client: 'Acme' })] })

    await click(view, '[data-rename]')
    type(view, '[data-rename-form] [data-field="client"]', 'Beta GmbH')
    await click(view, '[data-rename-form] [data-save]')
    await settled(view)

    expect(recorded.clients).toEqual([['project_local_a', 'Beta GmbH']])
    // The name did not change, so it is not written.
    expect(recorded.renamed).toEqual([])
  })

  it('clears a server project’s client with null', async () => {
    const view = await pro({
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project({ client: 'Acme' })],
    })

    await click(view, '[data-rename]')
    type(view, '[data-rename-form] [data-field="client"]', '')
    await click(view, '[data-rename-form] [data-save]')
    await settled(view)

    expect(recorded.updated).toEqual([['p1', { client: null }]])
  })
})

describe('every plan', () => {
  it('limits names and clients to the contract’s 200 characters', async () => {
    const fields = (view: Element) => [
      ...view.querySelectorAll('[data-field="name"], [data-field="client"]'),
    ]
    const free = await page()
    const member = await page({ plan: 'member', reportedLimit: 3 })
    const pro = await page({ plan: 'pro', reportedLimit: -1, local: [entry()] })
    await click(pro, '[data-rename]', find(pro, '[data-row="project_local_a"]'))

    const all = [...fields(free), ...fields(member), ...fields(pro)]
    expect(all.length).toBeGreaterThanOrEqual(6)
    for (const field of all) expect(field.getAttribute('maxlength')).toBe('200')
  })

  it('gives an unlimited member limit one empty row, not none (ADR 0020)', async () => {
    const view = await page({ plan: 'member', reportedLimit: -1, local: [entry()] })

    expect(view.querySelectorAll('[data-slot-empty]')).toHaveLength(1)
  })

  it('lists projects shared with the reader separately', async () => {
    const view = await page({
      plan: 'member',
      reportedLimit: 5,
      server: [project({ projectId: 'p2', dbName: 'project_p2', name: 'Theirs', role: 'write' })],
    })

    expect(text(find(view, '[data-shared]'))).toContain('Shared with me')
    expect(view.querySelector('[data-shared] [data-row="project_p2"]')).not.toBeNull()
    expect(view.querySelectorAll('[data-slot-empty]')).toHaveLength(5)
  })

  it('leaves out the pen, and says nothing, where the role never allows renaming', async () => {
    const view = await page({
      plan: 'member',
      local: [entry({ dbName: 'project_p2', name: 'Theirs', projectId: 'p2' })],
      server: [project({ projectId: 'p2', dbName: 'project_p2', name: 'Theirs', role: 'write' })],
    })

    const row = find(view, '[data-row="project_p2"]')
    expect(row.querySelector('[data-rename]')).toBeNull()
    expect(row.querySelector('[data-note]')).toBeNull()
    expect(text(row)).not.toContain('Only the owner or a manager can change this')
  })

  it('states the table roles, which survive the phone layout', async () => {
    const view = await page({
      plan: 'pro',
      local: [entry()],
      server: [project({ projectId: 'p2', dbName: 'project_p2', name: 'Remote' })],
    })

    const table = find(view, 'table')
    expect(table.getAttribute('role')).toBe('table')
    expect([...table.querySelectorAll('thead, tbody')].map((g) => g.getAttribute('role'))).toEqual([
      'rowgroup',
      'rowgroup',
    ])
    for (const row of table.querySelectorAll('tr')) expect(row.getAttribute('role')).toBe('row')
    for (const head of table.querySelectorAll('th')) {
      expect(head.getAttribute('role')).toBe('columnheader')
    }
    const cells = [...find(view, 'tr[data-row="project_local_a"]').children]
    expect(cells.map((cell) => cell.getAttribute('role'))).toEqual(Array(5).fill('cell'))
    expect(cells.map((cell) => cell.className.match(/app-cell-\w+/)?.[0])).toEqual([
      'app-cell-name',
      'app-cell-client',
      'app-cell-location',
      'app-cell-sync',
      'app-cell-actions',
    ])
  })

  it('signed out on the free plan, says to sign in and disables the create card', async () => {
    const view = await page({ session: 'signed-out', server: undefined })

    expect(text(find(view, '[data-hint="signed-out"]'))).toContain('Sign in to sync')
    const create = find(view, '[data-create-card] [data-create]') as HTMLElement & {
      disabled: boolean
    }
    expect(create.disabled).toBe(true)
  })

  it('says nothing about signing in while the session is still being checked', async () => {
    const view = await page({ session: 'checking', server: undefined })

    expect(view.querySelector('[data-hint="signed-out"]')).toBeNull()
  })

  it('signed out, says to sign in and disables creation', async () => {
    const view = await page({ plan: 'member', session: 'signed-out', server: undefined })

    expect(text(find(view, '[data-hint="signed-out"]'))).toContain('Sign in to sync')
    const create = find(view, '[data-slot-empty] [data-create]') as HTMLElement & {
      disabled: boolean
    }
    expect(create.disabled).toBe(true)
  })

  it('offline, says what needs a connection and what cannot be opened', async () => {
    const view = await page({
      plan: 'member',
      online: false,
      serverStale: true,
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project(), project({ projectId: 'p3', dbName: 'project_p3', name: 'Remote' })],
    })

    const remote = find(view, '[data-row="project_p3"]')
    expect(remote.querySelector('[data-open]')).toBeNull()
    expect(text(remote)).toContain('Not available offline')
    // Renaming comes back with the connection: the pen stays, disabled, with its reason on it
    // rather than as a sentence on the row.
    const pen = find(view, '[data-row="project_p1"] [data-rename]')
    expect(pen.hasAttribute('disabled')).toBe(true)
    expect(pen.getAttribute('title')).toBe('Needs a connection')
    expect(view.querySelector('[data-row="project_p1"] [data-note]')).toBeNull()
  })

  it('speaks German', async () => {
    await activateLocale('de')
    const view = await page()

    const said = text(find(view, '[data-create-card]'))
    expect(said).toContain('Ihr Projekt')
    expect(said).not.toContain('Create your project')
  })
})

describe('what a project is, and what the plan allows', () => {
  it('explains the project and the free allowance, kept on this device', async () => {
    const view = await page()

    const said = text(find(view, '[data-projects-intro]'))
    expect(said).toContain('A project holds the rooms and Matter devices of one home or site.')
    expect(said).toContain('Projects your plan includes: 1, kept on this device.')
  })

  it('states the allowance from the limit in force', async () => {
    const view = await page({ plan: 'member', reportedLimit: 3 })

    expect(text(find(view, '[data-projects-intro]'))).toContain('Projects your plan includes: 3.')
  })

  it('states an unlimited allowance in words, not a number', async () => {
    const view = await page({ plan: 'pro', reportedLimit: -1 })

    expect(text(find(view, '[data-projects-intro]'))).toContain('Your plan has no project limit.')
  })

  it('states a legacy allowance beside what the plan includes today (ADR 0020)', async () => {
    const view = await page({ plan: 'member', reportedLimit: 5, reportedPlanLimit: 3 })

    expect(text(find(view, '[data-projects-intro]'))).toContain(
      'Projects your plan includes: 3. Yours: 5 (legacy plan).',
    )
  })

  it('assumes one project, not the plan, until the server reports a limit', async () => {
    const view = await page({ plan: 'pro' })

    expect(text(find(view, '[data-projects-intro]'))).toContain('Projects your plan includes: 1.')
  })

  it('speaks German', async () => {
    await activateLocale('de')
    const view = await page()

    const said = text(find(view, '[data-projects-intro]'))
    expect(said).toContain('Ein Projekt')
    expect(said).not.toContain('A project')
  })
})

describe('the actions menu', () => {
  const member = (input: Partial<ProjectsInput> = {}) =>
    page({ plan: 'member', reportedLimit: 3, ...input })
  const synced = entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })

  /** The menu item for one action on one row. */
  const item = (view: ProjectsView, key: string, action: string) =>
    find<HTMLElement & { disabled: boolean }>(view, `[data-row="${key}"] [data-action="${action}"]`)

  /** Chooses an action from a row's menu, as clicking its item does. */
  async function choose(view: ProjectsView, key: string, action: string): Promise<void> {
    item(view, key, action).click()
    await view.updateComplete
  }

  /** The open confirmation dialog. */
  const dialog = (view: ProjectsView) => find(view, '[data-confirm-dialog][open]')

  it('offers only what applies to each row, and says why a refused one is refused', async () => {
    const view = await member({ local: [entry(), synced], server: [project()], online: true })

    expect(
      view.querySelector('[data-row="project_local_a"] [data-action="promote"]'),
    ).not.toBeNull()
    expect(
      view.querySelector('[data-row="project_local_a"] [data-action="deleteLocal"]'),
    ).not.toBeNull()
    expect(
      view.querySelector('[data-row="project_local_a"] [data-action="removeLocal"]'),
    ).toBeNull()
    expect(view.querySelector('[data-row="project_p1"] [data-action="removeLocal"]')).not.toBeNull()
    expect(
      view.querySelector('[data-row="project_p1"] [data-action="removeServer"]'),
    ).not.toBeNull()
    expect(view.querySelector('[data-row="project_p1"] [data-action="promote"]')).toBeNull()

    const offline = await member({
      local: [entry()],
      server: [project({ projectId: 'p3', dbName: 'project_p3', name: 'Remote' })],
      online: false,
      serverStale: true,
    })
    expect(item(offline, 'project_local_a', 'promote').disabled).toBe(true)
    expect(text(item(offline, 'project_local_a', 'promote'))).toContain('Needs a connection')
    expect(item(offline, 'project_p3', 'download').disabled).toBe(true)
  })

  it('separates the removals from the safe actions with a divider', async () => {
    const view = await member({ local: [entry(), synced], server: [project()], online: true })

    /** A row's menu, in order, with `divider` where one sits. */
    const menu = (key: string) =>
      [...find(view, `[data-row="${key}"] [data-actions]`).children]
        .map((child) =>
          child.localName === 'wa-divider' ? 'divider' : child.getAttribute('data-action'),
        )
        .filter((c) => c !== null)

    // The safe actions, then the removals: one divider, right before the first removal.
    expect(menu('project_local_a')).toEqual(['promote', 'export', 'divider', 'deleteLocal'])
    expect(menu('project_p1')).toEqual(['export', 'divider', 'removeLocal', 'removeServer'])
  })

  it('starts a removal confirmation on Cancel, and a delete on the name field', async () => {
    const view = await member({ local: [entry(), synced], server: [project()] })

    await choose(view, 'project_p1', 'removeLocal')
    expect(find(view, '[data-cancel-confirm]').hasAttribute('autofocus')).toBe(true)
    await click(view, '[data-cancel-confirm]', dialog(view))
    await view.updateComplete

    await choose(view, 'project_local_a', 'deleteLocal')
    expect(find(view, '[data-cancel-confirm]').hasAttribute('autofocus')).toBe(false)
    expect(find(view, '[data-field="confirm-name"]').hasAttribute('autofocus')).toBe(true)
  })

  it('promotes and downloads straight from the menu', async () => {
    const view = await member({
      local: [entry()],
      server: [project({ projectId: 'p3', dbName: 'project_p3', name: 'Remote' })],
    })

    await choose(view, 'project_local_a', 'promote')
    await settled(view)
    await choose(view, 'project_p3', 'download')
    await settled(view)

    expect(recorded.acted).toEqual([
      ['promote', 'project_local_a'],
      ['download', 'project_p3'],
    ])
  })

  it('confirms removing a local copy, saying the server keeps it', async () => {
    const view = await member({ local: [synced], server: [project()] })

    await choose(view, 'project_p1', 'removeLocal')
    expect(text(dialog(view))).toContain(
      'The server keeps it. Changes not yet uploaded are uploaded first.',
    )
    expect(recorded.acted).toEqual([])
    await click(view, '[data-confirm]', dialog(view))
    await settled(view)

    expect(recorded.acted).toEqual([['removeLocal', 'project_p1']])
    expect(view.querySelector('[data-confirm-dialog][open]')).toBeNull()
  })

  it('offers Export on every row with a copy here, warning that it holds the setup codes', async () => {
    const view = await member({
      local: [entry(), synced],
      server: [project(), project({ projectId: 'p3', dbName: 'project_p3', name: 'Remote' })],
    })

    for (const key of ['project_local_a', 'project_p1']) {
      expect(text(item(view, key, 'export'))).toContain('Export project')
      expect(item(view, key, 'export').disabled).toBe(false)
      expect(
        text(find(view, `[data-row="${key}"] [data-action="export"] [data-export-warning]`)),
      ).toContain('Contains the setup codes. Keep it safe.')
    }
    // Only on the server: nothing here to export.
    expect(view.querySelector('[data-row="project_p3"] [data-action="export"]')).toBeNull()
  })

  it('offers Export offline and signed out too, since it reads only this device', async () => {
    const view = await member({
      local: [synced],
      server: [project()],
      online: false,
      serverStale: true,
      session: 'signed-out',
    })

    expect(item(view, 'project_p1', 'export').disabled).toBe(false)
  })

  /**
   * Chooses Export on a row and answers its dialog: plainly, or with `password` typed twice.
   * Resolves once the dialog has handed over; the export may still be running.
   */
  async function exportVia(view: ProjectsView, key: string, password?: string): Promise<void> {
    await choose(view, key, 'export')
    const exportDialog = find(view, 'project-export-dialog') as HTMLElement & {
      updateComplete: Promise<boolean>
    }
    if (password !== undefined) {
      const box = find<HTMLElement & { checked: boolean }>(exportDialog, '[data-field="protect"]')
      box.checked = true
      box.dispatchEvent(new Event('change', { bubbles: true }))
      await exportDialog.updateComplete
      for (const field of ['password', 'confirm-password']) {
        type(exportDialog, `[data-field="${field}"]`, password)
        find(exportDialog, `[data-field="${field}"]`).dispatchEvent(
          new Event('input', { bubbles: true }),
        )
      }
      await exportDialog.updateComplete
    }
    find(exportDialog, '[data-confirm-export]').click()
    await view.updateComplete
  }

  it('asks how to export the row it was chosen on, then exports it plain', async () => {
    const view = await member({ local: [entry(), synced], server: [project()] })

    await choose(view, 'project_p1', 'export')
    expect(view.querySelector('[data-confirm-dialog][open]')).toBeNull()
    expect(view.querySelector('[data-export-dialog][open]')).not.toBeNull()
    expect(text(find(view, '[data-export-dialog]'))).toContain('“Beta”')
    expect(recorded.acted).toEqual([])

    find(view, '[data-confirm-export]').click()
    await settled(view)

    expect(recorded.acted).toEqual([['export', 'project_p1']])
    expect(view.querySelector('[data-export-dialog][open]')).toBeNull()
    expect(view.querySelector('[data-error]')).toBeNull()
  })

  it('hands the password to the export when one is chosen (#307)', async () => {
    const view = await member({ local: [entry()] })

    await exportVia(view, 'project_local_a', 'a long enough password')
    await settled(view)

    expect(recorded.acted).toEqual([['export', 'project_local_a', 'a long enough password']])
    expect(view.exporting).toBeUndefined()
  })

  it('exports nothing when the dialog is cancelled', async () => {
    const view = await member({ local: [entry()] })

    await choose(view, 'project_local_a', 'export')
    find(view, '[data-cancel-export]').click()
    await view.updateComplete

    expect(view.exporting).toBeUndefined()
    expect(view.busy).toBe(false)
    expect(recorded.acted).toEqual([])
  })

  it('holds the page busy while exporting', async () => {
    let finish: () => void = () => {}
    actionAnswer = () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
    const view = await member({ local: [entry()] })

    await exportVia(view, 'project_local_a')
    expect(view.busy).toBe(true)
    finish()
    await settled(view)
  })

  it('says so when the export fails', async () => {
    actionAnswer = async () => {
      throw new Error('storage refused the read')
    }
    const view = await member({ local: [entry()] })

    await exportVia(view, 'project_local_a')
    await settled(view)

    expect(text(find(view, '[data-error]'))).toContain('That did not work. Please try again.')
  })

  it('says the project is too large, rather than offering a file the import would refuse', async () => {
    actionAnswer = async () => {
      throw new ZipError('tooLarge', 'x')
    }
    const view = await member({ local: [entry()] })

    await exportVia(view, 'project_local_a')
    await settled(view)

    expect(text(find(view, '[data-error]'))).toContain(
      'This project is too large to export as one file. Nothing was downloaded.',
    )
  })

  it('says a locked project can be exported after the next sync, not that it failed', async () => {
    // #303: the archive is plaintext and a locked read has no codes, so the export refuses.
    actionAnswer = async () => {
      throw new ProjectLockedError('exporting')
    }
    const view = await member({ local: [entry()] })

    await exportVia(view, 'project_local_a')
    await settled(view)

    const said = text(find(view, '[data-error]'))
    expect(said).toContain('it can be exported after the next sync. Nothing was downloaded.')
    expect(said).not.toContain('try again')
  })

  it('says why a local copy was kept when the upload did not get through', async () => {
    actionAnswer = async () => {
      throw new ProjectActionError('unpushed')
    }
    const view = await member({ local: [synced], server: [project()] })

    await choose(view, 'project_p1', 'removeLocal')
    await click(view, '[data-confirm]', dialog(view))
    await settled(view)

    expect(text(find(view, '[data-error]'))).toContain('Not everything could be uploaded')
  })

  it('deletes a local-only project only once its exact name is typed', async () => {
    const view = await member({ local: [entry()] })

    await choose(view, 'project_local_a', 'deleteLocal')
    const confirm = find<HTMLElement & { disabled: boolean }>(dialog(view), '[data-confirm]')
    expect(confirm.disabled).toBe(true)

    const field = find<HTMLElement & { value: string }>(dialog(view), '[data-field="confirm-name"]')
    field.value = 'alpha'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await view.updateComplete
    expect(confirm.disabled).toBe(true)

    field.value = 'Alpha'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await view.updateComplete
    expect(confirm.disabled).toBe(false)

    await click(view, '[data-confirm]', dialog(view))
    await settled(view)
    expect(recorded.acted).toEqual([['deleteLocal', 'project_local_a', 'Alpha']])
  })

  it('warns harder when an orphan copy may hold changes that never left', async () => {
    const view = await member({ local: [synced], server: [] })

    await choose(view, 'project_p1', 'deleteLocal')

    expect(text(dialog(view))).toContain('Changes not yet uploaded will be lost')
  })

  it('says the server project stays when deleting a half-done promotion', async () => {
    const halfway = entry({ projectId: 'p1' })
    const view = await member({ local: [halfway], server: [project()] })

    await choose(view, 'project_local_a', 'deleteLocal')

    expect(dialog(view).querySelector('[data-server-stays]')).not.toBeNull()
    expect(dialog(view).querySelector('[data-warn]')).toBeNull()
  })

  it('promises no server project when the list no longer names the recorded one', async () => {
    // Archived, deleted or no longer the caller's: there is nothing on the server that stays.
    const halfway = entry({ projectId: 'p1' })
    const view = await member({ local: [halfway], server: [] })

    await choose(view, 'project_local_a', 'deleteLocal')

    expect(dialog(view).querySelector('[data-server-stays]')).toBeNull()
  })

  it('warns that an archived project’s copy may hold changes that never left', async () => {
    const view = await member({ local: [synced], server: [project({ archived: true })] })

    await choose(view, 'project_p1', 'deleteLocal')

    expect(text(dialog(view))).toContain('was removed from the server')
  })

  it('confirms removing from the server, saying collaborators lose access', async () => {
    const view = await member({ local: [synced], server: [project()] })

    await choose(view, 'project_p1', 'removeServer')
    expect(text(dialog(view))).toContain(
      'Collaborators lose access. Your copy on this device stays editable, and you can put it back on the server within 90 days. After that, the server deletes it.',
    )
    await click(view, '[data-confirm]', dialog(view))
    await settled(view)

    expect(recorded.acted).toEqual([['removeServer', 'project_p1']])
  })

  it('puts a removed project back straight from the menu, above the removals', async () => {
    const view = await member({ local: [synced], server: [project({ archived: true })] })

    const menu = find(view, '[data-row="project_p1"] [data-actions]')
    const children = [...menu.children].map((child) =>
      child.localName === 'wa-divider' ? 'divider' : child.getAttribute('data-action'),
    )
    expect(children.filter((c) => c !== null)).toEqual([
      'restore',
      'export',
      'divider',
      'deleteLocal',
    ])
    expect(text(item(view, 'project_p1', 'restore'))).toContain('Put back on the server')

    // Nothing is lost by it, so nothing is asked first.
    await choose(view, 'project_p1', 'restore')
    expect(view.querySelector('[data-confirm-dialog][open]')).toBeNull()
    await settled(view)

    expect(recorded.acted).toEqual([['restore', 'project_p1']])
  })

  it('says why the server would not put a project back', async () => {
    actionAnswer = async () => {
      throw new ProjectUpdateError('project-limit-reached')
    }
    const view = await member({ local: [synced], server: [project({ archived: true })] })

    await choose(view, 'project_p1', 'restore')
    await settled(view)

    expect(text(find(view, '[data-error]'))).toContain('Your plan has no room for another project')
  })

  it('says why a project cannot be put back while the plan has no room', async () => {
    const view = await member({
      local: [synced],
      server: [project({ archived: true }), project({ projectId: 'p2', dbName: 'project_p2' })],
      reportedLimit: 1,
    })

    expect(item(view, 'project_p1', 'restore').disabled).toBe(true)
    expect(text(item(view, 'project_p1', 'restore'))).toContain(
      'Your plan has no room for another project',
    )
  })

  it('disables every action while one runs', async () => {
    let finish = () => {}
    actionAnswer = () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
    const view = await member({ local: [entry(), synced], server: [project()] })

    await choose(view, 'project_local_a', 'promote')

    expect(view.busy).toBe(true)
    expect(item(view, 'project_local_a', 'promote').disabled).toBe(true)
    expect(item(view, 'project_p1', 'removeServer').disabled).toBe(true)
    await choose(view, 'project_local_a', 'promote')
    expect(recorded.acted).toHaveLength(1)

    finish()
    await settled(view)
    expect(item(view, 'project_local_a', 'promote').disabled).toBe(false)
  })

  it('gives the free plan’s card no sync controls: the upgrade hint covers them', async () => {
    // Ruling C-R14.
    const view = await page({ local: [entry()] })

    expect(view.querySelector('[data-row="project_local_a"] [data-action="promote"]')).toBeNull()
    expect(view.querySelector('[data-row="project_local_a"] [data-action="download"]')).toBeNull()
    expect(item(view, 'project_local_a', 'deleteLocal').disabled).toBe(false)
    expect(view.querySelector('[data-upgrade-hint]')).not.toBeNull()

    // Nor a way back to the server for a removed project's copy.
    const removed = await page({ local: [synced], server: [project({ archived: true })] })
    expect(removed.querySelector('[data-row="project_p1"] [data-action="restore"]')).toBeNull()
    expect(item(removed, 'project_p1', 'deleteLocal').disabled).toBe(false)
  })

  it('says only the owner can remove a shared project from the server', async () => {
    // Ruling C-R13: a manager may rename, but not remove.
    const shared = project({ role: 'manage', owner: { ownerType: 'user', ownerId: 'them' } })
    const view = await member({ server: [shared] })

    expect(item(view, 'project_p1', 'removeServer').disabled).toBe(true)
    expect(text(item(view, 'project_p1', 'removeServer'))).toContain(
      'Only the owner can remove this from the server',
    )
  })

  it('says the project changed when its row is gone by the time it is confirmed', async () => {
    const view = await member({ local: [synced], server: [project()] })
    await choose(view, 'project_p1', 'removeLocal')

    view.input = { ...view.input, local: [], server: [] }
    await view.updateComplete
    await click(view, '[data-confirm]', dialog(view))
    await settled(view)

    expect(recorded.acted).toEqual([])
    expect(text(find(view, '[data-error]'))).toContain('This project changed — try again')
  })

  it('speaks German in its confirmations', async () => {
    await activateLocale('de')
    const view = await member({ local: [synced], server: [project()] })

    await choose(view, 'project_p1', 'removeServer')

    expect(text(dialog(view))).not.toContain('Collaborators lose access')

    const removed = await member({ local: [synced], server: [project({ archived: true })] })
    expect(text(item(removed, 'project_p1', 'restore'))).toContain('Wieder auf den Server stellen')
  })
})

describe('the read-only grace after a downgrade (#211, #284)', () => {
  // Noon UTC, so the date is the same in every time zone a test browser might run in.
  const GRACE = 1_793_016_000 // 2026-10-26
  const DELETE = 1_797_768_000 // 2026-12-20

  /** Over a member limit of one: Beta kept writable, Gamma read-only, both downloaded. */
  const overInput = (over: Partial<ProjectsInput> = {}): Partial<ProjectsInput> => ({
    plan: 'member',
    reportedLimit: 1,
    local: [
      entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' }),
      entry({ dbName: 'project_p2', name: 'Gamma', projectId: 'p2' }),
    ],
    server: [
      project(),
      project({
        projectId: 'p2',
        dbName: 'project_p2',
        name: 'Gamma',
        readOnly: true,
        graceUntil: GRACE,
      }),
    ],
    syncStates: () => 'idle',
    ...over,
  })

  const item = (view: ProjectsView, key: string, action: string) =>
    view.querySelector<HTMLElement & { disabled: boolean }>(
      `[data-row="${key}"] [data-action="${action}"]`,
    )

  async function choose(view: ProjectsView, key: string, action: string): Promise<void> {
    const found = item(view, key, action)
    if (found === null) throw new Error(`no ${action} on ${key}`)
    found.click()
    await view.updateComplete
  }

  it('marks a read-only row, and says why, until when and how to restore it', async () => {
    const view = await page(overInput())

    const tag = find(view, '[data-row="project_p2"] [data-lifecycle="read-only"]')
    expect(text(tag)).toContain('Read-only')
    expect(tag.querySelector('wa-icon[name="lock"]')).not.toBeNull()
    const tip = text(find(view, '[data-row="project_p2"] [data-lifecycle-tip]'))
    expect(tip).toContain('over your plan’s project limit')
    expect(tip).toContain('Oct 26, 2026')
    expect(tip).toContain('Upgrade')
    // The writable row carries no mark.
    expect(view.querySelector('[data-row="project_p1"] [data-lifecycle]')).toBeNull()
  })

  it('says page-wide which projects are read-only, until when, and both ways out', async () => {
    const view = await page(overInput())

    const callout = text(find(view, '[data-grace]'))
    expect(callout).toContain('read-only until Oct 26, 2026')
    expect(callout).toContain('Upgrade')
    // Instead of the plain over-limit sentence, which says everything stays usable.
    expect(view.querySelector('[data-over-limit]')).toBeNull()
  })

  it('points to the menu only where the menu offers the swap: not on the free card', async () => {
    // The free card hides "Keep this one active" and "Make read-only" (C-R14), and on a plan
    // with no synchronized projects archiving frees no writable slot: upgrading is the way back.
    const freeView = await page(overInput({ plan: 'free' }))
    const free = text(find(freeView, '[data-grace]'))
    expect(free).toContain('Upgrade')
    expect(free).not.toContain('menu')
    // The row's own explanation names no hidden action either.
    const freeTip = text(find(freeView, '[data-row="project_p2"] [data-lifecycle-tip]'))
    expect(freeTip).toContain('Upgrade')
    expect(freeTip).not.toContain('Keep this one active')

    const memberView = await page(overInput())
    expect(text(find(memberView, '[data-grace]'))).toContain('menu')
    expect(text(find(memberView, '[data-row="project_p2"] [data-lifecycle-tip]'))).toContain(
      'Keep this one active',
    )
  })

  it('marks an auto-archived row with its deletion date and the upgrade that restores it', async () => {
    const view = await page(
      overInput({
        local: [],
        server: [
          project({
            projectId: 'p3',
            dbName: 'project_p3',
            name: 'Delta',
            archived: true,
            autoArchived: true,
            deleteAfter: DELETE,
          }),
        ],
        reportedLimit: 3,
      }),
    )

    const tag = find(view, '[data-row="project_p3"] [data-lifecycle="auto-archived"]')
    expect(text(tag)).toContain('Archived by plan')
    const tip = text(find(view, '[data-row="project_p3"] [data-lifecycle-tip]'))
    expect(tip).toContain('Dec 20, 2026')
    expect(tip).toContain('Upgrading brings it back')
    // Nothing to open or act on: the row explains, an upgrade restores.
    expect(view.querySelector('[data-row="project_p3"] [data-open]')).toBeNull()
    expect(view.querySelector('[data-row="project_p3"] [data-actions]')).toBeNull()
  })

  it('leaves the owner’s own archive as it was', async () => {
    const view = await page({
      plan: 'member',
      reportedLimit: 3,
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project({ archived: true })],
    })

    expect(view.querySelector('[data-lifecycle]')).toBeNull()
    expect(view.querySelector('[data-grace]')).toBeNull()
    expect(text(item(view, 'project_p1', 'restore'))).toContain('Put back on the server')
  })

  it('keeps a read-only project active from its menu, then reads the list again', async () => {
    const view = await page(overInput())

    await choose(view, 'project_p2', 'keepActive')
    await settled(view)

    expect(recorded.updated).toEqual([['p2', { readOnly: false }]])
    expect(recorded.refreshed).toBe(1)
    expect(view.querySelector('[data-error]')).toBeNull()
  })

  it('explains the swap when no writable slot is free, and still reads the list again', async () => {
    updateFails = new ProjectUpdateError('project-limit-reached')
    const view = await page(overInput())

    await choose(view, 'project_p2', 'keepActive')
    await settled(view)

    const said = text(find(view, '[data-error]'))
    expect(said).toContain('Make read-only')
    expect(said).toContain('Remove from server')
    expect(recorded.refreshed).toBe(1)
  })

  it('makes a writable project read-only, freeing its slot, only while over the limit', async () => {
    const view = await page(overInput())

    expect(item(view, 'project_p2', 'makeReadOnly')).toBeNull()
    await choose(view, 'project_p1', 'makeReadOnly')
    await settled(view)
    expect(recorded.updated).toEqual([['p1', { readOnly: true }]])
    expect(recorded.refreshed).toBe(1)

    // Within the limit: nothing is read-only, and the server would refuse it (409).
    const within = await page({
      plan: 'member',
      reportedLimit: 3,
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project()],
    })
    expect(item(within, 'project_p1', 'makeReadOnly')).toBeNull()
    expect(item(within, 'project_p1', 'keepActive')).toBeNull()
  })

  it('pushes this copy before making it read-only, then sends the lock', async () => {
    // Once locked the validator refuses every write, so what never left this copy never would.
    const view = await page(overInput())

    await choose(view, 'project_p1', 'makeReadOnly')
    await settled(view)

    expect(recorded.sequence).toEqual(['push:p1', 'patch:p1'])
    expect(view.querySelector('[data-error]')).toBeNull()
  })

  it('locks nothing when the push fails, and says the changes were not uploaded', async () => {
    pushFails = new Error('the push timed out')
    const view = await page(overInput())

    await choose(view, 'project_p1', 'makeReadOnly')
    await settled(view)

    expect(recorded.sequence).toEqual(['push:p1'])
    expect(recorded.updated).toEqual([])
    expect(text(find(view, '[data-error]'))).toContain('Not everything could be uploaded')
  })

  it('keeps a project active without a push: lifting a lock loses nothing', async () => {
    const view = await page(overInput())

    await choose(view, 'project_p2', 'keepActive')
    await settled(view)

    expect(recorded.sequence).toEqual(['patch:p2'])
  })

  it('offers a manager neither choice, but still says the project is read-only', async () => {
    const view = await page({
      plan: 'member',
      reportedLimit: 3,
      local: [entry({ dbName: 'project_p4', name: 'Theirs', projectId: 'p4', role: 'manage' })],
      server: [
        project({
          projectId: 'p4',
          dbName: 'project_p4',
          name: 'Theirs',
          role: 'manage',
          owner: { ownerType: 'user', ownerId: 'them' },
          readOnly: true,
          graceUntil: GRACE,
        }),
      ],
    })

    expect(item(view, 'project_p4', 'keepActive')).toBeNull()
    expect(item(view, 'project_p4', 'makeReadOnly')).toBeNull()
    expect(text(find(view, '[data-row="project_p4"] [data-lifecycle-tip]'))).toContain(
      'Only the owner',
    )
  })

  it('opens a read-only project non-editable', async () => {
    const view = await page(overInput())

    await click(view, '[data-row="project_p2"] [data-open]')

    expect(currentProjectDatabaseName()).toBe('project_p2')
    expect(projectIsEditable()).toBe(false)
  })

  it('marks a read-only project in the pro table and the free card too', async () => {
    const pro = await page(overInput({ plan: 'pro', reportedLimit: 1 }))
    expect(pro.querySelector('[data-row="project_p2"] [data-lifecycle="read-only"]')).not.toBeNull()

    const free = await page(overInput({ plan: 'free' }))
    expect(
      free.querySelector('[data-row="project_p2"] [data-lifecycle="read-only"]'),
    ).not.toBeNull()
    // The free card offers no sync controls (C-R14); its upgrade hint covers them.
    expect(item(free, 'project_p2', 'keepActive')).toBeNull()
  })

  it('speaks German', async () => {
    await activateLocale('de')
    const view = await page(overInput())

    expect(text(find(view, '[data-row="project_p2"] [data-lifecycle-tip]'))).toContain('26.10.2026')
    expect(text(item(view, 'project_p2', 'keepActive'))).toContain('Dieses Projekt aktiv halten')
  })
})
