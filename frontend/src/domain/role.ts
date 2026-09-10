/**
 * What a participant may do in a project.
 *
 * **Declared twice on purpose.** The backend has its own copy in `backend/src/domain/ownership.ts`,
 * because it is the only value that crosses between the browser and the server — every other
 * symbol belongs to exactly one of them. A shared package for one four-value union is not worth
 * a build boundary, and it would not survive the backend being rewritten in another language
 * (`docs/adr/0017-two-halves-one-contract.md` records what keeps that option open).
 *
 * The two copies are meant to be replaced by one generated from `openapi.yaml`, which is where a
 * client/server agreement belongs and is the only form of it a non-TypeScript backend can honour.
 * Until then: change one, change the other.
 *
 * @module
 */

export type ProjectRole = 'owner' | 'manage' | 'write' | 'read'
