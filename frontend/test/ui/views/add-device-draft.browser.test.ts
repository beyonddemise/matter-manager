/**
 * Drafts in the add form (#358): Save as draft on every step and in the leave question, a draft
 * reopened prefilled on its first unfinished step, saved again into the same document, and
 * finished through the full checks.
 *
 * Through the real History API and an in-memory database, like `add-device-history`: what can go
 * wrong is which document is written, and where the form is when it is written.
 */
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/combobox/combobox.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import { fixture, fixtureCleanup, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftDeviceDocument, StoredDevice, Unsaved } from '../../../src/domain/index.js'
import { PROJECT_DATA_CHANGED } from '../../../src/ui/current-project.js'
import type { ScanSource } from '../../../src/ui/scan/source.js'
import type { AddDeviceView } from '../../../src/ui/views/add-device.js'
import '../../../src/ui/views/add-device.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'
import { lockedDatabase } from '../support/locked-database.js'

const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const UUID = 'draft-1'

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
  history.replaceState(null, '', '#/start')
})

afterEach(async () => {
  for (const element of document.querySelectorAll<AddDeviceView>(
    'add-device-view, finish-device-view',
  )) {
    await waitUntil(() => element.historySettled, 'a form never settled its history')
  }
  fixtureCleanup()
  await database.destroy()
})

const neverAvailable = (): ScanSource => ({
  available: async () => false,
  open: async () => {
    throw new Error('never opened')
  },
  read: async () => [],
  close: () => {},
})

function stepper(element: HTMLElement): HTMLElement & {
  active: string
  updateComplete: Promise<unknown>
} {
  return element.querySelector('wa-stepper') as never
}

async function settle(element: AddDeviceView): Promise<void> {
  await element.updateComplete
  await stepper(element)?.updateComplete
  await element.updateComplete
}

/** A new add form at `#/devices/new`. */
async function newForm(repositories = database.repositories): Promise<AddDeviceView> {
  history.pushState(null, '', '#/devices/new')
  await customElements.whenDefined('wa-input')
  const element = (await fixture(
    html`<add-device-view
      .repositories=${repositories}
      .scanSource=${neverAvailable()}
      .signedIn=${() => false}
    ></add-device-view>`,
  )) as AddDeviceView
  await settle(element)
  return element
}

/** The form opened on the stored draft, as `#/devices/<uuid>/finish` opens it. */
async function finishForm(
  uuid = UUID,
  repositories = database.repositories,
): Promise<AddDeviceView> {
  history.pushState(null, '', `#/devices/${uuid}/finish`)
  await customElements.whenDefined('wa-input')
  const element = (await fixture(
    html`<finish-device-view
      draft-id=${uuid}
      .repositories=${repositories}
      .scanSource=${neverAvailable()}
      .signedIn=${() => false}
    ></finish-device-view>`,
  )) as AddDeviceView
  await settle(element)
  return element
}

const storeDraft = (extra: Partial<DraftDeviceDocument> = {}) =>
  database.repositories.devices.save({
    _id: `device:${UUID}`,
    type: 'device',
    status: 'draft',
    name: 'Hall sensor',
    addedAt: '2026-11-24T09:00:00.000Z',
    disabled: false,
    remarks: [],
    ...extra,
  } as Unsaved<StoredDevice>)

const devices = (): Promise<StoredDevice[]> => database.repositories.devices.list()

function fill(element: HTMLElement, field: string, value: string): void {
  const control = element.querySelector(`[data-field="${field}"]`) as { value?: string } | null
  if (control === null) throw new Error(`no control for "${field}"`)
  control.value = value
}

function typeRoom(element: HTMLElement, path: string): void {
  ;(element.querySelector('[data-field="room"]') as { inputValue?: string }).inputValue = path
}

function shown(element: HTMLElement, field: string): string {
  const control = element.querySelector(`[data-field="${field}"]`) as {
    value?: unknown
    inputValue?: unknown
  }
  const value = field === 'room' ? control.inputValue : control.value
  return typeof value === 'string' ? value : ''
}

async function press(element: AddDeviceView, selector: string): Promise<void> {
  const button = element.querySelector<HTMLElement>(selector)
  if (button === null) throw new Error(`nothing matches ${selector}`)
  button.click()
  await settle(element)
}

/** Waits for a save the form started to settle. */
const saved = (element: AddDeviceView) =>
  waitUntil(() => !element.saving, 'the save never settled', { timeout: 3000 })

describe('Save as draft', () => {
  it('is offered on every step', async () => {
    const element = await newForm()
    for (const step of ['scan', 'place', 'name', 'review']) {
      element.goToStep(step as never)
      await waitUntil(() => stepper(element).active === step)
      await settle(element)
      expect(element.querySelector('[data-save-draft]'), step).not.toBeNull()
    }
  })

  it('stores what there is as one draft, and leaves for the list', async () => {
    const element = await newForm()
    fill(element, 'name', 'Hall sensor')

    await press(element, '[data-save-draft]')
    await saved(element)

    const stored = await devices()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ status: 'draft', name: 'Hall sensor' })
    expect(stored[0]).not.toHaveProperty('room')
    await waitUntil(() => location.hash === '#/devices', `still at ${location.hash}`)
  })

  it('refuses an empty form, saying why, and stores nothing', async () => {
    const element = await newForm()
    await press(element, '[data-save-draft]')
    await saved(element)

    expect(element.querySelector('[data-error]')?.textContent).toContain('at least one value')
    expect(await devices()).toEqual([])
  })

  it('refuses a setup code that does not read, even in a draft', async () => {
    const element = await newForm()
    fill(element, 'credential', '1234')
    fill(element, 'name', 'Hall sensor')
    await press(element, '[data-save-draft]')
    await saved(element)

    expect(element.error?.field).toBe('credential')
    expect(await devices()).toEqual([])
  })

  it('shows a refusal on the step that owns the field', async () => {
    const element = await newForm()
    fill(element, 'name', 'Hall sensor')
    element.goToStep('name')
    await waitUntil(() => stepper(element).active === 'name')
    typeRoom(element, 'Ground Floor/')

    await press(element, '[data-save-draft]')
    await saved(element)

    await waitUntil(() => stepper(element).active === 'place', 'never moved to Place')
    expect(element.error?.problem).toBe('roomPathEmptySegment')
  })
})

describe('the leave question offers a draft', () => {
  it('saves a draft and leaves when the person chooses it', async () => {
    const element = await newForm()
    fill(element, 'name', 'Hall sensor')

    const answer = element.confirmLeave()
    await waitUntil(() => element.querySelector('[data-leave-draft]') !== null)
    element.querySelector<HTMLElement>('[data-leave-draft]')?.click()

    expect(await answer).toBe(true)
    expect(await devices()).toHaveLength(1)
    // Stored, so nothing is held back any more.
    expect(element.holdsInput()).toBe(false)
  })

  it('says why a draft cannot be saved, and offers no button for it', async () => {
    const element = await newForm()
    fill(element, 'credential', '1234')

    const answer = element.confirmLeave()
    await waitUntil(() => element.querySelector('[data-leave-draft-refused]') !== null)
    expect(element.querySelector('[data-leave-draft]')).toBeNull()
    element.querySelector<HTMLElement>('[data-leave-stay]')?.click()

    expect(await answer).toBe(false)
    expect(await devices()).toEqual([])
  })

  it('stays when storage refuses the draft, and keeps everything typed', async () => {
    const real = database.repositories
    let failures = 1
    const element = await newForm({
      ...real,
      devices: {
        ...real.devices,
        save: async (document) => {
          if (failures-- > 0) throw new Error('quota')
          return real.devices.save(document)
        },
      },
    })
    fill(element, 'name', 'Hall sensor')

    const answer = element.confirmLeave()
    await waitUntil(() => element.querySelector('[data-leave-draft]') !== null)
    element.querySelector<HTMLElement>('[data-leave-draft]')?.click()

    expect(await answer).toBe(false)
    expect(failures).toBe(0)
    await settle(element)
    expect(element.querySelector('[data-save-failed]')).not.toBeNull()
    expect(shown(element, 'name')).toBe('Hall sensor')
  })
})

describe('reopening a draft', () => {
  it('fills the form and opens on the first step that does not pass', async () => {
    await storeDraft({ name: 'Hall sensor', serial: 'SN-1' })
    const element = await finishForm()

    // No setup code: Scan it is the first step left to do.
    await waitUntil(() => element.stored !== undefined, 'the draft never loaded')
    await settle(element)
    expect(stepper(element).active).toBe('scan')
    expect(shown(element, 'name')).toBe('Hall sensor')
    expect(shown(element, 'serial')).toBe('SN-1')
    expect(element.querySelector('h1')?.textContent).toContain('Finish a draft')
  })

  it('goes to Place when the code and date are there and the room is not', async () => {
    await storeDraft({ manualCode: '34970112332', installedAt: '2026-11-20' })
    const element = await finishForm()

    await waitUntil(() => stepper(element).active === 'place', 'never opened on Place')
    expect(shown(element, 'credential')).toBe('34970112332')
    expect(shown(element, 'installed-at')).toBe('2026-11-20')
  })

  it('holds nothing unsaved until something is changed', async () => {
    await storeDraft()
    const element = await finishForm()
    await waitUntil(() => element.stored !== undefined)

    expect(element.holdsInput()).toBe(false)
    fill(element, 'name', 'Hall motion sensor')
    expect(element.holdsInput()).toBe(true)
  })

  it('saves into the same document again, never a second one', async () => {
    const first = await storeDraft()
    const element = await finishForm()
    await waitUntil(() => element.stored !== undefined)
    fill(element, 'serial', 'SN-2')

    await press(element, '[data-save-draft]')
    await saved(element)

    const stored = await devices()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ _id: first._id, status: 'draft', serial: 'SN-2' })
    expect(stored[0]?._rev).not.toBe(first._rev)
  })

  it('finishes through the full checks: the status goes, the document stays', async () => {
    const first = await storeDraft()
    const element = await finishForm()
    await waitUntil(() => element.stored !== undefined)
    fill(element, 'credential', PAYLOAD)
    // The draft had no date, and reopening it chose none: finishing needs one.
    fill(element, 'installed-at', '2026-11-24')
    typeRoom(element, 'Hall')
    element.goToStep('review')
    await waitUntil(() => stepper(element).active === 'review')
    await settle(element)

    await press(element, '[data-save]')
    await saved(element)

    const stored = await devices()
    expect(stored).toHaveLength(1)
    expect(stored[0]?._id).toBe(first._id)
    expect(stored[0]).not.toHaveProperty('status')
    expect(stored[0]).toMatchObject({ name: 'Hall sensor', room: 'Hall', payload: PAYLOAD })
  })

  it('refuses to finish a draft with a step left undone, and shows the step', async () => {
    await storeDraft({ manualCode: '34970112332', installedAt: '2026-11-20' })
    const element = await finishForm()
    await waitUntil(() => stepper(element).active === 'place')
    element.goToStep('review')
    await waitUntil(() => stepper(element).active === 'review')
    await settle(element)

    await press(element, '[data-save]')
    await saved(element)

    await waitUntil(() => stepper(element).active === 'place', 'never sent back to Place')
    expect((await devices())[0]).toMatchObject({ status: 'draft' })
  })

  it('names the narrower Discard in the leave question: changes, not the draft', async () => {
    await storeDraft()
    const element = await finishForm()
    await waitUntil(() => element.stored !== undefined)
    fill(element, 'name', 'Changed')

    const answer = element.confirmLeave()
    await waitUntil(() => element.querySelector('[data-leave-discard]') !== null)
    await settle(element)
    expect(element.querySelector('[data-leave-discard]')?.textContent).toContain('Discard changes')
    element.querySelector<HTMLElement>('[data-leave-discard]')?.click()
    expect(await answer).toBe(true)
    expect(await devices()).toHaveLength(1)
  })

  it('saves nothing while the draft is still being read, so no second document appears', async () => {
    await storeDraft()
    const real = database.repositories
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const element = await finishForm(UUID, {
      ...real,
      devices: {
        ...real.devices,
        get: async (id) => {
          await held
          return real.devices.get(id)
        },
      },
    })
    // Inert, so nobody can type into controls the prefill is about to overwrite.
    expect(element.querySelector('form')?.inert).toBe(true)
    fill(element, 'serial', 'SN-early')

    await press(element, '[data-save-draft]')
    await saved(element)
    expect(await devices()).toHaveLength(1)

    release()
    // Usable only once the draft is in the form and the form is on its first unfinished step.
    await waitUntil(() => element.querySelector('form')?.inert === false, 'never became usable')
    expect(element.stored).not.toBeUndefined()
    expect(shown(element, 'serial')).toBe('')
  })

  /**
   * A finish form whose draft has been read but whose room selection is still waiting for the
   * form's update (`openDraft`'s `updateComplete`), held there until `release` is called.
   */
  async function heldInRoomSelection(): Promise<{
    element: AddDeviceView
    release: () => void
  }> {
    await storeDraft({
      room: 'Hall',
      manualCode: '34970112332',
      installedAt: '2026-11-20',
    })
    await customElements.whenDefined('wa-input')
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    history.pushState(null, '', `#/devices/${UUID}/finish`)
    const fresh = document.createElement('finish-device-view') as AddDeviceView
    fresh.setAttribute('draft-id', UUID)
    fresh.repositories = database.repositories
    fresh.scanSource = neverAvailable()
    fresh.signedIn = () => false
    // Lit asks `getUpdateComplete` for `updateComplete`; holding it once the draft is stored
    // holds exactly the wait between reading the draft and selecting its room.
    const original = (fresh as unknown as { getUpdateComplete: () => Promise<boolean> })
      .getUpdateComplete
    ;(fresh as unknown as { getUpdateComplete: () => Promise<boolean> }).getUpdateComplete =
      function (this: AddDeviceView) {
        const settled = original.call(this)
        return this.stored === undefined ? settled : held.then(() => settled)
      }
    document.body.append(fresh)
    await waitUntil(() => fresh.stored !== undefined, 'the draft was never read')
    return { element: fresh, release }
  }

  it('stays inert and saves nothing until the room is selected and the step chosen', async () => {
    const { element, release } = await heldInRoomSelection()
    try {
      expect(element.querySelector('form')?.inert).toBe(true)
      element.querySelector<HTMLElement>('[data-save-draft]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(await devices()).toHaveLength(1)
      expect((await devices())[0]?._rev?.startsWith('1-')).toBe(true)

      release()
      await waitUntil(() => element.querySelector('form')?.inert === false, 'never became usable')
      expect(shown(element, 'room')).toBe('Hall')
    } finally {
      element.remove()
    }
  })

  it('takes no room and moves no step when left during the room selection (CodeRabbit on #369)', async () => {
    const { element, release } = await heldInRoomSelection()
    element.remove()
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(shown(element, 'room')).toBe('')
    expect(stepper(element).active).toBe('scan')
    expect(element.querySelector('form')?.inert).toBe(true)
  })

  it('does nothing with a read that lands after the form was left (CodeRabbit on #369)', async () => {
    // A device finished elsewhere: a live form would replace the address with its page.
    await database.repositories.devices.save({
      _id: `device:${UUID}`,
      type: 'device',
      name: 'Hall sensor',
      room: 'Hall',
      manualCode: '34970112332',
      installedAt: '2026-11-20',
      addedAt: '2026-11-24T09:00:00.000Z',
      disabled: false,
      remarks: [],
    })
    const real = database.repositories
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let read = false
    const element = await finishForm(UUID, {
      ...real,
      devices: {
        ...real.devices,
        get: async (id) => {
          await held
          read = true
          return real.devices.get(id)
        },
      },
    })
    const address = location.hash

    element.remove()
    release()
    await waitUntil(() => read, 'the read never landed')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(location.hash).toBe(address)
  })

  it('says so when there is no such draft', async () => {
    const element = await finishForm('gone')
    await waitUntil(() => element.querySelector('[data-draft-missing]') !== null)
  })

  it('goes to the device page when the draft was finished meanwhile', async () => {
    await database.repositories.devices.save({
      _id: `device:${UUID}`,
      type: 'device',
      name: 'Hall sensor',
      room: 'Hall',
      manualCode: '34970112332',
      installedAt: '2026-11-20',
      addedAt: '2026-11-24T09:00:00.000Z',
      disabled: false,
      remarks: [],
    })
    await finishForm()
    await waitUntil(() => location.hash === `#/devices/${UUID}`, `still at ${location.hash}`)
  })
})

describe('saving a reopened draft safely (CodeRabbit on #369)', () => {
  it('stays, saying so, when the rooms cannot be read for a draft', async () => {
    const real = database.repositories
    let reads = 0
    const element = await newForm({
      ...real,
      devices: {
        ...real.devices,
        list: async () => {
          // The form's own first read passes; the one Save as draft makes fails.
          if (reads++ > 0) throw new Error('storage')
          return real.devices.list()
        },
      },
    })
    fill(element, 'name', 'Hall sensor')

    const answer = element.confirmLeave()
    await waitUntil(() => element.querySelector('[data-leave-draft]') !== null)
    element.querySelector<HTMLElement>('[data-leave-draft]')?.click()

    expect(await answer).toBe(false)
    await settle(element)
    expect(element.querySelector('[data-save-failed]')).not.toBeNull()
    expect(await devices()).toEqual([])
  })

  it('says the draft was finished elsewhere, keeps the input, and saves no more', async () => {
    const first = await storeDraft()
    const element = await finishForm()
    await waitUntil(() => element.stored !== undefined)
    // Finished on another phone after this form read it.
    const { updatedAt: _stamp, status: _status, ...rest } = first as DraftDeviceDocument
    await database.repositories.devices.save({
      ...rest,
      name: 'Hall sensor',
      room: 'Hall',
      manualCode: '34970112332',
      installedAt: '2026-11-24',
    } as Unsaved<StoredDevice>)
    fill(element, 'serial', 'SN-mine')

    await press(element, '[data-save-draft]')
    await saved(element)
    await waitUntil(() => element.querySelector('[data-finished-elsewhere]') !== null)
    expect(shown(element, 'serial')).toBe('SN-mine')

    await press(element, '[data-save-draft]')
    await saved(element)
    const stored = await devices()
    expect(stored).toHaveLength(1)
    expect(stored[0]).not.toHaveProperty('status')
    expect(stored[0]).not.toHaveProperty('serial')
  })

  it('never saves a draft read while locked, so its stored code is kept', async () => {
    const locked = await lockedDatabase()
    try {
      await locked.unlocked.devices.save({
        _id: `device:${UUID}`,
        type: 'device',
        status: 'draft',
        name: 'Hall sensor',
        manualCode: '34970112332',
        addedAt: '2026-11-24T09:00:00.000Z',
        disabled: false,
        remarks: [],
      } as Unsaved<StoredDevice>)
      const element = await finishForm(UUID, locked.unlockable)
      await waitUntil(() => element.stored !== undefined)
      // The key arrives while the form still holds the locked read.
      locked.unlock()
      fill(element, 'serial', 'SN-1')

      await press(element, '[data-save-draft]')
      await saved(element)

      expect(element.saveFailed).toBe('locked')
      expect((await locked.unlocked.devices.get(`device:${UUID}`))?.manualCode).toBe('34970112332')

      // The next sync re-reads it: the code comes back into the form, and a save keeps it.
      window.dispatchEvent(new CustomEvent(PROJECT_DATA_CHANGED))
      await waitUntil(
        () => shown(element, 'credential') === '34970112332',
        'the code never came back',
      )
      await press(element, '[data-save-draft]')
      await saved(element)
      expect(await locked.unlocked.devices.get(`device:${UUID}`)).toMatchObject({
        manualCode: '34970112332',
        serial: 'SN-1',
      })
    } finally {
      fixtureCleanup()
      await locked.destroy()
    }
  })
})

describe('a draft that moved on elsewhere while open (review of #369)', () => {
  /** Another phone's write to the draft: a remark, as a teammate adds one. */
  async function remarkElsewhere(): Promise<void> {
    const current = (await database.repositories.devices.get(
      `device:${UUID}`,
    )) as DraftDeviceDocument
    const { updatedAt: _stamp, ...rest } = current
    await database.repositories.devices.save({
      ...rest,
      remarks: [
        {
          id: 'r1',
          text: 'Ask the owner',
          authorSub: 's',
          authorName: 'B',
          createdAt: '2026-11-24T10:00:00.000Z',
        },
      ],
    } as Unsaved<StoredDevice>)
  }

  it('saves a draft changed elsewhere on the first press, keeping what the other side added', async () => {
    await storeDraft()
    const element = await finishForm()
    await waitUntil(() => element.querySelector('form')?.inert === false)
    await remarkElsewhere()
    fill(element, 'serial', 'SN-mine')

    await press(element, '[data-save-draft]')
    await saved(element)

    const stored = await devices()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ status: 'draft', serial: 'SN-mine' })
    expect(stored[0]?.remarks.map((each) => each.id)).toEqual(['r1'])
    expect(element.querySelector('[data-save-failed]')).toBeNull()
  })

  it('finishes a draft changed elsewhere on the first press', async () => {
    await storeDraft({ manualCode: '34970112332', installedAt: '2026-11-20', room: 'Hall' })
    const element = await finishForm()
    await waitUntil(() => element.querySelector('form')?.inert === false)
    await remarkElsewhere()
    element.goToStep('review')
    await waitUntil(() => stepper(element).active === 'review')
    await settle(element)

    await press(element, '[data-save]')
    await saved(element)

    const stored = await devices()
    expect(stored).toHaveLength(1)
    expect(stored[0]).not.toHaveProperty('status')
    expect(stored[0]?.remarks.map((each) => each.id)).toEqual(['r1'])
  })

  it('says the draft changed elsewhere when the retry conflicts too, and saves on the next press', async () => {
    await storeDraft()
    const real = database.repositories
    let conflicts = 2
    const element = await finishForm(UUID, {
      ...real,
      devices: {
        ...real.devices,
        save: async (document) => {
          if (conflicts-- > 0)
            throw Object.assign(new Error('conflict'), { status: 409, name: 'conflict' })
          return real.devices.save(document)
        },
      },
    })
    await waitUntil(() => element.querySelector('form')?.inert === false)
    fill(element, 'serial', 'SN-mine')

    await press(element, '[data-save-draft]')
    await saved(element)
    expect(conflicts).toBe(0)
    expect(element.querySelector('[data-save-changed]')).not.toBeNull()
    expect(element.querySelector('[data-save-failed]')).toBeNull()

    await press(element, '[data-save-draft]')
    await saved(element)
    expect((await devices())[0]).toMatchObject({ serial: 'SN-mine' })
  })

  it('says the draft was deleted elsewhere, and saves the input as a new draft on the next press', async () => {
    const first = await storeDraft()
    const element = await finishForm()
    await waitUntil(() => element.querySelector('form')?.inert === false)
    // Deleted on another phone, and replicated here.
    await database.repositories.devices.remove(first)
    fill(element, 'credential', PAYLOAD)

    await press(element, '[data-save-draft]')
    await saved(element)
    expect(element.querySelector('[data-deleted-elsewhere]')).not.toBeNull()
    expect(element.querySelector('[data-save-failed]')).toBeNull()
    expect(shown(element, 'credential')).toBe(PAYLOAD)
    expect(await devices()).toEqual([])

    await press(element, '[data-save-draft]')
    await saved(element)
    const stored = await devices()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ status: 'draft', name: 'Hall sensor', payload: PAYLOAD })
  })
})
