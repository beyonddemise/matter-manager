/**
 * `POST /projects` and `GET /projects`.
 *
 * The one operation in this application that **requires connectivity**: creating a project means
 * creating a CouchDB database, writing its `_security` and installing its access rules, all of
 * which need admin credentials the browser does not and must not have (ADR 0003).
 *
 * Authenticated with the access token, which is what the contract declares. See `auth/bearer.ts`
 * for the one-sentence rule about which credential authorises what.
 *
 * @module
 */

import type { Action, Principal } from '@matter-manager/core'
import type { FastifyInstance } from 'fastify'
import { bearerSubject } from '../auth/bearer.js'
import type { SigningKey } from '../auth/jwt.js'
import type { CouchClient } from '../couch/client.js'
import { type Gate, NotEntitledError, gate as realGate } from '../entitlements/gate.js'
import { accessValidator } from './design-docs.js'
import {
  OrphanedDatabaseError,
  type ProjectSummary,
  ProvisioningError,
  provisionProject,
} from './provision.js'
import { projectsFor } from './registry.js'

/** What the project routes need. */
export interface ProjectDependencies {
  readonly couch: CouchClient
  /** The key the access token is verified with — the same one CouchDB validates it with. */
  readonly key: SigningKey
  /**
   * The entitlement seam.
   *
   * Injectable **so that a test can watch it being called**, which is what
   * `test/entitlements/gate.test.ts` requires of every gated route: a seam each handler
   * remembers to call is a seam with an invisible hole in it the first time somebody forgets,
   * because an ungated endpoint works exactly like a gated one.
   */
  readonly gate?: Gate
  /** The `validate_doc_update` source. Injectable so a test needs no repository on disk. */
  readonly validator?: () => string
  readonly newId?: () => string
  /** The clock in seconds, for token verification. */
  readonly now?: () => number
  /** The clock as an ISO string, for what is written into a pointer. */
  readonly clock?: () => string
}

/** The action `POST /projects` is gated by. Named so the route and the map cannot drift. */
const CREATE: Action = 'project.create'

/** What the request body may contain. Shape only — the rules live in `provision.ts`. */
interface CreateBody {
  readonly name?: unknown
  readonly address?: unknown
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectDependencies): void {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const gate = deps.gate ?? realGate

  app.post('/projects', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    // Everyone is on `free` until billing arrives (ADR 0009), and `can()` says yes to
    // everything today. The point is that the call is *here*, so M8 is a policy table change
    // rather than an audit of every handler.
    const principal: Principal = { sub, plan: 'free' }
    try {
      gate(principal, CREATE)
    } catch (error) {
      if (!(error instanceof NotEntitledError)) throw error
      return reply.code(403).send()
    }

    const body = (request.body ?? {}) as CreateBody
    if (typeof body.name !== 'string') {
      return reply.code(400).send({ title: 'A project needs a name.', status: 400 })
    }
    const address = typeof body.address === 'string' ? body.address : undefined

    let project: ProjectSummary
    try {
      project = await provisionProject(
        {
          couch: deps.couch,
          validator: deps.validator ?? (() => accessValidator()),
          newId: deps.newId,
          now: deps.clock,
        },
        { name: body.name, address },
        sub,
      )
    } catch (error) {
      // The database that could not be removed is the one thing an operator has to act on, so
      // it is logged at `error` with the name — and still answered as a plain failure, because
      // the caller can neither help nor be told about the deployment.
      if (error instanceof OrphanedDatabaseError) {
        request.log.error({ err: error, database: error.database }, 'orphaned project database')
        return reply.code(500).send({ title: 'That project could not be created.', status: 500 })
      }
      if (error instanceof ProvisioningError) {
        request.log.warn({ err: error }, 'provisioning failed')
        // The message is the domain's own — "a project needs a name", "at most 200 characters"
        // — which is safe to repeat because it describes the request, not the deployment.
        return reply.code(400).send({ title: error.message, status: 400 })
      }
      throw error
    }

    return reply.code(201).send(project)
  })

  app.get('/projects', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    const rows = await projectsFor(deps.couch, sub)

    return rows.flatMap((row) => {
      if (row.ownerId === undefined || row.ownerId === null || row.ownerId === '') {
        // A pointer with no owner is broken data that this API cannot produce. It is left out
        // rather than guessed at: `owner` decides which controls a project offers — transfer,
        // remove a member — and a summary that named the wrong owner would be worse than one
        // that is missing. The log is how somebody finds out.
        request.log.error({ projectId: row.projectId }, 'project pointer has no owner')
        return []
      }

      return [
        {
          projectId: row.projectId,
          dbName: row.dbName,
          name: row.projectName,
          role: row.role,
          owner: { ownerType: 'user' as const, ownerId: row.ownerId },
        },
      ]
    })
  })
}
