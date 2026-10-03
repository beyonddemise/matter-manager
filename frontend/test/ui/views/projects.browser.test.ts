import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/card/card.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/dropdown/dropdown.js'
import '@awesome.me/webawesome-pro/dist/components/dropdown-item/dropdown-item.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalProjectEntry } from '../../../src/data/index.js'
import { CURRENT_PROJECT_KEY } from '../../../src/ui/current-project.js'
import {
  currentProjectDatabaseName,
  PROJECT_DATABASE_NAME,
  projectIsEditable,
  useProjectDatabase,
} from '../../../src/ui/db/project-database.js'
import { activateLocale } from '../../../src/ui/i18n/localization.js'
import { ProjectActionError, type ProjectActions } from '../../../src/ui/project-actions.js'
import { projectActionRunning } from '../../../src/ui/project-busy.js'
import {
  type NewProject,
  type Project,
  ProjectCreationError,
  type ProjectPatch,
  type ProjectsApi,
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
  refreshed: number
}

let recorded: Recorded

/** How the fake API answers `create`: with a project, or by throwing. */
let createAnswer: () => Project

/** How every fake project action ends: resolving by default, or as a test says. */
let actionAnswer: () => Promise<void>

/** Project actions that record what they were asked and answer with {@link actionAnswer}. */
const actions: ProjectActions = {
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
    refreshed: 0,
  }
  actionAnswer = async () => {}
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
      .sync=${{ set: (projects: readonly SyncableProject[]) => recorded.synced.push(projects) }}
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
    expect(text(find(view, '[data-row="project_p1"] [data-sync]'))).toContain('Up to date')
  })

  it('shows a waiting sync quietly, never as an error', async () => {
    const view = await member({
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project()],
      syncStates: () => 'offline',
    })

    const tag = find(view, '[data-row="project_p1"] [data-sync]')
    expect(tag.getAttribute('variant')).toBe('neutral')
  })

  it('creates on the server, keeps a local copy and refetches the list', async () => {
    const view = await member({
      local: [entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
      server: [project()],
    })

    const slot = find(view, '[data-slot-empty]')
    type(slot, '[data-field="name"]', 'Neu')
    await click(view, '[data-create]', slot)
    await settled(view)

    expect(recorded.created).toEqual([{ name: 'Neu' }])
    expect(recorded.indexed).toEqual([expect.objectContaining({ projectId: 'p-new' })])
    expect(recorded.synced).toEqual([
      [
        { projectId: 'p1', dbName: 'project_p1' },
        { projectId: 'p-new', dbName: 'project_p-new' },
      ],
    ])
    expect(recorded.localCreated).toEqual([])
    expect(recorded.refreshed).toBe(1)
    // Indexed and handed to replication as a project action: a shell refresh in between would
    // hand replication a list without the new copy.
    expect(recorded.indexedWhileBusy).toEqual([true])
    expect(projectActionRunning()).toBe(false)
    // The slot is reused for the next render; it must not still hold the name just created.
    expect(fieldOf(find(view, '[data-slot-empty]'), 'name')).toBe('')
  })

  it('says a refused sync plainly, and an archived project as read-only', async () => {
    const view = await member({
      local: [
        entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' }),
        entry({ dbName: 'project_p2', name: 'Gamma', projectId: 'p2' }),
      ],
      server: [project(), project({ projectId: 'p2', dbName: 'project_p2', archived: true })],
      syncStates: () => 'denied',
    })

    const denied = find(view, '[data-row="project_p1"] [data-sync]')
    expect(text(denied)).toContain('No permission to sync')
    expect(denied.getAttribute('variant')).toBe('warning')
    expect(text(find(view, '[data-row="project_p2"] [data-sync]'))).toContain(
      'Archived — read-only',
    )
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

  it('says why the server refused, in the reader’s words', async () => {
    createAnswer = () => {
      throw new ProjectCreationError('project-limit-reached')
    }
    const view = await member()

    const slot = find(view, '[data-slot-empty]')
    type(slot, '[data-field="name"]', 'Neu')
    await click(view, '[data-create]', slot)
    await settled(view)

    expect(text(find(view, '[data-error]'))).toContain('Your plan has no room for another project')
    expect(recorded.refreshed).toBe(0)
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

    expect(recorded.created).toEqual([{ name: 'Neu', client: 'Acme' }])
    expect(view.querySelector('[data-add-dialog][open]')).toBeNull()

    // Opened again, it must not offer to create the same project a second time.
    await click(view, '[data-add-project]')
    expect(fieldOf(dialog, 'name')).toBe('')
    expect(fieldOf(dialog, 'client')).toBe('')
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

  it('lists projects shared with the reader separately', async () => {
    const view = await page({
      plan: 'member',
      server: [project({ projectId: 'p2', dbName: 'project_p2', name: 'Theirs', role: 'write' })],
    })

    expect(text(find(view, '[data-shared]'))).toContain('Shared with me')
    expect(view.querySelector('[data-shared] [data-row="project_p2"]')).not.toBeNull()
    expect(view.querySelectorAll('[data-slot-empty]')).toHaveLength(5)
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
    const pen = find(view, '[data-row="project_p1"] [data-rename]')
    expect(pen.hasAttribute('disabled')).toBe(true)
    expect(text(find(view, '[data-row="project_p1"]'))).toContain('Needs a connection')
  })

  it('speaks German', async () => {
    await activateLocale('de')
    const view = await page()

    const said = text(find(view, '[data-create-card]'))
    expect(said).toContain('Ihr Projekt')
    expect(said).not.toContain('Create your project')
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
      'Collaborators lose access. Deleted permanently after 90 days.',
    )
    await click(view, '[data-confirm]', dialog(view))
    await settled(view)

    expect(recorded.acted).toEqual([['removeServer', 'project_p1']])
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
  })
})
