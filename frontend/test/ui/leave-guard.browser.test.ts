/**
 * Leaving the add form with something entered (#356), through the shell: the browser's Back from
 * step 1, the header's navigation, and the form's own Cancel all ask first, and a navigation that
 * would lose nothing goes ahead without asking.
 */
import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import { fixture, fixtureCleanup, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../../src/ui/app-shell.js'
import { PROJECT_CHANGED } from '../../src/ui/current-project.js'
import { currentProjectDatabaseName, rawDatabase } from '../../src/ui/db/project-database.js'
import { followedAddress, samePage } from '../../src/ui/leave-guard.js'
import type { AddDeviceView } from '../../src/ui/views/add-device.js'
import {
  destroyProjectStores,
  isolatedProjectStore,
  mintDeviceKeyUpFront,
} from './support/project-store.js'

mintDeviceKeyUpFront()

const FORM = '#/devices/new'

beforeEach(() => {
  // The list, then the form: an entry for Back from step 1 to land on.
  history.replaceState(null, '', '#/devices')
  history.pushState(null, '', FORM)
})

afterEach(async () => {
  fixtureCleanup()
  window.location.hash = ''
  await removeWrittenDevices()
  await destroyProjectStores()
})

/**
 * Deletes every device a test here filed. The form writes through `projectDatabase()`, the real
 * current-project database, not the isolated store's (which isolates the index): it is shared by
 * every browser test file in the run, and a draft saved by Save as draft here showed up in the
 * next file's device list (`i18n.browser.test.ts` lost its empty state on CI, #369).
 */
async function removeWrittenDevices(): Promise<void> {
  const database = rawDatabase(currentProjectDatabaseName())
  const { rows } = await database.allDocs({ startkey: 'device:', endkey: 'device:￿' })
  await database.bulkDocs(rows.map((row) => ({ _id: row.id, _rev: row.value.rev, _deleted: true })))
}

async function shellOnForm(): Promise<{ shell: HTMLElement; form: AddDeviceView }> {
  const shell = await fixture<HTMLElement>(
    html`<app-shell .projectStore=${isolatedProjectStore()}></app-shell>`,
  )
  const form = shell.querySelector<AddDeviceView>('add-device-view')
  if (form === null) throw new Error('the shell did not render the add form')
  await form.updateComplete
  return { shell, form }
}

function type(form: HTMLElement, field: string, value: string): void {
  ;(form.querySelector(`[data-field="${field}"]`) as unknown as { value: string }).value = value
}

function dialogOpen(form: HTMLElement): boolean {
  return (form.querySelector('[data-leave-dialog]') as { open?: boolean } | null)?.open === true
}

async function choose(form: HTMLElement, choice: 'stay' | 'discard' | 'draft'): Promise<void> {
  await waitUntil(() => dialogOpen(form), 'the form never asked')
  form.querySelector<HTMLElement>(`[data-leave-${choice}]`)?.click()
}

describe('Back from step 1', () => {
  it('leaves at once when nothing was entered', async () => {
    const { shell } = await shellOnForm()

    history.back()

    await waitUntil(() => shell.querySelector('device-list-view') !== null, 'never left')
    expect(shell.querySelector('add-device-view')).toBeNull()
  })

  it('asks, and Stay keeps the form, its input and its address', async () => {
    const { shell, form } = await shellOnForm()
    type(form, 'credential', 'MT:Y.K9042C00KA0648G00')

    history.back()
    await choose(form, 'stay')

    await waitUntil(() => location.hash === FORM, `the address stayed ${location.hash}`)
    expect(shell.querySelector('add-device-view')).toBe(form)
    expect(
      (form.querySelector('[data-field="credential"]') as unknown as { value: string }).value,
    ).toBe('MT:Y.K9042C00KA0648G00')
    // And Back asks again, rather than having lost its way.
    history.back()
    await waitUntil(() => dialogOpen(form), 'Back did not ask a second time')
  })

  it('asks, and Discard goes where Back was going', async () => {
    const { shell, form } = await shellOnForm()
    type(form, 'name', 'Lamp')

    history.back()
    await choose(form, 'discard')

    await waitUntil(() => shell.querySelector('device-list-view') !== null, 'never left')
    expect(location.hash).toBe('#/devices')
  })
})

describe('a link out of the form', () => {
  it('asks before the header navigation leaves, and follows it on Discard', async () => {
    const { shell, form } = await shellOnForm()
    type(form, 'name', 'Lamp')
    const rooms = shell.querySelector<HTMLAnchorElement>('nav a[href="#/rooms"]')

    rooms?.click()
    expect(location.hash).toBe(FORM)
    await choose(form, 'discard')

    await waitUntil(() => location.hash === '#/rooms', `went to ${location.hash}`)
  })

  it('stays on the form when the person chooses Stay after Cancel', async () => {
    const { shell, form } = await shellOnForm()
    type(form, 'name', 'Lamp')
    const cancel = form.querySelector('wa-button[href="#/devices"]')
    const inner = cancel?.shadowRoot?.querySelector<HTMLAnchorElement>('a')

    inner?.click()
    await choose(form, 'stay')

    expect(location.hash).toBe(FORM)
    expect(shell.querySelector('add-device-view')).toBe(form)
  })

  it('does not ask when nothing was entered', async () => {
    const { shell } = await shellOnForm()

    shell.querySelector<HTMLAnchorElement>('nav a[href="#/rooms"]')?.click()

    await waitUntil(() => location.hash === '#/rooms', `went to ${location.hash}`)
  })
})

describe('while the question is open (review of #368)', () => {
  /** What a background key recovery does with no one pressing anything. */
  const switchProject = () => window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))

  /** Clicks a choice if the dialog is still there to click it in. */
  const pressIfOpen = (form: HTMLElement, choice: 'stay' | 'discard') => {
    if (dialogOpen(form)) form.querySelector<HTMLElement>(`[data-leave-${choice}]`)?.click()
  }

  it('lets a project switch take the form away, even after a link asked', async () => {
    const { shell, form } = await shellOnForm()
    type(form, 'name', 'Lamp')
    shell.querySelector<HTMLAnchorElement>('nav a[href="#/rooms"]')?.click()
    await waitUntil(() => dialogOpen(form), 'the form never asked')

    switchProject()
    // Long enough for the switch's own navigation to fire while the question is still open.
    await new Promise((resolve) => setTimeout(resolve, 100))
    pressIfOpen(form, 'stay')

    await waitUntil(() => shell.querySelector('device-list-view') !== null, 'the form stayed')
    expect(shell.querySelector('add-device-view')).toBeNull()
    expect(location.hash).toBe('#/devices')
  })

  it('lets a project switch take the form away, even after Back asked', async () => {
    const { shell, form } = await shellOnForm()
    type(form, 'name', 'Lamp')
    history.back()
    await waitUntil(() => dialogOpen(form), 'the form never asked')

    switchProject()
    // Long enough for the switch's own navigation to fire while the question is still open.
    await new Promise((resolve) => setTimeout(resolve, 100))
    pressIfOpen(form, 'stay')

    await waitUntil(() => shell.querySelector('device-list-view') !== null, 'the form stayed')
    expect(location.hash).toBe('#/devices')
  })

  it('keeps the form alive when Forward came back to it before Discard', async () => {
    const { shell, form } = await shellOnForm()
    type(form, 'name', 'Lamp')
    history.back()
    await waitUntil(() => dialogOpen(form), 'the form never asked')
    history.forward()
    await waitUntil(() => location.hash === FORM, 'Forward never came back')

    await choose(form, 'discard')
    await waitUntil(() => !dialogOpen(form))

    // Discard went nowhere, so nothing was let go: the form still guards what it holds.
    expect(shell.querySelector('add-device-view')).toBe(form)
    expect(form.holdsInput()).toBe(true)
  })

  it('stays on the form after a typed address, with Back still the previous page', async () => {
    const { shell, form } = await shellOnForm()
    type(form, 'name', 'Lamp')
    location.hash = '#/rooms'
    await choose(form, 'stay')
    await waitUntil(() => location.hash === FORM, `the address stayed ${location.hash}`)
    expect(shell.querySelector('add-device-view')).toBe(form)

    history.back()

    await waitUntil(() => dialogOpen(form), 'Back did not ask')
    expect(location.hash).toBe('#/devices')
  })
})

describe('the parts', () => {
  it('counts an address with another query as the same page', () => {
    expect(samePage('#/devices/new', '#/devices/new?step=place')).toBe(true)
    expect(samePage('#/devices', '#/devices/')).toBe(true)
    expect(samePage('#/devices/new', '#/devices')).toBe(false)
  })

  it('follows a plain click on an in-app link, and nothing else', () => {
    const link = document.createElement('a')
    link.href = '#/rooms'
    document.body.append(link)
    const heard: (string | undefined)[] = []
    const listen = (event: MouseEvent) => {
      heard.push(followedAddress(event))
      event.preventDefault()
    }
    document.addEventListener('click', listen)
    try {
      link.click()
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
      link.target = '_blank'
      link.click()
      link.removeAttribute('target')
      link.href = 'https://example.org/'
      link.click()
      document.body.click()
    } finally {
      document.removeEventListener('click', listen)
      link.remove()
    }
    expect(heard).toEqual(['#/rooms', undefined, undefined, undefined, undefined])
  })
})

describe('Save as draft in the question (#358)', () => {
  it('keeps a draft and goes where Back was going', async () => {
    const { shell, form } = await shellOnForm()
    type(form, 'name', 'Lamp')

    history.back()
    await choose(form, 'draft')

    await waitUntil(() => shell.querySelector('device-list-view') !== null, 'never left')
    expect(location.hash).toBe('#/devices')
    await waitUntil(
      () => shell.querySelector('device-list-view [data-draft-marker]') !== null,
      'the list never showed the draft',
    )
  })

  it('follows the link it was asked for once the draft is stored', async () => {
    // The form holds nothing unsaved by then, which a holdsInput check on the link would
    // have taken for a reason to swallow the click (#368 review).
    const { shell, form } = await shellOnForm()
    type(form, 'name', 'Lamp')

    shell.querySelector<HTMLAnchorElement>('nav a[href="#/rooms"]')?.click()
    await choose(form, 'draft')

    await waitUntil(() => location.hash === '#/rooms', `went to ${location.hash}`)
  })
})
