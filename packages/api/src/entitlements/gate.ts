/**
 * Where the entitlement seam meets HTTP.
 *
 * `can()` in `core` answers the question; this decides *which* routes have to ask it, and turns
 * a "no" into a 403. Today every answer is `true` (ADR 0009) — the seam exists so that when
 * billing arrives at M8 it is a policy table change rather than an audit of every handler.
 *
 * **The point of this module is the map below, not the function.** A seam that each handler
 * remembers to call is a seam with a hole in it the first time somebody forgets, and the hole is
 * invisible: the endpoint works, which is exactly what an ungated endpoint does. So the mapping
 * from action to route is declared **exhaustively and in one place**, and a test walks it.
 *
 * @module
 */

import { ACTIONS, type Action, can, type Principal, type ProjectRef } from '@matter-manager/core'

/** Where an action is enforced. */
export type Enforcement =
  /** An HTTP operation this service serves. The gate must be called before it acts. */
  | { readonly kind: 'route'; readonly method: string; readonly path: string }
  /**
   * Not an API action at all.
   *
   * Device creation, photo attachment and PDF export happen entirely in the browser against a
   * local database — the API is never asked, so there is nothing here to gate. Saying so
   * explicitly matters: an action silently absent from this map would look identical to one
   * somebody forgot, and the whole value of the map is that the two cannot be confused.
   */
  | { readonly kind: 'client'; readonly because: string }

/**
 * Every action, and where it is enforced.
 *
 * `Record<Action, …>` rather than a partial map, so **adding an action to `core` breaks this
 * build** until someone decides where it is enforced. That is the same trick `POLICIES` uses,
 * for the same reason.
 */
export const ENFORCEMENT: Readonly<Record<Action, Enforcement>> = Object.freeze({
  'project.create': { kind: 'route', method: 'POST', path: '/projects' },
  'project.invite': { kind: 'route', method: 'PUT', path: '/projects/:projectId/members' },
  'device.create': {
    kind: 'client',
    because: 'devices are written to a local PouchDB and replicated; the API never sees one',
  },
  'device.attachPhoto': {
    kind: 'client',
    because: 'an attachment goes into the same local document as the device it belongs to',
  },
  'pdf.export': {
    kind: 'client',
    because: 'the PDF is generated in the browser (ADR 0007) and no request is made',
  },
})

/** The actions enforced by an HTTP route, with the route. */
export function gatedRoutes(): ReadonlyArray<{
  readonly action: Action
  readonly method: string
  readonly path: string
}> {
  return ACTIONS.flatMap((action) => {
    const where = ENFORCEMENT[action]
    return where.kind === 'route' ? [{ action, method: where.method, path: where.path }] : []
  })
}

/** Refused by policy rather than by identity: the caller is who they say and still may not. */
export class NotEntitledError extends Error {
  override readonly name = 'NotEntitledError'
  readonly action: Action

  constructor(action: Action) {
    super(`This account's plan does not include ${action}.`)
    this.action = action
  }
}

/** How a handler asks. Injectable so a test can watch every call without patching a module. */
export type Gate = (principal: Principal, action: Action, project?: ProjectRef) => void

/**
 * The gate.
 *
 * Throws rather than returning a boolean, and that is deliberate: a handler that *forgets* to
 * check a returned boolean compiles, runs, and is ungated. A handler that forgets to call this
 * at all is caught by the enumeration test — but of the two mistakes, only one can be caught
 * twice, and this is the cheaper half.
 *
 * @throws {NotEntitledError} which the caller turns into a 403 — **not** a 401. The difference
 *   is worth keeping: 401 says "we do not know who you are" and invites signing in again, which
 *   for an entitlement failure sends the user round a loop that cannot help them.
 */
export const gate: Gate = (principal, action, project) => {
  if (!can(principal, action, project)) throw new NotEntitledError(action)
}
