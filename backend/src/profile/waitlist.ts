/**
 * `PUT /waitlist` and `DELETE /waitlist` (#224): joining the free waitlist for a plan, and
 * leaving it.
 *
 * A resource of its own rather than fields on `PATCH /profile`, because the two differ in what
 * they do: `PATCH` writes what a user chooses about themselves, and this records a request an
 * operator reads. `planRequested` is never a plan. `plan` is still set only by an operator,
 * through `PUT /customer`, and nothing here reaches it.
 *
 * Authenticated exactly as `/profile` is, by {@link callerClaims}, so the deny list and the clock
 * are the same ones.
 *
 * @module
 */

import type { FastifyInstance } from 'fastify'
import { hasAtLeast, isWaitlistPlan } from '../domain/index.js'
import { problem } from '../problem.js'
import { planOf, profileOf } from '../users/records.js'
import { callerClaims, type ProfileDependencies } from './routes.js'

/**
 * Registers `PUT /waitlist` and `DELETE /waitlist`.
 *
 * @param app - The server to register on.
 * @param deps - The profile routes' dependencies: the records, `ensureRecord`, the access-token
 *   key, the deny list and the clock.
 */
export function registerWaitlistRoutes(app: FastifyInstance, deps: ProfileDependencies): void {
  const callerOf = callerClaims(deps)
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))

  app.put('/waitlist', async (request, reply) => {
    const caller = callerOf(request)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const wanted = (request.body as { plan?: unknown } | undefined)?.plan
    // `free` is refused with any unknown value: everybody has it, so nobody can wait for it.
    if (!isWaitlistPlan(wanted)) {
      return problem(reply, { title: 'Not a plan to wait for', status: 400 })
    }

    // By plan order, never a tier literal (ADR 0009). Before anything is written, so a refusal
    // creates no record it would then have to explain.
    if (hasAtLeast(planOf(await deps.records.read(caller.email)), wanted)) {
      return problem(reply, {
        title: 'Already on this plan',
        status: 409,
        reason: 'already-on-plan',
      })
    }

    // A record is needed now: the server is asked to keep something.
    await deps.ensureRecord({
      email: caller.email,
      sub: caller.sub,
      ...(caller.name === undefined ? {} : { name: caller.name }),
    })
    const record = await deps.records.requestPlan(
      caller.email,
      wanted,
      new Date(now() * 1000).toISOString(),
    )
    // The subject only. The address is personal data and stays out of the log.
    request.log.info({ sub: caller.sub }, `waitlist: joined ${wanted}`)

    reply.header('cache-control', 'private, no-store')
    return profileOf(record, caller)
  })

  app.delete('/waitlist', async (request, reply) => {
    const caller = callerOf(request)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    // Never creates a record: leaving a waitlist one never joined is nothing to keep.
    const record = await deps.records.clearRequest(caller.email)

    reply.header('cache-control', 'private, no-store')
    return profileOf(record, caller)
  })
}
