/**
 * Who owns a project, and who may do what with it.
 *
 * **Nothing anywhere may compare against a bare owner id.** That is a rule in `CONTRIBUTING.md`
 * rather than a preference, and this module is what makes it possible to follow: ownership is a
 * `{ ownerType, ownerId }` pair (ADR 0011), so an organisation that happens to share a string
 * with a user is not that user. Today only `user` exists, which is precisely when the seam is
 * free to leave open — a comparison written as `project.ownerId === user.sub` works perfectly
 * until the day organisations arrive, and then it is a data migration and an access bug at the
 * same time.
 *
 * @module
 */

/**
 * What a participant may do.
 *
 * `read` and `write` map onto CouchDB's `_security`; `manage` and `owner` are enforced by the
 * API alone, because CouchDB has no way to express "may change who else has access". From the
 * database's point of view a manager and an owner are simply writers — see
 * `docs/SECURITY-MODEL.md`.
 */
export type ProjectRole = 'owner' | 'manage' | 'write' | 'read'

/**
 * Who owns a project.
 *
 * The OpenAPI contract calls this shape `Principal`. It is deliberately **not** called that
 * here, because `core` already has a `Principal` and it is a different thing: that one is the
 * caller making a request, this one is the subject a project belongs to. Two names for two
 * concepts beats one name that has to be disambiguated at every use.
 */
export interface Owner {
  readonly ownerType: 'user' | 'org'
  /** For a user, the OIDC subject — which is also the CouchDB user name. */
  readonly ownerId: string
}

/** One entry in a registry pointer's `participants`. */
export interface Participant {
  readonly role: ProjectRole
  /** The OIDC subject. Named as the registry document names it (`docs/DATA-MODEL.md`). */
  readonly userid: string
}

/** Who is asking. Just the subject: everything else about a caller is irrelevant to ownership. */
export interface Caller {
  readonly sub: string
}

/**
 * The owner named in a participant list, or `undefined` if none is.
 *
 * A pointer with no owner is a broken pointer rather than an ownerless project, and the caller
 * decides what to do about that. Inventing one here would be inventing an answer.
 */
export function ownerOf(participants: readonly Participant[]): Owner | undefined {
  const owner = participants.find((participant) => participant.role === 'owner')
  return owner === undefined ? undefined : { ownerType: 'user', ownerId: owner.userid }
}

/**
 * Whether the caller owns this project.
 *
 * **`ownerType` is checked first**, so an org-owned project is owned by nobody in particular
 * however the ids compare. And the comparison is exact: a subject is an opaque identifier from
 * an identity provider, not a name, so nothing may fold its case.
 *
 * An empty subject matches nothing, including an empty owner id — a caller with no subject is
 * not signed in, and a malformed pointer must not end up owned by everybody who is nobody.
 */
export function isOwner(caller: Caller, owner: Owner): boolean {
  if (owner.ownerType !== 'user') return false
  if (caller.sub === '' || owner.ownerId === '') return false
  return caller.sub === owner.ownerId
}

/**
 * What role somebody has, or `undefined` if they are not a participant.
 *
 * No default. A default of any kind grants access, and being absent from the list is the thing
 * the list exists to express.
 */
export function roleOf(participants: readonly Participant[], sub: string): ProjectRole | undefined {
  if (sub === '') return undefined
  return participants.find((participant) => participant.userid === sub)?.role
}
