import { describe, expect, it } from 'vitest'
import { browseDevices } from '../../src/documents/browse.js'
import type { DeviceDocument, RoomDocument } from '../../src/documents/types.js'

const room = (id: string, path: string): RoomDocument => ({
  _id: id,
  _rev: '1-a',
  updatedAt: '2026-08-20T10:00:00.000Z',
  type: 'room',
  path,
})

const device = (
  name: string,
  roomId: string,
  extra: Partial<DeviceDocument> = {},
): DeviceDocument => ({
  _id: `device:${name.toLowerCase().replace(/\s+/g, '-')}`,
  _rev: '1-a',
  updatedAt: '2026-08-20T10:00:00.000Z',
  type: 'device',
  name,
  roomId,
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

const KITCHEN = room('room:kitchen', 'Ground Floor/Kitchen')
const BATH = room('room:bath', 'First Floor/Bathroom')
const ROOMS = [KITCHEN, BATH]

/** The paths of the groups, in the order they were returned. */
const paths = (groups: ReturnType<typeof browseDevices>) => groups.map((group) => group.path)
/** The device names in each group, in order. */
const names = (groups: ReturnType<typeof browseDevices>) =>
  groups.map((group) => group.devices.map((d) => d.name))

describe('grouping', () => {
  it('puts each device under its room, with the room path', () => {
    const groups = browseDevices(
      [device('Ceiling light', KITCHEN._id), device('Mirror light', BATH._id)],
      ROOMS,
    )

    expect(paths(groups)).toEqual(['First Floor/Bathroom', 'Ground Floor/Kitchen'])
    expect(names(groups)).toEqual([['Mirror light'], ['Ceiling light']])
  })

  it('counts what is in each room', () => {
    const groups = browseDevices(
      [
        device('Ceiling light', KITCHEN._id),
        device('Under-cabinet light', KITCHEN._id),
        device('Mirror light', BATH._id),
      ],
      ROOMS,
    )

    expect(groups.map((group) => group.devices.length)).toEqual([1, 2])
  })

  it('produces no group for a room with nothing in it', () => {
    // A search for "kitchen" that also listed every empty room in the house would bury the
    // results it found.
    expect(paths(browseDevices([device('Ceiling light', KITCHEN._id)], ROOMS))).toEqual([
      'Ground Floor/Kitchen',
    ])
  })

  it('keeps a device whose room no longer exists, and puts it last', () => {
    // A room deleted on another replica must not make its devices invisible: losing sight of a
    // device is precisely the failure this application exists to prevent.
    const groups = browseDevices(
      [device('Orphan', 'room:gone'), device('Ceiling light', KITCHEN._id)],
      ROOMS,
    )

    expect(paths(groups)).toEqual(['Ground Floor/Kitchen', ''])
    expect(names(groups)[1]).toEqual(['Orphan'])
  })

  it('orders devices within a room by name', () => {
    const groups = browseDevices(
      [
        device('Under-cabinet light', KITCHEN._id),
        device('Ceiling light', KITCHEN._id),
        device('Extractor', KITCHEN._id),
      ],
      ROOMS,
    )

    expect(names(groups)).toEqual([['Ceiling light', 'Extractor', 'Under-cabinet light']])
  })

  it('is empty when there is nothing to show', () => {
    expect(browseDevices([], ROOMS)).toEqual([])
  })

  it('keeps two devices with the same name in the order they came in', () => {
    // Two "Ceiling light"s in one room is ordinary in a kitchen with a spot for each. The
    // comparator returns 0 for them, so what must not happen is the pair swapping between
    // renders and the list appearing to shuffle on its own.
    const first = device('Ceiling light', KITCHEN._id, { spot: 'north' })
    const second = device('Ceiling light', KITCHEN._id, { spot: 'south' })
    const groups = browseDevices(
      [
        { ...first, _id: 'device:a' },
        { ...second, _id: 'device:b' },
      ],
      ROOMS,
    )

    expect(groups[0]?.devices.map((d) => d.spot)).toEqual(['north', 'south'])
  })
})

describe('search', () => {
  const catalogue = [
    device('Ceiling light', KITCHEN._id, { serial: 'SN-000123', productName: 'Smart Bulb A60' }),
    device('Mirror light', BATH._id, { vendorName: 'Example GmbH', spot: 'above the basin' }),
  ]

  it('matches a device name', () => {
    expect(names(browseDevices(catalogue, ROOMS, { query: 'mirror' }))).toEqual([['Mirror light']])
  })

  it('matches the room path, so a room name finds what is in it', () => {
    expect(names(browseDevices(catalogue, ROOMS, { query: 'kitchen' }))).toEqual([
      ['Ceiling light'],
    ])
  })

  it('matches a serial number', () => {
    expect(names(browseDevices(catalogue, ROOMS, { query: 'sn-000123' }))).toEqual([
      ['Ceiling light'],
    ])
  })

  it('matches a product name', () => {
    expect(names(browseDevices(catalogue, ROOMS, { query: 'bulb' }))).toEqual([['Ceiling light']])
  })

  it('matches a vendor name and a spot', () => {
    expect(names(browseDevices(catalogue, ROOMS, { query: 'example' }))).toEqual([['Mirror light']])
    expect(names(browseDevices(catalogue, ROOMS, { query: 'basin' }))).toEqual([['Mirror light']])
  })

  it('requires every term, so two words narrow rather than widen', () => {
    // "kitchen light" must find the light in the kitchen, not everything in the kitchen plus
    // every light in the house.
    expect(names(browseDevices(catalogue, ROOMS, { query: 'kitchen light' }))).toEqual([
      ['Ceiling light'],
    ])
    expect(browseDevices(catalogue, ROOMS, { query: 'kitchen mirror' })).toEqual([])
  })

  it('ignores case and stray whitespace, because a search box receives both', () => {
    expect(names(browseDevices(catalogue, ROOMS, { query: '  CEILING   LIGHT ' }))).toEqual([
      ['Ceiling light'],
    ])
  })

  it('treats a blank query as no search at all', () => {
    expect(browseDevices(catalogue, ROOMS, { query: '   ' })).toHaveLength(2)
  })

  it('never matches the setup code, however exactly it is typed', () => {
    // A security property, not a nicety. `manualCode` and `payload` encode the passcode; a
    // search that matched them would confirm a guess - type digits, watch a device appear -
    // turning the list into an oracle for the one secret this application holds.
    const withCodes = [
      device('Ceiling light', KITCHEN._id, {
        manualCode: '34970112332',
        payload: 'MT:Y.K9042C00KA0648G00',
      }),
    ]

    expect(browseDevices(withCodes, ROOMS, { query: '34970112332' })).toEqual([])
    expect(browseDevices(withCodes, ROOMS, { query: 'MT:Y.K9042C00KA0648G00' })).toEqual([])
    expect(browseDevices(withCodes, ROOMS, { query: '3497' })).toEqual([])
  })

  it('still finds a device whose room is gone', () => {
    // No room means no path to search, and the device must not disappear from search along
    // with it - that would be losing sight of exactly the device that most needs finding.
    const orphan = [device('Ceiling light', 'room:gone', { serial: 'SN-000123' })]

    expect(names(browseDevices(orphan, ROOMS, { query: 'ceiling' }))).toEqual([['Ceiling light']])
    expect(browseDevices(orphan, ROOMS, { query: 'kitchen' })).toEqual([])
  })

  it('does not let one term match across two fields', () => {
    // A term is whitespace-delimited, so the join character only matters for a term that
    // contains one. Joined on `/` - the obvious choice, since room paths already use it -
    // `light/ground` would match "Ceiling light" in "Ground Floor/Kitchen", reporting a device
    // that contains that string nowhere. A newline cannot appear in a folded query at all,
    // because `foldForComparison` collapses every run of whitespace to a single space.
    expect(browseDevices(catalogue, ROOMS, { query: 'light/ground' })).toEqual([])
    // The same two words as separate terms still match, which is the behaviour we want to keep.
    expect(names(browseDevices(catalogue, ROOMS, { query: 'light ground' }))).toEqual([
      ['Ceiling light'],
    ])
  })
})

describe('disabled devices', () => {
  const catalogue = [
    device('Ceiling light', KITCHEN._id),
    device('Old sensor', KITCHEN._id, { disabled: true, disabledAt: '2026-07-01T00:00:00.000Z' }),
  ]

  it('leaves them out by default', () => {
    expect(names(browseDevices(catalogue, ROOMS))).toEqual([['Ceiling light']])
  })

  it('includes them when asked', () => {
    expect(names(browseDevices(catalogue, ROOMS, { includeDisabled: true }))).toEqual([
      ['Ceiling light', 'Old sensor'],
    ])
  })

  it('still filters them out under a search that would otherwise match', () => {
    expect(browseDevices(catalogue, ROOMS, { query: 'sensor' })).toEqual([])
    expect(
      names(browseDevices(catalogue, ROOMS, { query: 'sensor', includeDisabled: true })),
    ).toEqual([['Old sensor']])
  })

  it('drops a room whose only devices are disabled', () => {
    const onlyDisabled = [device('Old sensor', BATH._id, { disabled: true })]
    expect(browseDevices(onlyDisabled, ROOMS)).toEqual([])
  })
})

describe('ordering', () => {
  it('uses a supplied comparator for both rooms and devices', () => {
    // The web layer passes an `Intl.Collator` for the locale it is already rendering in.
    // Reversed here so that "it was used" and "it happened to agree" cannot be confused.
    const reversed = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
    const groups = browseDevices(
      [
        device('Ceiling light', KITCHEN._id),
        device('Extractor', KITCHEN._id),
        device('Mirror light', BATH._id),
      ],
      ROOMS,
      { compare: reversed },
    )

    expect(paths(groups)).toEqual(['Ground Floor/Kitchen', 'First Floor/Bathroom'])
    expect(names(groups)[0]).toEqual(['Extractor', 'Ceiling light'])
  })

  it('orders German umlauts sensibly when given a German collator', () => {
    // The reason `compare` is a parameter at all. The default folds and compares by code
    // point, which puts "Ärmelleuchte" after "Zuluft"; `Intl` in a German locale does not.
    const groups = browseDevices(
      [device('Zuluft', KITCHEN._id), device('Ärmelleuchte', KITCHEN._id)],
      ROOMS,
      { compare: new Intl.Collator('de').compare },
    )

    expect(names(groups)).toEqual([['Ärmelleuchte', 'Zuluft']])
  })

  it("leaves the caller's arrays alone", () => {
    const devices = [device('Zulu', KITCHEN._id), device('Alpha', KITCHEN._id)]
    browseDevices(devices, ROOMS)
    expect(devices.map((d) => d.name)).toEqual(['Zulu', 'Alpha'])
  })
})
