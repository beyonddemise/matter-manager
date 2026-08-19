# 12. A central project registry, with a local cache for offline discovery

Date: 2026-08-19

## Status

Accepted. Supersedes the project-discovery mechanism described in
[ADR 0003](0003-database-per-project.md); that record's core decision — one CouchDB database
per project — is unchanged.

## Context

ADR 0003 established one database per project, and answered "how does a client know which
projects to replicate?" with a per-user database, `user_<sub>`, holding pointer documents
that the API wrote and the client replicated.

That worked, but the per-user database was quietly doing two jobs:

1. **The authorisation record** — who may access what, server-authoritative.
2. **The offline discovery mechanism** — a client-readable list of what to replicate.

Merging them meant every pointer document had to be simultaneously server-written and
client-replicated, defended by a `validate_doc_update` to stop users granting themselves
membership. It also meant one database per user, on top of one per project.

## Decision

Split the two jobs.

**Authorisation lives in a single `projects` database.** One document per project, carrying a
`participants` array of `{ role, userid }`. Admin access only: **never replicated to a
client, and never made a member-readable database.** The API answers `GET /projects` from it
via a `by_participant` view.

**Discovery lives in `mm-local`,** a PouchDB database that exists only in the browser and is
never given a remote counterpart. The client writes it from the results of `GET /projects`
and `GET /profile`, and reads it when offline.

Profiles move to CouchDB's built-in `_users`, used purely as a profile store — see
[DATA-MODEL.md](../DATA-MODEL.md).

## Why `projects` must never be client-readable

CouchDB has no row-level read permission. That single fact is why ADR 0003 exists, and it
applies here with more force, not less.

A `projects` database readable by authenticated users would disclose **every** project's
name, address and participant list to **every** user. In this application project names are
street addresses, and `participants` is a record of who has access to whose home. There is no
filter, view or `_security` arrangement that fixes this — per-database is the only granularity
CouchDB offers, and this database deliberately spans all projects.

This is the obvious thing for someone to "optimise" later, by replicating the registry to the
client for offline access. It would work, it would feel like a simplification, and it would be
a full disclosure of the user base. Hence stating it here rather than only in the data model.

## Consequences

- Authorisation has one home. The registry is unambiguously authoritative and the cache is
  unambiguously disposable — which is a clearer split than the merged design allowed.
- No per-user databases. Database count is projects + 2, not projects + users + 1.
- `GET /projects` requires the `by_participant` view. Without it, listing one user's projects
  scans every project document on the server.
- **Membership writes contend.** All participants live in one document per project, so
  concurrent changes conflict. The API is the sole writer, so `_rev` plus retry on `409` — not
  the merge strategies used for device documents.
- **The cache can be stale in the permissive direction.** A revoked project stays listed until
  the next successful fetch. Not a new exposure, because the local replica already holds the
  data ([SECURITY.md](../../SECURITY.md)) — but replication starts returning `403`, and the UI
  must show *access removed* rather than appearing broken.
- **Nothing may read the cache to authorise anything.** It decides what the client attempts;
  `_security` decides what succeeds. A reviewer should treat any authorisation check reading
  `mm-local` as a defect.
- Profile reads now need connectivity on first use, since `_users` is unreadable by browsers.
  Cached in `mm-local` thereafter, so a returning user keeps their locale offline.

## Alternatives rejected

**Keep the per-user database.** Replication would keep the list fresh automatically, with no
cache-staleness question at all. Rejected because it forces every pointer to be both
server-authoritative and client-writable-in-principle, defended only by a validation function
— and because it multiplies databases by users as well as projects.

**Make `projects` member-readable, filtered by a view.** Views run after the read. Any client
able to query the database can read `_all_docs` directly. This is the same mistake as
filtered replication in ADR 0003, in a place where the payoff for getting it wrong is larger.
