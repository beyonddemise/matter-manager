/**
 * `PUT /customer` — setting somebody else's plan.
 *
 * Separate from `PATCH /profile` because that route takes its subject from the token and never
 * from the body; its own comment calls the alternative "an account-takeover primitive". So it can
 * only ever reach the caller, which upgrades an operator and nobody else. This route exists to
 * name a target, and keeping it separate is what lets `/profile` keep its rule intact.
 *
 * **The target is named by email address**, because that is what a user record is keyed by and
 * what an operator knows about a customer. There is **no 404**: a plan has nowhere else to live,
 * and the person it is for may have signed in only once, so the operation creates the record when
 * there is none (their `sub` is filled in at their next sign-in).
 *
 * **It is the only route in this service whose blast radius is somebody else's account.**
 * Everywhere else, a mistake in the gate is a user granting themselves something; here it is one
 * user rewriting another user's entitlements. That is why the order of the checks below is
 * commented as a requirement rather than left to read as style, and why the role list is passed
 * in from `routes.ts` rather than written again.
 *
 * @module
 */

import type { FastifyInstance } from 'fastify'
import { problem } from '../problem.js'
import { isPlan, profileOf, type UserRecords } from '../users/records.js'
import type { callerClaims } from './routes.js'

/** What `PUT /customer` needs: the records, who is asking, and which roles may act. */
export interface CustomerDependencies {
  readonly records: UserRecords
  /**
   * Resolves the caller from the bearer access token. `callerClaims` in `routes.ts`, the same
   * function `/profile` uses, passed in rather than rebuilt so there is one answer to "who is
   * asking" rather than two that can disagree.
   */
  readonly callerOf: ReturnType<typeof callerClaims>
  /**
   * The roles that may do this. Injected so the value is `OPERATOR_ROLES` from `routes.ts` at the
   * one wiring point, and so a test can hold the gate shut without editing the exported list
   * every other route shares.
   */
  readonly operatorRoles: readonly string[]
}

/**
 * Whether `value` has the shape `local@domain.tld`, matching the contract's `format: email`.
 *
 * Deliberately minimal: one `@` with something on each side and a dot inside the domain that
 * has text either side of it, and no whitespace. Real validation is the mail provider's job;
 * this exists so a typo is a 400 here rather than a stray record keyed by a non-address.
 */
export function looksLikeEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim())
}

/**
 * Registers `PUT /customer`.
 *
 * @param deps - The user records, how to identify the caller, and which roles may act.
 */
export function registerCustomerRoutes(app: FastifyInstance, deps: CustomerDependencies): void {
  app.put('/customer', async (request, reply) => {
    const caller = deps.callerOf(request)
    if (caller === undefined) {
      return problem(reply, { title: 'Not signed in', status: 401 })
    }

    // The gate, before the body is looked at and before the target is loaded. Both orderings
    // matter and both are information leaks if reversed: answering 400 first would let a caller
    // who cannot hold a role learn what the route accepts, and any answer that depends on the
    // target would make this an oracle for which accounts exist. For a non-operator every
    // request is the same 403, byte for byte.
    //
    // Exact membership, by `includes` on the role rather than any test over its text: a
    // substring match would make `customerservices`, somebody else's role, into this one, and a
    // case fold would make `Customerservice` into it. On this route that is not a self-grant:
    // it is a stranger rewriting an account.
    const roles = (await deps.records.read(caller.email))?.roles ?? []
    if (!roles.some((role) => deps.operatorRoles.includes(role))) {
      return problem(reply, {
        title: 'Changing a plan is not something this account may do.',
        status: 403,
        reason: 'not-an-operator',
      })
    }

    const body = request.body as { email?: unknown; plan?: unknown } | undefined
    if (!looksLikeEmail(body?.email)) {
      return problem(reply, { title: 'email must name an account.', status: 400 })
    }
    // `isPlan` rather than a comparison against a tier. ADR 0009: what a plan permits is the
    // policy table's business, and this route's only interest is whether the string is a plan
    // this build knows. An unknown one must not be stored: it would read back as `free`, so it
    // would look like a refusal that had in fact written something.
    if (!isPlan(body.plan)) {
      return problem(reply, { title: 'plan must be one of free, member, pro', status: 400 })
    }

    // `body.email`, never `caller.email`: taking the target from the token would compile, pass
    // any test whose operator and target are the same account, and quietly upgrade the operator
    // instead of the customer on every real request.
    //
    // Only `plan` reaches `setPlan`, which spreads the stored record, so `roles` and `type`
    // cannot come from this body. An operator who could set `roles` could mint more operators,
    // and then the gate above means nothing.
    const record = await deps.records.setPlan(body.email, body.plan)
    // Somebody else's record, in an answer to an operator. A shared cache holding it is a cache
    // that can hand a customer's name and address to the next request.
    reply.header('cache-control', 'private, no-store')
    return profileOf(record, { sub: record.sub ?? '', email: record.email })
  })
}
