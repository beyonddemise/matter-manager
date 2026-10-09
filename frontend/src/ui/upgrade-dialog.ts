/**
 * The upgrade dialog's body (#224): the three plans compared, the account's own highlighted, and
 * (Task W7) the free waitlist.
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
import { PLAN_FEATURES, PLANS, type Plan, PROJECT_LIMITS, planSyncs } from '../domain/plan.js'

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
                  <dt>${row.label()}</dt>
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
