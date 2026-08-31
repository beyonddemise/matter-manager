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

import {
  type Action,
  type Principal,
  type ProjectRole,
  planInvitation,
  planTransfer,
  type RetainedAccess,
  TransferError,
} from '@matter-manager/core'
import type { FastifyInstance } from 'fastify'
import { bearerSubject } from '../auth/bearer.js'
import type { SigningKey } from '../auth/jwt.js'
import type { CouchClient } from '../couch/client.js'
import { type Gate, NotEntitledError, gate as realGate } from '../entitlements/gate.js'
import { accessValidator } from './design-docs.js'
import { type InvitationSender, storeInvitation } from './invitations.js'
import {
  changeMembership,
  listMembers,
  type MembershipDependencies,
  MembershipRefused,
} from './members.js'
import {
  OrphanedDatabaseError,
  type ProjectSummary,
  ProvisioningError,
  provisionProject,
} from './provision.js'
import { pointerId, projectsFor, REGISTRY_DATABASE } from './registry.js'
import { SettingsRefused, updateProjectSettings } from './settings.js'
import {
  acceptTransfer,
  removeTransfer,
  storeTransfer,
  type TransferDocument,
  transferId,
  transfersFor,
} from './transfers.js'
import { findUser } from './users.js'

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
  /** The clock in milliseconds, for the lifetimes of offers. */
  readonly millis?: () => number
  /**
   * The verified identity behind a subject, for accepting a transfer.
   *
   * Rebuilt from what sign-in recorded rather than read off the token: acceptance is decided by
   * an address the **provider** verified, and a token carries a subject. Absent means transfers
   * cannot be accepted, which is what a deployment with no sign-in configured should answer.
   */
  readonly identityOf?: (
    sub: string,
  ) => Promise<
    { readonly sub: string; readonly email?: string; readonly emailVerified?: boolean } | undefined
  >
  /** Finds a user by address or subject. Injected so a test needs no `_users`. */
  readonly findUser?: MembershipDependencies['findUser']
  /**
   * How an invitation is sent (M5-4).
   *
   * Absent means this deployment cannot invite, and an unknown address is refused exactly as it
   * was before — see `InvitationSender` for why there is no default.
   */
  readonly sender?: InvitationSender
}

/** The actions these routes are gated by. Named so the routes and the map cannot drift. */
const CREATE: Action = 'project.create'
const INVITE: Action = 'project.invite'

/**
 * The roles this route may grant, checked before anything is written.
 *
 * **`owner` is deliberately absent**, and this is not the same list as `Role` in the contract.
 * Sharing requires `manage`, and `grantRole` will set any role it is given — so including
 * `owner` here would let a manager promote anybody, themselves included, and the whole of the
 * ownership transfer flow (an offer, a lifetime, an acceptance by the recipient, the outgoing
 * owner's decision about what to retain) would be bypassable by the people it exists to
 * constrain. Ownership moves through `POST /projects/:projectId/transfer` or it does not move.
 *
 * The transfer route makes the same narrowing for the same reason, on `retainAccess`.
 */
const ROLES = new Set(['manage', 'write', 'read'])

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
          // Absent rather than null when the project has none. The view emits the field
          // whatever the pointer holds, so this is the boundary that turns "no address" back
          // into a missing key rather than a value every reader has to special-case.
          ...(typeof row.address === 'string' && row.address !== ''
            ? { address: row.address }
            : {}),
          role: row.role,
          // Every project is listed, archived or not. Filtering here would leave a client no
          // way to show what it has put away and therefore no way to bring it back - which
          // would make archiving a deletion, and #55 says it is not one.
          archived: row.archived === true,
          owner: { ownerType: 'user' as const, ownerId: row.ownerId },
        },
      ]
    })
  })

  const membership: MembershipDependencies = {
    couch: deps.couch,
    findUser: deps.findUser ?? ((value) => findUser(deps.couch, value)),
    // Recorded **and then** sent. A send that fails must not leave an invitation nobody can
    // see; a record that fails must not leave a message promising access that was never
    // granted. Of the two orders, this is the one whose failure is recoverable — the invitation
    // exists and can be sent again.
    ...(deps.sender === undefined
      ? {}
      : {
          invite: async (invitation) => {
            const pointer = await deps.couch.getDoc<{ _id: string; projectName: string }>(
              REGISTRY_DATABASE,
              pointerId(invitation.projectId),
            )
            const planned = planInvitation(invitation, () => Date.now())
            await storeInvitation(deps.couch, planned)
            await deps.sender?.send({
              to: planned.email,
              projectName: pointer?.projectName ?? '',
              invitedByName: invitation.invitedBy,
              role: planned.role,
              expiresAt: planned.expiresAt,
            })
          },
        }),
  }

  app.patch('/projects/:projectId', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    const { projectId } = request.params as { projectId: string }
    const body = (request.body ?? {}) as { name?: unknown; address?: unknown; archived?: unknown }

    // Read as three states, not two: absent leaves the field alone, `null` clears it, and a
    // string sets it. Collapsing absent and null would make a body that forgot the address
    // erase the one that is stored.
    if (body.name !== undefined && typeof body.name !== 'string') {
      return reply.code(400).send({ title: 'A project name is text.', status: 400 })
    }
    if (body.address !== undefined && body.address !== null && typeof body.address !== 'string') {
      return reply
        .code(400)
        .send({ title: 'An address is text, or null to remove it.', status: 400 })
    }

    if (body.archived !== undefined && typeof body.archived !== 'boolean') {
      return reply.code(400).send({ title: 'Archiving a project is true or false.', status: 400 })
    }

    try {
      const summary = await updateProjectSettings({ couch: deps.couch }, projectId, sub, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.address === undefined ? {} : { address: body.address }),
        ...(body.archived === undefined ? {} : { archived: body.archived }),
      })
      return reply.code(200).send(summary)
    } catch (error) {
      if (error instanceof SettingsRefused) {
        return reply.code(error.status).send({ title: error.message, status: error.status })
      }
      throw error
    }
  })

  app.get('/projects/:projectId/members', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    const { projectId } = request.params as { projectId: string }

    try {
      return await listMembers(membership, projectId, sub)
    } catch (error) {
      if (error instanceof MembershipRefused) {
        return reply.code(error.status).send({ title: error.message, status: error.status })
      }
      throw error
    }
  })

  app.put('/projects/:projectId/members', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    const principal: Principal = { sub, plan: 'free' }
    try {
      gate(principal, INVITE, { id: (request.params as { projectId: string }).projectId })
    } catch (error) {
      if (!(error instanceof NotEntitledError)) throw error
      return reply.code(403).send()
    }

    const { projectId } = request.params as { projectId: string }
    const body = (request.body ?? {}) as { email?: unknown; role?: unknown }

    if (typeof body.email !== 'string' || body.email.trim() === '') {
      return reply.code(400).send({ title: 'An email address is needed.', status: 400 })
    }
    // `null` revokes. Spelled as a value rather than as a missing field, so that a body which
    // forgot `role` is a mistake rather than an accidental revocation.
    const revoking = body.role === null
    if (!revoking && (typeof body.role !== 'string' || !ROLES.has(body.role))) {
      return reply.code(400).send({ title: 'That is not a role.', status: 400 })
    }

    try {
      await changeMembership(
        membership,
        projectId,
        sub,
        body.email,
        revoking ? undefined : (body.role as ProjectRole),
      )
    } catch (error) {
      if (error instanceof MembershipRefused) {
        return reply.code(error.status).send({ title: error.message, status: error.status })
      }
      throw error
    }

    return reply.code(204).send()
  })

  /** The clock in milliseconds, for the lifetimes of offers. */
  const millis = deps.millis ?? (() => Date.now())

  app.post('/projects/:projectId/transfer', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    const { projectId } = request.params as { projectId: string }
    const body = (request.body ?? {}) as { toEmail?: unknown; retainAccess?: unknown }

    if (typeof body.toEmail !== 'string') {
      return reply.code(400).send({ title: 'An email address is needed.', status: 400 })
    }
    // The contract's enum is `[read]` and deliberately not a reference to `Role`: a departing
    // owner who could retain `owner` or `manage` could remove the new owner afterwards, which
    // is not a transfer.
    if (body.retainAccess !== undefined && body.retainAccess !== 'read') {
      return reply.code(400).send({ title: 'Only read access can be retained.', status: 400 })
    }
    const retainAccess: RetainedAccess = body.retainAccess === 'read' ? 'read' : 'none'

    const pointer = await deps.couch.getDoc<{ _id: string; participants: [] }>(
      REGISTRY_DATABASE,
      pointerId(projectId),
    )
    // 404 for a project the caller cannot see, and for one that is not there. `planTransfer`
    // refuses anybody who is not the owner, so this only decides which of the two it is.
    if (pointer === undefined) {
      return reply.code(404).send({ title: 'No such project.', status: 404 })
    }

    try {
      const offer = planTransfer(
        { projectId, toEmail: body.toEmail, fromSub: sub, retainAccess },
        pointer.participants,
        millis,
      )
      await storeTransfer(deps.couch, offer)
    } catch (error) {
      if (error instanceof TransferError) {
        // 404 rather than 403 for "you are not the owner": whether a project exists is a fact
        // about somebody else's house, and the caller may not be a participant at all.
        const status = /only the owner/i.test(error.message) ? 404 : 400
        return reply.code(status).send({ title: error.message, status })
      }
      throw error
    }

    return reply.code(204).send()
  })

  app.get('/transfers', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    const account = await membership.findUser(sub)
    if (account === undefined) return []

    const offers = await transfersFor(deps.couch, account.email, millis)

    return Promise.all(
      offers.map(async (offer) => {
        const pointer = await deps.couch.getDoc<{ _id: string; projectName: string }>(
          REGISTRY_DATABASE,
          pointerId(offer.projectId),
        )
        return {
          projectId: offer.projectId,
          projectName: pointer?.projectName ?? '',
          retainAccess: offer.retainAccess,
          expiresAt: offer.expiresAt,
        }
      }),
    )
  })

  app.post('/transfers/:projectId', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    const { projectId } = request.params as { projectId: string }

    // The identity is rebuilt from the account rather than taken from the token: the token
    // carries a subject, and acceptance is decided by a **verified address**. `verifiedEmail`
    // is what sign-in recorded, so it is the provider's answer rather than the caller's.
    const identity = await deps.identityOf?.(sub)
    if (identity === undefined) {
      return reply.code(404).send({ title: 'No such transfer.', status: 404 })
    }

    try {
      await acceptTransfer(membership, projectId, identity, millis)
    } catch (error) {
      if (error instanceof MembershipRefused) {
        return reply.code(error.status).send({ title: error.message, status: error.status })
      }
      throw error
    }

    return reply.code(204).send()
  })

  app.delete('/transfers/:projectId', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now)
    if (sub === undefined) return reply.code(401).send({ title: 'Not signed in', status: 401 })

    const { projectId } = request.params as { projectId: string }
    const account = await membership.findUser(sub)
    const offer = await deps.couch.getDoc<TransferDocument>(
      REGISTRY_DATABASE,
      transferId(projectId),
    )

    // Only the person it was offered to may decline it. Anybody else declining would be
    // withdrawing somebody else's offer, which is the owner's act and not theirs.
    if (
      offer === undefined ||
      account === undefined ||
      offer.toEmail !== account.email.trim().toLowerCase()
    ) {
      return reply.code(404).send({ title: 'No such transfer.', status: 404 })
    }

    await removeTransfer(deps.couch, offer)
    return reply.code(204).send()
  })
}
