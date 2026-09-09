/**
 * What a project's database is called.
 *
 * One function, because the name is assembled from a value that arrives over HTTP and is then
 * used to create and — on the rollback path — **delete** a database. `../_users` is a project id
 * somebody might send.
 *
 * ADR 0003 and the OpenAPI contract both say `project_<uuid>`. `docs/DATA-MODEL.md` carried an
 * example with the hyphens replaced by underscores; CouchDB permits hyphens (this repository's
 * own `verify-access-model.sh` creates `verify-access-model-$$` against a real server), and one
 * representation beats two, so the hyphens stay and the example was corrected.
 *
 * @module
 */

/** Every project database begins with this. Also what makes the name start with a letter. */
export const PROJECT_DATABASE_PREFIX = 'project_'

/**
 * What CouchDB accepts as a database name.
 *
 * From the CouchDB documentation: it must begin with a lower-case letter and may then contain
 * lower-case letters, digits and `_$()+-/`. Asserted against a generated name rather than used
 * to validate one — the uuid check below is the narrower rule, and this is the check that the
 * narrower rule is *enough*.
 */
export const COUCHDB_DATABASE_NAME = /^[a-z][a-z0-9_$()+/-]*$/

/**
 * A uuid as `crypto.randomUUID()` produces one: lower case, version 4, hyphenated.
 *
 * Deliberately not case-insensitive. Folding would let two project ids name one database;
 * refusing means whoever generated it finds out at once, and nothing legitimate is refused
 * because `crypto.randomUUID()` is lower case.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The database holding one project's devices and rooms. */
export function projectDatabaseName(projectId: string): string {
  if (!UUID.test(projectId)) {
    throw new Error(`Not a project id: expected a lower-case uuid, got "${projectId}".`)
  }
  return `${PROJECT_DATABASE_PREFIX}${projectId}`
}

/** Whether this is a database this application named. Asked before anything deletes one. */
export function isProjectDatabase(database: string): boolean {
  return projectIdOf(database) !== undefined
}

/** The project id a database name carries, or `undefined` if it is not one of ours. */
export function projectIdOf(database: string): string | undefined {
  if (!database.startsWith(PROJECT_DATABASE_PREFIX)) return undefined
  const candidate = database.slice(PROJECT_DATABASE_PREFIX.length)
  return UUID.test(candidate) ? candidate : undefined
}
