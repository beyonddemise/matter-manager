/**
 * `GET /profile` and `PATCH /profile`.
 *
 * Both are authenticated by the bearer access token, with the deny list consulted so that a
 * signed-out token stops working here as well as at sign-out. They read the caller's record in
 * `matter_manager`, and `PATCH` is what creates it: records exist on demand, and a person who has
 * only signed in has not yet asked the server to keep anything.
 *
 * @module
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { bearerClaims } from '../auth/bearer.js'
import type { DenyList } from '../auth/deny-list.js'
import type { SigningKey } from '../auth/jwt.js'
import { problem } from '../problem.js'
import type { EnsureRecord } from '../users/ensure.js'
import { isLocale, isPlan, profileOf, type UserRecords } from '../users/records.js'

/**
 * The roles that may set a plan.
 *
 * One role, and the list is short on purpose.
 *
 * `customerservice` is granted by editing the user's record in `matter_manager` directly, and is
 * not grantable through this API — `records.update` and `records.setPlan` both spread the
 * existing record and take only named fields, so no request can add a role. A user cannot give themselves the role
 * that would let them do this, and that property is what the whole gate rests on.
 *
 * **`_admin` is deliberately not here, and adding it back would grant every project database in
 * the deployment.** It reads as harmless — "CouchDB's own administrator should obviously be able
 * to do this" — and it is the opposite, for two reasons that only make sense together:
 *
 *   - It cannot do the job it looks like it does. A CouchDB *server* admin is configured in
 *     `local.ini [admins]` and has no user record at all, so the caller's roles read as none and
 *     the real administrator is refused 403 regardless. Listing the role buys that person
 *     nothing.
 *   - So the only account it can ever match is one with `roles: ["_admin"]` written into its
 *     record — and `infra/couchdb/design-docs/access.js` gives that role an unconditional early
 *     return from `validate_doc_update` on **every project database in the deployment**. Any
 *     record carrying it would also be granted every project database. Holding it is not "may
 *     change a plan"; it is "may write any document in anybody's project".
 *
 * Together those mean the entry could only ever have admitted an account that already had total
 * write access to every customer's data, while doing nothing for the administrator it appeared
 * to be for. Granting somebody the ability to change a plan must not require granting them
 * everything, so the way to make an operator is `customerservice` and nothing else.
 *
 * Exported because the operator endpoint checks the same thing, and a second literal list would
 * be free to drift from this one — a role removed here and left there is a gate that is still
 * open in one place.
 */
export const OPERATOR_ROLES: readonly string[] = ['customerservice']

/** What the profile routes need. */
export interface ProfileDependencies {
  /** The user record store, read for the caller and written by `PATCH`. */
  readonly records: UserRecords
  /** Creates the record on first `PATCH`, and moves the in-memory refresh entries onto it. */
  readonly ensureRecord: EnsureRecord
  /**
   * The key CouchDB validates, because these routes read the **access** token.
   *
   * Not the session key: that signs refresh tokens and handoffs, which must never be accepted
   * as a bearer. The two are interchangeable to the type checker and not at all in what they
   * mean — see `AuthDependencies.sessionKey`.
   */
  readonly key: SigningKey
  /** Access tokens signed out before their expiry. Passed to every verification here. */
  readonly deny: DenyList
  readonly now?: () => number
}

/**
 * How a caller is identified on the profile and customer routes: by the bearer access token.
 *
 * Exported so that the operator endpoint in `customer.ts` identifies its caller by exactly this
 * code path — including the default for `now` and the deny list, which are the parts a second
 * copy would get wrong without anything going red. A route that verified the token against a
 * different clock, or forgot the deny list, would look identical from the outside and admit
 * callers this one refuses.
 *
 * @returns A function reading the authenticated caller from a request, `undefined` when there is
 *   no valid access token, or when it carries no `email` — every record lookup needs the address.
 */
export function callerClaims(
  deps: Pick<ProfileDependencies, 'key' | 'deny' | 'now'>,
): (request: FastifyRequest) => { sub: string; email: string; name?: string } | undefined {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  return (request) => {
    const claims = bearerClaims(request, deps.key, now, deps.deny)
    if (claims?.email === undefined) return undefined
    return {
      sub: claims.sub,
      email: claims.email,
      ...(claims.name === undefined ? {} : { name: claims.name }),
    }
  }
}

/** Registers `GET /profile` and `PATCH /profile`. */
export function registerProfileRoutes(app: FastifyInstance, deps: ProfileDependencies): void {
  // The same function `PUT /customer` uses. See `callerClaims`.
  const callerOf = callerClaims(deps)

  // Exact membership, by `includes` on the role rather than any test over its text. A substring
  // match would make `customerservices` — somebody else's role — into this one, and a case fold
  // would make `Customerservice` into it.
  const isOperator = (roles: readonly string[] | undefined): boolean =>
    (roles ?? []).some((role) => OPERATOR_ROLES.includes(role))

  app.get('/profile', async (request, reply) => {
    const caller = callerOf(request)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    // A profile is per-user and changes when the user changes it. A shared cache holding one is
    // a cache that can hand somebody else's name and email to the next request.
    reply.header('cache-control', 'private, no-store')
    // Answered from the token when there is no record, and creates none: signing in alone does
    // not make a record.
    return profileOf(await deps.records.read(caller.email), caller)
  })

  app.patch('/profile', async (request, reply) => {
    const caller = callerOf(request)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const body = request.body as
      | { locale?: unknown; displayName?: unknown; plan?: unknown }
      | undefined

    // PATCH: an absent field is one the caller is not changing. A `locale` that is present and
    // wrong is still refused; only *nothing at all* means "leave it".
    const locale = body?.locale
    if (locale !== undefined && !isLocale(locale)) {
      // Named rather than generic: this endpoint has three fields.
      return problem(reply, { title: 'locale must be one of auto, en, de', status: 400 })
    }

    if (body?.plan !== undefined) {
      if (!isPlan(body.plan)) {
        return problem(reply, { title: 'plan must be one of free, member, pro', status: 400 })
      }
      // Refused out loud rather than dropped, and before anything is written, so a refused
      // request changes nothing at all: half of an operator's intent is not an outcome anybody
      // asked for. A caller with no record has no roles, so they are refused here too, and the
      // refusal does not create the record it would then have to explain.
      if (!isOperator((await deps.records.read(caller.email))?.roles)) {
        return problem(reply, {
          title: 'Changing a plan is not something this account may do.',
          status: 403,
          reason: 'not-an-operator',
        })
      }
    }

    // Identity comes from the token, never from the body: a profile endpoint that accepted an
    // arbitrary subject would be an account-takeover primitive.
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : undefined

    // A record is needed now: the user asked the server to keep something.
    await deps.ensureRecord({
      email: caller.email,
      sub: caller.sub,
      ...(caller.name === undefined ? {} : { name: caller.name }),
    })
    // `setPlan` rather than a field on the update, because the two differ in who may call them.
    if (isPlan(body?.plan)) await deps.records.setPlan(caller.email, body.plan)
    const record = await deps.records.update(caller.email, {
      ...(locale === undefined ? {} : { locale }),
      // An empty display name is a name nobody has; absent means "leave it alone", which is what
      // a form that only changed the language sends.
      ...(displayName === undefined || displayName === '' ? {} : { displayName }),
    })

    reply.header('cache-control', 'private, no-store')
    return profileOf(record, caller)
  })
}
