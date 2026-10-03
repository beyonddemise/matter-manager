/**
 * The plans, as the page needs to read them.
 *
 * **This mirrors `backend/src/domain/can.ts`** — `PROJECT_LIMITS`, `SYNCED_PLANS` and
 * `withinLimit` are the same tables with the same values, because the page must predict what the
 * service will answer rather than discover it from a refused request. The service stays the
 * authority; a drift here costs a disabled button that should have been enabled (or the reverse,
 * which the service then refuses), never a wrong write. ADR 0009 forbids `plan === '…'`
 * anywhere outside this file: every question about a plan is a lookup in a table keyed by
 * {@link Plan}, so adding a fourth plan stops compiling until each table has an answer for it.
 *
 * @module
 */

/** The account tiers, matching the contract's `Profile.plan` enum. */
export type Plan = 'free' | 'member' | 'pro'

/** The projects one account may own per plan; `-1` is unlimited. Mirrors the backend table. */
export const PROJECT_LIMITS: Readonly<Record<Plan, number>> = Object.freeze({
  free: 1,
  member: 5,
  pro: -1,
} satisfies Record<Plan, number>)

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
  return typeof value === 'string' && Object.hasOwn(PROJECT_LIMITS, value)
}

/**
 * A stored or received value as a plan, `free` when it is not one.
 *
 * Free because it is the plan that grants least: a cache written by a newer build, or a device
 * that never signed in, must not read as entitled to something the account may not have.
 */
export function planOf(value: unknown): Plan {
  return isPlan(value) ? value : 'free'
}

/** The limit the page enforces: what the server reported when known, else the plan's table entry. */
export function limitFor(plan: Plan, reported?: number): number {
  return reported ?? PROJECT_LIMITS[plan]
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
export function canOwnAnother(plan: Plan, owned: number, reported?: number): boolean {
  return withinLimit(owned, limitFor(plan, reported))
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
