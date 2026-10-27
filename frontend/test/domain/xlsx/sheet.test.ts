import { describe, expect, it } from 'vitest'
import { browseDevices, type DeviceGroup } from '../../../src/domain/documents/browse.js'
import type { DeviceDocument } from '../../../src/domain/documents/types.js'
import { type DeviceSheetWords, deviceRows } from '../../../src/domain/xlsx/sheet.js'

/**
 * The sheet model: one row per device, the issue's ten columns, in the order the groups
 * arrive — which, coming from `browseDevices`, is room path then name (#295).
 */

/** English stand-ins; the real ones arrive through `msg()` in the web layer. */
const WORDS: DeviceSheetWords = {
  room: 'Room',
  spot: 'Spot',
  name: 'Name',
  type: 'Device type',
  vendor: 'Manufacturer',
  product: 'Product',
  serial: 'Serial number',
  installed: 'Installed',
  pairingCode: 'Pairing code',
  payload: 'QR payload',
  testVendor: 'Testhersteller',
}

const device = (
  name: string,
  room: string,
  extra: Partial<DeviceDocument> = {},
): DeviceDocument => ({
  _id: `device:${name}`,
  _rev: '1-a',
  updatedAt: '2026-08-26T09:00:00.000Z',
  type: 'device',
  name,
  room,
  manualCode: '34970112332',
  installedAt: '2026-08-26',
  addedAt: '2026-08-26T09:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

const group = (path: string, devices: readonly DeviceDocument[]): DeviceGroup => ({
  key: path.toLowerCase(),
  path,
  spellings: path === '' ? [] : [path],
  devices,
})

describe('deviceRows', () => {
  it('starts with the header row, in column order', () => {
    const [header] = deviceRows([], WORDS)

    expect(header).toEqual([
      'Room',
      'Spot',
      'Name',
      'Device type',
      'Manufacturer',
      'Product',
      'Serial number',
      'Installed',
      'Pairing code',
      'QR payload',
    ])
  })

  it('writes one row per device with every column filled', () => {
    const rows = deviceRows(
      [
        group('Ground Floor/Kitchen', [
          device('Hue bulb', 'Ground Floor/Kitchen', {
            spot: 'ceiling, north end',
            deviceTypeId: 0x010d,
            vendorName: 'Signify Netherlands B.V.',
            vendorPreferredName: 'Philips Hue',
            productName: 'Hue A19',
            serial: 'SN-123',
            payload: 'MT:Y.K9042C00KA0648G00',
          }),
        ]),
      ],
      WORDS,
    )

    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual([
      'Ground Floor/Kitchen',
      'ceiling, north end',
      'Hue bulb',
      '0x010D',
      'Philips Hue',
      'Hue A19',
      'SN-123',
      '2026-08-26',
      '34970112332',
      'MT:Y.K9042C00KA0648G00',
    ])
  })

  it('leaves empty cells, not an error, for a device without a catalogue match or serial', () => {
    const rows = deviceRows([group('Attic', [device('Bare bulb', 'Attic')])], WORDS)

    expect(rows[1]).toEqual([
      'Attic',
      '', // no spot
      'Bare bulb',
      '', // no device type
      '', // no vendor
      '', // no product
      '', // no serial
      '2026-08-26',
      '34970112332',
      '', // filed from a manual code: no MT: payload, and none can be invented
    ])
  })

  it('falls back from the preferred vendor name to the vendor name', () => {
    const rows = deviceRows(
      [group('Attic', [device('Bulb', 'Attic', { vendorName: 'Signify' })])],
      WORDS,
    )

    expect(rows[1]?.[4]).toBe('Signify')
  })

  it('shows the test vendor under its translated name, as the list and the PDF do', () => {
    const rows = deviceRows(
      [group('Attic', [device('Bulb', 'Attic', { vendorName: 'Test vendor' })])],
      WORDS,
    )

    expect(rows[1]?.[4]).toBe('Testhersteller')
  })

  it('keeps the pairing code as text, never as a number', () => {
    // A 21-digit code is beyond IEEE-754's 15 significant digits, and an 11-digit one can
    // start with 0. Either way a numeric cell would corrupt the one value this product
    // exists to reproduce.
    const rows = deviceRows(
      [group('Attic', [device('Bulb', 'Attic', { manualCode: '000000000000000000001' })])],
      WORDS,
    )

    expect(rows[1]?.[8]).toBe('000000000000000000001')
  })

  it('orders rows by room path, then device name, as browseDevices groups them', () => {
    // Deliberately shuffled: the order must come from the grouping, not from the input.
    const devices = [
      device('Zuluft', 'Kitchen'),
      device('Mirror light', 'Attic/Studio'),
      device('Lamp', 'Kitchen'),
      device('Heater', 'Attic'),
    ]

    const rows = deviceRows(browseDevices(devices), WORDS)

    expect(rows.slice(1).map((row) => [row[0], row[2]])).toEqual([
      ['Attic', 'Heater'],
      ['Attic/Studio', 'Mirror light'],
      ['Kitchen', 'Lamp'],
      ['Kitchen', 'Zuluft'],
    ])
  })

  it('leaves the room cell empty for devices without a room', () => {
    const rows = deviceRows([group('', [device('Orphan', '')])], WORDS)

    expect(rows[1]?.[0]).toBe('')
    expect(rows[1]?.[2]).toBe('Orphan')
  })

  it('produces only the header for no devices at all', () => {
    expect(deviceRows([], WORDS)).toHaveLength(1)
  })
})
