/**
 * Paid plans through Stripe (#263, backend #60): what this deployment sells, the subscription an
 * account has, and the two Stripe-hosted pages that change it.
 *
 * **Card data never reaches this code.** Subscribing is a Stripe-hosted Checkout and managing
 * (change plan, cancel, update payment) is the Stripe Customer Portal: the API answers a URL and
 * the browser is sent there by a top-level navigation. That is why there is no Stripe.js and why
 * the Content-Security-Policy names no Stripe origin: a navigation is not a fetch, so neither
 * `connect-src` nor `form-action` applies to it.
 *
 * **Stripe is the source of truth for the plan.** Nothing here grants anything: a signed webhook
 * sets `plan` on the account, and the page learns of it by reading the profile again.
 *
 * Every `/billing` route answers 404 on a deployment without Stripe; this module reads that as
 * "nothing for sale here" and the page then behaves as it did before billing existed.
 *
 * **It never throws**, like `waitlist.ts`: the status decides the outcome, never the problem's
 * title, and a failure is an outcome to switch on.
 *
 * @module
 */

import type { LocalCache } from '../data/index.js'
import { isWaitlistPlan, type Plan } from '../domain/plan.js'
import { accessToken } from './tokens.js'

/** Stripe's subscription status, as the contract's `Billing.status` enumerates it. */
export type BillingStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused'

/**
 * Whether a subscription in each status can still charge the account. Mirrors the backend's
 * refusal of a second Checkout (`409 already-subscribed`): live (active, trialing, past due),
 * first payment pending (incomplete), an open invoice (unpaid) or resumable (paused). Only an
 * ended subscription leaves room to subscribe again; every other change goes through the portal.
 */
const CHARGES: Readonly<Record<BillingStatus, boolean>> = Object.freeze({
  active: true,
  trialing: true,
  past_due: true,
  unpaid: true,
  incomplete: true,
  paused: true,
  canceled: false,
  incomplete_expired: false,
} satisfies Record<BillingStatus, boolean>)

/**
 * Whether the status grants the plan, so the period end is the next billing date. As the
 * contract says: `active`, `trialing` and `past_due` grant it; the others leave the account free.
 */
const GRANTS: Readonly<Record<BillingStatus, boolean>> = Object.freeze({
  active: true,
  trialing: true,
  past_due: true,
  unpaid: false,
  incomplete: false,
  paused: false,
  canceled: false,
  incomplete_expired: false,
} satisfies Record<BillingStatus, boolean>)

/** The Stripe subscription the account's plan follows, as the profile's `billing` reports it. */
export interface Billing {
  readonly status: BillingStatus
  /** When the current period ends, ISO-8601: the next billing date, or the end date. */
  readonly currentPeriodEnd?: string
  /** True when the subscription ends at {@link currentPeriodEnd} instead of renewing. */
  readonly cancelAtPeriodEnd: boolean
}

const isStatus = (value: unknown): value is BillingStatus =>
  typeof value === 'string' && Object.hasOwn(CHARGES, value)

/** Whether a value is a {@link Billing}. Checked by shape at the trust boundary, as `isProfile` is. */
export function isBilling(value: unknown): value is Billing {
  if (typeof value !== 'object' || value === null) return false
  const billing = value as Record<string, unknown>
  return (
    isStatus(billing.status) &&
    typeof billing.cancelAtPeriodEnd === 'boolean' &&
    (billing.currentPeriodEnd === undefined || typeof billing.currentPeriodEnd === 'string')
  )
}

/** Whether the account has a subscription that can still charge it; see {@link CHARGES}. */
export function canCharge(billing: Billing | undefined): boolean {
  return billing !== undefined && CHARGES[billing.status]
}

/** Whether the subscription grants the plan; see {@link GRANTS}. */
export function grantsPlan(billing: Billing): boolean {
  return GRANTS[billing.status]
}

/** What `GET /billing` came to. */
export type OfferOutcome =
  /** The plans `POST /billing/checkout` accepts, in plan order. */
  | { readonly kind: 'offer'; readonly plans: readonly Plan[] }
  /** 404: the deployment has no Stripe, so nothing is for sale. */
  | { readonly kind: 'none' }
  /** Signed out, offline, or any other answer: the server could not say. */
  | { readonly kind: 'unknown' }

/** What starting a Checkout or a portal session came to. */
export type SessionOutcome =
  /** The Stripe-hosted page to send the browser to. */
  | { readonly kind: 'redirect'; readonly url: string }
  /** No token held, or 401. */
  | { readonly kind: 'signed-out' }
  /** Checkout's 409: a subscription that can still charge exists; change it in the portal. */
  | { readonly kind: 'already-subscribed' }
  /** The portal's 409: the account never started a Checkout, so there is nothing to manage. */
  | { readonly kind: 'no-billing-account' }
  /** 429: too many sessions started by this account. */
  | { readonly kind: 'rate-limited' }
  /** 404 or 400: the plan, or billing itself, is no longer sold here; the offer is stale. */
  | { readonly kind: 'not-offered' }
  /** A network error, a 503, any other status, or a 200 without a usable URL. */
  | { readonly kind: 'unavailable' }

/** The billing calls. Injected so views and the shell test without a server. */
export interface BillingApi {
  /** The plans for sale. */
  offer(): Promise<OfferOutcome>
  /** A Checkout for `plan`. */
  checkout(plan: Plan): Promise<SessionOutcome>
  /** A Customer Portal session. */
  portal(): Promise<SessionOutcome>
}

/** The two calls the account page makes: the shell wraps them to react to what they answer. */
export type BillingActions = Pick<BillingApi, 'checkout' | 'portal'>

const UNAVAILABLE: SessionOutcome = { kind: 'unavailable' }

/**
 * A session URL the browser may be sent to: absolute `https` and nothing else. Not narrowed to
 * Stripe's own hosts, because Stripe serves Checkout and the portal from an operator's custom
 * domain when one is configured; the URL comes from our own API either way. The scheme check is
 * what matters: a `javascript:` or `data:` URL handed to `location.assign` would run in the page.
 */
function sessionUrl(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const url = (body as Record<string, unknown>).url
  if (typeof url !== 'string') return undefined
  try {
    return new URL(url).protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * The API client, in the style of `waitlistApi`: the access token is read when a call is made,
 * and with none held nothing is asked.
 *
 * @param baseUrl `/api`, behind the application's own origin
 * @param fetchImpl injected by tests
 */
export function billingApi(baseUrl: string, fetchImpl: typeof fetch = fetch): BillingApi {
  const base = baseUrl.replace(/\/+$/, '')

  /** Starts a session; `conflict` is what this route's 409 means. */
  const start = async (
    path: string,
    conflict: SessionOutcome,
    body?: string,
  ): Promise<SessionOutcome> => {
    const token = accessToken()
    if (token === undefined) return { kind: 'signed-out' }
    let response: Response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          // Only with a body: the portal takes none, and an empty body labelled JSON is a 400.
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      })
    } catch {
      return UNAVAILABLE
    }
    if (response.status === 401) return { kind: 'signed-out' }
    if (response.status === 409) return conflict
    if (response.status === 429) return { kind: 'rate-limited' }
    if (response.status === 404 || response.status === 400) return { kind: 'not-offered' }
    if (!response.ok) return UNAVAILABLE
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return UNAVAILABLE
    }
    const url = sessionUrl(parsed)
    return url === undefined ? UNAVAILABLE : { kind: 'redirect', url }
  }

  return {
    async offer(): Promise<OfferOutcome> {
      const token = accessToken()
      if (token === undefined) return { kind: 'unknown' }
      let parsed: unknown
      try {
        const response = await fetchImpl(`${base}/billing`, {
          headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        })
        if (response.status === 404) return { kind: 'none' }
        if (!response.ok) return { kind: 'unknown' }
        parsed = await response.json()
      } catch {
        return { kind: 'unknown' }
      }
      const plans = offeredPlans(parsed)
      return plans === undefined ? { kind: 'unknown' } : { kind: 'offer', plans }
    },
    checkout: (plan) =>
      start('/billing/checkout', { kind: 'already-subscribed' }, JSON.stringify({ plan })),
    portal: () => start('/billing/portal', { kind: 'no-billing-account' }),
  }
}

/**
 * The plans of a `BillingOffer` body, or of a cached one. A body without a `plans` array is
 * refused; a plan in it this build cannot sell (`free`, or a tier from a later version) is left
 * out rather than refusing the rest, because the others are still for sale.
 */
function offeredPlans(body: unknown): readonly Plan[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const plans = (body as Record<string, unknown>).plans
  if (!Array.isArray(plans)) return undefined
  // `isWaitlistPlan`: a plan with one below it, which is every plan a Checkout can sell.
  return plans.filter(isWaitlistPlan)
}

/**
 * Loads the offer, preferring the cache and correcting it from the server: the
 * `resolvePlanMatrix` ladder. A 404 is cached as an empty offer, so a deployment that drops
 * Stripe stops offering it on every device that hears so; signed out or offline, the cached
 * answer stands. The offer is the deployment's, the same for every account, so a late answer
 * needs no sign-out guard.
 *
 * Never throws. `onOffer` fires up to twice, cached then corrected, never with the same answer
 * twice, and not at all when neither cache nor server has one.
 */
export async function resolveBillingOffer(
  api: BillingApi,
  cache: LocalCache,
  onOffer: (plans: readonly Plan[]) => void,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  let cached: readonly Plan[] | undefined
  try {
    const stored = await cache.readBillingOffer()
    cached = stored === undefined ? undefined : offeredPlans(stored)
  } catch {
    cached = undefined
  }
  if (cached !== undefined) onOffer(cached)

  const outcome = await api.offer()
  if (outcome.kind === 'unknown') return
  const fresh = outcome.kind === 'offer' ? outcome.plans : []
  await cache.writeBillingOffer({ plans: fresh, fetchedAt: now() }).catch(() => {
    // A cache that refuses the write still leaves this session's page correct.
  })
  if (JSON.stringify(fresh) !== JSON.stringify(cached)) onOffer(fresh)
}
