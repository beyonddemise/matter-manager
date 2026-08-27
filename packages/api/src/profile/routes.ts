/**
 * `GET /profile` and `PUT /profile`.
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
import { isLocale, type ProfileStore } from './store.js'

/** The cookie the sign-in flow sets. Named here too rather than exported across modules. */
const SESSION_COOKIE = 'mm_session'

export interface ProfileDependencies {
  readonly store: ProfileStore
  readonly key: SigningKey
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
  key: SigningKey,
  now: () => number,
): string | undefined {
  const session = cookie(request, SESSION_COOKIE)
  if (session === undefined) return undefined
  try {
    return verifyToken(session, key.publicKey, 'session', now).sub
  } catch {
    return undefined
  }
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileDependencies): void {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))

  app.get('/profile', async (request, reply) => {
    const sub = subjectOf(request, deps.key, now)
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

  app.put('/profile', async (request, reply) => {
    const sub = subjectOf(request, deps.key, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    const body = request.body as { locale?: unknown; displayName?: unknown } | undefined
    if (!isLocale(body?.locale)) {
      // Named rather than generic. "Invalid request" leaves the caller guessing which of two
      // fields was wrong, and this endpoint has exactly two.
      return reply.code(400).send({
        title: 'locale must be one of auto, en, de',
        status: 400,
      })
    }

    // `sub` comes from the session, never from the body. A profile endpoint that accepted an
    // arbitrary subject would be an account-takeover primitive: send somebody else's id, change
    // their settings. The contract says so too, and this is where it is true.
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : undefined

    const profile = await deps.store.update(sub, {
      locale: body.locale,
      // An empty display name is a name nobody has. Absent means "leave it alone", which is
      // what a form that only changed the language sends.
      ...(displayName === undefined || displayName === '' ? {} : { displayName }),
    })

    reply.header('cache-control', 'private, no-store')
    return profile
  })
}
