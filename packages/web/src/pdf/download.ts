/**
 * Handing a generated PDF to the user, and the strings it needs.
 *
 * The labels live here rather than in `pdf/inventory.ts` because that module is pure of
 * localisation on purpose: it takes the words it prints, so it can be tested without a locale
 * loaded and so the same layout code can serve a German document and an English one. This is
 * the seam where `msg()` is allowed.
 *
 * @module
 */

import { msg, str } from '@lit/localize'
import type { InventoryLabels } from './inventory.js'

/** The words the inventory prints, in whatever language is active right now. */
export function inventoryLabels(): InventoryLabels {
  return {
    title: msg('Matter Manager inventory'),
    pageNumber: (page, total) => msg(str`Page ${page} of ${total}`),
    continued: (path) => msg(str`${path} (continued)`),
    installed: msg('Installed'),
    pairingCode: msg('Pairing code'),
    noQrCode: msg('Filed from a pairing code'),
    withoutRoom: msg('Without a room'),
    nothingToExport: msg('There are no devices to export.'),
  }
}

/**
 * A filename with the date in it, so a folder of these sorts and reads.
 *
 * `YYYY-MM-DD` rather than a localised date: this is a filename, where sorting matters more
 * than familiarity, and a locale-formatted one puts the day first in half the world.
 */
export function inventoryFilename(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return `matter-manager-${local.toISOString().slice(0, 10)}.pdf`
}

/** The label sheet's filename, on the same pattern and for the same reason. */
export function labelsFilename(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return `matter-manager-labels-${local.toISOString().slice(0, 10)}.pdf`
}

/**
 * Offers the bytes to the user as a download.
 *
 * The object URL is revoked, and that is not housekeeping: each one pins its blob in memory
 * for the lifetime of the document, and an inventory of five hundred devices is not a small
 * blob to pin twice.
 *
 * Revoked on a later turn of the event loop rather than immediately — revoking in the same
 * task as the click is a race some browsers lose, producing a download that silently does not
 * happen.
 */
export function offerDownload(
  bytes: Uint8Array,
  filename: string,
  root: Document = document,
): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const link = root.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  root.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
