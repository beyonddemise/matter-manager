/**
 * `GET /profile` and `PATCH /profile`.
 *
 * Both are authenticated by the session cookie rather than by a bearer, because they are called
 * by the *page* rather than by replication — and the page's credential is the httpOnly cookie
 * it cannot read (see `auth/routes.ts` for why that split exists).
 *
 * @module
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SigningKey } from '../auth/jwt.js'
import { verifyToken } from '../auth/jwt.js'
import { problem } from '../problem.js'
import { isLocale, isPlan, type ProfileStore } from './store.js'

/** The cookie the sign-in flow sets. Named here too rather than exported across modules. */
const SESSION_COOKIE = 'mm_session'

/**
 * The roles that may set a plan.
 *
 * One role, and the list is short on purpose.
 *
 * `customerservice` is granted by editing a `_users` document directly, and is not grantable
 * through this API — `store.update` and `store.setPlan` both spread the existing document and
 * take only named fields, so no request can add a role. A user cannot give themselves the role
 * that would let them do this, and that property is what the whole gate rests on.
 *
 * **`_admin` is deliberately not here, and adding it back would grant every project database in
 * the deployment.** It reads as harmless — "CouchDB's own administrator should obviously be able
 * to do this" — and it is the opposite, for two reasons that only make sense together:
 *
 *   - It cannot do the job it looks like it does. `rolesOf` is `(await load(sub))?.roles ?? []`:
 *     it reads the caller's `_users` document and nothing else. A CouchDB *server* admin is
 *     configured in `local.ini [admins]` and has no `_users` document at all, so `rolesOf`
 *     answers `[]` and the real administrator is refused 403 regardless. Listing the role buys
 *     that person nothing.
 *   - So the only account it can ever match is one with `roles: ["_admin"]` written into its
 *     `_users` document — and `infra/couchdb/design-docs/access.js` gives that role an
 *     unconditional early return from `validate_doc_update` on **every project database in the
 *     deployment**. Holding it is not "may change a plan"; it is "may write any document in
 *     anybody's project, past every access rule this system has".
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

export interface ProfileDependencies {
  readonly store: ProfileStore
  /**
   * The **session** key, not the one CouchDB validates.
   *
   * These routes authenticate by the session cookie, so they verify with the key that signs
   * one. Naming it plainly because the two are interchangeable to the type checker and not at
   * all interchangeable in what they mean — see `AuthDependencies.sessionKey`.
   */
  readonly sessionKey: SigningKey
  readonly now?: () => number
}

/** Reads one cookie out of a request. */
function cookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

/**
 * Identifies the authenticated subject from the session cookie.
 *
 * @param now - Supplies the current Unix time for token verification.
 * @returns The subject identifier if the session token is valid, `undefined` otherwise.
 */
function subjectOf(
  request: FastifyRequest,
  sessionKey: SigningKey,
  now: () => number,
): string | undefined {
  const session = cookie(request, SESSION_COOKIE)
  if (session === undefined) return undefined
  try {
    return verifyToken(session, sessionKey.publicKey, 'session', now).sub
  } catch {
    return undefined
  }
}

/**
 * How a caller is identified on the cookie-authenticated routes.
 *
 * Exported so that the operator endpoint in `customer.ts` identifies its caller by exactly this
 * code path — including the default for `now`, which is the part a second copy would get wrong
 * without anything going red. A route that still verified the cookie, but against a different
 * clock or against the key CouchDB validates rather than the key that signs a session, would
 * look identical from the outside and admit callers this one refuses.
 *
 * @returns A function reading the authenticated subject from a request, `undefined` when there
 *   is no valid session.
 */
export function sessionSubject(
  deps: Pick<ProfileDependencies, 'sessionKey' | 'now'>,
): (request: FastifyRequest) => string | undefined {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  return (request) => subjectOf(request, deps.sessionKey, now)
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileDependencies): void {
  // The same function `PUT /customer` uses. See `sessionSubject`.
  const callerOf = sessionSubject(deps)

  app.get('/profile', async (request, reply) => {
    const sub = callerOf(request)
    if (sub === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const profile = await deps.store.read(sub)
    if (profile === undefined) {
      // A signed-in user always has a profile — `rememberUser` writes one during sign-in. If
      // there is none, the session outlived the account, and the honest answer is that this
      // credential no longer identifies anybody.
      return problem(reply, { title: 'Not signed in', status: 401 })
    }

    // A profile is per-user and changes when the user changes it. A shared cache holding one is
    // a cache that can hand somebody else's name and email to the next request.
    reply.header('cache-control', 'private, no-store')
    return profile
  })

  app.patch('/profile', async (request, reply) => {
    const sub = callerOf(request)
    if (sub === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const body = request.body as
      | { locale?: unknown; displayName?: unknown; plan?: unknown }
      | undefined

    // PATCH: an absent field is one the caller is not changing. `locale` was required before,
    // which made the endpoint a PATCH wearing a PUT's name — it already treated an absent
    // display name as "leave it alone". A `locale` that is present and wrong is still refused;
    // only *nothing at all* means "leave it".
    const locale = body?.locale
    if (locale !== undefined && !isLocale(locale)) {
      // Named rather than generic. "Invalid request" leaves the caller guessing which field was
      // wrong, and this endpoint has three.
      return problem(reply, {
        title: 'locale must be one of auto, en, de',
        status: 400,
      })
    }

    if (body?.plan !== undefined) {
      if (!isPlan(body.plan)) {
        return problem(reply, { title: 'plan must be one of free, member, pro', status: 400 })
      }

      // Exact membership, by `includes` on the role rather than by any test over its text. A
      // substring match would make `customerservices` — somebody else's role — into this one,
      // and a case fold would make `Customerservice` into it; either way a user who can get any
      // role at all named near this one can pay themselves whatever they like.
      const roles = await deps.store.rolesOf(sub)
      if (!roles.some((role) => OPERATOR_ROLES.includes(role))) {
        // Refused out loud rather than dropped. A caller that asked for something and was not
        // told it was refused concludes the field does not exist — and nothing else in the
        // request is applied either, because half of an operator's intent is not an outcome
        // anybody asked for.
        return problem(reply, {
          title: 'Changing a plan is not something this account may do.',
          status: 403,
          reason: 'not-an-operator',
        })
      }

      // `setPlan` rather than a field on the update, because the two differ in who may call
      // them. It cannot raise `UnknownSubjectError` from here: a subject with no `_users`
      // document has no roles, so the 403 above is reached first.
      await deps.store.setPlan(sub, body.plan)
    }

    // `sub` comes from the session, never from the body. A profile endpoint that accepted an
    // arbitrary subject would be an account-takeover primitive: send somebody else's id, change
    // their settings. The contract says so too, and this is where it is true.
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : undefined

    // `store.update` still requires a locale, so a PATCH that changed only the display name has
    // to supply the current one. Reading it here rather than making the parameter optional keeps
    // the store's contract — "this is the locale now" — intact. Defaulting to `auto` instead of
    // reading would silently return a German speaker to whatever their browser says, the first
    // time they edited anything else.
    const current = await deps.store.read(sub)
    if (current === undefined) {
      // The same answer `GET /profile` gives, and for the same reason: a signed-in user always
      // has a profile, because `remember` writes one during sign-in, so no document means the
      // session outlived the account and this credential no longer identifies anybody.
      //
      // Without this the request reached `store.update`, which throws a bare `Error` for the
      // condition — and a bare Error out of a handler is a raw Fastify 500 carrying its message
      // to the caller. So a stale cookie produced `500 {"message":"No profile for <sub>; a
      // signed-in user always has one."}`: an internal invariant, quoted verbatim, with the
      // subject in it, on a route every other failure of which is deliberately shaped. Found by
      // the drift check once it began driving credentialed requests at every operation.
      return problem(reply, { title: 'Not signed in', status: 401 })
    }
    const profile = await deps.store.update(sub, {
      locale: locale ?? current.locale,
      // An empty display name is a name nobody has. Absent means "leave it alone", which is
      // what a form that only changed the language sends.
      ...(displayName === undefined || displayName === '' ? {} : { displayName }),
    })

    reply.header('cache-control', 'private, no-store')
    return profile
  })
}
