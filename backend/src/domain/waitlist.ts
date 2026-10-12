/**
 * The order of the plans, and which of them can be waited for (#224).
 *
 * Tables keyed by {@link Plan}, for the reason `can.ts` gives for its own: ADR 0009 forbids
 * `plan === 'free'`, and a lookup stops compiling the day a fourth plan is added until somebody
 * decides where it ranks and whether anyone can wait for it.
 *
 * @module
 */

import type { Plan } from './can.js'

/**
 * Where each plan stands, lowest first. Only the order means anything: a rank is compared with
 * another plan's rank, never with a constant.
 */
const RANK: Readonly<Record<Plan, number>> = Object.freeze({
  free: 0,
  member: 1,
  pro: 2,
} satisfies Record<Plan, number>)

/** Whether each plan can be joined on the waitlist. The lowest cannot: everybody has it. */
const WAITABLE: Readonly<Record<Plan, boolean>> = Object.freeze({
  free: false,
  member: true,
  pro: true,
} satisfies Record<Plan, boolean>)

/**
 * Whether an account on `held` already has `wanted`, or a plan above it.
 *
 * @param held - The plan the account has now.
 * @param wanted - The plan it asks to wait for.
 */
export function hasAtLeast(held: Plan, wanted: Plan): boolean {
  return RANK[held] >= RANK[wanted]
}

/**
 * Whether a request body's value is a plan somebody can wait for.
 *
 * An own-property check, as `evaluate` in `can.ts` does, so `'constructor'` cannot resolve
 * through the prototype to something truthy.
 */
export function isWaitlistPlan(value: unknown): value is Plan {
  return typeof value === 'string' && Object.hasOwn(WAITABLE, value) && WAITABLE[value as Plan]
}
