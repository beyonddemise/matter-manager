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
import { isLocale, isPlan, type ProfileStore } from './store.js'

/** The cookie the sign-in flow sets. Named here too rather than exported across modules. */
const SESSION_COOKIE = 'mm_session'

/**
 * The roles that may set a plan.
 *
 * `_admin` is CouchDB's own. `customerservice` is granted by editing a `_users` document, and
 * neither is grantable through this API — `store.update` spreads the existing document and takes
 * only named fields, so a user cannot give themselves the role that would let them do this. That
 * property is what the whole gate rests on.
 *
 * Exported because the operator endpoint checks the same thing, and a second literal list would
 * be free to drift from this one — a role removed here and left there is a gate that is still
 * open in one place.
 */
export const OPERATOR_ROLES: readonly string[] = ['_admin', 'customerservice']

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

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileDependencies): void {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))

  app.get('/profile', async (request, reply) => {
    const sub = subjectOf(request, deps.sessionKey, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    const profile = await deps.store.read(sub)
    if (profile === undefined) {
      // A signed-in user always has a profile — `rememberUser` writes one during sign-in. If
      // there is none, the session outlived the account, and the honest answer is that this
      // credential no longer identifies anybody.
      return reply.code(401).send({ title: 'Not signed in', status: 401 })
    }

    // A profile is per-user and changes when the user changes it. A shared cache holding one is
    // a cache that can hand somebody else's name and email to the next request.
    reply.header('cache-control', 'private, no-store')
    return profile
  })

  app.patch('/profile', async (request, reply) => {
    const sub = subjectOf(request, deps.sessionKey, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

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
      return reply.code(400).send({
        title: 'locale must be one of auto, en, de',
        status: 400,
      })
    }

    if (body?.plan !== undefined) {
      if (!isPlan(body.plan)) {
        return reply.code(400).send({ title: 'plan must be one of free, user, pro', status: 400 })
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
        return reply.code(403).send({
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
    const profile = await deps.store.update(sub, {
      locale: locale ?? current?.locale ?? 'auto',
      // An empty display name is a name nobody has. Absent means "leave it alone", which is
      // what a form that only changed the language sends.
      ...(displayName === undefined || displayName === '' ? {} : { displayName }),
    })

    reply.header('cache-control', 'private, no-store')
    return profile
  })
}
