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
 * PLAN ENFORCEMENT
 * ----------------
 * A project's OWNER pays for it. When `_security.owners` names the caller and the caller's
 * roles carry neither `member` nor `pro`, every write is refused - deletions included, so a
 * downgraded owner cannot keep using the database by trimming it. Invited writers are not
 * checked: the owner's plan covers them, and their own plan is irrelevant. Reads are not
 * gated (`members` is an OR of names and roles), so a downgraded owner still sees the data.
 * The rule sits before the `_deleted` block precisely so deletions fall under it. A
 * `_security` without `owners` leaves the rule inert. ES5 only: CouchDB's JS engine.
 *
 * SERVICE-OWNED STATE
 * -------------------
 * Two rules come before every other, right after the admin bypass: the `project` document is
 * written by the service alone, and a `_security` carrying `archived: true` refuses every
 * write, deletions included. Both are things the registry decides and the database mirrors.
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

  // The `project` document says what this database is - its name, its client, the server
  // database it mirrors - and the service keeps it in step with the registry pointer. A
  // participant who could write it could rename the project on every replica while the
  // registry said otherwise, so only the server admin may create, change or delete it. Both
  // ids are checked so the rule does not depend on what a deletion happens to carry.
  if (newDoc._id === 'project' || (oldDoc && oldDoc._id === 'project')) {
    throw { forbidden: 'Only the service may change the project document.' }
  }

  // An archived project is put away, not deleted: everybody keeps reading it and nobody
  // writes it until it is brought back. The service sets `archived` in `_security` (another
  // custom key, like `writers`) while the registry says the project is archived, so a replica
  // that keeps syncing cannot go on changing it. Strictly `true`, so nothing else locks it.
  if (secObj && secObj.archived === true) {
    throw { forbidden: 'This project is archived.' }
  }

  var writers = (secObj && secObj.writers && secObj.writers.names) || []
  if (writers.indexOf(userCtx.name) === -1) {
    throw { forbidden: 'You have read-only access to this project.' }
  }

  var owners = (secObj && secObj.owners && secObj.owners.names) || []
  if (owners.indexOf(userCtx.name) !== -1 &&
      userCtx.roles.indexOf('member') === -1 && userCtx.roles.indexOf('pro') === -1) {
    throw { forbidden: 'Your plan does not include synchronized projects.' }
  }

  // A deletion is `{_id, _rev, _deleted: true}` and carries NO other fields - so the
  // document's type has to come from oldDoc. Checking newDoc.type here would silently
  // let every audit entry be deleted, which is exactly the hole this used to have.
  if (newDoc._deleted) {
    if (oldDoc && oldDoc.type === 'audit') {
      throw { forbidden: 'Audit entries are immutable and cannot be deleted.' }
    }
    return
  }

  if (!newDoc.type) {
    throw { forbidden: 'Every document must carry a `type` field.' }
  }

  // Append-only in both directions: no edits, and no deletions above. Allowing either
  // would defeat the point of having an audit log, and they are conflict-free precisely
  // because nothing ever rewrites them.
  if (newDoc.type === 'audit' && oldDoc) {
    throw { forbidden: 'Audit entries are immutable.' }
  }
}
