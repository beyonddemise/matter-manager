import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import { fixture, html } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CURRENT_PROJECT_KEY } from '../../src/ui/current-project.js'
import { useProjectDatabase } from '../../src/ui/db/project-database.js'

/**
 * #55: what switching the open project does to the views, and a read-only project's controls.
 * The switch itself is the projects page's Open (`views/projects.browser.test.ts`) and the
 * shell's choice of the current project (`shell-projects.browser.test.ts`).
 */

beforeEach(() => {
  localStorage.removeItem(CURRENT_PROJECT_KEY)
  useProjectDatabase('project_local')
})

afterEach(() => {
  localStorage.removeItem(CURRENT_PROJECT_KEY)
  useProjectDatabase('project_local')
})

describe('editing controls on a project somebody may only read', () => {
  /** The device list, rendered under whatever the current project allows. */
  const deviceList = async () => {
    await import('../../src/ui/views/device-list.js')
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

describe('what a project switch must not leave behind', () => {
  /**
   * All five of these came from one review, and all five are the same mistake: the first
   * version of the switch cleared the repositories and nothing else, so every piece of state a
   * view was holding stayed pointed at the project it came from.
   */

  it('forgets a device loaded under the previous project', async () => {
    // The worst of them. The route's uuid does not change on a switch, so nothing else clears
    // the loaded device - and a delete confirmation opened under project A would still hold
    // project A's document when it fired against project B's repository. Two projects can hold
    // the same `_id` and `_rev`, which is how that becomes a deletion in the wrong building.
    await import('../../src/ui/views/device.js')
    const element = (await fixture(html`<device-view uuid="abc"></device-view>`)) as HTMLElement & {
      device?: unknown
      confirmingDelete?: boolean
      updateComplete: Promise<unknown>
    }
    await element.updateComplete

    element.device = { _id: 'device:abc', _rev: '1-a', name: 'Kitchen lamp' }
    element.confirmingDelete = true
    await element.updateComplete

    useProjectDatabase('project_elsewhere', true)
    await element.updateComplete

    expect(element.device).toBeUndefined()
    expect(element.confirmingDelete).toBe(false)
  })

  it('leaves a half-filled form rather than saving it into the new project', async () => {
    // An add form filled under project A and saved after switching to B would create the device
    // in B. The typed input is lost, which is the lesser harm: switching mid-form is deliberate,
    // and a device filed in the wrong building is a device nobody finds again.
    await import('../../src/ui/views/add-device.js')
    const element = (await fixture(html`<add-device-view></add-device-view>`)) as HTMLElement & {
      updateComplete: Promise<unknown>
    }
    await element.updateComplete

    window.location.hash = '#/devices/new'
    useProjectDatabase('project_elsewhere', true)
    await element.updateComplete

    expect(window.location.hash).toBe('#/devices')
  })

  it('clears the list rather than showing the other project’s devices', async () => {
    await import('../../src/ui/views/device-list.js')
    const element = (await fixture(html`<device-list-view></device-list-view>`)) as HTMLElement & {
      devices?: unknown[]
      updateComplete: Promise<unknown>
    }
    await element.updateComplete

    element.devices = [{ _id: 'device:one', name: 'Hall light' }]
    await element.updateComplete

    useProjectDatabase('project_elsewhere', true)
    await element.updateComplete

    expect(element.devices).toEqual([])
  })
})
