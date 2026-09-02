import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import '@awesome.me/webawesome-pro/dist/components/select/select.js'
import type { DeviceDocument, RoomDocument } from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useProjectDatabase } from '../../src/db/project-database.js'
import type { RoomsView } from '../../src/views/rooms.js'
import '../../src/views/rooms.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'

/**
 * #142: `planRoomDeletion`, `renameRoom`, `reorderRooms` and `roomsInOrder` were written and
 * tested at M5-9 and imported by nothing — #120's defect one package over.
 *
 * The decisions are covered exhaustively in `core/test/rooms/list.test.ts`. What is tested here
 * is the half that was missing: that a caller exists, and that it writes what each plan produced
 * in the order the plan says.
 */

let database: TestDatabase

const room = (id: string, path: string, sortKey?: number) => ({
  _id: id,
  type: 'room' as const,
  path,
  ...(sortKey === undefined ? {} : { sortKey }),
})

const device = (id: string, name: string, roomId: string) => ({
  _id: id,
  type: 'device' as const,
  name,
  roomId,
  manualCode: '34970112332',
  installedAt: '2026-09-02',
  addedAt: '2026-09-02T09:00:00.000Z',
  disabled: false,
  remarks: [],
})

const view = async (): Promise<RoomsView> => {
  const element = (await fixture(
    html`<rooms-view .repositories=${database.repositories}></rooms-view>`,
  )) as RoomsView
  await waitUntil(() => element.loaded, 'never loaded')
  await element.updateComplete
  return element
}

const paths = (element: RoomsView): string[] =>
  [...element.querySelectorAll('[data-room-path]')].map((node) => node.textContent?.trim() ?? '')

beforeEach(() => {
  database = browserDatabase()
  useProjectDatabase('project_local', true)
})

afterEach(async () => {
  await database.destroy()
})

describe('the rooms of a project', () => {
  it('lists them in the order the domain decides', async () => {
    // `roomsInOrder` puts a manual position first and falls back to text. Sorting here instead
    // would be a second answer to a question `core` already answers.
    await database.repositories.rooms.save(room('room:b', 'Bathroom', 2))
    await database.repositories.rooms.save(room('room:a', 'Attic', 1))

    expect(paths(await view())).toEqual(['Attic', 'Bathroom'])
  })

  it('says how many devices a room holds', async () => {
    await database.repositories.rooms.save(room('room:k', 'Kitchen'))
    await database.repositories.devices.save(device('device:one', 'Lamp', 'room:k'))

    const element = await view()
    expect(element.querySelector('[data-room-count]')?.textContent?.trim()).toBe('1')
  })

  it('says so plainly when a room holds nothing', async () => {
    await database.repositories.rooms.save(room('room:k', 'Kitchen'))
    const element = await view()
    expect(element.querySelector('[data-room-count]')?.textContent).toContain('No devices')
  })
})

describe('renaming a room', () => {
  it('takes the rooms beneath it too', async () => {
    // `renameRoom` moves the whole subtree: renaming `Ground Floor` has to take
    // `Ground Floor/Kitchen` with it, or the child becomes a room nobody meant to create.
    await database.repositories.rooms.save(room('room:floor', 'Ground Floor'))
    await database.repositories.rooms.save(room('room:kitchen', 'Ground Floor/Kitchen'))

    const element = await view()
    ;(element.querySelector('[data-rename]') as HTMLElement).click()
    await element.updateComplete

    const input = element.querySelector('[data-rename-input]') as HTMLElement & { value: string }
    input.value = 'Erdgeschoss'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    await waitUntil(() => paths(element).includes('Erdgeschoss'), 'never renamed')
    expect(paths(element)).toEqual(['Erdgeschoss', 'Erdgeschoss/Kitchen'])
  })

  it('changes nothing when the new name would collide', async () => {
    // `renameRoom` throws, and the list is left exactly as it was: the remedy is another name.
    await database.repositories.rooms.save(room('room:a', 'Attic'))
    await database.repositories.rooms.save(room('room:b', 'Bathroom'))

    const element = await view()
    ;(element.querySelector('[data-rename]') as HTMLElement).click()
    await element.updateComplete

    const input = element.querySelector('[data-rename-input]') as HTMLElement & { value: string }
    input.value = 'Bathroom'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await waitUntil(() => element.querySelector('[data-rooms-failed]') !== null, 'no message')

    expect((await database.repositories.rooms.list()).map((r) => r.path).sort()).toEqual([
      'Attic',
      'Bathroom',
    ])
  })
})

describe('reordering', () => {
  it('moves a room down one place', async () => {
    await database.repositories.rooms.save(room('room:a', 'Attic', 1))
    await database.repositories.rooms.save(room('room:b', 'Bathroom', 2))

    const element = await view()
    ;(element.querySelector('[data-move-down]') as HTMLElement).click()
    await waitUntil(() => paths(element)[0] === 'Bathroom', 'never moved')

    expect(paths(element)).toEqual(['Bathroom', 'Attic'])
  })
})

describe('deleting a room', () => {
  it('sends its devices to Unassigned rather than orphaning them', async () => {
    // The destination is required by `planRoomDeletion`'s signature, which is the mechanism
    // rather than a check: no value of `RoomDestination` means "never mind".
    await database.repositories.rooms.save(room('room:k', 'Kitchen'))
    await database.repositories.devices.save(device('device:one', 'Lamp', 'room:k'))

    const element = await view()
    ;(element.querySelector('[data-delete-room]') as HTMLElement).click()
    await element.updateComplete
    ;(element.querySelector('[data-confirm-delete-room]') as HTMLElement).click()

    await waitUntil(
      async () => (await database.repositories.rooms.list()).length === 1,
      'not deleted',
    )

    const rooms = await database.repositories.rooms.list()
    const devices = await database.repositories.devices.list()
    expect(rooms[0]?.path).toContain('Unassigned')
    expect(devices[0]?.roomId).toBe(rooms[0]?._id)
  })

  it('keeps the devices, which is the whole point', async () => {
    await database.repositories.rooms.save(room('room:k', 'Kitchen'))
    await database.repositories.devices.save(device('device:one', 'Lamp', 'room:k'))

    const element = await view()
    ;(element.querySelector('[data-delete-room]') as HTMLElement).click()
    await element.updateComplete
    ;(element.querySelector('[data-confirm-delete-room]') as HTMLElement).click()
    await waitUntil(
      async () => (await database.repositories.rooms.list()).length === 1,
      'not deleted',
    )

    expect(await database.repositories.devices.list()).toHaveLength(1)
  })

  it('reloads what was saved when a later write fails', async () => {
    await database.repositories.rooms.save(room('room:k', 'Kitchen'))
    await database.repositories.devices.save(device('device:one', 'Lamp', 'room:k'))

    const repositories: ProjectRepositories = {
      ...database.repositories,
      devices: {
        ...database.repositories.devices,
        save: async () => {
          throw new Error('later write failed')
        },
      },
    }
    const element = (await fixture(
      html`<rooms-view .repositories=${repositories}></rooms-view>`,
    )) as RoomsView
    await waitUntil(() => element.loaded, 'never loaded')
    ;(element.querySelector('[data-delete-room]') as HTMLElement).click()
    await element.updateComplete
    ;(element.querySelector('[data-confirm-delete-room]') as HTMLElement).click()

    await waitUntil(() => element.querySelector('[data-rooms-failed]') !== null, 'no message')
    await element.updateComplete

    expect(paths(element)).toContain('Unassigned')
    expect(element.querySelector('[data-rooms-failed]')?.textContent).toContain(
      'Some changes may have been saved',
    )
  })

  it('asks even when the room is empty', async () => {
    // An optional-when-empty parameter is an optional parameter, and the caller who forgets it
    // is the caller who did not check. The interface asks for the same reason the signature does.
    await database.repositories.rooms.save(room('room:k', 'Kitchen'))

    const element = await view()
    ;(element.querySelector('[data-delete-room]') as HTMLElement).click()
    await element.updateComplete

    expect(element.querySelector('[data-delete-room-dialog]')).not.toBeNull()
  })
})

describe('a project somebody may only read', () => {
  it('offers the controls when it can be written to', async () => {
    // The positive control: a view rendering no controls at all would satisfy the assertion
    // below while being broken for everybody.
    await database.repositories.rooms.save(room('room:k', 'Kitchen'))
    const element = await view()
    expect(element.querySelector('[data-delete-room]')).not.toBeNull()
  })

  it('removes them entirely rather than disabling them', async () => {
    useProjectDatabase('project_readonly', false)
    await database.repositories.rooms.save(room('room:k', 'Kitchen'))

    const element = await view()
    expect(element.querySelector('[data-delete-room]')).toBeNull()
    expect(element.querySelector('[data-rename]')).toBeNull()
  })
})
