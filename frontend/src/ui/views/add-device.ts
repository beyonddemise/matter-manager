// Rendered by this form and by nothing else, so imported here (#214), like the combobox in
// `device-form.ts`: they travel in this view's lazy chunk rather than in the entry chunk.
import '@awesome.me/webawesome-pro/dist/components/step/step.js'
import '@awesome.me/webawesome-pro/dist/components/stepper/stepper.js'
// Types only: the side-effect imports above are what register the elements.
import type { WaStepChangeEvent } from '@awesome.me/webawesome-pro/dist/events/events.js'
import { msg } from '@lit/localize'
import { html, type TemplateResult } from 'lit'
import {
  type CatalogLookup,
  catalogNames,
  type DeviceDraft,
  DraftError,
  needsCatalogLookup,
  PayloadError,
  type PayloadProblem,
  planNewDevice,
  readCredential,
} from '../../domain/index.js'
import { BACKFILL_WANTED, type CatalogApi } from '../catalog.js'
import { catalog } from '../composition.js'
import { imageMessage, problemMessage } from '../i18n/problems.js'
import { LEAVE_GUARD, type LeaveGuard } from '../leave-guard.js'
import { codesFromImage, type ImageProblem, ImageScanError } from '../scan/image.js'
import { cameraSource, type ScanSource } from '../scan/source.js'
import { accessToken } from '../tokens.js'
import { type ReviewSummary, renderReview, type StepStatus } from './add-device-review.js'
import { type AddStep, type StepChecks, StepNavigation, stepOf } from './add-device-steps.js'
import { DeviceFormView, fieldValue } from './device-form.js'
import type { LeaveDialog } from './leave-dialog.js'
import './leave-dialog.js'
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

/**
 * How long the camera check may take before the add form gives up and offers Upload (#352).
 * Long enough for the ZXing decoder to download on a slow phone connection, short enough that
 * someone holding a label is not left looking at a form with no way to read it.
 */
export const SCAN_CHECK_TIMEOUT_MS = 5000

/**
 * How long Review's live region stays empty before a repeated "something changed" notice goes
 * back in, so that screen readers see a change to announce (#353; see `announceReviewChanged`).
 */
const REVIEW_CHANGED_GAP_MS = 100

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
 *
 * Each step is also an entry in the browser's history (#356), so Back moves one step back with
 * everything kept; leaving the form any other way while it holds input asks first, through the
 * shell's {@link LeaveGuard}.
 */
export class AddDeviceView extends DeviceFormView implements LeaveGuard {
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
    checked: { state: true },
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

  /**
   * What each step's check found when the person last left it: `true` for a pass, the problem
   * otherwise; absent for a step not yet left. The stepper draws its checkmarks and warnings
   * from this, and a step shows its problem again when the person comes back to it.
   */
  declare checked: StepChecks

  /** Bound by a test to a camera that is not one; the real one otherwise. */
  declare scanSource?: ScanSource
  /**
   * Whether this browser can scan at all. Decides which one of Scan and Upload the form offers.
   */
  declare canScan: boolean
  /**
   * Whether the answer is in yet. Until it is, the form offers neither Scan nor Upload: offering
   * Upload first and swapping it for Scan when the answer lands would move a button out from
   * under a thumb already on its way to it.
   *
   * Distinct from `canScan` being false for that reason, and for tests: without it, "the button
   * is absent" is true before the check has finished and a test asserting it would pass against
   * a form that was about to grow one.
   */
  declare scanChecked: boolean
  declare scanOpen: boolean
  /** Why the last chosen picture produced no code, if it produced none. */
  declare uploadProblem: ImageProblem | PayloadProblem | undefined
  /** Bound by a test to a decoder that is not one; the real one otherwise. */
  decodeImage: (file: Blob) => Promise<readonly string[]> = codesFromImage
  /**
   * How long the camera check may take before the form offers Upload instead. A plain field,
   * like {@link decodeImage}: a test binds a shorter one, nothing renders from it.
   */
  scanCheckTimeoutMs: number = SCAN_CHECK_TIMEOUT_MS
  /**
   * How long a repeated "something changed" notice stays down before it goes back in. A plain
   * field for the same reason: a test binds a longer one to act inside the gap.
   */
  reviewChangedGapMs: number = REVIEW_CHANGED_GAP_MS
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

  /**
   * Moving between the steps (`add-device-steps.ts`). The state it changes - {@link step},
   * {@link checked}, `error` - stays here, where the template renders from it.
   */
  private readonly steps = new StepNavigation(this, {
    draft: () => this.draft(),
    enterReview: () => {
      this.showReview(this.snapshotForReview())
      this.dismissReviewChanged()
    },
  })

  /** The date the form opened with, so that a date left as it was is not input to lose. */
  private openedOn = ''
  /**
   * Whether nothing here may hold the person back any more: the device was saved, the person
   * chose Discard, or a project switch abandoned the form.
   */
  private released = false

  private lookupTimer: ReturnType<typeof setTimeout> | undefined
  /** The pending re-show of the "something changed" notice; see {@link announceReviewChanged}. */
  private reviewChangedTimer: ReturnType<typeof setTimeout> | undefined
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
    this.checked = {}
  }

  protected override firstUpdated(): void {
    // The date is set once, imperatively, rather than bound in the template: a bound `value`
    // would be rewritten on every re-render, so the first validation error would silently
    // undo whatever date the user had chosen.
    this.openedOn = today()
    this.setControlValue('[data-field="installed-at"]', this.openedOn)
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
   * The answer decides whether the scan control is rendered at all. A disabled button that explains
   * itself when pressed would be worse than nothing on a desktop with no camera: it offers
   * something, takes a press, and then says no — which reads as a broken feature rather than
   * as a feature this machine cannot have.
   */
  private async checkScanning(): Promise<void> {
    // Raced against a timeout, which counts as "cannot scan" (#352). The check can hang: on the
    // fallback path it downloads the ZXing decoder, and a stalled download would leave the form
    // offering neither Scan nor Upload, with no way at all to read the label. Upload needs no
    // camera, so it is the safe answer to give in the meantime.
    //
    // Awaited once, so an answer arriving after the timeout is ignored rather than swapping
    // Upload for Scan under a thumb already on its way to it. `Promise.race` also handles a
    // late rejection, which would otherwise surface as an unhandled one.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.scanCheckTimeoutMs)
    })
    try {
      this.canScan = await Promise.race([this.source().available(), timedOut])
    } catch {
      // A source that cannot even say whether it works is one to leave alone.
      this.canScan = false
    } finally {
      clearTimeout(timer)
      this.scanChecked = true
    }
  }

  override connectedCallback(): void {
    super.connectedCallback()
    this.setAttribute(LEAVE_GUARD, '')
    window.addEventListener('beforeunload', this.onBeforeUnload)
  }

  /**
   * Asks the browser to confirm a reload or a closed tab while the form holds input. The
   * browser's own dialog, not ours: a page may show nothing of its own while it unloads.
   */
  private readonly onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.holdsInput()) event.preventDefault()
  }

  /**
   * Whether leaving now would lose what the person entered: any field with something in it, or
   * a date changed from the one the form opened with. Being on a later step is not input: an
   * empty form on Review loses nothing.
   */
  holdsInput(): boolean {
    if (this.released) return false
    const draft = this.draft()
    const typed = [draft.credential, draft.serial, draft.room, draft.spot, draft.name]
    return typed.some((value) => (value ?? '').trim() !== '') || draft.installedAt !== this.openedOn
  }

  /**
   * Asks whether to leave (`leave-dialog.ts`). Discard lets the form go, so that the navigation
   * the shell then makes is not asked about a second time.
   *
   * Drafts (#358) answer here: a `'draft'` choice will save the draft, then resolve `true`.
   */
  async confirmLeave(): Promise<boolean> {
    const dialog = this.querySelector<LeaveDialog>('leave-dialog')
    if (dialog === null) return true
    const choice = await dialog.ask()
    if (choice === 'discard') this.released = true
    return choice === 'discard'
  }

  /** Puts the form's history entries back, after the browser left them and the person stayed. */
  restoreAddress(): void {
    this.steps.restore()
  }

  /** Whether the form's history has caught up with its stepper. For tests, which must wait. */
  get historySettled(): boolean {
    return this.steps.settled
  }

  /** A project switch abandons the form: it leaves, and takes its history entries with it. */
  protected override leaveForList(): void {
    this.released = true
    this.steps.leave('#/devices')
  }

  override disconnectedCallback(): void {
    window.removeEventListener('beforeunload', this.onBeforeUnload)
    // The form closing is one of the two moments the spec aborts a lookup; the other is the
    // code changing. A lookup still `pending` is forgotten as well as aborted: an element that is
    // detached and attached again (a move, not a destroy) would otherwise keep "pending" on
    // screen for a question nobody is asking, and treat the same code as already being asked.
    // A settled `found` answer is kept: it is still true of the code in the field, and nothing
    // would ask again, because lookups start only when the field changes.
    this.stopLookup()
    if (this.lookupState.kind === 'pending') this.lookupState = IDLE
    // A notice due to reappear would otherwise do so on a form nobody is looking at.
    clearTimeout(this.reviewChangedTimer)
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
   * Puts a summary on the Save step, with every step checked against the same controls.
   *
   * The one way a summary reaches the screen - on arriving and when Save refreshes it - so
   * the cards and the stepper cannot judge different values. Every step, including any jumped
   * over or changed since it was left: a code an image decoded after Save opened would
   * otherwise sit beside a card still saying the code is missing.
   */
  private showReview(summary: Reviewed): void {
    for (const step of ['scan', 'place', 'name'] as const) this.steps.check(step)
    this.reviewed = summary
  }

  /**
   * Says, in Review's live region, that Save refreshed the summary instead of saving - every
   * time it does, not only the first.
   *
   * Why the notice is taken down and put back after a pause: a live region speaks when its
   * content changes, and a second refresh while the notice is still up changes nothing, so
   * assistive technology would stay silent (#353). Re-rendering it in the same update - a
   * counter or a `keyed` node - is a removal and an insertion of the same text in one batch,
   * which screen readers coalesce or ignore unevenly. An empty region left long enough to be
   * noticed, then the notice inserted again, is the one change they all report; the 100 ms is
   * the gap Angular CDK's LiveAnnouncer uses for the same reason. A sighted person sees the
   * notice blink, which tells them too that Save refreshed again.
   */
  private announceReviewChanged(): void {
    this.dismissReviewChanged()
    this.reviewChangedTimer = setTimeout(() => {
      this.reviewChanged = true
    }, this.reviewChangedGapMs)
  }

  /**
   * Takes the "something changed" notice down, including one still waiting to reappear: a
   * Save that gets past the comparison within the gap would otherwise see it come back.
   */
  private dismissReviewChanged(): void {
    clearTimeout(this.reviewChangedTimer)
    this.reviewChangedTimer = undefined
    this.reviewChanged = false
  }

  /**
   * Moves to a step. Public for the last step's "Edit" links and for a save-time error that
   * has to be shown on the step that owns its field.
   */
  goToStep(step: AddStep): void {
    this.steps.goTo(step)
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

  /** Each step's verdict for its Review card, the problem put into the person's language. */
  private reviewStatus(): StepStatus {
    return Object.fromEntries(
      Object.entries(this.checked).map(([step, outcome]) => [
        step,
        outcome === true ? true : problemMessage(outcome.problem),
      ]),
    )
  }

  /** Review, once it has been entered; nothing before, as there is nothing yet to summarise. */
  private renderReviewPanel(): TemplateResult | '' {
    const reviewed = this.reviewed
    if (reviewed === undefined) return ''
    return html`
      <div class="wa-stack wa-gap-m">
        <!-- Where focus lands on entering Review (see StepNavigation.focus), so that a screen reader says
             Review rather than the first card's step name. Hidden even while focused, unlike the
             plain visually-hidden utility, which shows content on focus: the stepper already
             names the step on screen, and a heading appearing on every entry would shift the
             cards. Not in the tab order; only StepNavigation.focus puts focus here. -->
        <h2 class="wa-visually-hidden-force" tabindex="-1" data-review-heading>${msg('Save')}</h2>
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
          this.reviewStatus(),
          (step) => this.goToStep(step),
          this.reviewCatalogLines(reviewed.code),
        )}
      </div>
    `
  }

  private async onSubmit(event: Event): Promise<void> {
    event.preventDefault()
    // Enter in a field on steps 1-3 means Next. Saving from Scan would store a device whose
    // place and name the person never saw on Review.
    if (this.step !== 'review') {
      this.steps.next()
      return
    }
    // Released: saved, discarded or abandoned, and on its way out. The form stays on screen until
    // its history traversal lands, and a Save in that moment would file the device twice, or
    // file it after the person chose Discard (CodeRabbit on #368).
    if (this.saving || this.released) return
    // Set before the first `await`, not after the planning: two quick clicks would otherwise
    // both get past the guard while the room read below was still in flight.
    this.saving = true
    // Before the first wait: a project switch during it must not write this device into the
    // next project (see `projectSnapshot`).
    const since = this.projectSnapshot()
    // The summary this press of Save was made against. Steps stay usable while the rooms are
    // read, and Edit then Next back to Review replaces `reviewed`; comparing against the
    // replacement would save the edit with no press of Save after it.
    const pressedOn = this.reviewed

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
      //
      // The person left Review while the rooms were read: that press of Save is dropped, not
      // carried over to whatever Review shows now. They are on the step they chose, or back on
      // a Review they have not yet confirmed, and the next Save starts afresh.
      if (this.step !== 'review' || this.reviewed !== pressedOn) return
      const now = this.snapshotForReview()
      if (pressedOn === undefined || !sameReview(now, pressedOn)) {
        this.showReview(now)
        this.announceReviewChanged()
        return
      }
      // Review now shows what is about to be saved, so a notice from an earlier refresh is no
      // longer true - and left up, it would sit beside a storage error as if it explained it.
      this.dismissReviewChanged()

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
          // has no control in it. Recorded as that step's problem first, because the step change
          // (`StepNavigation.onStepChange`) shows exactly the problem the new step has - and the
          // stepper then flags it too.
          const step = stepOf(problem.field)
          if (step !== undefined) {
            this.checked = { ...this.checked, [step]: problem }
            this.goToStep(step)
          } else {
            this.error = problem
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

    // The form's entries go with it (StepNavigation.leave): Back from the list must not return
    // to a finished form, whose Save would file the same device a second time.
    this.released = true
    this.steps.leave('#/devices')
  }

  /**
   * Scan the code where this browser can scan, Upload an image where it cannot: the one way,
   * besides typing, that the form offers to fill the setup code. Only called once
   * {@link scanChecked}, so it never shows one and then swaps it for the other.
   */
  private renderCodeSource(): TemplateResult {
    if (this.canScan) {
      return html`
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
    }
    return html`
      <div class="wa-cluster wa-gap-s">
        <wa-button
          data-upload
          type="button"
          appearance="outlined"
          @click=${() => {
            ;(this.querySelector('[data-upload-input]') as HTMLInputElement | null)?.click()
          }}
        >
          <wa-icon slot="start" name="image"></wa-icon>
          ${msg('Upload an image')}
        </wa-button>

        <!-- Hidden rather than absent, and rendered with the button: the button opens it, so
             it has to be in the tree whenever the button is. Found by its own attribute, not as
             the first file input in the form, because the scan dialog renders into the light
             DOM too and has one of its own. The accept attribute filters the picker and
             enforces nothing, which is why codesFromImage still answers for a file that is not
             an image. No backticks in this comment: it sits inside a template literal, where
             one would end it. -->
        <input
          data-upload-input
          type="file"
          accept="image/*"
          hidden
          @change=${(event: Event) => void this.onUpload(event)}
        />
      </div>
    `
  }

  /**
   * One step in the stepper, drawn from {@link checked}: a checkmark once it passed, a warning
   * once it did not. The warning is a shape in the marker as well as a colour, and is named for
   * assistive technology (WCAG 2.2 1.4.1) - in the marker rather than as a description under the
   * label, which wrapped to three lines per step on a phone.
   */
  private renderStep(step: AddStep, label: string): TemplateResult {
    const outcome = this.checked[step]
    const problem = outcome instanceof DraftError
    return html`
      <wa-step name=${step} ?completed=${outcome === true} variant=${problem ? 'danger' : 'brand'}>
        ${label}
        ${
          problem
            ? html`<wa-icon
                slot="icon"
                name="triangle-exclamation"
                label=${msg('Check this step')}
                data-step-problem
              ></wa-icon>`
            : ''
        }
      </wa-step>
    `
  }

  override render() {
    return html`
      <form class="wa-stack wa-gap-l app-form" @submit=${this.onSubmit} novalidate>
        <h1>${msg('Add a device')}</h1>
        ${this.renderRequiredNote()}

        <wa-stepper
          active="scan"
          orientation="horizontal"
          clickable
          label=${msg('Add a device')}
          @wa-step-change=${(event: WaStepChangeEvent) => this.steps.onStepChange(event)}
        >
          ${this.renderStep('scan', msg('Scan'))}
          ${this.renderStep('place', msg('Place'))}
          ${this.renderStep(
            'name',
            msg('Name', {
              id: 'add-device.step.name',
              desc: 'Step label, a verb: give the device its name',
            }),
          )}
          <wa-step name="review">${msg('Save')}</wa-step>
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

              <!-- One control, never both, and neither until the camera check has answered or
                   timed out (see scanChecked, checkScanning). Where this browser can scan, Scan the code; uploading is then
                   the scan dialog's own fallback, for a label the camera cannot read, and a
                   second Upload beside Scan would be two ways in to say the same thing. Where it
                   cannot, Upload an image, which is precisely the person with no camera holding
                   a photograph of the label: nothing is asked beforehand because every browser
                   can choose a file, and the only uncertainty, decoding, is reported when it
                   happens rather than guessed at here - which also keeps the ZXing chunk off the
                   page load. Absent rather than disabled; see checkScanning. -->
              ${this.scanChecked ? this.renderCodeSource() : ''}

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
                    @click=${() => this.steps.previous()}
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
                  <!-- A submit button, so that Enter in a field reaches onSubmit, which advances
                       on steps 1-3: wa-input turns Enter into a click on the form's first submit
                       button, and with none it submits only a form with exactly one field -
                       which this one never is, as hidden panels stay in the tree. -->
                  <wa-button data-next type="submit" variant="brand">${msg('Next')}</wa-button>
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
        <leave-dialog></leave-dialog>
      </form>
    `
  }
}

customElements.define('add-device-view', AddDeviceView)
