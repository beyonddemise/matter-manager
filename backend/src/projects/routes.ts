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

import type { FastifyInstance } from 'fastify'
import { bearerClaims, bearerSubject } from '../auth/bearer.js'
import type { DenyList } from '../auth/deny-list.js'
import type { SigningKey } from '../auth/jwt.js'
import type { CouchClient } from '../couch/client.js'
import {
  type Action,
  foldEmail,
  type Principal,
  type ProjectRole,
  planInvitation,
  planTransfer,
  type RetainedAccess,
  TransferError,
} from '../domain/index.js'
import { type Gate, NotEntitledError, gate as realGate } from '../entitlements/gate.js'
import { problem } from '../problem.js'
import type { EnsureRecord } from '../users/ensure.js'
import { planOf, type UserRecords } from '../users/records.js'
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
import { ensureRegistry, pointerId, projectsFor, REGISTRY_DATABASE } from './registry.js'
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
   * Where the caller's plan is read from — by the address on their access token — and where
   * another participant's address or subject is resolved to an account.
   *
   * **Required, not optional.** An absent record store would have to mean something, and the only
   * thing it could mean is `free` for everybody — which is a deployment that silently stops
   * charging, looks exactly like one that works, and is found by an invoice rather than by a
   * test. A missing wire is a compile error instead.
   */
  readonly records: UserRecords
  /**
   * Creates or completes a user's record, moving their in-memory refresh entries onto it.
   *
   * Called when somebody accepts a transfer: an owner has to be resolvable, and the recipient may
   * have no record, or one without a `sub`. **Required**, and the same instance the profile and
   * sign-in paths use, so the refresh entries it moves are the ones the auth routes wrote.
   */
  readonly ensureRecord: EnsureRecord
  /**
   * Access tokens signed out before they expired. Optional because a deployment without sign-in
   * has no sign-out and so nothing to deny; where there is sign-in, composition passes the one
   * list the auth routes write to.
   */
  readonly deny?: DenyList
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
   * Finds **another** user by address or subject. Injected so a test needs no user records.
   *
   * Never used for the caller. Who is asking is read off their access token — see
   * `callerOf` in {@link registerProjectRoutes} — because a person who has only signed in has
   * no record for this to find.
   */
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
const SYNC: Action = 'project.sync'
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
  readonly client?: unknown
}

/**
 * Registers the project, membership and transfer routes.
 *
 * @param app - The Fastify application to which the routes are added
 * @param deps - CouchDB, the access-token key, the user records and the seams tests replace
 */
export function registerProjectRoutes(app: FastifyInstance, deps: ProjectDependencies): void {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const gate = deps.gate ?? realGate

  /**
   * The caller, as their access token names them: subject, and the address the provider
   * verified.
   *
   * **The caller is always read off the token, never looked up.** `/auth/token` mints an access
   * token only for an address the provider verified at sign-in, and this service signed it, so
   * the address on a token that verifies is a verified address. A lookup by subject, which is
   * what these routes did before, finds only records that carry a `sub` — and a person who has
   * only signed in has no record, while one an operator upgraded through `PUT /customer` has a
   * record with no `sub` until their next sign-in. Both were invisible: an upgraded user stayed
   * `free` here while `/profile` said otherwise, and a recipient saw no transfer made to them.
   *
   * @returns `undefined` when there is no valid, undenied access token
   */
  const callerOf = (
    request: Parameters<typeof bearerClaims>[0],
  ): { readonly sub: string; readonly email?: string; readonly name?: string } | undefined =>
    bearerClaims(request, deps.key, now, deps.deny)

  /**
   * Who is asking, and what they already have.
   *
   * Read before the gate, because the gate cannot read: `Policy` is
   * `(principal, project?) => boolean` and stays synchronous so the policy table can be tested
   * without a database. The I/O therefore lives out here, once, rather than at each call site.
   *
   * `role === 'owner'` rather than the row's presence: the view emits one row **per
   * participant**, so a project somebody shared with this user is theirs to open and not theirs
   * to count. Archived ones do not: archiving is how a project is put away, and a plan's
   * allowance is for the projects somebody is working on. This reverses #55, which counted them
   * because the database still exists. Accepted, because the other reading made archiving a
   * dead end — a member at the limit could not make room without deleting — and the free plan,
   * the one that could have accumulated databases that way, now owns none (`project.sync`).
   *
   * `ensureRegistry` first, for the reason `provisionProject` gives for doing it as its own
   * step 1: a registry that cannot be reached costs nothing at this point. Without it the
   * **first** project on a fresh deployment would query a view in a database that does not
   * exist yet and answer 500 — a count that has to happen before provisioning cannot rely on
   * provisioning to have created the thing it counts. It is remembered per process, so every
   * later call is free.
   *
   * **Two requests racing at the limit can both pass**: each counts before the gate and nothing
   * holds a lock. Accepted rather than solved. The cost is one project over on a race nobody is
   * trying to win, against a serialisation point on project creation for every account — and a
   * limit that is one out under concurrency is a different thing from a limit that is not
   * enforced.
   */
  const principalFor = async (caller: {
    readonly sub: string
    readonly email?: string
  }): Promise<Principal> => {
    const { sub } = caller
    await ensureRegistry(deps.couch)
    const owned = (await projectsFor(deps.couch, sub)).filter(
      (row) => row.role === 'owner' && !row.archived,
    ).length
    // By the address on the token, which is what the record is keyed by and what `/auth/token`
    // and `/profile` read — so all three agree on the plan. See `callerOf` for why not by `sub`.
    // Every token `/auth/token` mints carries an address; one without is answered as `free`.
    const record = caller.email === undefined ? undefined : await deps.records.read(caller.email)
    // `free` is the only tier literal ADR 0009 permits outside the policy table, and it is here
    // because a subject with no record has no plan to read rather than a cheap one. `planOf`
    // owns that default, and the one for a plan this build does not know.
    return { sub, plan: planOf(record), ownedProjects: owned }
  }

  app.post('/projects', async (request, reply) => {
    const caller = callerOf(request)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })
    const { sub } = caller

    let principal: Principal
    try {
      principal = await principalFor(caller)
    } catch (error) {
      // `principalFor` does three pieces of I/O — `ensureRegistry`, the owned-projects view and
      // the user-record read — and any of them can raise `CouchError`. Unwrapped, that escaped as a
      // raw Fastify 500 carrying CouchDB's own message, on the one route whose every other
      // failure is deliberately mapped and scrubbed: there is a test in this file named "says
      // nothing about CouchDB", and this path walked straight past it.
      //
      // Answered as the same shaped 500 `OrphanedDatabaseError` gets, and logged the same way,
      // because they are the same thing to the caller: the deployment could not do its job, the
      // request was not their fault, and there is nothing in the detail they can act on. The
      // detail goes to the log, where somebody can.
      request.log.error({ err: error }, 'could not read the principal for a project creation')
      return problem(reply, { title: 'That project could not be created.', status: 500 })
    }

    try {
      // Sync before capacity: a free account has no server projects to run out of, so telling
      // it "no room" would send it to archive things when the fix is a plan that syncs.
      gate(principal, SYNC)
      gate(principal, CREATE)
    } catch (error) {
      if (!(error instanceof NotEntitledError)) throw error
      // Named, not empty. `reply.code(403).send()` told the page nothing, so it could not tell
      // a capacity refusal from a permission one — and only one of those is fixed by upgrading.
      if (error.action === SYNC) {
        return problem(reply, {
          title: 'This plan does not include synchronized projects.',
          status: 403,
          reason: 'plan-no-sync',
        })
      }
      return problem(reply, {
        title: 'This plan has no room for another project.',
        status: 403,
        reason: 'project-limit-reached',
      })
    }

    const body = (request.body ?? {}) as CreateBody
    if (typeof body.name !== 'string') {
      return problem(reply, { title: 'A project needs a name.', status: 400 })
    }
    const address = typeof body.address === 'string' ? body.address : undefined
    const client = typeof body.client === 'string' ? body.client : undefined

    let project: ProjectSummary
    try {
      project = await provisionProject(
        {
          couch: deps.couch,
          validator: deps.validator ?? (() => accessValidator()),
          newId: deps.newId,
          now: deps.clock,
        },
        { name: body.name, address, client },
        sub,
      )
    } catch (error) {
      // The database that could not be removed is the one thing an operator has to act on, so
      // it is logged at `error` with the name — and still answered as a plain failure, because
      // the caller can neither help nor be told about the deployment.
      if (error instanceof OrphanedDatabaseError) {
        request.log.error({ err: error, database: error.database }, 'orphaned project database')
        return problem(reply, { title: 'That project could not be created.', status: 500 })
      }
      if (error instanceof ProvisioningError) {
        request.log.warn({ err: error }, 'provisioning failed')
        // The message is the domain's own — "a project needs a name", "at most 200 characters"
        // — which is safe to repeat because it describes the request, not the deployment.
        return problem(reply, { title: error.message, status: 400 })
      }
      throw error
    }

    return reply.code(201).send(project)
  })

  app.get('/projects', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now, deps.deny)
    if (sub === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

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
          ...(typeof row.client === 'string' ? { client: row.client } : {}),
          ...(typeof row.archivedAt === 'number' ? { archivedAt: row.archivedAt } : {}),
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
    findUser: deps.findUser ?? ((value) => findUser(deps.records, value)),
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
    const sub = bearerSubject(request, deps.key, now, deps.deny)
    if (sub === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const { projectId } = request.params as { projectId: string }
    const body = (request.body ?? {}) as {
      name?: unknown
      address?: unknown
      client?: unknown
      archived?: unknown
    }

    // Read as three states, not two: absent leaves the field alone, `null` clears it, and a
    // string sets it. Collapsing absent and null would make a body that forgot the address
    // erase the one that is stored.
    if (body.name !== undefined && typeof body.name !== 'string') {
      return problem(reply, { title: 'A project name is text.', status: 400 })
    }
    if (body.address !== undefined && body.address !== null && typeof body.address !== 'string') {
      return problem(reply, { title: 'An address is text, or null to remove it.', status: 400 })
    }
    if (body.client !== undefined && body.client !== null && typeof body.client !== 'string') {
      return problem(reply, { title: 'A client is text, or null to remove it.', status: 400 })
    }

    if (body.archived !== undefined && typeof body.archived !== 'boolean') {
      return problem(reply, { title: 'Archiving a project is true or false.', status: 400 })
    }

    try {
      const summary = await updateProjectSettings({ couch: deps.couch, now }, projectId, sub, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.address === undefined ? {} : { address: body.address }),
        ...(body.client === undefined ? {} : { client: body.client }),
        ...(body.archived === undefined ? {} : { archived: body.archived }),
      })
      return reply.code(200).send(summary)
    } catch (error) {
      if (error instanceof SettingsRefused) {
        return problem(reply, { title: error.message, status: error.status })
      }
      throw error
    }
  })

  app.get('/projects/:projectId/members', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now, deps.deny)
    if (sub === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const { projectId } = request.params as { projectId: string }

    try {
      return await listMembers(membership, projectId, sub)
    } catch (error) {
      if (error instanceof MembershipRefused) {
        return problem(reply, { title: error.message, status: error.status })
      }
      throw error
    }
  })

  app.put('/projects/:projectId/members', async (request, reply) => {
    const caller = callerOf(request)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })
    const { sub } = caller

    // The real count, by the same rule the creation route uses, and deliberately not a
    // literal `0`. `project.invite` is `ALLOW` today and reads nothing from the principal, so a
    // literal would be invisible now and silently wrong on the day a policy starts reading it —
    // which is precisely the failure ADR 0009's seam exists to prevent. One extra read on this
    // route is the price.
    let principal: Principal
    try {
      principal = await principalFor(caller)
    } catch (error) {
      // The same three pieces of I/O `POST /projects` wraps for the same reason —
      // `ensureRegistry`, the owned-projects view and the user-record read — any of which can raise
      // `CouchError`. Unwrapped, that escaped as a raw Fastify 500 carrying CouchDB's own
      // message, on a route that otherwise maps and scrubs every failure. Before this route
      // counted the caller's owned projects it built the principal from literal values and did
      // no I/O at all, so this path did not exist until `principalFor` replaced that literal.
      //
      // Answered as the same shaped 500 `POST /projects` answers for the identical failure, and
      // logged the same way: the deployment could not do its job, the request was not the
      // caller's fault, and there is nothing in the detail they can act on. The detail goes to
      // the log, where somebody can.
      request.log.error({ err: error }, 'could not read the principal for a membership change')
      return problem(reply, { title: 'That membership could not be changed.', status: 500 })
    }

    try {
      gate(principal, INVITE, { id: (request.params as { projectId: string }).projectId })
    } catch (error) {
      if (!(error instanceof NotEntitledError)) throw error
      // A body, where this sent none. The contract declares this 403 as `Forbidden`, whose
      // schema requires `title` and `status`, and an empty body satisfies neither — so the
      // response was undescribed as well as unhelpful. `project.invite` is `ALLOW` today, which
      // is why nothing had noticed: the branch is unreachable with the real policy table and
      // reachable the moment M8 gives the action a real one.
      //
      // No `reason`. The contract names one only for the refusals a client has to tell apart,
      // and this operation has a single 403; inventing a name here would put a value in the
      // contract that no page branches on. See `POST /projects` for the case that does.
      return problem(reply, {
        title: 'This plan does not include sharing a project.',
        status: 403,
      })
    }

    const { projectId } = request.params as { projectId: string }
    const body = (request.body ?? {}) as { email?: unknown; role?: unknown }

    if (typeof body.email !== 'string' || body.email.trim() === '') {
      return problem(reply, { title: 'An email address is needed.', status: 400 })
    }
    // `null` revokes. Spelled as a value rather than as a missing field, so that a body which
    // forgot `role` is a mistake rather than an accidental revocation.
    const revoking = body.role === null
    if (!revoking && (typeof body.role !== 'string' || !ROLES.has(body.role))) {
      return problem(reply, { title: 'That is not a role.', status: 400 })
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
        return problem(reply, { title: error.message, status: error.status })
      }
      throw error
    }

    return reply.code(204).send()
  })

  /** The clock in milliseconds, for the lifetimes of offers. */
  const millis = deps.millis ?? (() => Date.now())

  app.post('/projects/:projectId/transfer', async (request, reply) => {
    const sub = bearerSubject(request, deps.key, now, deps.deny)
    if (sub === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const { projectId } = request.params as { projectId: string }
    const body = (request.body ?? {}) as { toEmail?: unknown; retainAccess?: unknown }

    if (typeof body.toEmail !== 'string') {
      return problem(reply, { title: 'An email address is needed.', status: 400 })
    }
    // The contract's enum is `[read]` and deliberately not a reference to `Role`: a departing
    // owner who could retain `owner` or `manage` could remove the new owner afterwards, which
    // is not a transfer.
    if (body.retainAccess !== undefined && body.retainAccess !== 'read') {
      return problem(reply, { title: 'Only read access can be retained.', status: 400 })
    }
    const retainAccess: RetainedAccess = body.retainAccess === 'read' ? 'read' : 'none'

    const pointer = await deps.couch.getDoc<{ _id: string; participants: [] }>(
      REGISTRY_DATABASE,
      pointerId(projectId),
    )
    // 404 for a project the caller cannot see, and for one that is not there. `planTransfer`
    // refuses anybody who is not the owner, so this only decides which of the two it is.
    if (pointer === undefined) {
      return problem(reply, { title: 'No such project.', status: 404 })
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
        return problem(reply, { title: error.message, status })
      }
      throw error
    }

    return reply.code(204).send()
  })

  app.get('/transfers', async (request, reply) => {
    const caller = callerOf(request)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })
    // Offers are addressed to an address, and the token's is verified (see `callerOf`). Nobody
    // has to have a record to be offered a house.
    if (caller.email === undefined) return []

    const offers = await transfersFor(deps.couch, caller.email, millis)

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
    const caller = callerOf(request)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const { projectId } = request.params as { projectId: string }

    // Acceptance is decided by a **verified address**, and the token's is one: `/auth/token`
    // mints access tokens only for an address the provider verified at sign-in, and this service
    // signed the token. So `emailVerified: true` is the provider's answer carried forward, not
    // the caller's claim. A token with no address cannot be anybody's recipient.
    if (caller.email === undefined) {
      return problem(reply, { title: 'No such transfer.', status: 404 })
    }
    const identity = {
      sub: caller.sub,
      email: caller.email,
      emailVerified: true,
      // Seeds the record acceptance creates, as sign-in would have.
      ...(caller.name === undefined ? {} : { name: caller.name }),
    }

    try {
      await acceptTransfer(
        { couch: deps.couch, ensureRecord: deps.ensureRecord },
        projectId,
        identity,
        millis,
      )
    } catch (error) {
      if (error instanceof MembershipRefused) {
        return problem(reply, { title: error.message, status: error.status })
      }
      throw error
    }

    return reply.code(204).send()
  })

  app.delete('/transfers/:projectId', async (request, reply) => {
    const caller = callerOf(request)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const { projectId } = request.params as { projectId: string }
    const offer = await deps.couch.getDoc<TransferDocument>(
      REGISTRY_DATABASE,
      transferId(projectId),
    )

    // Only the person it was offered to may decline it. Anybody else declining would be
    // withdrawing somebody else's offer, which is the owner's act and not theirs.
    // The token's address, as for listing and accepting: see `callerOf`.
    if (
      offer === undefined ||
      caller.email === undefined ||
      offer.toEmail !== foldEmail(caller.email)
    ) {
      return problem(reply, { title: 'No such transfer.', status: 404 })
    }

    await removeTransfer(deps.couch, offer)
    return reply.code(204).send()
  })
}
