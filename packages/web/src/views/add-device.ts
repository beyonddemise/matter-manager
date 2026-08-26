import { msg } from '@lit/localize'
import { type DeviceDraft, DraftError, planNewDevice } from '@matter-manager/core'
import { html } from 'lit'
import { cameraSource, type ScanSource } from '../scan/source.js'
import { DeviceFormView, fieldValue } from './device-form.js'
import './scan-dialog.js'

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
  static override properties = {
    ...DeviceFormView.properties,
    scanSource: { attribute: false },
    canScan: { state: true },
    scanChecked: { state: true },
    scanOpen: { state: true },
  }

  /** Bound by a test to a camera that is not one; the real one otherwise. */
  declare scanSource?: ScanSource
  /** Whether this browser can scan at all. Decides whether the control exists. */
  declare canScan: boolean
  /**
   * Whether the answer is in yet.
   *
   * Distinct from `canScan` being false, and only a test needs the difference: without it,
   * "the button is absent" is true before the check has finished and a test asserting it would
   * pass against a form that was about to grow one.
   */
  declare scanChecked: boolean
  declare scanOpen: boolean

  constructor() {
    super()
    this.canScan = false
    this.scanChecked = false
    this.scanOpen = false
  }

  protected override firstUpdated(): void {
    // The date is set once, imperatively, rather than bound in the template: a bound `value`
    // would be rewritten on every re-render, so the first validation error would silently
    // undo whatever date the user had chosen.
    this.setControlValue('[data-field="installed-at"]', today())
    void this.loadRooms()
    void this.checkScanning()
  }

  private resolvedSource: ScanSource | undefined
  private source(): ScanSource {
    this.resolvedSource ??= this.scanSource ?? cameraSource()
    return this.resolvedSource
  }

  /**
   * Asks, once, whether scanning is possible here.
   *
   * The answer decides whether the control is rendered at all. A disabled button that explains
   * itself when pressed would be worse than nothing on a desktop with no camera: it offers
   * something, takes a press, and then says no — which reads as a broken feature rather than
   * as a feature this machine cannot have.
   */
  private async checkScanning(): Promise<void> {
    try {
      this.canScan = await this.source().available()
    } catch {
      // A source that cannot even say whether it works is one to leave alone.
      this.canScan = false
    } finally {
      this.scanChecked = true
    }
  }

  /**
   * Puts a scanned code into the field, exactly as if it had been typed.
   *
   * Written to the control rather than held in a property, for the reason this whole form is
   * built that way: values here are imperative, so that a re-render cannot revert them.
   * `planNewDevice` reads the control on submit, so a scanned code and a typed one reach the
   * same validation by the same route — there is one place that turns text into a device.
   */
  private onScan(event: Event): void {
    const { credential } = (event as CustomEvent<{ credential: string }>).detail
    this.setControlValue('[data-field="credential"]', credential)
    this.scanOpen = false
    // A code that was scanned cannot be malformed in the ways a typed one can, so an error
    // still on screen from an earlier attempt is now about text that is no longer there.
    if (this.error?.field === 'credential') this.error = undefined
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

      // Stay on the form when storage refuses the write: navigating to a list that does not
      // contain the device would be the application saying it saved something it did not.
      if (!(await this.write(creation))) return
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

        <div class="wa-stack wa-gap-2xs">
          <wa-input
            data-field="credential"
            label=${msg('Setup code')}
            hint=${this.messageFor('credential') ?? msg('The MT: code from the QR label, or the numeric pairing code beneath it.')}
            autocomplete="off"
            spellcheck="false"
          ></wa-input>

          <!-- Absent, not disabled, when nothing here can scan. See {@link checkScanning}. -->
          ${
            this.canScan
              ? html`
                  <div class="wa-cluster wa-gap-s">
                    <wa-button
                      data-scan
                      type="button"
                      appearance="outlined"
                      @click=${() => {
                        this.scanOpen = true
                      }}
                    >
                      <wa-icon slot="start" name="camera"></wa-icon>
                      ${msg('Scan the code')}
                    </wa-button>
                  </div>
                `
              : ''
          }
        </div>

        ${this.renderFields()}

        <div class="wa-cluster wa-gap-s">
          <wa-button type="submit" variant="brand" ?disabled=${this.saving}>
            ${msg('Save device')}
          </wa-button>
          <wa-button href="#/" appearance="plain">${msg('Cancel')}</wa-button>
        </div>

        <!-- Outside the controls it fills, and outside the submit path entirely: the dialog
             hands over text and the form does what it would have done with typed text. -->
        <scan-dialog
          .source=${this.scanSource}
          ?open=${this.scanOpen}
          @scan=${this.onScan}
          @wa-after-hide=${() => {
            this.scanOpen = false
          }}
        ></scan-dialog>
      </form>
    `
  }
}

customElements.define('add-device-view', AddDeviceView)
