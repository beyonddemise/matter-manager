/**
 * Finding a user by email address, or by subject.
 *
 * `_users` holds one document per account (`docs/DATA-MODEL.md`), keyed by
 * `org.couchdb.user:<sub>`. Looking somebody up by their **address** therefore needs an index,
 * because the alternative is reading every account in the deployment to answer one invitation.
 *
 * **Addresses are compared case-insensitively, and the view is what makes that true.** The local
 * part of an address is case-sensitive by the letter of RFC 5321 and case-insensitive at every
 * provider anybody uses; somebody typing `Ada@Example.test` to share their house means the
 * person they know as `ada@example.test`, and telling them that person has no account would be
 * wrong in the only way that matters.
 *
 * @module
 */

import type { CouchClient } from '../couch/client.js'
import { installDesign, once } from '../couch/design.js'
import { userDocumentId } from '../profile/store.js'

/** CouchDB's own account database. */
export const USERS_DATABASE = '_users'

/** The design document holding the address index. */
export const BY_EMAIL_DESIGN = 'by_email'

/** The view within it. */
export const BY_EMAIL_VIEW = 'by_email'

/**
 * The map function, emitting a folded address.
 *
 * `toLowerCase()` in the view rather than at the call site, so the *index* is folded and a
 * lookup is one keyed read. Folding only the query would mean scanning to find a match, which
 * is the thing the view exists to avoid.
 */
const BY_EMAIL_MAP = `function (doc) {
  if (doc.type === 'user' && doc.email) {
    emit(doc.email.toLowerCase(), { sub: doc.name, email: doc.email })
  }
}`

/** What a lookup answers with. */
export interface FoundUser {
  readonly sub: string
  /** As the user gave it, not as it was folded for the index. */
  readonly email: string
}

const index = once(async (couch: CouchClient) => {
  await installDesign(couch, USERS_DATABASE, `_design/${BY_EMAIL_DESIGN}`, {
    [BY_EMAIL_VIEW]: { map: BY_EMAIL_MAP },
  })
})

/** Forgets that the index was established. For tests. */
export function forgetUserIndex(): void {
  index.forget()
}

/**
 * Ensures the CouchDB user email index is installed.
 */
export async function ensureUserIndex(couch: CouchClient): Promise<void> {
  return index.ensure(couch)
}

/**
 * Finds a user by email address or by subject.
 *
 * Accepts both because the two callers want different things from one function: an invitation
 * arrives as an address, and rendering a member list starts from a subject. Which one it is
 * given is decided by shape — a subject is `provider|id` and never contains an `@`.
 *
 * @returns the user, or `undefined` if there is no account. Not an error: "nobody has that
 *   address yet" is an ordinary answer, and M5-4 turns it into an invitation.
 */
export async function findUser(
  couch: CouchClient,
  emailOrSub: string,
): Promise<FoundUser | undefined> {
  const value = emailOrSub.trim()
  if (value === '') return undefined

  if (!value.includes('@')) {
    const user = await couch.getDoc<{ _id: string; name: string; email?: string }>(
      USERS_DATABASE,
      userDocumentId(value),
    )
    return user === undefined ? undefined : { sub: user.name, email: user.email ?? '' }
  }

  await ensureUserIndex(couch)
  const result = await couch.view<{ value: FoundUser }>(
    USERS_DATABASE,
    BY_EMAIL_DESIGN,
    BY_EMAIL_VIEW,
    { key: value.toLowerCase() },
  )

  // The first, when two accounts somehow share an address. That should not happen — sign-in
  // creates one account per subject and providers do not reuse addresses — but a deployment is
  // not a proof, and throwing here would make sharing impossible rather than merely ambiguous.
  return result.rows[0]?.value
}
