import { msg } from '@lit/localize'
import { html, type TemplateResult } from 'lit'
import {
  type CatalogLookup,
  catalogNames,
  type DeviceDraft,
  DraftError,
  PayloadError,
  type PayloadProblem,
  planNewDevice,
  readCredential,
} from '../../domain/index.js'
import type { CatalogApi } from '../catalog.js'
import { catalog } from '../composition.js'
import { imageMessage } from '../i18n/problems.js'
import { codesFromImage, type ImageProblem, ImageScanError } from '../scan/image.js'
import { cameraSource, type ScanSource } from '../scan/source.js'
import { accessToken } from '../tokens.js'
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

/** How long typing must pause before the code is looked up (spec §Adding a device). */
export const LOOKUP_DEBOUNCE_MS = 300

/** Where the background lookup stands, and for which code. */
type LookupState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly code: string }
  | { readonly kind: 'found'; readonly code: string; readonly result: CatalogLookup }

const IDLE: LookupState = { kind: 'idle' }

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
    uploadProblem: { state: true },
    catalog: { attribute: false },
    lookupState: { state: true },
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
  /** Why the last chosen picture produced no code, if it produced none. */
  declare uploadProblem: ImageProblem | PayloadProblem | undefined
  /** Bound by a test to a decoder that is not one; the real one otherwise. */
  decodeImage: (file: Blob) => Promise<readonly string[]> = codesFromImage
  /** Bound by a test to a fake; the real API otherwise. */
  declare catalog?: CatalogApi
  /** Where the background lookup stands. Never read by anything that saves except `onSubmit`. */
  declare lookupState: LookupState
  /**
   * Whether a lookup may be attempted at all. Plain fields rather than reactive properties,
   * like {@link decodeImage}: a test binds them, nothing renders from them.
   *
   * `signedIn` asks for a token rather than the shell's session state, which this view cannot
   * see; a token is exactly what the request needs.
   */
  signedIn: () => boolean = () => accessToken() !== undefined
  /** `navigator.onLine` is trusted only to say *offline* (`connectivity.ts`). */
  online: () => boolean = () => navigator.onLine !== false

  private lookupTimer: ReturnType<typeof setTimeout> | undefined
  private lookupAbort: AbortController | undefined

  constructor() {
    super()
    this.canScan = false
    this.scanChecked = false
    this.scanOpen = false
    this.uploadProblem = undefined
    this.lookupState = IDLE
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

  override disconnectedCallback(): void {
    // The form closing is one of the two moments the spec aborts a lookup; the other is the
    // code changing. Nothing reactive is set here: the element is leaving.
    this.stopLookup()
    super.disconnectedCallback()
  }

  /**
   * The code as the catalogue should receive it, or `undefined` when there is nothing to ask:
   * not a readable code, or an 11-digit code, which carries no vendor or product id.
   *
   * Normalised (the payload, or the digits of a manual code), so "the same code typed with a
   * trailing space" is recognised as the same question.
   */
  private lookupCode(): string | undefined {
    let credential: ReturnType<typeof readCredential>
    try {
      credential = readCredential(fieldValue(this, '[data-field="credential"]'))
    } catch {
      return undefined
    }
    if (credential.vendorId === undefined || credential.productId === undefined) return undefined
    return credential.payload ?? credential.manualCode
  }

  /** Stops whatever is scheduled or in flight, without touching what is shown. */
  private stopLookup(): void {
    clearTimeout(this.lookupTimer)
    this.lookupTimer = undefined
    this.lookupAbort?.abort()
    this.lookupAbort = undefined
  }

  /**
   * Starts a lookup for whatever the field now holds, after the debounce.
   *
   * Called on every change of the field: typing, a scan, an upload. Anything already scheduled
   * or in flight is aborted first, and the names on screen go with it, because they describe a
   * code that is no longer there. Never awaited by anything: submit reads {@link lookupState}
   * as it is at that moment.
   */
  private scheduleLookup(): void {
    const code = this.lookupCode()
    const state = this.lookupState
    if (code !== undefined && state.kind !== 'idle' && state.code === code) return

    this.stopLookup()
    this.lookupState = IDLE
    if (code === undefined || !this.signedIn() || !this.online()) return

    const controller = new AbortController()
    this.lookupAbort = controller
    this.lookupTimer = setTimeout(() => {
      void this.runLookup(code, controller.signal)
    }, LOOKUP_DEBOUNCE_MS)
  }

  /** Asks the catalogue about `code` and records the answer, unless it was superseded. */
  private async runLookup(code: string, signal: AbortSignal): Promise<void> {
    this.lookupTimer = undefined
    this.lookupState = { kind: 'pending', code }
    const outcome = await (this.catalog ?? catalog()).lookup(code, signal)
    // Aborted means a newer question replaced this one, or the form closed; either way this
    // answer is about nothing on screen.
    if (signal.aborted) return
    this.lookupAbort = undefined
    // Every failure ends the same way: no names, nothing alarming. Backfill catches up later.
    this.lookupState =
      outcome.kind === 'found' ? { kind: 'found', code, result: outcome.lookup } : IDLE
  }

  /**
   * The answer to pass to `planNewDevice`, or `undefined`.
   *
   * Only an answer for the code in the field *now*: one that landed for the code before it was
   * corrected must not name this device.
   */
  private answerForSave(): CatalogLookup | undefined {
    const state = this.lookupState
    return state.kind === 'found' && state.code === this.lookupCode() ? state.result : undefined
  }

  /** The hint while asking, the names once answered. Always in the tree, so it is announced. */
  private renderLookup(): TemplateResult {
    const state = this.lookupState
    return html`
      <div role="status" data-catalog-status>
        ${
          state.kind === 'pending'
            ? html`<small class="app-empty" data-catalog-pending>
                ${msg('Looking up manufacturer…')}
              </small>`
            : ''
        }
        ${state.kind === 'found' ? this.renderCatalogLines(catalogNames(state.result)) : ''}
      </div>
    `
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
    this.scheduleLookup()
    this.scanOpen = false
    // A code that was scanned cannot be malformed in the ways a typed one can, so an error
    // still on screen from an earlier attempt is now about text that is no longer there.
    if (this.error?.field === 'credential') this.error = undefined
  }

  /**
   * Reads a chosen picture, and fills the field if there is a setup code in it.
   *
   * Deliberately the same destination as {@link onScan}: a code from a photograph is one more
   * way to fill the field the form already has, not a second flow with a second idea of what a
   * setup code is. `readCredential` runs here only to decide whether what was decoded *is* one
   * - the form runs it again for real when it saves.
   */
  private async onUpload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    // Resetting lets the same file be chosen twice running. Without it the input holds the
    // previous selection, `change` never fires again, and a second attempt at the same
    // photograph appears to do nothing at all.
    input.value = ''
    if (file === undefined) return

    this.uploadProblem = undefined
    let codes: readonly string[]
    try {
      codes = await this.decodeImage(file)
    } catch (error) {
      if (!(error instanceof ImageScanError)) throw error
      this.uploadProblem = error.problem
      return
    }

    for (const code of codes) {
      try {
        readCredential(code)
      } catch (error) {
        if (!(error instanceof PayloadError)) throw error
        // Kept, and the next code tried: a device's box often carries two, and giving up
        // because the first one decoded was a URL would fail in the case this is most needed.
        this.uploadProblem = error.problem
        continue
      }
      this.setControlValue('[data-field="credential"]', code)
      this.scheduleLookup()
      this.uploadProblem = undefined
      if (this.error?.field === 'credential') this.error = undefined
      return
    }
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
        creation = planNewDevice(
          this.draft(),
          rooms,
          {
            uuid: () => crypto.randomUUID(),
            now: () => new Date().toISOString(),
          },
          // Whatever has arrived by now. Submit never waits for a lookup: saving offline, or
          // before the answer, is the normal case, and backfill fills the names in later.
          this.answerForSave(),
        )
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

    window.location.hash = '#/devices'
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
            @input=${() => this.scheduleLookup()}
          ></wa-input>

          ${this.renderLookup()}

          <div class="wa-cluster wa-gap-s">
            <!-- Absent, not disabled, when nothing here can scan. See {@link checkScanning}. -->
            ${
              this.canScan
                ? html`
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
                  `
                : ''
            }

            <!-- Always rendered, unlike the camera button beside it, and that asymmetry is the
                 feature. A machine with no camera shows no scan control at all, which is
                 precisely the person holding a photograph of the label instead. Nothing is
                 asked beforehand because every browser can choose a file; the only uncertainty
                 is decoding, and that is reported when it happens rather than guessed at
                 here - which also keeps the ZXing chunk off the page load. -->
            <wa-button
              data-upload
              type="button"
              appearance="outlined"
              @click=${() => {
                ;(this.querySelector('input[type="file"]') as HTMLInputElement | null)?.click()
              }}
            >
              <wa-icon slot="start" name="image"></wa-icon>
              ${msg('Upload an image')}
            </wa-button>

            <!-- Hidden rather than absent: the button above opens it, so it has to be in the
                 tree to be opened. The accept attribute filters the picker and enforces
                 nothing, which is why codesFromImage still answers for a file that is not an
                 image. No backticks in this comment: it sits inside a template literal, where
                 one would end it. -->
            <input
              type="file"
              accept="image/*"
              hidden
              @change=${(event: Event) => void this.onUpload(event)}
            />
          </div>

          ${
            this.uploadProblem === undefined
              ? ''
              : html`
                  <wa-callout variant="neutral" data-upload-problem>
                    <wa-icon slot="icon" name="circle-info"></wa-icon>
                    ${imageMessage(this.uploadProblem)}
                  </wa-callout>
                `
          }
        </div>

        ${this.renderFields()}

        <div class="wa-cluster wa-gap-s">
          <wa-button type="submit" variant="brand" ?disabled=${this.saving}>
            ${msg('Save device')}
          </wa-button>
          <wa-button href="#/devices" appearance="plain">${msg('Cancel')}</wa-button>
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
