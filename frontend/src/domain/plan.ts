/**
 * The plans, as the page needs to read them.
 *
 * **How many projects a plan includes is not here.** The published plan matrix decides it, and
 * each account keeps the limit it was given (ADR 0020): the page reads both from `GET /profile`
 * (`projectLimit`, `planProjectLimit`) and never from a table of its own, so management can change
 * a limit without a release. `SYNCED_PLANS` and `withinLimit` mirror the backend's `PlanPolicy`,
 * because the page must predict what the service will answer rather than discover it from a
 * refused request. The service stays the authority; a drift here costs a disabled button that
 * should have been enabled (or the reverse, which the service then refuses), never a wrong write.
 * ADR 0009 forbids `plan === '…'`
 * anywhere outside this file: every question about a plan is a lookup in a table keyed by
 * {@link Plan}, so adding a fourth plan stops compiling until each table has an answer for it.
 *
 * @module
 */

/** The account tiers, matching the contract's `Profile.plan` enum. */
export type Plan = 'free' | 'member' | 'pro'

/**
 * The limit assumed when the server never said one: a device that never signed in, or a cache
 * written before limits were reported. One project, the least any plan grants, so a guess never
 * offers more than the account may have; the server's answer replaces it once heard.
 */
export const UNHEARD_PROJECT_LIMIT = 1

/** Whether each plan may own a server project at all. Mirrors the backend table. */
export const SYNCED_PLANS: Readonly<Record<Plan, boolean>> = Object.freeze({
  free: false,
  member: true,
  pro: true,
} satisfies Record<Plan, boolean>)

/**
 * Which projects-page layout each plan sees.
 *
 * A table so the view switches on a looked-up name, not on a tier literal; the value is a layout
 * identifier, not a plan.
 */
export const LAYOUTS: Readonly<Record<Plan, 'free' | 'member' | 'pro'>> = Object.freeze({
  free: 'free',
  member: 'member',
  pro: 'pro',
} satisfies Record<Plan, 'free' | 'member' | 'pro'>)

/** Whether each plan is shown the upgrade offer. The top plan has nothing left to upgrade to. */
const UPGRADES: Readonly<Record<Plan, boolean>> = Object.freeze({
  free: true,
  member: true,
  pro: false,
} satisfies Record<Plan, boolean>)

/**
 * Whether one more project is allowed.
 *
 * The only place the `-1` sentinel is interpreted. Negative first: `owned >= -1` is true for
 * every count, so comparing before testing would make the unlimited plan the one that can never
 * create anything.
 */
export function withinLimit(owned: number, limit: number): boolean {
  return limit < 0 || owned < limit
}

/** Whether a value is one of the plans this build knows. */
export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && Object.hasOwn(SYNCED_PLANS, value)
}

/**
 * The plan assumed when none is known: a device that never signed in, or a value this build does
 * not recognise. The one that grants least, for the reason {@link planOf} gives.
 */
export const DEFAULT_PLAN: Plan = 'free'

/**
 * A stored or received value as a plan, `free` when it is not one.
 *
 * Free because it is the plan that grants least: a cache written by a newer build, or a device
 * that never signed in, must not read as entitled to something the account may not have.
 */
export function planOf(value: unknown): Plan {
  return isPlan(value) ? value : DEFAULT_PLAN
}

/** The limit the page enforces: what the server reported when known, else {@link UNHEARD_PROJECT_LIMIT}. */
export function limitFor(reported?: number): number {
  return reported ?? UNHEARD_PROJECT_LIMIT
}

/**
 * Whether limit `a` allows more projects than limit `b`.
 *
 * Unlimited first, for the reason {@link withinLimit} gives: `-1` is the largest limit and the
 * smallest number, so `a > b` answers every comparison involving it backwards.
 */
export function allowsMore(a: number, b: number): boolean {
  if (a < 0) return b >= 0
  return b >= 0 && a > b
}

/**
 * Whether the account keeps a limit above what its plan includes today: the matrix lowered the
 * plan after the account was given more (ADR 0020). Derived from the two numbers the profile
 * reports; unknown when the plan's limit was not heard.
 *
 * @param accountLimit the profile's `projectLimit`
 * @param planLimit the profile's `planProjectLimit`, when reported
 */
export function isLegacyLimit(accountLimit: number, planLimit: number | undefined): boolean {
  return planLimit !== undefined && allowsMore(accountLimit, planLimit)
}

/** Whether the plan puts projects on the server. */
export function planSyncs(plan: Plan): boolean {
  return SYNCED_PLANS[plan]
}

/** Whether the plan is shown the upgrade offer. */
export function showsUpgrade(plan: Plan): boolean {
  return UPGRADES[plan]
}

/**
 * Whether an account that owns `owned` projects may own one more.
 *
 * @param owned owned projects wherever they live; shared ones never count
 * @param reported the server's `projectLimit`, when it has been heard
 */
export function canOwnAnother(owned: number, reported?: number): boolean {
  return withinLimit(owned, limitFor(reported))
}

/**
 * Whether an account owns more projects than its limit — the state a downgrade leaves behind.
 *
 * Not the same as being at the limit: at it, the page simply has no room left; over it, the
 * page says why nothing can be created even though everything stays listed and usable.
 * Unlimited is tested first for the same reason as in {@link withinLimit}: `owned > -1` is
 * always true.
 */
export function exceedsLimit(owned: number, limit: number): boolean {
  return limit >= 0 && owned > limit
}

/**
 * The plans in upgrade order, lowest first (#224).
 *
 * The one place the order is written. The upgrade dialog walks it to lay out its columns and to
 * find the plans above the account's, so the view never compares against a tier literal.
 */
export const PLANS: readonly Plan[] = Object.freeze(['free', 'member', 'pro'] satisfies Plan[])

/** What the plan comparison says about one plan beyond its project limit and its sync. */
export interface PlanFeatures {
  /** Whether projects carry a client name. */
  readonly clientName: boolean
  /** Whether a project can be handed to another account. */
  readonly transfer: boolean
  /** `tba` ("to be announced") while ADR 0009 leaves billing open. */
  readonly price: 'free' | 'tba'
}

/**
 * The comparison's rows that no other table answers. Sync comes from {@link SYNCED_PLANS}, so it
 * is not repeated here; projects are the published matrix's alone (ADR 0020).
 */
export const PLAN_FEATURES: Readonly<Record<Plan, PlanFeatures>> = Object.freeze({
  free: { clientName: false, transfer: false, price: 'free' },
  member: { clientName: false, transfer: false, price: 'tba' },
  pro: { clientName: true, transfer: true, price: 'tba' },
} satisfies Record<Plan, PlanFeatures>)

/** The plans above `plan`, in upgrade order: what an account on it could still wait for. */
export function plansAbove(plan: Plan): readonly Plan[] {
  return PLANS.slice(PLANS.indexOf(plan) + 1)
}

/**
 * The tier behind each marketing name `GET /plans` may use as a column key.
 *
 * The plan matrix is operator-maintained marketing copy, and its keys are the plans' *public*
 * names — today the `member` tier is marketed as `home`. This is the one table that connects the
 * two vocabularies, here because ADR 0009 confines plan literals to this file. A key missing
 * from it is not an error: the dialog shows such a column as a plain comparison column, without
 * "Your plan" or waitlist actions, so a fourth marketing plan displays before this build learns
 * its tier.
 */
const MARKETING_TIERS: Readonly<Record<string, Plan>> = Object.freeze({
  free: 'free',
  home: 'member',
  member: 'member',
  pro: 'pro',
} satisfies Record<string, Plan>)

/**
 * The tier a marketing key names, or `undefined` for one this build does not know.
 *
 * `Object.hasOwn` before indexing, as in {@link isPlan}: the key is server data, and a bare
 * record lookup would answer `tierOf('constructor')` with a function off the prototype chain.
 */
export function tierOf(marketingKey: string): Plan | undefined {
  return Object.hasOwn(MARKETING_TIERS, marketingKey) ? MARKETING_TIERS[marketingKey] : undefined
}

/**
 * Whether `value` is a plan an account can wait for: one with a plan below it, so there is
 * something to upgrade from. Derived from {@link PLANS}, never from a plan literal (ADR 0009).
 */
export function isWaitlistPlan(value: unknown): value is Plan {
  return isPlan(value) && PLANS.indexOf(value) > 0
}
