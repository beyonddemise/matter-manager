import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectRepositories } from '../../../src/data/index.js'
import { type DeviceDocument, roomPathKey, type Unsaved } from '../../../src/domain/index.js'
import { useProjectDatabase } from '../../../src/ui/db/project-database.js'
import type { RoomsView } from '../../../src/ui/views/rooms.js'
import '../../../src/ui/views/rooms.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'

/**
 * The Rooms page (ADR 0021): a room is the path its devices carry, so the page lists what the
 * devices say and a rename rewrites the devices.
 *
 * The decisions (grouping by key, the subtree rule, spelling order) are covered in
 * `test/domain/rooms/list.test.ts`. What is tested here is that the page shows them and writes
 * what `renameRoom` planned.
 */

let database: TestDatabase

const device = (id: string, room: string, name = 'Lamp'): Unsaved<DeviceDocument> => ({
  _id: id,
  type: 'device',
  name,
  room,
  manualCode: '34970112332',
  installedAt: '2026-09-02',
  addedAt: '2026-09-02T09:00:00.000Z',
  disabled: false,
  remarks: [],
})

const view = async (
  repositories: ProjectRepositories = database.repositories,
  projectName = '',
): Promise<RoomsView> => {
  const element = (await fixture(
    html`<rooms-view .repositories=${repositories} .projectName=${projectName}></rooms-view>`,
  )) as RoomsView
  await waitUntil(() => element.loaded, 'never loaded')
  await element.updateComplete
  return element
}

/** Each room's key, in the order the page lists them. Compare with {@link key}. */
const keys = (element: RoomsView): string[] =>
  [...element.querySelectorAll('[data-room]')].map(
    (node) => node.getAttribute('data-room-key') ?? '',
  )

/** The key a room path folds to, so expectations do not restate the folding rule. */
const key = (path: string): string => roomPathKey(path)

/** The room each device is filed under, by id: what a rename is supposed to change. */
const filed = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await database.repositories.devices.list()).map((stored) => [stored._id, stored.room]),
  )

/** The row of the room `path` names, by key, so any spelling finds it. */
const row = (element: RoomsView, path: string): HTMLElement =>
  element.querySelector(`[data-room-key="${CSS.escape(key(path))}"]`) as HTMLElement

/** Opens the dialog through `button` in a row, types `name` and saves. */
async function rename(
  element: RoomsView,
  path: string,
  name: string,
  button = '[data-rename]',
): Promise<void> {
  ;(row(element, path).querySelector(button) as HTMLElement).click()
  await element.updateComplete
  const input = element.querySelector('[data-rename-input]') as HTMLElement & { value: string }
  input.value = name
  ;(element.querySelector('[data-save-rename]') as HTMLElement).click()
}

beforeEach(() => {
  database = browserDatabase()
  useProjectDatabase('project_local', true)
})

afterEach(async () => {
  await database.destroy()
})

describe('the page', () => {
  it('says where a room comes from', async () => {
    // It is also the empty state: with no devices there is nothing else on the page.
    const element = await view()
    expect(element.querySelector('[data-rooms-intro]')?.textContent?.trim()).toBe(
      'A room appears when you add the first device to a new room.',
    )
    expect(element.querySelector('[data-room]')).toBeNull()
  })

  it('names the open project under the heading', async () => {
    const element = await view(database.repositories, 'Hillside')
    expect(element.querySelector('[data-project-name]')?.textContent?.trim()).toBe(
      'Project Hillside',
    )
  })

  it('shows no project line for a project with no name yet', async () => {
    // "Project " with nothing after it reads as a fault.
    const element = await view()
    expect(element.querySelector('[data-project-name]')).toBeNull()
  })
})

describe('the rooms of a project', () => {
  it('lists the rooms the devices are in, in path order', async () => {
    await database.repositories.devices.save(device('device:b', 'Bathroom'))
    await database.repositories.devices.save(device('device:a', 'Attic'))

    expect(keys(await view())).toEqual([key('attic'), key('bathroom')])
  })

  it('links each room to the device list filtered to it', async () => {
    await database.repositories.devices.save(device('device:k', 'Ground Floor/Kitchen'))

    const link = (await view()).querySelector('[data-room-path]')
    expect(link?.getAttribute('href')).toBe('#/devices?room=Ground+Floor%2FKitchen')
  })

  it('says how many devices a room holds', async () => {
    await database.repositories.devices.save(device('device:one', 'Kitchen'))
    await database.repositories.devices.save(device('device:two', 'Hall'))
    await database.repositories.devices.save(device('device:three', 'Hall'))

    const element = await view()
    const count = (path: string) =>
      row(element, path).querySelector('[data-room-count]')?.textContent?.trim()
    expect(count('kitchen')).toBe('1 device')
    expect(count('hall')).toBe('2 devices')
  })

  it('lists every spelling of one room together', async () => {
    await database.repositories.devices.save(device('device:one', 'Kitchen'))
    await database.repositories.devices.save(device('device:two', 'kitchen'))

    const element = await view()
    expect(keys(element)).toEqual([key('kitchen')])
    // Both, in the collator's order; neither is preferred.
    const shown = element.querySelector('[data-room-path]')?.textContent?.trim().split(', ')
    expect(shown?.sort()).toEqual(['Kitchen', 'kitchen'].sort())
  })
})

describe('renaming a room', () => {
  it('rewrites its devices, and the rooms beneath it too', async () => {
    // Renaming `Ground Floor` has to take `Ground Floor/Kitchen` with it, or the child is left
    // under a parent nobody can find any more.
    await database.repositories.devices.save(device('device:floor', 'Ground Floor'))
    await database.repositories.devices.save(device('device:kitchen', 'Ground Floor/Kitchen'))
    await database.repositories.devices.save(device('device:attic', 'Attic'))

    const element = await view()
    await rename(element, 'ground floor', 'Erdgeschoss')

    await waitUntil(() => keys(element).includes(key('Erdgeschoss')), 'never renamed')
    expect(keys(element)).toEqual([key('attic'), key('erdgeschoss'), key('erdgeschoss/kitchen')])
    expect(await filed()).toEqual({
      'device:attic': 'Attic',
      'device:floor': 'Erdgeschoss',
      'device:kitchen': 'Erdgeschoss/Kitchen',
    })
  })

  it('prefills the dialog with the room as it is spelled', async () => {
    await database.repositories.devices.save(device('device:k', 'Ground Floor/Kitchen'))

    const element = await view()
    ;(element.querySelector('[data-rename]') as HTMLElement).click()
    await element.updateComplete

    const input = element.querySelector('[data-rename-input]') as HTMLElement & { value: string }
    expect(input.value).toBe('Ground Floor/Kitchen')
  })

  it('merges into a room that already exists', async () => {
    // A room is nothing but its devices, so renaming onto another room files them there.
    await database.repositories.devices.save(device('device:a', 'Attic'))
    await database.repositories.devices.save(device('device:b', 'Bathroom'))

    const element = await view()
    await rename(element, 'attic', 'Bathroom')

    await waitUntil(() => keys(element).length === 1, 'never merged')
    expect(keys(element)).toEqual([key('bathroom')])
    expect(row(element, 'bathroom').querySelector('[data-room-count]')?.textContent?.trim()).toBe(
      '2 devices',
    )
  })

  it('says so when a write fails, and shows what was saved', async () => {
    await database.repositories.devices.save(device('device:one', 'Kitchen'))

    const repositories: ProjectRepositories = {
      ...database.repositories,
      devices: {
        ...database.repositories.devices,
        save: async () => {
          throw new Error('write failed')
        },
      },
    }
    const element = await view(repositories)
    await rename(element, 'kitchen', 'Cocina')

    await waitUntil(() => element.querySelector('[data-rooms-failed]') !== null, 'no message')
    expect(element.querySelector('[data-rooms-failed]')?.textContent).toContain(
      'Some changes may have been saved',
    )
    expect(keys(element)).toEqual([key('kitchen')])
  })
})

describe('merging spellings', () => {
  it('is offered only for a room spelled more than one way', async () => {
    await database.repositories.devices.save(device('device:one', 'Kitchen'))
    await database.repositories.devices.save(device('device:two', 'kitchen'))
    await database.repositories.devices.save(device('device:three', 'Hall'))

    const element = await view()
    expect(row(element, 'kitchen').querySelector('[data-merge]')).not.toBeNull()
    expect(row(element, 'hall').querySelector('[data-merge]')).toBeNull()
  })

  it('leaves one spelling, and the button goes', async () => {
    await database.repositories.devices.save(device('device:one', 'Kitchen'))
    await database.repositories.devices.save(device('device:two', 'kitchen'))
    await database.repositories.devices.save(device('device:three', 'kitCHEN/Pantry'))

    const element = await view()
    const first = (row(element, 'Kitchen').querySelector('[data-room-path]')?.textContent ?? '')
      .split(', ')[0]
      ?.trim()
    // The dialog is prefilled with the first spelling; saving it unchanged is the merge, and it
    // takes the sub-room spelled a third way with it.
    ;(row(element, 'kitchen').querySelector('[data-merge]') as HTMLElement).click()
    await element.updateComplete
    ;(element.querySelector('[data-save-rename]') as HTMLElement).click()

    await waitUntil(
      () => row(element, 'kitchen').querySelector('[data-merge]') === null,
      'never merged',
    )
    expect(row(element, 'Kitchen').querySelector('[data-room-path]')?.textContent?.trim()).toBe(
      first,
    )
    expect(await filed()).toEqual({
      'device:one': first,
      'device:two': first,
      'device:three': `${first}/Pantry`,
    })
  })
})

describe('a project somebody may only read', () => {
  it('offers the controls when it can be written to', async () => {
    // The positive control: a view rendering no controls at all would satisfy the assertion
    // below while being broken for everybody.
    await database.repositories.devices.save(device('device:one', 'Kitchen'))
    await database.repositories.devices.save(device('device:two', 'kitchen'))

    const element = await view()
    expect(element.querySelector('[data-rename]')).not.toBeNull()
    expect(element.querySelector('[data-merge]')).not.toBeNull()
  })

  it('removes them entirely rather than disabling them', async () => {
    useProjectDatabase('project_readonly', false)
    await database.repositories.devices.save(device('device:one', 'Kitchen'))
    await database.repositories.devices.save(device('device:two', 'kitchen'))

    const element = await view()
    expect(element.querySelector('[data-rename]')).toBeNull()
    expect(element.querySelector('[data-merge]')).toBeNull()
    // The room itself is still listed and still a link.
    expect(element.querySelector('[data-room-path]')).not.toBeNull()
  })
})
