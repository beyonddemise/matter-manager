import { msg } from '@lit/localize'
import { type DeviceDraft, DraftError, planNewDevice } from '@matter-manager/core'
import { html } from 'lit'
import { DeviceFormView, fieldValue } from './device-form.js'

/** Today, as `<input type="date">` writes it: a calendar date in the user's own timezone. */
function today(): string {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  // `toISOString` is UTC, which is why the offset is subtracted first: without it, anyone east
  // of Greenwich filing a device late in the evening would have it dated tomorrow.
  return local.toISOString().slice(0, 10)
}

/**
 * The add-a-device form.
 *
 * One field takes the setup code in either form it comes in — an `MT:` payload or a manual
 * pairing code — because a person holding a label does not first classify what is printed on
 * it. `readCredential` in `core` decides, and the camera in M2b-1 becomes one more way to fill
 * the same field rather than a second flow.
 *
 * Nothing is written until every field has passed: `planNewDevice` returns documents rather
 * than saving them, so "an invalid payload creates no device" is a property of the code's
 * shape rather than of remembering to return early.
 *
 * Everything shared with the edit form lives in {@link DeviceFormView}; what is here is the
 * setup code, the date default, and what happens on save.
 */
export class AddDeviceView extends DeviceFormView {
  protected override firstUpdated(): void {
    // The date is set once, imperatively, rather than bound in the template: a bound `value`
    // would be rewritten on every re-render, so the first validation error would silently
    // undo whatever date the user had chosen.
    this.setControlValue('[data-field="installed-at"]', today())
    void this.loadRooms()
  }

  private draft(): DeviceDraft {
    return { ...this.fields(), credential: fieldValue(this, '[data-field="credential"]') }
  }

  private async onSubmit(event: Event): Promise<void> {
    event.preventDefault()
    if (this.saving) return
    // Set before the first `await`, not after the planning: two quick clicks would otherwise
    // both get past the guard while the room read below was still in flight.
    this.saving = true

    try {
      // Re-read the rooms rather than planning against `this.rooms`.
      //
      // `firstUpdated` starts that read asynchronously, so a user who types the name of an
      // existing room and saves before it lands would be planned against an empty list - and
      // `planNewDevice`, seeing no match, would create a *second* room with the same path.
      // That is precisely the duplicate this flow exists to prevent, and it would appear only
      // on a slow device or a large catalogue, which is where nobody is watching for it.
      //
      // Re-reading closes the window completely rather than narrowing it, and it costs one
      // ranged `_all_docs` on a deliberate action. It also picks up a room another tab created
      // since this form was opened.
      const rooms = await this.repos().rooms.list()
      this.rooms = rooms

      let creation: ReturnType<typeof planNewDevice>
      try {
        creation = planNewDevice(this.draft(), rooms, {
          uuid: () => crypto.randomUUID(),
          now: () => new Date().toISOString(),
        })
      } catch (problem) {
        if (problem instanceof DraftError) {
          this.error = problem
          return
        }
        // Anything else is a bug rather than a statement about the form, and swallowing it
        // here would show the user a validation message for a fault that is not theirs.
        // Unreachable from the form and deliberately left uncovered; see the matching note in
        // `core/src/documents/new-device.ts`.
        throw problem
      }

      this.error = undefined

      // The room first. PouchDB has no transactions, so a failure between the two writes
      // leaves either nothing or an empty room - and an empty room is harmless and reusable,
      // whereas a device pointing at a room that does not exist is a broken record.
      if (creation.room !== undefined) {
        await this.repos().rooms.save(creation.room)
      }
      await this.repos().devices.save(creation.device)
    } finally {
      this.saving = false
    }

    window.location.hash = '#/'
  }

  override render() {
    return html`
      <form class="wa-stack wa-gap-l app-form" @submit=${this.onSubmit} novalidate>
        <h1>${msg('Add a device')}</h1>

        ${this.renderError()}

        <wa-input
          data-field="credential"
          label=${msg('Setup code')}
          hint=${this.messageFor('credential') ?? msg('The MT: code from the QR label, or the numeric pairing code beneath it.')}
          autocomplete="off"
          spellcheck="false"
        ></wa-input>

        ${this.renderFields()}

        <div class="wa-cluster wa-gap-s">
          <wa-button type="submit" variant="brand" ?disabled=${this.saving}>
            ${msg('Save device')}
          </wa-button>
          <wa-button href="#/" appearance="plain">${msg('Cancel')}</wa-button>
        </div>
      </form>
    `
  }
}

customElements.define('add-device-view', AddDeviceView)
