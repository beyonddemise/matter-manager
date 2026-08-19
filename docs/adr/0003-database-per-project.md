# 3. One CouchDB database per project

Date: 2026-08-19

## Status

Accepted — **verified experimentally on 2026-08-19 against CouchDB 3.5.2**

## Context

A project is a house or apartment. Users grant others read or write access to specific
projects. The authorisation requirement is therefore: Alice can read project A but must not
be able to read project B, and Bob can read project A but must not write to it.

CouchDB has no row-level read permission. `_security` governs an entire database and offers
exactly two tiers, `admins` and `members`, where members can read *and* write.

Two problems follow, and they need separate solutions.

**Problem 1: isolating projects from each other.** Filtered replication is the obvious
candidate and is wrong. The filter runs *after* the read, on the server, as a convenience
for the client. A client that talks to `_all_docs` or `_changes` directly bypasses it
entirely. It shapes what a well-behaved client receives; it does not constrain a hostile
one. As a security boundary it is not one.

**Problem 2: read-only access.** There is no native read-only role, so `members` alone
cannot express "Bob may read but not write".

For problem 2 the candidates were:

- **A CouchDB role per project, carried in the JWT.** Works, but an installer with 200
  customer projects carries 200 roles in every token, on every replication request.
- **Extra keys in `_security`, enforced by `validate_doc_update`.** CouchDB interprets only
  `admins` and `members` and preserves other keys; validation functions receive the whole
  `_security` object as their fourth argument. So readers go in `members.names` and the
  writable subset in a custom `writers.names`, with a validation function enforcing the
  difference. Keeps tokens constant-size regardless of project count.

The second depends on behaviour that is not prominently documented, so it was verified
before being adopted rather than after being built on.

## Decision

One CouchDB database per project, named `project_<uuid>`.

Read access is `members.names`. Write access is a custom `writers.names` key in
`_security`, enforced by `_design/access`'s `validate_doc_update`
(`infra/couchdb/design-docs/access.js`).

Clients never enumerate databases. `_all_dbs` is blocked at the reverse proxy, and a user
discovers their projects through pointer documents in their own `user_<sub>` database.

## Verification

Confirmed against CouchDB 3.5.2 before any code depended on it. All eight assertions passed:

| Assertion | Result |
|---|---|
| `_security` preserves the non-standard `writers` key | pass |
| A writer can create a document | pass |
| A reader cannot create a document | pass |
| A reader **can** read a document | pass |
| A reader cannot delete a document (deletes are writes) | pass |
| A document without a `type` is rejected | pass |
| Audit entries are immutable once written | pass |
| A non-member cannot read at all | pass |

Key persistence and *enforcement using* that key are separate claims; both were tested.

This is preserved as `infra/couchdb/verify-access-model.sh` and runs in CI on every push.
It is not a formality: if a future CouchDB version stops preserving unknown `_security`
keys, read-only access silently becomes read-write, and **no application-level test would
catch it**, because the application would be behaving exactly as written. This script is
the only thing standing between that upgrade and a privilege escalation.

## Consequences

- Sharing is enforced by the database boundary, which is the strongest guarantee CouchDB
  offers.
- Creating a project is the single operation requiring connectivity: it needs admin rights
  to create a database, write `_security` and install the design document. Every other
  operation works offline.
- Many databases. A CouchDB instance handles thousands comfortably, but backup and
  monitoring must be written to enumerate rather than assume a fixed set.
- The client replicates N databases concurrently, so the sync manager tracks a set of
  replications, not one.
- Cross-project queries are impossible without fan-out. Accepted: no user-facing feature
  requires them.
- **Run the verification script against any new CouchDB version before adopting it.**
