/**
 * The add form's step navigation (#349, split out in #357): which step owns which field, what
 * earns a step its checkmark, and what happens when the person moves between steps - in the
 * stepper, or with the browser's Back and Forward (#356).
 *
 * Kept apart from `add-device.ts` the way Review's template is kept in `add-device-review.ts`:
 * the form owns the controls, the lookup and Save; this owns moving between steps. The state
 * itself - the step on screen, each step's verdict, the error shown - stays on the element as
 * reactive properties, because the template renders from it. {@link StepNavigation} only reads
 * and writes it there, so moving the code here changed nothing about when the form re-renders.
 */
// Types only: the add form's side-effect imports are what register the elements.
import type WaStepper from '@awesome.me/webawesome-pro/dist/components/stepper/stepper.js'
import type { WaStepChangeEvent } from '@awesome.me/webawesome-pro/dist/events/events.js'
import type { ReactiveController, ReactiveControllerHost } from 'lit'
import {
  checkDraftFields,
  type DeviceDraft,
  DraftError,
  type DraftField,
} from '../../domain/index.js'

/** The four steps of adding a device, by their `<wa-step name>` (#349). */
export type AddStep = 'scan' | 'place' | 'name' | 'review'

/**
 * The steps in the order the stepper shows them. A history entry's place among the form's
 * entries is its step's place here (#356): the first entry is Scan, the second Place, and so on.
 */
const STEPS: readonly AddStep[] = ['scan', 'place', 'name', 'review']

/**
 * What the form writes into `history.state` for each of its entries: which form it belongs to,
 * and the step it shows.
 *
 * The form's id rather than nothing, because the router keeps one address for every add form:
 * an entry another form left behind (one closed earlier, or one before a reload) is told apart by
 * its id alone.
 */
interface StepEntry {
  readonly addDevice: string
  readonly step: AddStep
}

/**
 * The ids of the forms connected now. A form opening on an entry whose form is still connected
 * does not adopt it: two forms answering the same entries would each move the other's history.
 * The application never has two, but nothing else would stop it.
 */
const connectedForms = new Set<string>()

/** `state` as one of the form's entries, or `undefined` for any other entry. */
function stepEntry(state: unknown): StepEntry | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const { addDevice, step } = state as Partial<Record<keyof StepEntry, unknown>>
  return typeof addDevice === 'string' && STEPS.includes(step as AddStep)
    ? { addDevice, step: step as AddStep }
    : undefined
}

/**
 * What each step's check found when the person last left it: `true` for a pass, the problem
 * otherwise; absent for a step not yet left.
 */
export type StepChecks = Readonly<Partial<Record<AddStep, DraftError | true>>>

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
 * What earns each step its checkmark: its own fields, and only those.
 *
 * Derived from {@link STEP_OF} rather than written out a second time, so a field cannot be
 * shown on one step and checked on another. The last step checks nothing of its own; Save
 * runs the whole plan.
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

/** The `data-field` of the control for each field {@link STEP_OF} places on a step. */
const CONTROL_OF: Readonly<Record<keyof typeof STEP_OF, string>> = {
  credential: 'credential',
  installedAt: 'installed-at',
  room: 'room',
  name: 'name',
}

/** The step a field's message belongs on, or `undefined` for a field this form never has. */
export function stepOf(field: DraftField): AddStep | undefined {
  return field === 'remark' ? undefined : STEP_OF[field]
}

/**
 * The parts of the add form the navigation reads and writes: its reactive state, its light DOM
 * (where the stepper and the panels render), and when an update has landed. All of it is
 * already public on the element, so the element is passed as itself.
 */
export type StepHost = Pick<ReactiveControllerHost, 'updateComplete' | 'addController'> &
  Pick<HTMLElement, 'querySelector'> & {
    /**
     * The step on screen, mirrored from the stepper's `wa-step-change`. Decides which panel is
     * shown, which buttons are offered, and which step Next and Enter check.
     */
    step: AddStep
    /**
     * What each step's check found. The stepper draws its checkmarks and warnings from this,
     * and a step shows its problem again when the person comes back to it.
     */
    checked: StepChecks
    /** The error on screen: always the current step's own, if it has one. */
    error: DraftError | undefined
  }

/**
 * What the navigation asks of the form that the form keeps to itself.
 *
 * Callbacks rather than members of {@link StepHost} because both are private to the element:
 * passing them in keeps them off its public surface, which tests and the shell can reach.
 */
export interface StepForm {
  /** The draft as the controls hold it now, the same one Save plans from. */
  draft(): DeviceDraft
  /** Puts a fresh summary on Review, with every other step checked against it. */
  enterReview(): void
}

/**
 * Moves the add form between its steps, checks each step as the person leaves it, and keeps the
 * browser's history in step with the stepper (#356).
 *
 * **History.** Each step is an entry: `#/devices/new` for Scan, then `?step=place`, `?step=name`
 * and `?step=review`, each stamped with a {@link StepEntry}. The router ignores the query, so the
 * shell keeps this element across them. The form's entries are always its steps in order - its
 * n-th entry shows the n-th step - which is what makes browser Back the previous step and Forward
 * the next, and the Previous button and Back the same move.
 *
 * The stepper stays the one source of truth for what is on screen. Every move, from the stepper's
 * buttons, a click on a step, an Edit link or a save-time error, lands in the stepper first;
 * {@link sync} then brings the history to it: an entry pushed for each step forward, an entry
 * gone back for each step back. Back and Forward in the browser go the other way: `popstate`
 * names an entry of this form, and the stepper is moved to its step, through the same
 * `wa-step-change` as a press of Next, so a step left that way is checked like any other.
 *
 * Going back is one `history.go(-n)` straight to the entry wanted: the form's entries are always
 * one unbroken run, its first step first (pushed in order, and put back in order by
 * {@link restore}), so the entry n back is the step n back. A traversal is asynchronous, and the
 * stepper may move again while one is in flight; nothing else is started until it lands, and
 * landing syncs again to wherever the stepper is by then.
 *
 * A Lit `ReactiveController`, for the history: the entry the form opened on is taken over when
 * it is connected, and `popstate` is listened to only while it is.
 */
export class StepNavigation implements ReactiveController {
  /** Which form the entries belong to; adopted from an entry this form left before a reload. */
  private id: string = crypto.randomUUID()
  /** The step the current history entry shows. Differs from the stepper only while syncing. */
  private shown: AddStep = 'scan'
  /** Whether a traversal of this form's own (`history.go`) is in flight. */
  private traversing = false
  /** Where to go once back on the form's first entry, after Save or a project switch. */
  private exit: string | undefined
  /**
   * The form's address without its query, as it was when the form was connected: the route the
   * shell matched. Kept rather than read each time, because the address may be another page's
   * by the time the entries are put back ({@link restore}).
   */
  private path = '#'
  /**
   * Whether the form has left for its {@link exit}. Its entries are gone, so it touches the
   * history no more, whatever its stepper does in the moment before the shell removes it.
   */
  private left = false

  /**
   * @param host the add form, whose state this reads and writes
   * @param form what the form exposes to the navigation and to nothing else
   */
  constructor(
    private readonly host: StepHost,
    private readonly form: StepForm,
  ) {
    host.addController(this)
  }

  /**
   * Takes over the entry the form opened on.
   *
   * One of this form's own entries - the person reloaded on a later step, or came Forward into
   * the form after leaving it - is adopted, with its id, and the history walked back from it to
   * the first: the values are gone, so a later step would be an empty one, and Back from step 1
   * must leave rather than walk through entries for steps nobody is on. Any other entry,
   * including a deep link naming a later step, is replaced with the form's own first entry.
   */
  hostConnected(): void {
    window.addEventListener('popstate', this.onPopState)
    this.path = location.hash.split('?')[0] || '#'
    const arrived = stepEntry(history.state)
    if (arrived !== undefined && !connectedForms.has(arrived.addDevice)) {
      this.id = arrived.addDevice
      this.shown = arrived.step
      connectedForms.add(this.id)
      this.sync()
      return
    }
    connectedForms.add(this.id)
    this.shown = this.host.step
    history.replaceState(this.entry(this.shown), '', this.address(this.shown))
  }

  hostDisconnected(): void {
    window.removeEventListener('popstate', this.onPopState)
    connectedForms.delete(this.id)
  }

  /** Whether the form has nothing of its own in flight in the history: no walk, no exit. */
  get settled(): boolean {
    return !this.traversing && this.exit === undefined
  }

  /** The state stamped on the entry for `step`. */
  private entry(step: AddStep): StepEntry {
    return { addDevice: this.id, step }
  }

  /**
   * The address of the entry for `step`: the form's own, with the step in its query. Built from
   * {@link path}, so that it is the route the shell matched.
   */
  private address(step: AddStep): string {
    return step === 'scan' ? this.path : `${this.path}?step=${step}`
  }

  /**
   * Brings the history to the step the stepper shows, or to the first entry once {@link exit} is
   * set: entries pushed going forward, one traversal going back, after which `onPopState` calls
   * this again.
   */
  private sync(): void {
    if (this.traversing || this.left) return
    if (stepEntry(history.state)?.addDevice !== this.id) {
      // Not on one of the form's own entries, so there is nothing of the form's to move, and
      // walking back from here would walk another page's history. An exit is then a plain
      // navigation, as it was before the form had entries.
      const exit = this.exit
      if (exit !== undefined) {
        this.exit = undefined
        this.left = true
        location.hash = exit
      }
      return
    }
    const target = this.exit === undefined ? this.host.step : 'scan'
    const from = STEPS.indexOf(this.shown)
    const to = STEPS.indexOf(target)
    if (to < from) {
      this.traversing = true
      history.go(to - from)
      return
    }
    for (const step of STEPS.slice(from + 1, to + 1)) {
      history.pushState(this.entry(step), '', this.address(step))
    }
    this.shown = target
    if (this.exit !== undefined) {
      const exit = this.exit
      this.exit = undefined
      this.left = true
      location.replace(exit)
    }
  }

  /**
   * Follows the person's Back and Forward, and lands this form's own traversals.
   *
   * An entry that is not this form's is left alone: leaving the form is the shell's to decide
   * (`leave-guard.ts`), and an entry another form left behind is not this one's to rewrite.
   */
  private readonly onPopState = (event: PopStateEvent): void => {
    const arrived = stepEntry(event.state)
    if (this.left) return
    if (arrived === undefined || arrived.addDevice !== this.id) {
      // Something else moved the history off the form's entries while it was walking them back
      // (an address assigned, the person's own Back on top of the form's). Walking on from an
      // entry that is not the form's would walk through another page's history, so it stops,
      // and an exit it was walking towards is already somewhere else.
      if (this.traversing && this.exit !== undefined) this.left = true
      this.traversing = false
      this.exit = undefined
      return
    }
    const ours = this.traversing
    this.traversing = false
    this.shown = arrived.step
    const stepper = this.stepper()
    if (!ours && this.exit === undefined && arrived.step !== this.host.step && stepper !== null) {
      // The person's own Back or Forward: the stepper follows, and its `wa-step-change` checks
      // the step left exactly as Next would. No sync here: the stepper reports the change after
      // its own update, and until then the history would be synced to the step being left.
      // `onStepChange` syncs once it lands, and finds the history already there.
      stepper.goTo(arrived.step)
      return
    }
    this.sync()
  }

  /**
   * Leaves the form for `address`, taking the form's entries with it: back to the first, which
   * is then replaced. Back from wherever the form led then goes to wherever the form was opened
   * from, never into a form that has been saved, or abandoned by a project switch.
   */
  leave(address: string): void {
    if (this.left) return
    this.exit = address
    this.sync()
  }

  /**
   * Puts the form's entries back after the browser has already left them - Back from step 1, an
   * address typed in - and the person chose to stay. Every step up to the one on screen, not
   * only that one, so that Back from it is still the previous step.
   */
  restore(): void {
    this.traversing = false
    for (const step of STEPS.slice(0, STEPS.indexOf(this.host.step) + 1)) {
      history.pushState(this.entry(step), '', this.address(step))
    }
    this.shown = this.host.step
  }

  /** The stepper, once rendered. */
  private stepper(): WaStepper | null {
    return this.host.querySelector('wa-stepper')
  }

  /**
   * Moves to a step. For the last step's "Edit" links and for a save-time error that has to be
   * shown on the step that owns its field.
   */
  goTo(step: AddStep): void {
    this.stepper()?.goTo(step)
  }

  /** Moves to the next step: what Next and Enter in a field do on steps 1-3. */
  next(): void {
    this.stepper()?.next()
  }

  /** Moves to the previous step: what the Previous button does, and browser Back with it. */
  previous(): void {
    this.stepper()?.previous()
  }

  /**
   * Checks a step's own fields as the person leaves it, and records what it found.
   *
   * Validation without a gate (#349): every step is checked, and none refuses the person on
   * the way out - they move between steps freely, in any order. The same readers
   * `planNewDevice` runs (`checkDraftFields`), so a checkmark never promises what Save would
   * refuse. The message itself waits for the person's return: shown now, it would name a
   * control that is about to be hidden. Until then the stepper flags the step.
   */
  check(step: AddStep): void {
    let outcome: DraftError | true = true
    try {
      checkDraftFields(this.form.draft(), CHECKS[step])
    } catch (problem) {
      if (!(problem instanceof DraftError)) throw problem
      outcome = problem
    }
    this.host.checked = { ...this.host.checked, [step]: outcome }
  }

  /** The problem the last check of `step` found, if it found one. */
  private problemOn(step: AddStep): DraftError | undefined {
    const outcome = this.host.checked[step]
    return outcome instanceof DraftError ? outcome : undefined
  }

  /**
   * Checks the step being left, and shows the panel for the step the stepper moved to.
   *
   * The error on screen is always the new step's own, if it has one: an error about a field on
   * another step would name a control the person can no longer see (the spec's third
   * anti-goal). The last step has no fields of its own, so it is never flagged itself;
   * arriving on it checks every other step, including any jumped over, so its cards and the
   * stepper give one verdict on everything about to be saved.
   */
  onStepChange(event: WaStepChangeEvent): void {
    const host = this.host
    const left = event.detail.previousName as AddStep | null
    host.step = event.detail.name as AddStep
    if (host.step === 'review') {
      this.form.enterReview()
    } else if (left !== null && left !== 'review') {
      this.check(left)
    }
    host.error = this.problemOn(host.step)
    void this.focus(host.step)
    this.sync()
  }

  /**
   * Puts focus where a step that has just come on screen begins (WCAG 2.2 AA, PRODUCT.md): the
   * control an error on this step is about, else the step's first control, else - on Review,
   * which has no control of its own - Review's heading.
   *
   * Without it, focus stays on Next, or on a control inside a panel that is now hidden, and a
   * keyboard or screen-reader user has to hunt for where the new step begins. The control in
   * error first because a save-time refusal lands here to be fixed, and starting on another
   * control would make the person find the one the message names. Review's own heading rather
   * than its first card's: focus on "Scan it" would announce step 1's name on entering step 4,
   * and the stepper announces nothing when focus is moved elsewhere. Only on a change, which is
   * all `wa-step-change` reports - the form opening on Scan it moves nothing, because jumping
   * into a field on load scrolls a phone and opens its keyboard before the page has been read.
   *
   * After `updateComplete`, because the panel is unhidden, and Review first rendered, by the
   * update this step change has just requested.
   */
  private async focus(step: AddStep): Promise<void> {
    const host = this.host
    await host.updateComplete
    // A later change superseded this one while it waited; that change does its own focusing.
    if (host.step !== step) return
    const panel = host.querySelector(`[data-step-panel="${step}"]`)
    if (panel === null) return
    const field = host.error?.field
    // `stepOf` places only fields that have a control, so a match is a key of CONTROL_OF.
    const inError =
      field !== undefined && stepOf(field) === step
        ? panel.querySelector<HTMLElement>(
            `[data-field="${CONTROL_OF[field as keyof typeof CONTROL_OF]}"]`,
          )
        : null
    const target =
      inError ??
      panel.querySelector<HTMLElement>(step === 'review' ? '[data-review-heading]' : '[data-field]')
    target?.focus()
  }
}
