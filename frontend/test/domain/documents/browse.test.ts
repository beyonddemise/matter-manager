import { describe, expect, it } from 'vitest'
import { browseDevices } from '../../../src/domain/documents/browse.js'
import type { DeviceDocument } from '../../../src/domain/documents/types.js'

const device = (
  name: string,
  room: string,
  extra: Partial<DeviceDocument> = {},
): DeviceDocument => ({
  _id: `device:${name.toLowerCase().replace(/\s+/g, '-')}`,
  _rev: '1-a',
  updatedAt: '2026-08-20T10:00:00.000Z',
  type: 'device',
  name,
  room,
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

const KITCHEN = 'Ground Floor/Kitchen'
const BATH = 'First Floor/Bathroom'

/** A device written before ADR 0021: it has a `roomId` and no `room`. No repair is made. */
const legacy = (name: string): DeviceDocument => {
  const { room: _room, ...rest } = device(name, '')
  return { ...rest, roomId: 'room:gone' } as unknown as DeviceDocument
}

/** The paths of the groups, in the order they were returned. */
const paths = (groups: ReturnType<typeof browseDevices>) => groups.map((group) => group.path)
/** The device names in each group, in order. */
const names = (groups: ReturnType<typeof browseDevices>) =>
  groups.map((group) => group.devices.map((d) => d.name))

describe('grouping', () => {
  it('puts each device under its room, with the room path', () => {
    const groups = browseDevices([device('Ceiling light', KITCHEN), device('Mirror light', BATH)])

    expect(paths(groups)).toEqual(['First Floor/Bathroom', 'Ground Floor/Kitchen'])
    expect(names(groups)).toEqual([['Mirror light'], ['Ceiling light']])
  })

  it('counts what is in each room', () => {
    const groups = browseDevices([
      device('Ceiling light', KITCHEN),
      device('Under-cabinet light', KITCHEN),
      device('Mirror light', BATH),
    ])

    expect(groups.map((group) => group.devices.length)).toEqual([1, 2])
  })

  it('produces no group for a room with nothing in it', () => {
    // A search for "kitchen" that also listed every empty room in the house would bury the
    // results it found.
    expect(paths(browseDevices([device('Ceiling light', KITCHEN)]))).toEqual([
      'Ground Floor/Kitchen',
    ])
  })

  it('keeps a device with no room, and puts it last', () => {
    // A stray document from before ADR 0021 carries no `room`. It must render rather than crash
    // or vanish: losing sight of a device is precisely the failure this application exists to
    // prevent.
    const groups = browseDevices([
      legacy('Orphan'),
      device('Blank', ''),
      device('Ceiling light', KITCHEN),
    ])

    expect(paths(groups)).toEqual(['Ground Floor/Kitchen', ''])
    expect(groups[1]?.key).toBe('')
    expect(groups[1]?.spellings).toEqual([])
    expect(names(groups)[1]).toEqual(['Blank', 'Orphan'])
  })

  it('orders devices within a room by name', () => {
    const groups = browseDevices([
      device('Under-cabinet light', KITCHEN),
      device('Ceiling light', KITCHEN),
      device('Extractor', KITCHEN),
    ])

    expect(names(groups)).toEqual([['Ceiling light', 'Extractor', 'Under-cabinet light']])
  })

  it('is empty when there is nothing to show', () => {
    expect(browseDevices([])).toEqual([])
  })

  it('keeps two devices with the same name in the order they came in', () => {
    // Two "Ceiling light"s in one room is ordinary in a kitchen with a spot for each. The
    // comparator returns 0 for them, so what must not happen is the pair swapping between
    // renders and the list appearing to shuffle on its own.
    const first = device('Ceiling light', KITCHEN, { spot: 'north' })
    const second = device('Ceiling light', KITCHEN, { spot: 'south' })
    const groups = browseDevices([
      { ...first, _id: 'device:a' },
      { ...second, _id: 'device:b' },
    ])

    expect(groups[0]?.devices.map((d) => d.spot)).toEqual(['north', 'south'])
  })
})

/**
 * #248: the test vendor is stored in English and shown in the interface language, so a person
 * searching in German types "Testhersteller". The domain holds no `msg()`; the view hands the
 * shown term in.
 */
describe('searching the localised test vendor', () => {
  const lamp = device('Bench lamp', KITCHEN, { vendorName: 'Test vendor' })
  const other = device('Mirror light', BATH, { vendorName: 'Example GmbH' })

  it('does not match the localised term unless it is passed in', () => {
    expect(browseDevices([lamp, other], { query: 'testhersteller' })).toEqual([])
  })

  it('matches the localised term when it is passed in, and only on test-vendor devices', () => {
    const groups = browseDevices([lamp, other], {
      query: 'testhersteller',
      testVendorTerm: 'Testhersteller',
    })
    expect(names(groups)).toEqual([['Bench lamp']])
  })

  it('still matches the stored English name', () => {
    const groups = browseDevices([lamp, other], {
      query: 'test vendor',
      testVendorTerm: 'Testhersteller',
    })
    expect(names(groups)).toEqual([['Bench lamp']])
  })
})

describe('search', () => {
  const catalogue = [
    device('Ceiling light', KITCHEN, { serial: 'SN-000123', productName: 'Smart Bulb A60' }),
    device('Mirror light', BATH, { vendorName: 'Example GmbH', spot: 'above the basin' }),
  ]

  it('matches a device name', () => {
    expect(names(browseDevices(catalogue, { query: 'mirror' }))).toEqual([['Mirror light']])
  })

  it('matches the room path, so a room name finds what is in it', () => {
    expect(names(browseDevices(catalogue, { query: 'kitchen' }))).toEqual([['Ceiling light']])
  })

  it('matches a serial number', () => {
    expect(names(browseDevices(catalogue, { query: 'sn-000123' }))).toEqual([['Ceiling light']])
  })

  it('matches a product name', () => {
    expect(names(browseDevices(catalogue, { query: 'bulb' }))).toEqual([['Ceiling light']])
  })

  it('matches a vendor name and a spot', () => {
    expect(names(browseDevices(catalogue, { query: 'example' }))).toEqual([['Mirror light']])
    expect(names(browseDevices(catalogue, { query: 'basin' }))).toEqual([['Mirror light']])
  })

  it('matches a part number and a preferred manufacturer name', () => {
    const withCatalogue = [
      ...catalogue,
      device('Door sensor', KITCHEN, {
        partNumber: 'AS056',
        vendorPreferredName: 'Aqara Home',
      }),
    ]
    expect(names(browseDevices(withCatalogue, { query: 'as056' }))).toEqual([['Door sensor']])
    expect(names(browseDevices(withCatalogue, { query: 'aqara home' }))).toEqual([['Door sensor']])
  })

  it('requires every term, so two words narrow rather than widen', () => {
    // "kitchen light" must find the light in the kitchen, not everything in the kitchen plus
    // every light in the house.
    expect(names(browseDevices(catalogue, { query: 'kitchen light' }))).toEqual([['Ceiling light']])
    expect(browseDevices(catalogue, { query: 'kitchen mirror' })).toEqual([])
  })

  it('ignores case and stray whitespace, because a search box receives both', () => {
    expect(names(browseDevices(catalogue, { query: '  CEILING   LIGHT ' }))).toEqual([
      ['Ceiling light'],
    ])
  })

  it('treats a blank query as no search at all', () => {
    expect(browseDevices(catalogue, { query: '   ' })).toHaveLength(2)
  })

  it('never matches the setup code, however exactly it is typed', () => {
    // A security property, not a nicety. `manualCode` and `payload` encode the passcode; a
    // search that matched them would confirm a guess - type digits, watch a device appear -
    // turning the list into an oracle for the one secret this application holds.
    const withCodes = [
      device('Ceiling light', KITCHEN, {
        manualCode: '34970112332',
        payload: 'MT:Y.K9042C00KA0648G00',
      }),
    ]

    expect(browseDevices(withCodes, { query: '34970112332' })).toEqual([])
    expect(browseDevices(withCodes, { query: 'MT:Y.K9042C00KA0648G00' })).toEqual([])
    expect(browseDevices(withCodes, { query: '3497' })).toEqual([])
  })

  it('still finds a device with no room', () => {
    // No room means no path to search, and the device must not disappear from search along
    // with it - that would be losing sight of exactly the device that most needs finding.
    const orphan = [device('Ceiling light', '', { serial: 'SN-000123' }), legacy('Old lamp')]

    expect(names(browseDevices(orphan, { query: 'ceiling' }))).toEqual([['Ceiling light']])
    expect(names(browseDevices(orphan, { query: 'lamp' }))).toEqual([['Old lamp']])
    expect(browseDevices(orphan, { query: 'kitchen' })).toEqual([])
  })

  it('does not let one term match across two fields', () => {
    // A term is whitespace-delimited, so the join character only matters for a term that
    // contains one. Joined on `/` - the obvious choice, since room paths already use it -
    // `light/ground` would match "Ceiling light" in "Ground Floor/Kitchen", reporting a device
    // that contains that string nowhere. A newline cannot appear in a folded query at all,
    // because `foldForComparison` collapses every run of whitespace to a single space.
    expect(browseDevices(catalogue, { query: 'light/ground' })).toEqual([])
    // The same two words as separate terms still match, which is the behaviour we want to keep.
    expect(names(browseDevices(catalogue, { query: 'light ground' }))).toEqual([['Ceiling light']])
  })
})

describe('disabled devices', () => {
  const catalogue = [
    device('Ceiling light', KITCHEN),
    device('Old sensor', KITCHEN, { disabled: true, disabledAt: '2026-07-01T00:00:00.000Z' }),
  ]

  it('leaves them out by default', () => {
    expect(names(browseDevices(catalogue))).toEqual([['Ceiling light']])
  })

  it('includes them when asked', () => {
    expect(names(browseDevices(catalogue, { includeDisabled: true }))).toEqual([
      ['Ceiling light', 'Old sensor'],
    ])
  })

  it('still filters them out under a search that would otherwise match', () => {
    expect(browseDevices(catalogue, { query: 'sensor' })).toEqual([])
    expect(names(browseDevices(catalogue, { query: 'sensor', includeDisabled: true }))).toEqual([
      ['Old sensor'],
    ])
  })

  it('drops a room whose only devices are disabled', () => {
    const onlyDisabled = [device('Old sensor', BATH, { disabled: true })]
    expect(browseDevices(onlyDisabled)).toEqual([])
  })
})

describe('ordering', () => {
  it('uses a supplied comparator for both rooms and devices', () => {
    // The web layer passes an `Intl.Collator` for the locale it is already rendering in.
    // Reversed here so that "it was used" and "it happened to agree" cannot be confused.
    const reversed = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
    const groups = browseDevices(
      [
        device('Ceiling light', KITCHEN),
        device('Extractor', KITCHEN),
        device('Mirror light', BATH),
      ],
      { compare: reversed },
    )

    expect(paths(groups)).toEqual(['Ground Floor/Kitchen', 'First Floor/Bathroom'])
    expect(names(groups)[0]).toEqual(['Extractor', 'Ceiling light'])
  })

  it('orders German umlauts sensibly when given a German collator', () => {
    // The reason `compare` is a parameter at all. The default folds and compares by code
    // point, which puts "Ärmelleuchte" after "Zuluft"; `Intl` in a German locale does not.
    const groups = browseDevices([device('Zuluft', KITCHEN), device('Ärmelleuchte', KITCHEN)], {
      compare: new Intl.Collator('de').compare,
    })

    expect(names(groups)).toEqual([['Ärmelleuchte', 'Zuluft']])
  })

  it("leaves the caller's arrays alone", () => {
    const devices = [device('Zulu', KITCHEN), device('Alpha', KITCHEN)]
    browseDevices(devices)
    expect(devices.map((d) => d.name)).toEqual(['Zulu', 'Alpha'])
  })
})

describe('room hierarchy (#242)', () => {
  const ATTIC = 'Attic'
  const STUDIO = 'Attic/Studio'
  const ATTIC_BEDROOM = 'Attic Bedroom'
  const GROUND = 'Ground Floor'
  const GROUND_KITCHEN = 'Ground Floor/Kitchen'
  const PANTRY = 'Ground Floor/Kitchen/Pantry'
  const HOUSE = [PANTRY, ATTIC_BEDROOM, GROUND_KITCHEN, STUDIO, GROUND, ATTIC]

  /** One device in each of the given rooms, named after the room so a failure is readable. */
  const oneIn = (...rooms: readonly string[]) =>
    rooms.map((path) => device(`Lamp in ${path}`, path))

  it('puts sub-rooms straight after their parent, before a sibling with a longer name', () => {
    expect(paths(browseDevices(oneIn(...HOUSE)))).toEqual([
      'Attic',
      'Attic/Studio',
      'Attic Bedroom',
      'Ground Floor',
      'Ground Floor/Kitchen',
      'Ground Floor/Kitchen/Pantry',
    ])
  })

  it('produces no heading for a parent that holds no devices itself', () => {
    // The breadcrumb on `Attic › Studio` already says where it is; an empty `Attic` group
    // would break the "never empty" promise every consumer relies on.
    expect(paths(browseDevices(oneIn(STUDIO, ATTIC_BEDROOM)))).toEqual([
      'Attic/Studio',
      'Attic Bedroom',
    ])
  })

  it('keeps three levels in order when the middle one is empty', () => {
    expect(paths(browseDevices(oneIn(PANTRY, GROUND, ATTIC_BEDROOM)))).toEqual([
      'Attic Bedroom',
      'Ground Floor',
      'Ground Floor/Kitchen/Pantry',
    ])
  })

  it('collates each segment with the supplied comparator', () => {
    const rooms = ['Haus/Zulu', 'Haus/Ärmel', 'Haus/Armel']

    expect(
      paths(browseDevices(oneIn(...rooms), { compare: new Intl.Collator('de').compare })),
    ).toEqual(['Haus/Armel', 'Haus/Ärmel', 'Haus/Zulu'])
  })

  it('still puts devices without a room last', () => {
    const groups = browseDevices([device('Orphan', ''), ...oneIn(STUDIO, ATTIC)])

    expect(paths(groups)).toEqual(['Attic', 'Attic/Studio', ''])
  })
})

/**
 * ADR 0021: a room is identified by its key, so two spellings of one room are one group. The
 * heading lists every spelling, as the Rooms page does, and neither is picked as the winner.
 */
describe('spellings of one room', () => {
  const spelled = [
    device('Ceiling light', 'Ground Floor/Kitchen'),
    device('Extractor', 'ground floor/kitchen'),
    device('Kettle', 'Ground Floor/KITCHEN'),
  ]
  /** Code-point order, so which spelling comes first is predictable here. */
  const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

  it('puts every spelling in one group', () => {
    const groups = browseDevices(spelled)

    expect(groups).toHaveLength(1)
    expect(names(groups)).toEqual([['Ceiling light', 'Extractor', 'Kettle']])
  })

  it('lists the spellings in path order, and heads the group with the first', () => {
    const [group] = browseDevices(spelled, { compare: byCodePoint })

    expect(group?.spellings).toEqual([
      'Ground Floor/KITCHEN',
      'Ground Floor/Kitchen',
      'ground floor/kitchen',
    ])
    expect(group?.path).toBe('Ground Floor/KITCHEN')
  })

  it('gives the same group whichever spelling arrives first', () => {
    // With the default comparator, which folds the spellings equal: code point breaks the tie,
    // so the order is not the order the devices came in.
    const one = browseDevices(spelled)
    const other = browseDevices([...spelled].reverse())

    expect(one[0]?.key).toBe(other[0]?.key)
    expect(one[0]?.spellings).toEqual(other[0]?.spellings)
    expect(one[0]?.path).toBe(other[0]?.path)
  })

  it('orders spellings a collator calls equal the same way every time', () => {
    // A composed and a decomposed `Küche` are canonically equivalent, so a locale collator
    // compares them as equal; the heading must not depend on which device was read first.
    const composed = 'K\u00fcche'
    const decomposed = 'Ku\u0308che'
    const collator = new Intl.Collator('de').compare
    const devices = [device('Lamp', composed), device('Fan', decomposed)]

    const one = browseDevices(devices, { compare: collator })
    const other = browseDevices([...devices].reverse(), { compare: collator })

    expect(one[0]?.spellings).toEqual(other[0]?.spellings)
  })

  it('lists one spelling once, however many devices carry it', () => {
    const [group] = browseDevices([device('A', KITCHEN), device('B', KITCHEN)])

    expect(group?.spellings).toEqual([KITCHEN])
  })

  it('lists only the spellings of the devices it shows', () => {
    // A search that hides the lower-case device should not leave its spelling in the heading.
    const [group] = browseDevices(spelled, { query: 'kettle' })

    expect(group?.spellings).toEqual(['Ground Floor/KITCHEN'])
  })
})

/** The filter the Rooms page links to: `#/devices?room=…`. */
describe('filtering to a room', () => {
  const house = [
    device('Ceiling light', 'Ground Floor/Kitchen'),
    device('Extractor', 'ground floor/kitchen'),
    device('Pantry light', 'Ground Floor/Kitchen/Pantry'),
    device('Hall light', 'Ground Floor/Hall'),
    device('Mirror light', BATH),
    device('Floor ten lamp', 'Ground Floor 10/Kitchen'),
    device('Orphan', ''),
    legacy('Old lamp'),
  ]

  it('shows the room and the rooms inside it', () => {
    expect(paths(browseDevices(house, { room: 'Ground Floor/Kitchen' }))).toEqual([
      'Ground Floor/Kitchen',
      'Ground Floor/Kitchen/Pantry',
    ])
  })

  it('takes every spelling of the room, whichever one the filter names', () => {
    expect(names(browseDevices(house, { room: 'GROUND FLOOR/KITCHEN' }))).toEqual([
      ['Ceiling light', 'Extractor'],
      ['Pantry light'],
    ])
  })

  it('does not reach across a segment boundary', () => {
    // `Ground Floor 10` starts with `Ground Floor` and is not in it.
    expect(names(browseDevices(house, { room: 'Ground Floor' })).flat()).not.toContain(
      'Floor ten lamp',
    )
  })

  it('never shows a device with no room', () => {
    const shown = names(browseDevices(house, { room: 'Ground Floor' })).flat()

    expect(shown).not.toContain('Orphan')
    expect(shown).not.toContain('Old lamp')
  })

  it('combines with a search, so both must match', () => {
    expect(names(browseDevices(house, { room: 'Ground Floor', query: 'light' }))).toEqual([
      ['Hall light'],
      ['Ceiling light'],
      ['Pantry light'],
    ])
    expect(browseDevices(house, { room: 'Ground Floor/Kitchen', query: 'mirror' })).toEqual([])
  })

  it('still leaves disabled devices out unless asked', () => {
    const withDisabled = [...house, device('Old sensor', KITCHEN, { disabled: true })]

    expect(names(browseDevices(withDisabled, { room: KITCHEN })).flat()).not.toContain('Old sensor')
    expect(
      names(browseDevices(withDisabled, { room: KITCHEN, includeDisabled: true })).flat(),
    ).toContain('Old sensor')
  })

  it('is empty for a room nothing is in', () => {
    expect(browseDevices(house, { room: 'Cellar' })).toEqual([])
  })
})
