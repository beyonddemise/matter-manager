/**
 * validate_doc_update for every project_<uuid> database.

 * Excluded from Biome in biome.json: this is a bare function EXPRESSION, which is how
 * CouchDB validation functions are written, and is not parseable as a standalone module.
 * It is stringified into the design document rather than imported.
 *
 * WHY THIS EXISTS
 * ---------------
 * CouchDB's `_security` document has exactly two tiers: `admins` and `members`.
 * Members can read *and* write. There is no native read-only role, so "grant read
 * access to this project" cannot be expressed with `_security` alone.
 *
 * The workaround relies on two documented CouchDB behaviours:
 *   1. `_security` is a free-form document; CouchDB only interprets the `admins` and
 *      `members` keys, and preserves any others untouched.
 *   2. Validation functions receive the entire `_security` object as their fourth
 *      argument.
 *
 * So readers go in `members.names` (granting read), and a custom `writers.names` key
 * carries the subset allowed to write. This function enforces the difference.
 *
 * The rejected alternative was a CouchDB role per project carried in the JWT. That
 * works, but an installer with 200 customer projects would carry 200 roles in every
 * token on every replication request.
 *
 * ASSUMPTION UNDER TEST: behaviour (1) above must be confirmed by integration test
 * before M5 builds on it. If CouchDB strips the `writers` key, fall back to
 * per-sync-session scoped JWT roles. See docs/adr/0003-database-per-project.md.
 *
 * @param {object}  newDoc  the document being written
 * @param {object=} oldDoc  the current revision, absent on create
 * @param {object}  userCtx { name, roles } derived from the validated JWT
 * @param {object}  secObj  the database's `_security` document
 */
function (newDoc, oldDoc, userCtx, secObj) {
  // Server admins bypass validation entirely - this is how the API provisions
  // projects and repairs data.
  if (userCtx.roles.indexOf('_admin') !== -1) {
    return
  }

  var writers = (secObj && secObj.writers && secObj.writers.names) || []
  if (writers.indexOf(userCtx.name) === -1) {
    throw { forbidden: 'You have read-only access to this project.' }
  }

  // Deletions are ordinary writes in CouchDB; nothing extra to check here.
  if (newDoc._deleted) {
    return
  }

  if (!newDoc.type) {
    throw { forbidden: 'Every document must carry a `type` field.' }
  }

  // Audit entries are append-only. Allowing edits would defeat the point of
  // having them, and they are conflict-free precisely because nothing rewrites them.
  if (newDoc.type === 'audit' && oldDoc) {
    throw { forbidden: 'Audit entries are immutable.' }
  }
}
