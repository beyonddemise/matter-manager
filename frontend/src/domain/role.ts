/**
 * What a participant may do in a project.
 *
 * **Declared twice on purpose.** The backend has its own copy in `backend/src/domain/ownership.ts`.
 * Plenty of values cross between the browser and the server — that is what `openapi.yaml` is
 * for — but this is the only one *duplicated as a source declaration* rather than described by
 * the contract; every other symbol belongs to exactly one side. A shared package for one
 * four-value union is not worth a build boundary, and it would not survive the backend being
 * rewritten in another language — `docs/adr/0017-two-halves-one-contract.md` records what keeps
 * that option open.
 *
 * The two copies are meant to be replaced by one generated from `openapi.yaml`, which is where a
 * client/server agreement belongs and is the only form of it a non-TypeScript backend can honour.
 * Until then, "change one, change the other" is enforced rather than remembered (#183): the
 * roles live in the {@link PROJECT_ROLES} tuple, the type is derived from it — so the compiler
 * guarantees the two cannot disagree — and `test/domain/role-drift.test.ts` compares the tuple
 * against the contract's `Role` enum, failing the suite the moment either side gains or loses a
 * role the other lacks.
 *
 * @module
 */

/** The roles, in the order the contract's `Role` enum lists them. */
export const PROJECT_ROLES = ['owner', 'manage', 'write', 'read'] as const

export type ProjectRole = (typeof PROJECT_ROLES)[number]
