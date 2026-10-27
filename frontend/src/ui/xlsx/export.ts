/**
 * Exporting the device inventory as an Excel workbook (#295): the words, the file name, and
 * the download.
 *
 * Reached only through the dynamic import in `views/device-list.ts`, like the PDF builders
 * beside it, so the writer travels in a chunk only the Export button downloads —
 * `scripts/check-lazy-xlsx.mjs` is what keeps that true. The format lives in
 * `domain/xlsx/workbook.ts` (where the no-dependency decision is recorded), the rows in
 * `domain/xlsx/sheet.ts`, and this is the seam where `msg()` is allowed — the same division as
 * `ui/pdf/download.ts` for the inventory PDF.
 *
 * Deep imports from `domain/` rather than the barrel, as `ui/archive` does: the barrel is in
 * the entry chunk's static closure, and a barrel re-export is one tree-shaking regression away
 * from carrying the writer into the first load.
 *
 * @module
 */

import { msg } from '@lit/localize'
import type { DeviceGroup } from '../../domain/documents/browse.js'
import { type DeviceSheetWords, deviceRows } from '../../domain/xlsx/sheet.js'
import { writeXlsx } from '../../domain/xlsx/workbook.js'
import { streamCodecs } from '../archive/codec.js'
import { offerDownload } from '../pdf/download.js'

/** The column headers and the test vendor's name, in whatever language is active right now. */
export function xlsxWords(): DeviceSheetWords {
  return {
    room: msg('Room'),
    spot: msg('Spot'),
    name: msg('Name'),
    type: msg('Device type'),
    vendor: msg('Manufacturer'),
    product: msg('Product'),
    serial: msg('Serial number'),
    installed: msg('Installed'),
    pairingCode: msg('Pairing code'),
    payload: msg('QR payload', {
      desc: 'Column header for the MT: string a device QR code encodes.',
    }),
    testVendor: msg('Test vendor'),
  }
}

/** A filename with the date in it, on the same pattern as the PDF's and for the same reason. */
export function xlsxFilename(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return `matter-manager-${local.toISOString().slice(0, 10)}.xlsx`
}

/**
 * The workbook for these groups, in the interface's language.
 *
 * @param groups from `browseDevices` — already filtered and ordered by room path then name,
 *   so the sheet, the PDF and the screen agree about what the project contains
 */
export function buildDeviceXlsx(groups: readonly DeviceGroup[]): Promise<Uint8Array> {
  return writeXlsx(
    // The tab carries the page's own name for the same list of devices.
    { name: msg('Devices'), rows: deviceRows(groups, xlsxWords()) },
    streamCodecs,
    new Date(),
  )
}

/** Offers the workbook as a download, under its own media type rather than the PDF default. */
export function offerXlsxDownload(bytes: Uint8Array, filename: string): void {
  offerDownload(
    bytes,
    filename,
    document,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
}
