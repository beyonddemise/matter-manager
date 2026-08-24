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

/** Subscription tiers. One today; M8 adds the rest, and the policy table is where they land. */
export type Plan = 'free'

/** Whoever is asking. `plan` is carried from the first migration so there is somewhere to put the answer. */
export interface Principal {
  /** The OIDC subject, which is also the CouchDB user name. */
  readonly sub: string
  readonly plan: Plan
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
 * `satisfies` rather than a type annotation is doing real work here: it requires an entry for
 * every {@link Action} and rejects any key that is not one, so adding an action to
 * {@link ACTIONS} breaks the build until it has an explicit policy. A plain
 * `Record<Action, Policy>` annotation would allow the same completeness check, but would also
 * widen the values and lose the literal types.
 */
export const POLICIES = {
  'project.create': ALLOW,
  'project.invite': ALLOW,
  'device.create': ALLOW,
  'device.attachPhoto': ALLOW,
  'pdf.export': ALLOW,
} satisfies Record<Action, Policy>

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
 * Only an explicit `true` permits. A policy returning anything else fails closed, because for
 * a gate the safe direction for every unexpected value is no.
 */
export function evaluate(
  policies: Readonly<Record<Action, Policy>>,
  principal: Principal,
  action: Action,
  project?: ProjectRef,
): boolean {
  if (!Object.hasOwn(policies, action)) return false
  const policy = policies[action]
  if (typeof policy !== 'function') return false
  return policy(principal, project) === true
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
