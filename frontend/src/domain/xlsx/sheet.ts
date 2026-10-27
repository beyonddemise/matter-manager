/**
 * The device inventory as a flat sheet: one row per device, ten columns (#295).
 *
 * The same division of labour as `pdf/layout.ts`: what goes in which cell is a decision over
 * plain data, so it lives here and is tested in milliseconds; `xlsx/workbook.ts` turns the rows
 * into a file. **Grouping and order are not decided here** — `browseDevices` already decided
 * them for the screen, and the export flattens that answer, which is what keeps the sheet
 * reading like the list (and like the PDF inventory): room path first, then device name.
 *
 * Unknown facts become empty cells rather than placeholders or errors: a spreadsheet is made
 * for filtering, and a filter should find emptiness where there is nothing, not an `n/a` that
 * sorts between `Mirror` and `Zuluft`.
 *
 * @module
 */

import { manufacturerName, TEST_VENDOR_NAME } from '../catalog/copy.js'
import type { DeviceGroup } from '../documents/browse.js'

/**
 * The words the sheet carries, in whatever language is active: the ten column headers, plus
 * the test vendor's shown name. Passed in rather than looked up, because this package holds
 * no `msg()` and no ambient locale — the same seam as `InventoryLabels` in the PDF.
 */
export interface DeviceSheetWords {
  readonly room: string
  readonly spot: string
  readonly name: string
  readonly type: string
  readonly vendor: string
  readonly product: string
  readonly serial: string
  readonly installed: string
  readonly pairingCode: string
  readonly payload: string
  /** The test vendors' manufacturer name, stored in English as `TEST_VENDOR_NAME`. */
  readonly testVendor: string
}

/** A Matter id as every Matter document writes it, e.g. `0x010D`. */
const hex = (value: number | undefined): string =>
  value === undefined ? '' : `0x${value.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * The rows of the sheet, header first, every cell text.
 *
 * Text deliberately, including the two date-ish and two numeric-looking columns:
 *
 * - `installedAt` is already a calendar date (`YYYY-MM-DD`, ISO 8601), which sorts and filters
 *   correctly as text; converting it to an Excel serial date would mean choosing a display
 *   format and a 1900/1904 epoch for no gain.
 * - The pairing code **must not** become a number. A 21-digit manual code is beyond IEEE-754's
 *   15 significant digits, so a numeric cell would silently corrupt the one value this product
 *   exists to reproduce — and an 11-digit code may begin with a zero that a number drops.
 *
 * @param groups from `browseDevices` — already filtered, grouped and ordered by room path
 *   then name, so the sheet and the screen agree about what the project contains
 */
export function deviceRows(
  groups: readonly DeviceGroup[],
  words: DeviceSheetWords,
): readonly (readonly string[])[] {
  const header = [
    words.room,
    words.spot,
    words.name,
    words.type,
    words.vendor,
    words.product,
    words.serial,
    words.installed,
    words.pairingCode,
    words.payload,
  ]

  const rows = groups.flatMap((group) =>
    group.devices.map((device) => {
      // The preferred name, then the vendor name — and the test vendor under the name the
      // interface shows (#248), so the sheet matches what its reader searched for on screen.
      const vendor = manufacturerName(device)
      return [
        group.path,
        device.spot ?? '',
        device.name,
        hex(device.deviceTypeId),
        (vendor === TEST_VENDOR_NAME ? words.testVendor : vendor) ?? '',
        device.productName ?? '',
        device.serial ?? '',
        device.installedAt,
        device.manualCode,
        device.payload ?? '',
      ]
    }),
  )

  return [header, ...rows]
}
