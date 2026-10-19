/**
 * Counts in words. `@lit/localize` has no plural forms, so the singular is its own message;
 * one helper per noun keeps every caller saying it the same way, and lets the extractor see one
 * message rather than several that must be kept identical by hand.
 *
 * @module
 */

import { msg, str } from '@lit/localize'

/** "1 device", "3 devices". */
export function deviceCountText(count: number): string {
  return count === 1 ? msg('1 device') : msg(str`${count} devices`, { desc: 'A count of devices.' })
}
