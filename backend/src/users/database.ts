/**
 * The `matter_manager` database: one record per user, and nothing a user may read.
 *
 * It holds refresh-token hashes and plans, so **no user token may ever read it**. `_security`
 * is written immediately after creation, before the view, for the reason `provision.ts` gives
 * for project databases: until it lands, the database is open to every account in the
 * deployment.
 *
 * @module
 */

import type { CouchClient } from '../couch/client.js'
import { installDesign, once } from '../couch/design.js'

/** The database user records live in. */
export const USERS_DB = 'matter_manager'
/** The design document holding {@link BY_SUB_VIEW}. */
export const BY_SUB_DESIGN = 'by_sub'
/** Records by subject. Participants are stored by subject, so this resolves them. */
export const BY_SUB_VIEW = 'by_sub'

// Only records with a subject. An operator can create a record by address before its owner has
// ever signed in, and an empty key would collect every such record under one row.
const BY_SUB_MAP = `function (doc) {
  if (doc.type === 'user' && doc.sub) {
    emit(doc.sub, null)
  }
}`

/** The design document holding {@link BY_PLAN_REQUESTED_VIEW}. */
export const BY_PLAN_REQUESTED_DESIGN = 'by_plan_requested'
/**
 * Waiting records by `[planRequested, requestedAt]`, valued by address (#224). For operators, in
 * Fauxton or with curl (see the backend README); the API never reads it.
 */
export const BY_PLAN_REQUESTED_VIEW = 'by_plan_requested'

// Only records that are waiting, so the view is the demand and nothing else.
const BY_PLAN_REQUESTED_MAP = `function (doc) {
  if (doc.type === 'user' && doc.planRequested) {
    emit([doc.planRequested, doc.requestedAt], doc.email)
  }
}`

const setup = once(async (couch: CouchClient) => {
  await couch.createDb(USERS_DB)
  await couch.putSecurity(USERS_DB, {
    admins: { names: [], roles: ['_admin'] },
    members: { names: [], roles: ['_admin'] },
  })
  await installDesign(couch, USERS_DB, `_design/${BY_SUB_DESIGN}`, {
    [BY_SUB_VIEW]: { map: BY_SUB_MAP },
  })
  await installDesign(couch, USERS_DB, `_design/${BY_PLAN_REQUESTED_DESIGN}`, {
    [BY_PLAN_REQUESTED_VIEW]: { map: BY_PLAN_REQUESTED_MAP },
  })
})

/** Creates `matter_manager` if needed, locks it down, and installs its views. Once per process. */
export function ensureUsersDatabase(couch: CouchClient): Promise<void> {
  return setup.ensure(couch)
}

/** Forgets that setup ran. For tests that use a fresh fake CouchDB each time. */
export function forgetUsersDatabase(): void {
  setup.forget()
}
