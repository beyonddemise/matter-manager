import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import '@awesome.me/webawesome-pro/dist/components/select/select.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CURRENT_PROJECT_KEY, LOCAL_PROJECT_ID } from '../src/current-project.js'
import { currentProjectDatabaseName, useProjectDatabase } from '../src/db/project-database.js'
import '../src/app-shell.js'

/**
 * #55, first two scenarios: moving between projects with the current one remembered, and a
 * read-only project saying so.
 */

const OFFLINE = { addEventListener: () => {}, removeEventListener: () => {}, onLine: true }

const shell = async (projects: readonly unknown[]) => {
  const element = (await fixture(html`
    <app-shell
      .readSession=${async () => 'signed-in' as const}
      .connectivity=${OFFLINE}
      .followLocale=${async () => undefined}
      .listProjects=${async () => projects}
      .makeSync=${() => ({
        set: () => {},
        running: () => [],
        stateOf: () => undefined,
        stopAll: () => {},
      })}
      .signOutOf=${async () => []}
    ></app-shell>
  `)) as HTMLElement & { updateComplete: Promise<unknown> }
  await element.updateComplete
  return element
}

const project = (over: Record<string, unknown> = {}) => ({
  projectId: 'p1',
  dbName: 'project_p1',
  name: 'Musterstraße 12',
  role: 'owner',
  archived: false,
  ...over,
})

beforeEach(() => {
  localStorage.removeItem(CURRENT_PROJECT_KEY)
  useProjectDatabase('project_local')
})

afterEach(() => {
  localStorage.removeItem(CURRENT_PROJECT_KEY)
  useProjectDatabase('project_local')
})

describe('moving between projects', () => {
  it('offers no switcher when there is nothing to switch between', async () => {
    // A control offering one choice is not a choice, and somebody with no account has exactly
    // one catalogue.
    const element = await shell([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(element.querySelector('[data-project-switcher]')).toBeNull()
  })

  it('offers the local catalogue alongside the account’s projects', async () => {
    const element = await shell([project()])
    await waitUntil(() => element.querySelector('[data-project-switcher]') !== null, 'no switcher')

    const offered = [...element.querySelectorAll('[data-project-switcher] wa-option')].map((o) =>
      o.getAttribute('value'),
    )
    expect(offered).toEqual([LOCAL_PROJECT_ID, 'p1'])
  })

  it('does not offer an archived project', async () => {
    // What archiving is for. The API still lists it, so somewhere else can offer to bring it
    // back; the switcher is not that somewhere.
    const element = await shell([project(), project({ projectId: 'p2', archived: true })])
    await waitUntil(() => element.querySelector('[data-project-switcher]') !== null, 'no switcher')

    const offered = [...element.querySelectorAll('[data-project-switcher] wa-option')].map((o) =>
      o.getAttribute('value'),
    )
    expect(offered).not.toContain('p2')
  })

  it('opens the chosen project’s database', async () => {
    const element = await shell([project()])
    await waitUntil(() => element.querySelector('[data-project-switcher]') !== null, 'no switcher')

    const select = element.querySelector('[data-project-switcher]') as HTMLElement & {
      value: string
    }
    select.value = 'p1'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    expect(currentProjectDatabaseName()).toBe('project_p1')
  })

  it('remembers the choice', async () => {
    const element = await shell([project()])
    await waitUntil(() => element.querySelector('[data-project-switcher]') !== null, 'no switcher')

    const select = element.querySelector('[data-project-switcher]') as HTMLElement & {
      value: string
    }
    select.value = 'p1'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    expect(localStorage.getItem(CURRENT_PROJECT_KEY)).toBe('p1')
  })

  it('ignores a value that is not on offer', async () => {
    // The value arrives from a DOM property rather than from our own code. A stray event must
    // not leave the interface pointing at a project this browser has no database for.
    const element = await shell([project()])
    await waitUntil(() => element.querySelector('[data-project-switcher]') !== null, 'no switcher')

    const select = element.querySelector('[data-project-switcher]') as HTMLElement & {
      value: string
    }
    select.value = 'not-a-project'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    expect(currentProjectDatabaseName()).toBe('project_local')
    expect(localStorage.getItem(CURRENT_PROJECT_KEY)).not.toBe('not-a-project')
  })

  it('falls back when the remembered project is no longer on offer', async () => {
    // Access revoked, or archived since. A view handed no database shows an empty catalogue,
    // which is indistinguishable from having lost everything.
    localStorage.setItem(CURRENT_PROJECT_KEY, 'p9')
    const element = await shell([project()])
    await waitUntil(() => element.querySelector('[data-project-switcher]') !== null, 'no switcher')

    expect(currentProjectDatabaseName()).toBe('project_local')
  })
})

describe('a project somebody may only read', () => {
  it('says so in the switcher', async () => {
    const element = await shell([project({ role: 'read' })])
    await waitUntil(() => element.querySelector('[data-project-switcher]') !== null, 'no switcher')

    const option = element.querySelector('[data-project-switcher] wa-option[value="p1"]')
    expect(option?.textContent).toContain('read-only')
  })

  it('does not mark a project that can be written to', async () => {
    const element = await shell([project({ role: 'write' })])
    await waitUntil(() => element.querySelector('[data-project-switcher]') !== null, 'no switcher')

    const option = element.querySelector('[data-project-switcher] wa-option[value="p1"]')
    expect(option?.textContent).not.toContain('read-only')
  })
})

describe('editing controls on a project somebody may only read', () => {
  /** The device list, rendered under whatever the current project allows. */
  const deviceList = async () => {
    await import('../src/views/device-list.js')
    const element = (await fixture(html`<device-list-view></device-list-view>`)) as HTMLElement & {
      updateComplete: Promise<unknown>
    }
    await element.updateComplete
    await new Promise((resolve) => setTimeout(resolve, 30))
    return element
  }

  it('offers adding a device on a project that can be written to', async () => {
    // The positive control, and it matters: a view that rendered no add button at all would
    // satisfy the assertion below while being broken for everybody.
    useProjectDatabase('project_local', true)
    const element = await deviceList()
    expect(element.querySelector('[data-add-device]')).not.toBeNull()
  })

  it('removes it entirely rather than disabling it', async () => {
    // Absent, not disabled. A disabled control says "this is possible and you are doing it
    // wrong"; on a project somebody may only read, neither half is true.
    useProjectDatabase('project_readonly', false)
    const element = await deviceList()
    expect(element.querySelector('[data-add-device]')).toBeNull()
  })

  it('keeps the controls that only read', async () => {
    // Labels and the PDF export are not editing. Removing them would confuse "you may not
    // change this" with "you may not use this".
    useProjectDatabase('project_readonly', false)
    const element = await deviceList()
    expect(element.querySelector('[data-export]')).not.toBeNull()
  })
})
