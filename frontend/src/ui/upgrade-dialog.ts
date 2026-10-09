/**
 * The upgrade dialog's body (#224): the three plans compared, the account's own highlighted, and
 * the free waitlist.
 *
 * Plain functions over plain values, rendered inside `<app-shell>`, like `shell-header.ts`. The
 * shell owns the state and subscribes to locale changes, so every `msg()` here follows the
 * language with it.
 *
 * **No plan literals** (ADR 0009). Columns come from `PLANS` and values from the plan tables.
 * The account's column is found by comparing two `Plan` values held in variables; a named tier
 * is never compared against.
 *
 * **One layout per width.** At desktop width the comparison is a table with the plans as
 * columns. At phone width (`wa-mobile-only`, below `<wa-page>`'s breakpoint) it is one `wa-card`
 * per plan, stacked, so nothing scrolls sideways at 360 px. Only one of the two is displayed, so
 * assistive technology reads one.
 *
 * @module
 */

import { msg, str } from '@lit/localize'
import { html, type TemplateResult } from 'lit'
import {
  PLAN_FEATURES,
  PLANS,
  type Plan,
  PROJECT_LIMITS,
  planSyncs,
  plansAbove,
} from '../domain/plan.js'
import { getLocale } from './i18n/localization.js'
import type { PlanRequest } from './profile.js'
import type { SessionState } from './session.js'

/** Each plan's name as the dialog shows it. A table, so no plan is named by comparison. */
const PLAN_NAMES: Readonly<Record<Plan, () => string>> = {
  free: () => msg('Free'),
  member: () => msg('Member'),
  pro: () => msg('Pro'),
}

/** A plan's name in the current language. */
export function planName(plan: Plan): string {
  return PLAN_NAMES[plan]()
}

/** The price row's words, while ADR 0009 leaves billing open. */
const PRICES: Readonly<Record<'free' | 'tba', () => string>> = {
  /* why: this shares its id with the plan name "Free"; a `desc` alone does not split the two
     translations, so a different German word here would need an explicit `{id: …}`. */
  free: () => msg('Free'),
  tba: () => msg('To be announced'),
}

/** How many projects a plan may own: unlimited, a number, or a number kept on this device. */
function projectsText(plan: Plan): string {
  const limit = PROJECT_LIMITS[plan]
  // `-1` is unlimited, and is tested before anything else reads the number.
  if (limit < 0) return msg('Unlimited')
  return planSyncs(plan) ? String(limit) : msg(str`${limit}, on this device`)
}

/** A check or a dash, labelled, so the table reads correctly to a screen reader. */
function included(yes: boolean): TemplateResult {
  return html`<wa-icon
    name=${yes ? 'check' : 'minus'}
    label=${yes ? msg('Included') : msg('Not included')}
  ></wa-icon>`
}

/** One row of the comparison: its label, and its value for each plan. */
interface Row {
  readonly id: string
  readonly label: () => string
  readonly value: (plan: Plan) => TemplateResult | string
}

/** The comparison's rows, in the order the issue lists them. Every value is a table lookup. */
const ROWS: readonly Row[] = [
  { id: 'projects', label: () => msg('Projects'), value: projectsText },
  { id: 'sync', label: () => msg('Sync and sharing'), value: (plan) => included(planSyncs(plan)) },
  {
    id: 'client-name',
    label: () => msg('Client name'),
    value: (plan) => included(PLAN_FEATURES[plan].clientName),
  },
  {
    id: 'transfer',
    label: () => msg('Project transfer'),
    value: (plan) => included(PLAN_FEATURES[plan].transfer),
  },
  { id: 'price', label: () => msg('Price'), value: (plan) => PRICES[PLAN_FEATURES[plan].price]() },
]

/**
 * "Your plan", as a tag: size s, with its icon (DESIGN.md). Filled-outlined rather than filled,
 * because it sits on the brand's quiet fill, which is also a filled brand tag's fill: without the
 * edge it would read as loose text, not a tag.
 */
function yourPlan(): TemplateResult {
  return html`<wa-tag data-your-plan variant="brand" appearance="filled-outlined" size="s">
    <wa-icon name="user" class="app-status-icon"></wa-icon>
    ${msg('Your plan')}
  </wa-tag>`
}

/** The plans as columns, with the rows as row headers. Desktop only. */
function comparisonTable(isCurrent: (plan: Plan) => boolean): TemplateResult {
  const highlight = (plan: Plan) => (isCurrent(plan) ? 'app-plan-current' : '')
  return html`<table data-plan-table class="app-plan-table wa-desktop-only">
    <caption class="wa-visually-hidden">${msg('The plans compared')}</caption>
    <thead>
      <tr>
        <td></td>
        ${PLANS.map(
          (plan) =>
            html`<th scope="col" data-plan-column=${plan} class=${highlight(plan)}>
              <div class="wa-stack wa-gap-2xs wa-align-items-start">
                <span>${planName(plan)}</span>
                ${isCurrent(plan) ? yourPlan() : ''}
              </div>
            </th>`,
        )}
      </tr>
    </thead>
    <tbody>
      ${ROWS.map(
        (row) =>
          html`<tr data-row=${row.id}>
            <th scope="row" class="app-plan-label">${row.label()}</th>
            ${PLANS.map(
              (plan) =>
                html`<td data-plan=${plan} class=${highlight(plan)}>${row.value(plan)}</td>`,
            )}
          </tr>`,
      )}
    </tbody>
  </table>`
}

/** One card per plan, stacked, with the rows as a description list. Phone width only. */
function comparisonCards(isCurrent: (plan: Plan) => boolean): TemplateResult {
  return html`<div data-plan-cards class="wa-stack wa-gap-s wa-mobile-only">
    ${PLANS.map(
      (plan) =>
        html`<wa-card data-plan-card=${plan} class=${isCurrent(plan) ? 'app-plan-current' : ''}>
          <div slot="header" class="wa-split wa-gap-s">
            <strong>${planName(plan)}</strong>
            ${isCurrent(plan) ? yourPlan() : ''}
          </div>
          <dl class="wa-stack wa-gap-2xs app-plan-facts">
            ${ROWS.map(
              (row) =>
                html`<div class="wa-split wa-gap-s" data-row=${row.id}>
                  <dt class="app-plan-label">${row.label()}</dt>
                  <dd>${row.value(plan)}</dd>
                </div>`,
            )}
          </dl>
        </wa-card>`,
    )}
  </div>`
}

/**
 * The three plans compared, `current` highlighted.
 *
 * @param current the account's plan, from the cached profile
 */
export function renderPlanComparison(current: Plan): TemplateResult {
  // Two variables compared, never a tier literal (ADR 0009).
  const isCurrent = (plan: Plan): boolean => plan === current
  return html`${comparisonTable(isCurrent)}${comparisonCards(isCurrent)}`
}

/**
 * Why the last waitlist change did not happen, or did not reach this device: the client's
 * outcomes less `done`, and `not-stored` when the server took the change but the cache refused it.
 */
export type WaitlistProblem = 'already-on-plan' | 'signed-out' | 'unavailable' | 'not-stored'

/** What the waitlist part of the dialog shows. */
export interface WaitlistState {
  /** The account's plan, from the cached profile. */
  readonly plan: Plan
  readonly session: SessionState | undefined
  readonly online: boolean
  /** The cached request, when the account is waiting. */
  readonly request: PlanRequest | undefined
  /** A change is on its way to the server: every action waits for it. */
  readonly busy: boolean
  /** Why the last change did not happen, until the dialog closes or another is tried. */
  readonly problem: WaitlistProblem | undefined
}

/** What the waitlist part of the dialog calls back with. */
export interface WaitlistHandlers {
  /** Join for `plan`, or change to it. */
  readonly onJoin: (plan: Plan) => void
  readonly onLeave: () => void
  /** The shell's own sign-in. */
  readonly onSignIn: () => void
}

/** What each problem says, in DESIGN.md's error style: what happened, and what to do. */
const PROBLEMS: Readonly<Record<WaitlistProblem, () => string>> = {
  'already-on-plan': () => msg('You already have this plan.'),
  'signed-out': () => msg('Your session has ended. Please sign in again.'),
  unavailable: () => msg('The waitlist could not be reached. Please try again.'),
  'not-stored': () => msg('Saved, but this device could not store it. Reload to see it.'),
}

/**
 * Each problem's callout variant (DESIGN.md): danger for a change that failed, warning for one
 * that succeeded but left this device behind, like a sync problem.
 */
const PROBLEM_VARIANTS: Readonly<Record<WaitlistProblem, 'danger' | 'warning'>> = {
  'already-on-plan': 'danger',
  'signed-out': 'danger',
  unavailable: 'danger',
  'not-stored': 'warning',
}

/**
 * A request's date in the current language. A value this build cannot read is shown as it is:
 * `Intl.DateTimeFormat#format` throws a `RangeError` on an invalid date, which would take the
 * whole header down with it.
 */
function since(at: string): string {
  const time = Date.parse(at)
  if (Number.isNaN(time)) return at
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(time)
}

function joinLabel(plan: Plan): string {
  const name = planName(plan)
  return msg(str`Join the waitlist for ${name}`)
}

function changeLabel(plan: Plan): string {
  const name = planName(plan)
  return msg(str`Change to ${name}`)
}

function waitingText(request: PlanRequest): string {
  const name = planName(request.plan)
  const date = since(request.at)
  return msg(str`You are on the waitlist for ${name} (since ${date}).`)
}

/**
 * The waitlist's actions for the reader's state.
 *
 * - **Signed out** (or not yet known): one button, the shell's sign-in.
 * - **Signed in, not waiting:** "Join the waitlist for …", for each plan above the account's.
 *   The next plan up is the one loud brand button (DESIGN.md's Commissioning Blue Rule); any
 *   further one is outlined.
 * - **Waiting:** what for and since when, "Change to …" for each other plan above the account's,
 *   and "Leave the waitlist", all outlined: nothing is the obvious next step. Leaving asks
 *   nothing first: it is not destructive and can be redone at once.
 * - **Offline:** everything that needs the server is disabled, and the reader is told why.
 */
export function renderWaitlist(state: WaitlistState, handlers: WaitlistHandlers): TemplateResult {
  const disabled = !state.online || state.busy
  const problem =
    state.problem === undefined
      ? ''
      : html`<wa-callout variant=${PROBLEM_VARIANTS[state.problem]} data-waitlist-problem>
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          ${PROBLEMS[state.problem]()}
        </wa-callout>`
  const waiting =
    state.session === 'signed-in' && state.request !== undefined
      ? html`<p data-waiting>${waitingText(state.request)}</p>`
      : ''
  const offline = state.online
    ? ''
    : html`<p data-needs-connection data-note>${msg('Needs a connection')}</p>`

  // One outer template for every state, so the status region is the same element before and
  // after a change: a live region that arrives together with its content is not announced.
  return html`<div data-waitlist class="wa-stack wa-gap-s">
    <div data-waitlist-status role="status" class="wa-stack wa-gap-s">${problem}${waiting}</div>
    <div class="wa-cluster wa-gap-s">${actions(state, handlers, disabled)}</div>
    ${offline}
  </div>`
}

/** The buttons for the reader's state; see {@link renderWaitlist}. */
function actions(
  state: WaitlistState,
  handlers: WaitlistHandlers,
  disabled: boolean,
): TemplateResult {
  if (state.session !== 'signed-in') {
    return html`<wa-button
      data-sign-in-waitlist
      variant="brand"
      ?disabled=${!state.online}
      @click=${handlers.onSignIn}
    >
      ${msg('Sign in to join the waitlist')}
    </wa-button>`
  }
  const join = (plan: Plan, label: string, primary: boolean) =>
    html`<wa-button
      data-join=${plan}
      variant="brand"
      appearance=${primary ? 'accent' : 'outlined'}
      ?disabled=${disabled}
      @click=${() => handlers.onJoin(plan)}
    >
      ${label}
    </wa-button>`

  const request = state.request
  const above = plansAbove(state.plan)
  if (request === undefined) {
    return html`${above.map((plan, index) => join(plan, joinLabel(plan), index === 0))}`
  }
  // Two variables compared, never a tier literal (ADR 0009).
  const others = above.filter((plan) => plan !== request.plan)
  return html`${others.map((plan) => join(plan, changeLabel(plan), false))}
    <wa-button
      data-leave-waitlist
      appearance="outlined"
      ?disabled=${disabled}
      @click=${handlers.onLeave}
    >
      ${msg('Leave the waitlist')}
    </wa-button>`
}

/**
 * Moves focus to what a settled change left behind (WCAG 2.4.3): the waiting line when there is
 * one, else the first action that can be taken. The button that was clicked was disabled while
 * the change was on its way, and a disabled control drops focus to the page behind the dialog.
 *
 * @param root the open dialog
 */
export async function focusWaitlist(root: ParentNode): Promise<void> {
  const target =
    root.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>('[data-waiting]') ??
    root.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      '[data-waitlist] wa-button:not([disabled])',
    )
  if (target === null) return
  // Made focusable only now, by script: rendered with a tabindex, the line would be what the
  // dialog itself focuses first whenever it opens.
  if (target.matches('[data-waiting]')) target.tabIndex = -1
  // A button enabled by this render has not yet enabled its inner control, which refuses focus.
  await target.updateComplete
  target.focus()
}
