/**
 * The entitlement seam (ADR 0009).
 *
 * The product needs a subscription eventually and does not need one yet. Adding billing later
 * usually goes badly, and the reason is specific: the payment integration is a day's work,
 * while the entitlement *checks* must appear at every gated action scattered across the UI and
 * the API. Retrofitting them means auditing the whole application for places a limit should
 * have applied — and the ones that get missed are, by definition, the ones nobody tested.
 *
 * So the seam exists now and the provider does not. Every gated action asks {@link can} from
 * the first day it is written. Today the answer is always yes.
 *
 * **This is deliberately not a permissions system.** Who may read or write a project is
 * decided by CouchDB per ADR 0003, and duplicating that here would create two answers to one
 * question. This answers only "does this account's plan allow it", which today is "yes".
 *
 * When M8 arrives, the work is this file and its tests. The call sites already exist and are
 * already exercised, so a missing one shows up immediately rather than as a revenue leak.
 * Never `if (principal.plan === 'free')` in a component — that scattering is the precise
 * failure this module exists to prevent.
 *
 * @module
 */

/**
 * Every action a plan may one day gate.
 *
 * The type is derived from this array rather than declared alongside it, so the two cannot
 * drift: adding an action here immediately makes the policy table below incomplete, and the
 * build fails until someone decides what the new action costs.
 */
export const ACTIONS = [
  'project.create',
  'project.invite',
  'device.create',
  'device.attachPhoto',
  'pdf.export',
] as const

/** An action a plan may one day gate. */
export type Action = (typeof ACTIONS)[number]

/**
 * Subscription tiers.
 *
 * `free` was the only one until capacity became real. The others are named for what they are
 * to a person rather than for what they cost, so a price change is not a type change.
 */
export type Plan = 'free' | 'user' | 'pro'

/**
 * How many projects each plan may own.
 *
 * A table rather than a conditional, for the reason the policy table below is a table: ADR 0009
 * forbids `plan === 'free'` anywhere, and a lookup cannot drift from the type the way a chain of
 * `if` can.
 */
export const PROJECT_LIMITS: Readonly<Record<Plan, number>> = Object.freeze({
  free: 1,
  user: 5,
  /**
   * Unlimited, as a sentinel rather than as `Infinity` or an absence.
   *
   * `Infinity` compares correctly and then serialises to `null`, so an API that computed with
   * it would report something it did not mean. `undefined` forces every reader to handle two
   * shapes. `-1` is one number, it survives JSON, and it is what the contract describes.
   *
   * **It must be tested before it is compared, never after.** `owned >= limit` with a limit of
   * `-1` is true for every count including zero, so the plan with no limit would be the only
   * one that can never create a project — a failure that is both silent and exactly backwards.
   * Every read of this table goes through {@link withinLimit}, which is why that function
   * exists rather than the comparison being written out at each call site.
   */
  pro: -1,
} satisfies Record<Plan, number>)

/**
 * Whether one more project is allowed.
 *
 * The only place the `-1` sentinel is interpreted. Negative first, so unlimited never reaches
 * the comparison.
 */
export function withinLimit(owned: number, limit: number): boolean {
  return limit < 0 || owned < limit
}

/** Whoever is asking. `plan` is carried from the first migration so there is somewhere to put the answer. */
export interface Principal {
  /** The OIDC subject, which is also the CouchDB user name. */
  readonly sub: string
  readonly plan: Plan
  /**
   * How many projects this subject owns.
   *
   * On the principal rather than passed to the policy, because `Policy` is
   * `(principal, project?) => boolean` and a creation has no project to inspect — the count is
   * a fact about the actor, which is what a principal is for. The cost is that the caller has
   * to read it: `POST /projects` counts before it may ask. That is one query on the one route
   * that needs it, against the alternative of a third argument threaded through every policy
   * and every call site.
   */
  readonly ownedProjects: number
}

/** The project an action targets. Absent for actions that create one. */
export interface ProjectRef {
  readonly id: string
}

/**
 * Whether a plan permits one action.
 *
 * Takes the principal and the project rather than closing over them, so an M8 policy can
 * decide on the plan and on what the project already contains without this signature changing
 * — which is the one thing the seam must not do.
 */
export type Policy = (principal: Principal, project?: ProjectRef) => boolean

/** Permits the action. Every policy is this one today. */
export const ALLOW: Policy = () => true

/**
 * What each action costs.
 *
 * `satisfies` is doing real work here: it requires an entry for every {@link Action} and
 * rejects any key that is not one, so adding an action to {@link ACTIONS} breaks the build
 * until it has an explicit policy.
 *
 * Frozen because it is exported. Without that, a consumer could assign
 * `POLICIES['pdf.export'] = () => true` and {@link can} would use the replacement everywhere -
 * turning a gate into a suggestion, from outside the module that owns it and with nothing in
 * this file to show for it. `Readonly` states the same thing to the compiler, which catches it
 * far earlier than the runtime error does.
 */
export const POLICIES: Readonly<Record<Action, Policy>> = Object.freeze({
  'project.create': (principal) =>
    withinLimit(principal.ownedProjects, PROJECT_LIMITS[principal.plan]),
  'project.invite': ALLOW,
  'device.create': ALLOW,
  'device.attachPhoto': ALLOW,
  'pdf.export': ALLOW,
} satisfies Record<Action, Policy>)

/**
 * Applies a policy table to one question.
 *
 * Separate from {@link can} so the wiring can be tested against a table that refuses. With
 * only the real table — which permits everything — a `can` that ignored its policies entirely
 * would pass every test, and would keep passing on the day M8 writes a policy it never
 * consults. That failure is silent, and its symptom is revenue rather than an exception.
 *
 * An action with no policy is refused. It is unreachable from typed callers, but the API
 * boundary and stale persisted values are not typed; permitting the unrecognised is how a
 * typo becomes a bypass.
 *
 * That refusal needs an **own-property** check, not merely a lookup. A plain `policies[action]`
 * walks the prototype chain, so `'constructor'` resolves to `Object` — which passes a
 * `typeof === 'function'` test, gets called, and returns a truthy object. `if (can(...))` then
 * permits it. `'valueOf'` is worse: it throws, taking the gate down rather than opening it.
 *
 * Only an explicit `true` permits. A policy returning anything else fails closed, and so does
 * one that throws, because for a gate the safe direction for every unexpected outcome is no.
 *
 * **Nothing here throws**, and the whole body sits inside the `try` for that reason rather
 * than only the policy call. Every step can raise: `Object.hasOwn` converts its second
 * argument to a property key, and a null-prototype object has no `toString` to convert with;
 * a `policies` object that is a proxy can throw from its `getOwnPropertyDescriptor` trap
 * during the same call. A guard that escapes the catch makes this contract false, which is
 * worse than not claiming it, because callers write `if (can(...))` and never wrap it.
 *
 * A policy that throws is a bug, and swallowing it means that bug presents as a blanket denial
 * rather than a stack trace. That is the right trade for a gate — the application keeps
 * running and the symptom is visible to whoever tries the action — but it is a trade, and
 * worth knowing about when M8 debugs a policy that refuses everything.
 *
 * The same catch covers a table whose entry is not callable at all. An explicit `typeof` check
 * stood here until a mutation probe showed no test could tell it from its absence, which is
 * true: calling a non-function throws, and the catch already denies. One mechanism is easier
 * to keep correct than two that overlap.
 */
export function evaluate(
  policies: Readonly<Record<Action, Policy>>,
  principal: Principal,
  action: Action,
  project?: ProjectRef,
): boolean {
  try {
    if (typeof action !== 'string' || !Object.hasOwn(policies, action)) return false
    return policies[action](principal, project) === true
  } catch {
    return false
  }
}

/**
 * Whether the principal's plan permits the action.
 *
 * Returns `true` for everything today. Call it anyway, from every gated action — that is the
 * entire point, and the cost of not doing so is an audit of the whole application later.
 *
 * @param principal Whoever is asking.
 * @param action What they want to do.
 * @param project The project it targets, omitted for actions that create one.
 */
export function can(principal: Principal, action: Action, project?: ProjectRef): boolean {
  return evaluate(POLICIES, principal, action, project)
}
