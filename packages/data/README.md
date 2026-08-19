# @matter-manager/data

PouchDB repositories, the replication manager, and conflict resolution.

**Created in M2.** Deliberately empty until then — an empty package with a `tsconfig.json`
and no source files makes `tsc --build` fail, and scaffolding that has to be worked around
is worse than scaffolding that does not yet exist.

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
