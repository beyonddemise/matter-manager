/**
 * How a draft is marked on paper (#358), shared by the inventory and the label sheet.
 *
 * A module of its own so that neither PDF builder imports the other: each travels in its own
 * lazy chunk (`check:lazy-pdf`), and this is all they share.
 *
 * @module
 */

import type { StoredDevice } from '../../domain/index.js'

/**
 * The words a draft is printed with.
 *
 * In words, not in a colour: a printout is often black and white, and the product owner asked
 * for "Draft" as text wherever a draft shows.
 */
export interface DraftWords {
  /** The name line of a draft, e.g. "Draft: Hall sensor". */
  readonly marked: (name: string) => string
  /** Stands in for the name of a draft that has none yet. */
  readonly untitled: string
  /** Shown in place of a QR for a draft with no setup code yet. */
  readonly noSetupCode: string
}

/** The name line for any stored device: its name, or for a draft its name marked as one. */
export function printedName(device: StoredDevice, words: DraftWords): string {
  return device.status === 'draft' ? words.marked(device.name ?? words.untitled) : device.name
}
