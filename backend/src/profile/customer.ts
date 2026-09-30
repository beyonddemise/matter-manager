/**
 * `PUT /customer` — setting somebody else's plan.
 *
 * Separate from `PATCH /profile` because that route takes its subject from the session and never
 * from the body; its own comment calls the alternative "an account-takeover primitive". So it can
 * only ever reach the caller, which upgrades an operator and nobody else. This route exists to
 * name a subject, and keeping it separate is what lets `/profile` keep its rule intact rather
 * than smuggling a subject into a body whose comment forbids it.
 *
 * **It is therefore the only cookie-authenticated route in this service whose blast radius is
 * somebody else's account.** Everywhere else, a mistake in the gate is a user granting
 * themselves something; here it is one user rewriting another user's entitlements. That is why
 * the order of the checks below is commented as a requirement rather than left to read as
 * style, and why the role list is imported from `routes.ts` rather than written again.
 *
 * @module
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isPlan, type ProfileStore, UnknownSubjectError } from './store.js'

export interface CustomerDependencies {
  readonly store: ProfileStore
  /**
   * Resolves the caller from the session cookie. The same function `PATCH /profile` uses —
   * `sessionSubject` in `routes.ts`, passed in rather than rebuilt so there is one answer to
   * "who is asking" rather than two that can disagree.
   */
  readonly subjectOf: (request: FastifyRequest) => string | undefined
  /**
   * The roles that may do this. Injected rather than imported here so that the value is
   * `OPERATOR_ROLES` from `routes.ts` at the one wiring point, and so a test can hold the gate
   * shut without editing the exported list every other route shares.
   */
  readonly operatorRoles: readonly string[]
}

/**
 * Registers `PUT /customer`.
 *
 * @param deps - The profile store, how to identify the caller, and which roles may act.
 */
export function registerCustomerRoutes(app: FastifyInstance, deps: CustomerDependencies): void {
  app.put('/customer', async (request, reply) => {
    const caller = deps.subjectOf(request)
    if (caller === undefined) {
      return reply.code(401).send({ title: 'Not signed in', status: 401 })
    }

    // The gate, before the body is looked at and before the subject is loaded. Both orderings
    // matter and both are information leaks if reversed:
    //
    //   - answering 404 first would make this route an oracle. Any signed-in user could send a
    //     name and learn from the status code whether that account exists, which is the user
    //     base enumerable one guess at a time. An operator needs to tell "no such account" from
    //     "you may not"; nobody else may tell them apart at all, so for a non-operator both are
    //     403 and byte-for-byte identical.
    //   - answering 400 first is the same leak one step earlier: a caller who cannot hold a role
    //     would still learn, from 400 against 404, which of two names is real.
    //
    // Exact membership, by `includes` on the role rather than by any test over its text — the
    // same rule `PATCH /profile` states. A substring match would make `customerservices`,
    // somebody else's role, into this one, and a case fold would make `Customerservice` into
    // it. On this route that is not a self-grant: it is a stranger rewriting an account.
    const roles = await deps.store.rolesOf(caller)
    if (!roles.some((role) => deps.operatorRoles.includes(role))) {
      return reply.code(403).send({
        title: 'Changing a plan is not something this account may do.',
        status: 403,
        reason: 'not-an-operator',
      })
    }

    const body = request.body as { sub?: unknown; plan?: unknown } | undefined
    if (typeof body?.sub !== 'string' || body.sub === '') {
      return reply.code(400).send({ title: 'sub must name an account.', status: 400 })
    }
    // `isPlan` rather than a comparison against a tier. ADR 0009: what a plan permits is the
    // policy table's business, and this route's only interest is whether the string is a plan
    // this build knows. An unknown one must not be stored — `toProfile` would read it back as
    // `free`, so it would look like a refusal that had in fact written something.
    if (!isPlan(body.plan)) {
      return reply.code(400).send({ title: 'plan must be one of free, user, pro', status: 400 })
    }

    try {
      // `body.sub`, never `caller`. Taking the subject from the token here would compile, pass
      // any test whose operator and subject are the same account, and quietly upgrade the
      // operator instead of the customer on every real request.
      //
      // `setPlan` rather than `update`, and only `plan` reaches it: `setPlan` spreads the
      // stored document, so `name`, `roles` and `type` cannot come from this body. An operator
      // who could set `roles` could mint more operators, and then the gate above means nothing.
      const profile = await deps.store.setPlan(body.sub, body.plan)
      // Somebody else's record, in an answer to an operator. A shared cache holding it is a
      // cache that can hand a customer's name and address to the next request.
      reply.header('cache-control', 'private, no-store')
      return profile
    } catch (error) {
      // Rethrown unless it is *the* error, so a genuine CouchDB failure stays a 500 rather than
      // being reported to an operator as "no such account" — which would send them looking for
      // a user who is in fact there.
      if (!(error instanceof UnknownSubjectError)) throw error
      // Distinct from the 403 above. "You may not" and "there is no such account" send an
      // operator to different places, which is the whole reason `setPlan` throws something
      // nameable rather than the bare Error `update` throws for the same condition. Reached
      // only after the gate, so it tells this to an operator and to nobody else.
      return reply.code(404).send({ title: 'No such account.', status: 404 })
    }
  })
}
