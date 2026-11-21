// Rendered by this form and by nothing else, so imported here (#214), like the combobox in
// `device-form.ts`: they travel in this view's lazy chunk rather than in the entry chunk.
import '@awesome.me/webawesome-pro/dist/components/step/step.js'
import '@awesome.me/webawesome-pro/dist/components/stepper/stepper.js'
// Types only: the side-effect imports above are what register the elements.
import type WaStep from '@awesome.me/webawesome-pro/dist/components/step/step.js'
import type WaStepper from '@awesome.me/webawesome-pro/dist/components/stepper/stepper.js'
import type {
  WaBeforeStepChangeEvent,
  WaStepChangeEvent,
} from '@awesome.me/webawesome-pro/dist/events/events.js'
import { msg } from '@lit/localize'
import { html, type TemplateResult } from 'lit'
import {
  type CatalogLookup,
  catalogNames,
  checkDraftFields,
  type DeviceDraft,
  DraftError,
  type DraftField,
  needsCatalogLookup,
  PayloadError,
  type PayloadProblem,
  planNewDevice,
  readCredential,
} from '../../domain/index.js'
import { BACKFILL_WANTED, type CatalogApi } from '../catalog.js'
import { catalog } from '../composition.js'
import { imageMessage } from '../i18n/problems.js'
import { codesFromImage, type ImageProblem, ImageScanError } from '../scan/image.js'
import { cameraSource, type ScanSource } from '../scan/source.js'
import { accessToken } from '../tokens.js'
import { type ReviewSummary, renderReview } from './add-device-review.js'
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
 * What Review shows: the controls' values as they were on entering it, and the setup code as the
 * catalogue would be asked it, so that only an answer about *that* code is shown beside them.
 */
interface Reviewed {
  readonly summary: ReviewSummary
  readonly code: string | undefined
}

/** Whether two snapshots would show the person the same thing. */
function sameReview(a: Reviewed, b: Reviewed): boolean {
  const keys = Object.keys(a.summary) as (keyof ReviewSummary)[]
  return a.code === b.code && keys.every((key) => a.summary[key] === b.summary[key])
}

/** The four steps of adding a device, by their `<wa-step name>` (#349). */
export type AddStep = 'scan' | 'place' | 'name' | 'review'

/** The steps in the order the stepper shows them: what "forward" means for a jump. */
const STEPS: readonly AddStep[] = ['scan', 'place', 'name', 'review']

/**
 * The step that owns each field a new device's draft can fail on: where a message about that
 * field has to be shown, so that it sits beside a control the person can see.
 */
export const STEP_OF: Readonly<Record<'credential' | 'installedAt' | 'room' | 'name', AddStep>> = {
  credential: 'scan',
  installedAt: 'scan',
  room: 'place',
  name: 'name',
}

/**
 * What each step checks before it may be left forward: its own fields, and only those.
 *
 * Derived from {@link STEP_OF} rather than written out a second time, so a field cannot be
 * shown on one step and checked on another. Review checks nothing of its own; Save runs the
 * whole plan.
 */
const CHECKS: Readonly<Record<AddStep, readonly DraftField[]>> = {
  scan: fieldsOf('scan'),
  place: fieldsOf('place'),
  name: fieldsOf('name'),
  review: [],
}

/** The fields {@link STEP_OF} places on `step`. A declaration, so {@link CHECKS} can call it. */
function fieldsOf(step: AddStep): readonly DraftField[] {
  return (Object.keys(STEP_OF) as (keyof typeof STEP_OF)[]).filter(
    (field) => STEP_OF[field] === step,
  )
}

/** The step a field's message belongs on, or `undefined` for a field this form never has. */
function stepOf(field: DraftField): AddStep | undefined {
  return field === 'remark' ? undefined : STEP_OF[field]
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
 * setup code, the date default, the steps, and what happens on save.
 *
 * The form is four steps (#349) - Scan it, Place it, Name it, Review - because that is the job:
 * read the label, decide where the thing lives, name it, check it. All four panels stay in the
 * tree and only the active one is shown, so the controls keep their values across steps and
 * `planNewDevice` still reads every control on Save, exactly as on the one-page form.
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
    step: { state: true },
    reviewed: { state: true },
    reviewChanged: { state: true },
  }

  /**
   * The step on screen, mirrored from the stepper's `wa-step-change`. Decides which panel is
   * shown, which buttons are offered, and which step Next and Enter check.
   */
  declare step: AddStep

  /**
   * Review's summary, read from the controls each time Review is entered; `undefined` before
   * it first is.
   *
   * A snapshot taken on the step change rather than a read in `render`, because typing into a
   * control re-renders nothing: a read in `render` would show whatever the controls held at the
   * last unrelated re-render, which is a value the person may since have changed. Entering
   * Review is the one moment that is guaranteed to be after every edit, so it is the one read.
   */
  declare reviewed: Reviewed | undefined

  /**
   * Whether the last Save found the controls no longer matching {@link reviewed}, refreshed the
   * summary instead of saving, and has to say so. Cleared each time Review is entered afresh.
   */
  declare reviewChanged: boolean

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
    this.step = 'scan'
    this.reviewed = undefined
    this.reviewChanged = false
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
    // code changing. A lookup still `pending` is forgotten as well as aborted: an element that is
    // detached and attached again (a move, not a destroy) would otherwise keep "pending" on
    // screen for a question nobody is asking, and treat the same code as already being asked.
    // A settled `found` answer is kept: it is still true of the code in the field, and nothing
    // would ask again, because lookups start only when the field changes.
    this.stopLookup()
    if (this.lookupState.kind === 'pending') this.lookupState = IDLE
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

  /**
   * Asks the shell for a backfill run when the device just saved still has no catalogue answer
   * and one could be had now (#238). Offline or signed out, the shell's own triggers (network
   * back, sign-in) already cover it, so nothing is asked.
   */
  private askForBackfill(device: Parameters<typeof needsCatalogLookup>[0]): void {
    if (!this.signedIn() || !this.online()) return
    if (!needsCatalogLookup(device, new Date())) return
    window.dispatchEvent(new CustomEvent(BACKFILL_WANTED))
  }

  private draft(): DeviceDraft {
    return { ...this.fields(), credential: fieldValue(this, '[data-field="credential"]') }
  }

  /**
   * The stepper, once rendered. Under `linear`, its `next()` and `goTo()` silently do nothing
   * for a locked step: every step after the first one not `completed`.
   */
  private stepper(): WaStepper | null {
    return this.querySelector('wa-stepper')
  }

  /** The `<wa-step>` for a step. */
  private stepElement(step: AddStep): WaStep | null {
    return this.querySelector<WaStep>(`wa-step[name="${step}"]`)
  }

  /**
   * Checks one step's own fields, and says whether they pass.
   *
   * The same readers `planNewDevice` runs (`checkDraftFields`), so a step cannot accept what
   * Save would refuse. A failure shows the existing error and hint and takes the step's
   * checkmark away, because under `linear` that checkmark is what lets later steps be reached;
   * a pass clears an error that was about this step.
   */
  private checkStep(step: AddStep): boolean {
    try {
      checkDraftFields(this.draft(), CHECKS[step])
    } catch (problem) {
      if (!(problem instanceof DraftError)) throw problem
      this.error = problem
      const element = this.stepElement(step)
      if (element) element.completed = false
      return false
    }
    if (this.error !== undefined && stepOf(this.error.field) === step) this.error = undefined
    return true
  }

  /**
   * Next: checks the step on screen and, if it passes, moves to the one after it.
   *
   * `completed` is set **before** `next()`, and that order is load-bearing: the stepper never
   * sets it itself, and under `linear` the step after an incomplete one is locked, so `next()`
   * would silently do nothing.
   */
  private async advance(): Promise<void> {
    const step = this.step
    if (!this.checkStep(step)) return
    const element = this.stepElement(step)
    if (element) element.completed = true
    this.stepper()?.next()
  }

  /**
   * Moves to a step, if the stepper lets it: one not yet reached stays locked.
   *
   * Public for Review's "Edit" links and for a save-time error that has to be shown on the step
   * that owns its field.
   */
  goToStep(step: AddStep): void {
    this.stepper()?.goTo(step)
  }

  /**
   * Refuses a jump forward - a click on a later step - when the step being left fails its check.
   *
   * Going back is always allowed and never takes a checkmark away: Review's "Edit" would
   * otherwise lock every step after the one edited and make the person walk them all again.
   * Only the step being left is checked; the steps jumped over passed when they were left, and
   * Save checks everything once more regardless.
   */
  private onBeforeStepChange(event: WaBeforeStepChangeEvent): void {
    const from = event.detail.previousName as AddStep | null
    const to = event.detail.name as AddStep
    if (from === null || STEPS.indexOf(to) <= STEPS.indexOf(from)) return
    if (!this.checkStep(from)) event.preventDefault()
  }

  /**
   * Shows the panel for the step the stepper moved to.
   *
   * An error about a field on another step goes: it names a control the person can no longer
   * see (the spec's third anti-goal). One about this step's own fields stays beside them.
   */
  private onStepChange(event: WaStepChangeEvent): void {
    this.step = event.detail.name as AddStep
    if (this.error !== undefined && stepOf(this.error.field) !== this.step) this.error = undefined
    if (this.step === 'review') {
      this.reviewed = this.snapshotForReview()
      this.reviewChanged = false
    }
  }

  /**
   * What Review would show if it were entered now, read from the controls.
   *
   * The one place a summary is built, for both moments that need one: entering Review, and
   * Save checking that the controls still say what Review shows. Two builders could drift, and
   * a field missing from one would be a change Save never noticed.
   */
  private snapshotForReview(): Reviewed {
    const draft = this.draft()
    return {
      summary: {
        credential: draft.credential,
        serial: draft.serial ?? '',
        installedAt: draft.installedAt,
        room: draft.room,
        spot: draft.spot ?? '',
        name: draft.name,
      },
      code: this.lookupCode(),
    }
  }

  /**
   * Review's manufacturer and product: live, unlike the rest of the summary, because the lookup
   * may answer while Review is on screen - but only an answer about the code being reviewed.
   */
  private reviewCatalogLines(code: string | undefined): TemplateResult | '' {
    const state = this.lookupState
    return state.kind === 'found' && state.code === code
      ? this.renderCatalogLines(catalogNames(state.result))
      : ''
  }

  /** Review, once it has been entered; nothing before, as there is nothing yet to summarise. */
  private renderReviewPanel(): TemplateResult | '' {
    const reviewed = this.reviewed
    if (reviewed === undefined) return ''
    return html`
      <div class="wa-stack wa-gap-m">
        <!-- Always in the tree, so that the callout is announced when it appears. -->
        <div role="status">
          ${
            this.reviewChanged
              ? html`
                  <wa-callout variant="neutral" data-review-changed>
                    <wa-icon slot="icon" name="circle-info"></wa-icon>
                    ${msg('Something changed since you opened Review. Check it, then save again.')}
                  </wa-callout>
                `
              : ''
          }
        </div>
        ${renderReview(
          reviewed.summary,
          (step) => this.goToStep(step),
          this.reviewCatalogLines(reviewed.code),
        )}
      </div>
    `
  }

  private async onSubmit(event: Event): Promise<void> {
    event.preventDefault()
    // Enter in a field on steps 1-3 means Next. Saving from Scan it would store a device whose
    // place and name the person never saw on Review.
    if (this.step !== 'review') {
      await this.advance()
      return
    }
    if (this.saving) return
    // Set before the first `await`, not after the planning: two quick clicks would otherwise
    // both get past the guard while the room read below was still in flight.
    this.saving = true
    // Before the first wait: a project switch during it must not write this device into the
    // next project (see `projectSnapshot`).
    const since = this.projectSnapshot()

    try {
      // Re-read the rooms rather than planning against `this.rooms`.
      //
      // `firstUpdated` starts that read asynchronously, so a user who types an existing room in
      // other capitals and saves before it lands would be planned against an empty list - and
      // `planNewDevice`, seeing no match, would store a *second* spelling of the room. It would
      // appear only on a slow device or a large catalogue, which is where nobody is watching.
      //
      // Re-reading closes the window completely rather than narrowing it, and it costs one
      // ranged `_all_docs` on a deliberate action. It also picks up a room another tab filed a
      // device under since this form was opened.
      const rooms = await this.readRooms()
      this.rooms = rooms

      // Save stores only what Review shows. A control can change behind it - an image still
      // decoding when the person pressed Next writes its code into the hidden field, and a
      // test or script can set any control - and planning from the live controls would then
      // store a code, or catalogue names, the person never saw. So the summary is rebuilt and,
      // if it differs, shown instead of saved. Checked after the last wait, so nothing can
      // change between this comparison and the plan below, which runs synchronously.
      const now = this.snapshotForReview()
      if (this.reviewed === undefined || !sameReview(now, this.reviewed)) {
        this.reviewed = now
        this.reviewChanged = true
        return
      }

      let creation: ReturnType<typeof planNewDevice>
      try {
        creation = planNewDevice(
          this.draft(),
          this.knownRoomPaths(rooms),
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
          // Shown on the step that owns the field, beside its control, not above a summary that
          // has no control in it. The error is set first because `onStepChange` keeps exactly
          // the error the new step owns; the checkmark goes because that step no longer passes.
          this.error = problem
          const step = stepOf(problem.field)
          if (step !== undefined) {
            const element = this.stepElement(step)
            if (element) element.completed = false
            this.goToStep(step)
          }
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
      if (!(await this.write(creation, since))) return
      this.askForBackfill(creation)
    } finally {
      this.saving = false
    }

    window.location.hash = '#/devices'
  }

  override render() {
    return html`
      <form class="wa-stack wa-gap-l app-form" @submit=${this.onSubmit} novalidate>
        <h1>${msg('Add a device')}</h1>
        ${this.renderRequiredNote()}

        <wa-stepper
          data-stepper
          active="scan"
          orientation="auto"
          linear
          clickable
          label=${msg('Add a device')}
          @wa-before-step-change=${this.onBeforeStepChange}
          @wa-step-change=${this.onStepChange}
        >
          <wa-step name="scan">${msg('Scan it')}</wa-step>
          <wa-step name="place">${msg('Place it')}</wa-step>
          <wa-step name="name">${msg('Name it')}</wa-step>
          <wa-step name="review">${msg('Review')}</wa-step>
        </wa-stepper>

        ${this.renderError()}

        <!-- Every panel stays in the tree; only the active one is shown. The values live in the
             controls, so a hidden panel keeps what was typed and Save still reads it. The
             layout class sits on an inner div: on the section itself its display would outrank
             the browser's own [hidden] rule and show every panel at once. -->
        <section data-step-panel="scan" ?hidden=${this.step !== 'scan'}>
          <div class="wa-stack wa-gap-l">
            <div class="wa-stack wa-gap-2xs">
              <wa-input
                data-field="credential"
                required
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

            ${this.renderSerialField()}
            ${this.renderInstalledField()}
          </div>
        </section>

        <section data-step-panel="place" ?hidden=${this.step !== 'place'}>
          <div class="wa-stack wa-gap-l">${this.renderPlaceFields()}</div>
        </section>

        <section data-step-panel="name" ?hidden=${this.step !== 'name'}>
          <div class="wa-stack wa-gap-l">${this.renderNameField()}</div>
        </section>

        <section data-step-panel="review" ?hidden=${this.step !== 'review'}>
          ${this.renderReviewPanel()}
        </section>

        <div class="wa-cluster wa-gap-s">
          ${
            this.step === 'scan'
              ? ''
              : html`
                  <wa-button
                    data-back
                    type="button"
                    appearance="outlined"
                    @click=${() => this.stepper()?.previous()}
                  >
                    ${msg('Back')}
                  </wa-button>
                `
          }
          ${
            this.step === 'review'
              ? html`
                  <wa-button data-save type="submit" variant="brand" ?disabled=${this.saving}>
                    ${msg('Save device')}
                  </wa-button>
                `
              : html`
                  <wa-button
                    data-next
                    type="button"
                    variant="brand"
                    @click=${() => void this.advance()}
                  >
                    ${msg('Next')}
                  </wa-button>
                `
          }
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
