/**
 * The add form's step navigation (#349, split out in #357): which step owns which field, what
 * earns a step its checkmark, and what happens when the person moves between steps.
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
import type { ReactiveControllerHost } from 'lit'
import {
  checkDraftFields,
  type DeviceDraft,
  DraftError,
  type DraftField,
} from '../../domain/index.js'

/** The four steps of adding a device, by their `<wa-step name>` (#349). */
export type AddStep = 'scan' | 'place' | 'name' | 'review'

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
export type StepHost = Pick<ReactiveControllerHost, 'updateComplete'> &
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
 * Moves the add form between its steps, and checks each step as the person leaves it.
 *
 * A plain helper rather than a Lit `ReactiveController`: it has nothing to do on connect,
 * disconnect or update, and the state it changes lives on the element, which re-renders on
 * each assignment as it did before the split.
 */
export class StepNavigation {
  /**
   * @param host the add form, whose state this reads and writes
   * @param form what the form exposes to the navigation and to nothing else
   */
  constructor(
    private readonly host: StepHost,
    private readonly form: StepForm,
  ) {}

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

  /** Moves to the previous step: what Back does. */
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
