/**
 * The account page's billing (#263, phase 2): the subscription's dates, Subscribe for each plan
 * on sale above the account's, and Manage billing for the Stripe portal.
 *
 * Plain functions over plain values, like `upgrade-dialog.ts`: `<account-view>` owns the state
 * and subscribes to locale changes, so every `msg()` here follows the language with it.
 *
 * **Nothing here decides the plan.** Stripe is the source of truth: a webhook sets `plan`, and
 * the page only shows what the profile says and sends the browser to Stripe's own pages. On a
 * deployment without Stripe (`GET /billing` 404, an empty offer) none of this renders, and the
 * page is what it was before billing existed.
 *
 * **No plan literals** (ADR 0009): the plans offered come from `plansForSale`, names from a
 * table keyed by `Plan`.
 *
 * @module
 */

import { msg, str } from '@lit/localize'
import { html, nothing, type TemplateResult } from 'lit'
import { type Plan, plansForSale } from '../../domain/plan.js'
import { type Billing, canCharge, grantsPlan, type SessionOutcome } from '../billing.js'
import { getLocale } from '../i18n/localization.js'
import type { SessionState } from '../session.js'

/**
 * Each plan's public name, a table so no plan is named by comparison (ADR 0009). The `member`
 * tier is marketed as "Home" (see `MARKETING_TIERS` in `domain/plan.ts`); the internal tier name
 * never reaches the reader.
 */
const PLAN_NAMES: Readonly<Record<Plan, () => string>> = {
  free: () => msg('Free'),
  member: () => msg('Home'),
  pro: () => msg('Pro'),
}

/** A plan's public name in the current language. */
export function planName(plan: Plan): string {
  return PLAN_NAMES[plan]()
}

/** Why the last Checkout or portal request did not send the browser to Stripe. */
export type BillingProblem =
  | 'signed-out'
  | 'already-subscribed'
  | 'no-billing-account'
  | 'rate-limited'
  | 'unavailable'

/**
 * The problem an outcome is, or `undefined` for a redirect. `not-offered` reads as unavailable:
 * the shell reloads the offer behind it, and the button that was pressed goes if the plan is no
 * longer sold, so the reader is told only that this attempt did not work.
 */
export function problemOf(outcome: SessionOutcome): BillingProblem | undefined {
  if (outcome.kind === 'redirect') return undefined
  return outcome.kind === 'not-offered' ? 'unavailable' : outcome.kind
}

/** What each problem says, in DESIGN.md's error style: what happened, and what to do. */
const PROBLEMS: Readonly<Record<BillingProblem, () => string>> = {
  'signed-out': () => msg('Your session has ended. Please sign in again.'),
  'already-subscribed': () =>
    msg('You already have a subscription. Change it under Manage billing.'),
  'no-billing-account': () => msg('There is no subscription to manage yet.'),
  'rate-limited': () => msg('Too many attempts. Please wait a minute and try again.'),
  unavailable: () => msg('Billing could not be reached. Please try again.'),
}

/** Which button a request is on its way for: a plan's Subscribe, or Manage billing. */
export type BillingPending = Plan | 'portal'

/** What the billing part of the page shows. */
export interface BillingState {
  /** The account's plan, from the cached profile. */
  readonly plan: Plan
  /** The plans the deployment sells; `undefined` until heard, empty when it sells nothing. */
  readonly offer: readonly Plan[] | undefined
  /** The Stripe subscription, from the cached profile. */
  readonly billing: Billing | undefined
  readonly session: SessionState | undefined
  readonly online: boolean
  /** The request on its way, if any: every action waits for it. */
  readonly pending: BillingPending | undefined
  readonly problem: BillingProblem | undefined
  /** How the browser came back from Checkout, when it just did. */
  readonly checkoutReturn: 'success' | 'cancel' | undefined
}

/** What the billing part calls back with. */
export interface BillingHandlers {
  readonly onSubscribe: (plan: Plan) => void
  readonly onManage: () => void
}

/**
 * A date in the current language. A value this build cannot read is shown as it is:
 * `Intl.DateTimeFormat#format` throws a `RangeError` on an invalid date.
 */
function day(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(time)
}

/**
 * Whether the reader is an account the actions can be offered to: signed in, or a stored
 * session the server has not confirmed yet (`offline-held`, #215), whose actions show disabled.
 */
function knownAccount(session: SessionState | undefined): boolean {
  return session === 'signed-in' || session === 'offline-held'
}

/**
 * The subscription's dates: the day it ends when cancelled, else the next billing date while it
 * grants the plan. An ended or unpaid subscription has no next billing date to state.
 */
function dates(billing: Billing): TemplateResult | typeof nothing {
  const end = billing.currentPeriodEnd
  if (end === undefined) return nothing
  const date = day(end)
  if (billing.cancelAtPeriodEnd)
    return html`<p data-billing-ends>${msg(str`Your subscription ends on ${date}.`)}</p>`
  if (!grantsPlan(billing)) return nothing
  return html`<p data-billing-next>${msg(str`Next billing date: ${date}`)}</p>`
}

/**
 * A payment that did not go through: past due (Stripe retries, the plan still holds) or unpaid
 * (the plan has lapsed). Either way the remedy is the portal's payment method, so it says so.
 */
function paymentProblem(billing: Billing): TemplateResult | typeof nothing {
  if (billing.status !== 'past_due' && billing.status !== 'unpaid') return nothing
  return html`<wa-callout variant="warning" data-billing-payment>
    <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
    ${msg('Your last payment did not go through. Update your payment method under Manage billing.')}
  </wa-callout>`
}

/** What coming back from Checkout says. Not a promise of the plan: the webhook grants it. */
function returnNote(how: 'success' | 'cancel'): TemplateResult {
  return how === 'success'
    ? html`<wa-callout variant="success" data-checkout-return>
        <wa-icon slot="icon" name="circle-check"></wa-icon>
        ${msg('Thank you. Your plan changes as soon as Stripe confirms the payment, usually within a minute.')}
      </wa-callout>`
    : html`<p data-checkout-return>${msg('Checkout was cancelled. Nothing was charged.')}</p>`
}

/**
 * The billing part of the account page's Plan card, or nothing on a deployment that sells
 * nothing to an account without a subscription.
 *
 * - **No subscription that can charge:** "Subscribe to …" for each plan on sale above the
 *   account's; the next plan up is the one loud button (DESIGN.md's Commissioning Blue Rule).
 * - **A subscription:** Manage billing, the Stripe portal, where the plan is changed or
 *   cancelled and the payment method updated. Loud when it is the only action. A second Checkout
 *   is not offered while the subscription can still charge: the backend would refuse it (409)
 *   and the account would otherwise pay twice.
 * - **Offline, mid-request, or the session merely held:** the actions show disabled, and the
 *   reader is told a connection is needed.
 */
export function renderBilling(
  state: BillingState,
  handlers: BillingHandlers,
): TemplateResult | typeof nothing {
  const account = knownAccount(state.session)
  const sells = state.offer !== undefined && state.offer.length > 0
  const billing = account ? state.billing : undefined
  const subscribable =
    account && sells && !canCharge(billing) ? plansForSale(state.plan, state.offer ?? []) : []
  // The portal needs billing configured: on a deployment that dropped Stripe it would be a 404.
  const manageable = account && sells && billing !== undefined
  const note = state.checkoutReturn === undefined ? nothing : returnNote(state.checkoutReturn)
  if (billing === undefined && subscribable.length === 0 && !manageable && note === nothing)
    return nothing

  const disabled = !state.online || state.pending !== undefined || state.session !== 'signed-in'
  const problem =
    state.problem === undefined
      ? nothing
      : html`<wa-callout variant="danger" data-billing-problem>
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          ${PROBLEMS[state.problem]()}
        </wa-callout>`
  const subscribe = subscribable.map(
    (plan, index) =>
      html`<wa-button
        data-subscribe=${plan}
        variant="brand"
        appearance=${index === 0 ? 'accent' : 'outlined'}
        ?disabled=${disabled}
        ?loading=${state.pending === plan}
        @click=${() => handlers.onSubscribe(plan)}
      >
        ${msg(str`Subscribe to ${planName(plan)}`)}
      </wa-button>`,
  )
  const manage = manageable
    ? html`<wa-button
        data-manage-billing
        variant="brand"
        appearance=${subscribable.length === 0 ? 'accent' : 'outlined'}
        ?disabled=${disabled}
        ?loading=${state.pending === 'portal'}
        @click=${handlers.onManage}
      >
        ${msg('Manage billing')}
      </wa-button>`
    : nothing
  const actions = subscribable.length > 0 || manageable
  const offline =
    actions && !state.online
      ? html`<p data-billing-offline data-note>${msg('Needs a connection')}</p>`
      : nothing

  // One outer template for every state, so the status region is the same element before and
  // after a request: a live region that arrives together with its content is not announced.
  return html`<div data-billing class="wa-stack wa-gap-s">
    ${note}
    ${billing === undefined ? nothing : html`${dates(billing)}${paymentProblem(billing)}`}
    <div data-billing-status role="status" class="wa-stack wa-gap-s">${problem}</div>
    ${actions ? html`<div class="wa-cluster wa-gap-s">${subscribe}${manage}</div>` : nothing}
    ${offline}
  </div>`
}
