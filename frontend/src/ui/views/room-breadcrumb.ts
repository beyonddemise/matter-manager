/**
 * A room path as the interface shows it: `Attic › Studio`, never the `Attic/Studio` it is stored
 * as. Shared by the device list's room headings and the device page's Room field so the two read
 * and sound the same (#242, #248).
 *
 * @module
 */

import { html } from 'lit'
import { splitRoomPath } from '../../domain/index.js'

/**
 * What a screen reader hears between two segments: a comma and a space, so `Attic › Studio` is
 * announced "Attic, Studio" and reads as one place at every punctuation level (#248).
 */
export const SPOKEN_CRUMB_SEPARATOR = ', '

/**
 * A room path as a breadcrumb, `Attic › Studio`, for headings, the export menu and the Room field.
 *
 * The parents are quiet and the room's own segment carries the emphasis, because that is the
 * part that tells two sibling rooms apart. It is text, not `<wa-breadcrumb>`, which renders a
 * `<nav>` of links; this is a name, not navigation.
 *
 * The `›` is decoration and is hidden from assistive technology; in its place a visually hidden
 * {@link SPOKEN_CRUMB_SEPARATOR} makes the accessible name "Attic, Studio". Search is unaffected:
 * it matches the stored path, not this rendering.
 *
 * Written without whitespace between the spans on purpose: any would end up in the accessible
 * name. The visual spacing around the `›` comes from CSS.
 *
 * @param path the stored room path, `Attic/Studio`
 */
export function roomBreadcrumb(path: string) {
  const segments = splitRoomPath(path)
  const own = segments[segments.length - 1]
  return html`${segments.slice(0, -1).map((parent) => html`<span class="app-room-parent" data-room-parent>${parent}</span><span class="app-room-crumb" aria-hidden="true">›</span><span class="wa-visually-hidden">${SPOKEN_CRUMB_SEPARATOR}</span>`)}<span data-room-own>${own}</span>`
}
