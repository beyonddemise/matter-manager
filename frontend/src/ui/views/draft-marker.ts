/**
 * How a draft shows on screen wherever a device does (#358): the device list, a room, the device
 * page. One module, so a draft is marked the same way everywhere.
 *
 * The marker is a word, "Draft", in a tag: WCAG 2.2 1.4.1 (not colour alone), and read out by a
 * screen reader as part of the row it sits in, because it is text rather than an icon.
 *
 * @module
 */

import { msg } from '@lit/localize'
import { html, type TemplateResult } from 'lit'
import { type StoredDevice, uuidOf } from '../../domain/index.js'

/** The word a draft is marked with. Also what a search for drafts matches (`draftTerm`). */
export function draftWord(): string {
  return msg('Draft', { id: 'draft.marker', desc: 'Marks a device saved before it was complete' })
}

/** A device's name as shown: its name, or for a draft that has none, a stand-in. */
export function shownName(device: StoredDevice): string {
  return device.name ?? msg('Untitled draft')
}

/** The draft marker, or nothing for a complete device. */
export function draftTag(device: StoredDevice): TemplateResult | '' {
  return device.status === 'draft'
    ? html`<wa-tag variant="warning" size="s" data-draft-marker>${draftWord()}</wa-tag>`
    : ''
}

/** Where a draft is finished: the add form, opened on it. */
export function finishAddress(device: StoredDevice): string {
  return `#/devices/${uuidOf(device._id) ?? ''}/finish`
}

/**
 * The "Finish" action for a draft, or nothing for a complete device. Named with the device for
 * assistive technology, as a list of identical "Finish" buttons would be indistinguishable
 * (WCAG 2.2 2.4.6).
 */
export function finishButton(device: StoredDevice): TemplateResult | '' {
  if (device.status !== 'draft') return ''
  return html`
    <wa-button data-finish size="s" variant="brand" appearance="outlined" href=${finishAddress(device)}>
      ${msg('Finish')}<span class="wa-visually-hidden">: ${shownName(device)}</span>
    </wa-button>
  `
}
