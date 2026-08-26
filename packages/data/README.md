# @matter-manager/data

PouchDB repositories, the replication manager, and conflict resolution.

**Created in M2-4.**

## It constructs no database

A repository is handed an open `PouchDB.Database`; this package imports no PouchDB
implementation and opens nothing. That is forced rather than chosen: `pouchdb-browser`, the
allowlisted runtime build, references `self` at module scope and **cannot be imported in Node
at all**, so any code depending on it could only be tested in a browser.

Inverting it means `packages/web` supplies the browser build, the tests supply `pouchdb-core`
plus `pouchdb-adapter-memory`, and these tests run in Node in milliseconds like `core`'s. The
only PouchDB name in `src` is the *type* `PouchDB.Database`, which is erased at compile time —
asserted by `test/no-pouchdb-import.test.ts`, which is what makes the `allowedDev` claim in
`dependency-policy.json` a proof rather than a promise.

## Documents are keyed by type

Ids are `device:<uuid>` and `room:<uuid>`, so each type is a contiguous key range and `list()`
is a ranged `_all_docs` query with no view to define, index, replicate or find stale. The cost
is that the only free query is by id prefix, which is why a device's `roomId` is a full
document id rather than a bare uuid.

## The repository owns `updatedAt`

`Unsaved<T>` removes it, so a caller cannot supply one. It is half of the total order the
conflict merge depends on (ADR 0010), and a document written without it does not fail — it
quietly loses every future conflict. The clock is injected, so tests are deterministic.

## What belongs here

- Repositories over PouchDB (`DeviceRepository`, `RoomRepository`, `ProjectRepository`)
- The sync manager: one live replication per project, restart on reconnect, JWT refresh
- Conflict detection and the application of merge strategies from `@matter-manager/core`

## What does not

Merge *logic* itself. Deciding how two conflicting remark arrays combine is a pure function
over plain data and lives in `core`, where it can be tested exhaustively without a database.
This package finds the conflicts and applies the decision; it does not make it.

## Testing

`pouchdb-adapter-memory`, never a real CouchDB. Tests that need a live CouchDB belong in
`packages/api` or in `infra/couchdb/verify-access-model.sh`.
