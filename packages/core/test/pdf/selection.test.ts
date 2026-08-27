import { describe, expect, it } from 'vitest'
import { browseDevices, type DeviceGroup } from '../../src/documents/browse.js'
import type { DeviceDocument, RoomDocument } from '../../src/documents/types.js'
import { countSelected, selectForExport } from '../../src/pdf/selection.js'
import { isWithinRoom } from '../../src/rooms/path.js'

const device = (
  id: string,
  roomId: string,
  extra: Partial<DeviceDocument> = {},
): DeviceDocument => ({
  _id: id,
  _rev: '1-a',
  updatedAt: '2026-08-19T08:00:00.000Z',
  type: 'device',
  name: id,
  roomId,
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

const room = (id: string, path: string): RoomDocument => ({
  _id: id,
  _rev: '1-a',
  updatedAt: '2026-08-19T08:00:00.000Z',
  type: 'room',
  path,
})

const group = (path: string, ...ids: string[]): DeviceGroup => ({
  roomId: `room:${path}`,
  path,
  devices: ids.map((id) => device(id, `room:${path}`)),
})

const names = (groups: readonly DeviceGroup[]): string[] =>
  groups.flatMap((entry) => entry.devices.map((one) => one._id))

describe('selecting what to export', () => {
  const GROUPS = [
    group('Ground Floor/Kitchen', 'device:a', 'device:b'),
    group('Ground Floor/Hall', 'device:c'),
    group('First Floor/Bathroom', 'device:d'),
  ]

  it('exports everything when nothing is narrowed', () => {
    expect(selectForExport(GROUPS, { kind: 'all' })).toBe(GROUPS)
  })

  it('exports only the devices that were ticked', () => {
    const chosen = selectForExport(GROUPS, {
      kind: 'devices',
      ids: new Set(['device:a', 'device:d']),
    })

    expect(names(chosen)).toEqual(['device:a', 'device:d'])
  })

  it('drops a room left with nothing in it', () => {
    // A PDF of one room that also lists every other room as a heading with nothing under it
    // is a document that has misunderstood the request.
    const chosen = selectForExport(GROUPS, { kind: 'devices', ids: new Set(['device:a']) })

    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.path).toBe('Ground Floor/Kitchen')
  })

  it('exports a room and everything below it', () => {
    const chosen = selectForExport(GROUPS, { kind: 'room', path: 'Ground Floor' })

    expect(names(chosen)).toEqual(['device:a', 'device:b', 'device:c'])
  })

  it('exports a leaf room without reaching sideways', () => {
    const chosen = selectForExport(GROUPS, { kind: 'room', path: 'Ground Floor/Kitchen' })

    expect(names(chosen)).toEqual(['device:a', 'device:b'])
  })

  it('does not take Floor 10 along with Floor 1', () => {
    // The trap this whole rule exists for. `startsWith` puts a room in a building it was never
    // in — and in an export, the result is a PDF quietly containing rooms nobody asked for,
    // handed to someone else.
    const floors = [group('Floor 1/Kitchen', 'device:one'), group('Floor 10/Kitchen', 'device:ten')]

    expect(names(selectForExport(floors, { kind: 'room', path: 'Floor 1' }))).toEqual([
      'device:one',
    ])
  })

  it('leaves out devices whose room no longer exists', () => {
    // They show on screen under "Without a room", and belong to no room's export. Including
    // them in every room export would be worse than either alternative.
    const orphaned = [...GROUPS, group('', 'device:lost')]

    expect(names(selectForExport(orphaned, { kind: 'room', path: 'Ground Floor' }))).not.toContain(
      'device:lost',
    )
  })

  it('exports nothing for a room named by an empty path', () => {
    // An empty path is what an uninitialised variable looks like, not what a request looks
    // like — the interface offers no room export for devices whose room is gone. Reading it
    // permissively would mean a bug elsewhere silently produces a PDF of exactly the devices
    // nobody asked about, handed to someone else.
    const orphaned = [...GROUPS, group('', 'device:lost')]

    expect(selectForExport(orphaned, { kind: 'room', path: '' })).toEqual([])
  })

  it('keeps the order it was given', () => {
    const chosen = selectForExport(GROUPS, {
      kind: 'devices',
      ids: new Set(['device:d', 'device:a']),
    })

    expect(names(chosen)).toEqual(['device:a', 'device:d'])
  })

  it('exports nothing when nothing is ticked', () => {
    expect(selectForExport(GROUPS, { kind: 'devices', ids: new Set() })).toEqual([])
  })

  it('counts what a selection would export', () => {
    expect(countSelected(GROUPS, { kind: 'all' })).toBe(4)
    expect(countSelected(GROUPS, { kind: 'room', path: 'Ground Floor' })).toBe(3)
    expect(countSelected(GROUPS, { kind: 'devices', ids: new Set(['device:a']) })).toBe(1)
  })
})

describe('disabled devices in an export', () => {
  const DEVICES = [
    device('device:live', 'room:kitchen'),
    device('device:old', 'room:kitchen', { disabled: true }),
  ]
  const ROOMS = [room('room:kitchen', 'Ground Floor/Kitchen')]

  it('leaves them out, because the browse that produced the groups did', () => {
    // The criterion is met by *not having a second opinion*. A device the user cannot see on
    // screen cannot appear in a PDF they hand to someone else, whatever they select.
    const groups = browseDevices(DEVICES, ROOMS)

    expect(names(selectForExport(groups, { kind: 'all' }))).toEqual(['device:live'])
    expect(names(selectForExport(groups, { kind: 'room', path: 'Ground Floor' }))).toEqual([
      'device:live',
    ])
  })

  it('includes them when the user has explicitly asked to see them', () => {
    const groups = browseDevices(DEVICES, ROOMS, { includeDisabled: true })

    expect(names(selectForExport(groups, { kind: 'all' }))).toEqual(['device:live', 'device:old'])
  })

  it('cannot be talked into one by ticking it', () => {
    // A disabled device is not in the groups at all, so its id in the selection matches
    // nothing. Worth pinning: the alternative implementation - filtering the raw device list
    // by id - would export it.
    const groups = browseDevices(DEVICES, ROOMS)

    expect(
      names(selectForExport(groups, { kind: 'devices', ids: new Set(['device:old']) })),
    ).toEqual([])
  })
})

describe('whether a path is inside a room', () => {
  it.each([
    ['Ground Floor/Kitchen', 'Ground Floor', true],
    ['Ground Floor', 'Ground Floor', true],
    ['Ground Floor/Kitchen/Pantry', 'Ground Floor', true],
    ['Floor 10/Kitchen', 'Floor 1', false],
    ['Ground Floor', 'Ground Floor/Kitchen', false],
    ['First Floor/Bath', 'Ground Floor', false],
  ])('%s within %s is %s', (path, root, expected) => {
    expect(isWithinRoom(path, root)).toBe(expected)
  })

  it('is case-sensitive, because ADR 0006 makes case distinguish rooms', () => {
    expect(isWithinRoom('ground floor/Kitchen', 'Ground Floor')).toBe(false)
  })

  it('ignores whitespace around segments on either side', () => {
    expect(isWithinRoom(' Ground Floor / Kitchen ', 'Ground Floor')).toBe(true)
  })
})
