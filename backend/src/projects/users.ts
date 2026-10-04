/**
 * Finding a user by email address, or by subject, among user records.
 *
 * Only records with a `sub` are found: a record an operator created by address names somebody
 * who has not signed in yet, and there is no account to add to a project until they do.
 *
 * **Addresses are compared case-insensitively, and the record key is what makes that true.**
 * The local part of an address is case-sensitive by the letter of RFC 5321 and case-insensitive
 * at every provider anybody uses; somebody typing `Ada@Example.test` to share their house means
 * the person they know as `ada@example.test`. `userKey` folds the address, so the lookup is one
 * keyed read and needs no index.
 *
 * @module
 */

import type { UserRecords } from '../users/records.js'

/** What a lookup answers with. */
export interface FoundUser {
  readonly sub: string
  /** As the user gave it, not as it was folded for the key. */
  readonly email: string
}

/**
 * Finds a user by email address or by subject.
 *
 * Accepts both because the two callers want different things from one function: an invitation
 * arrives as an address, and rendering a member list starts from a subject. Which one it is
 * given is decided by shape - a subject is `provider|id` and never contains an `@`. An address
 * resolves by direct read, a subject through the `by_sub` view.
 *
 * @returns the user, or `undefined` if there is no signed-in account. Not an error: "nobody has
 *   that address yet" is an ordinary answer, and M5-4 turns it into an invitation.
 */
export async function findUser(
  records: UserRecords,
  emailOrSub: string,
): Promise<FoundUser | undefined> {
  const value = emailOrSub.trim()
  if (value === '') return undefined

  const record = value.includes('@') ? await records.read(value) : await records.readBySub(value)
  return record?.sub === undefined ? undefined : { sub: record.sub, email: record.email }
}
