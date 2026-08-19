# 2. Offline-first with PouchDB and CouchDB

Date: 2026-08-19

## Status

Accepted

## Context

The core use case happens in bad places for connectivity: a basement utility room, a loft,
behind a wall panel, in a new build with no wifi yet. Someone is standing in front of a
device with a phone, and the application must work.

"Offline support" as a feature bolted onto an online-first application means a cache, a
queue, and a long tail of states where the two disagree. Offline-*first* inverts it: the
local database is the source of truth for the client, and synchronisation is a background
concern that can fail without the user noticing or caring.

Options considered:

1. **PouchDB in the browser replicating to CouchDB.** Replication is the product, not a
   feature written on top of it. Bidirectional sync, revision history and conflict detection
   are inherent to the protocol.
2. **IndexedDB with a hand-written sync layer.** Full control, no CouchDB constraints. But
   the sync layer is the hard part, and writing one means reimplementing revision trees,
   conflict detection and resumable replication — badly, and over several months.
3. **SQLite via WASM with a change-log sync.** Better querying than PouchDB. Same sync
   problem as option 2, plus a heavier runtime.

## Decision

PouchDB in the browser, replicating to CouchDB.

## Consequences

Offline works by default rather than by effort. Multi-device use falls out of replication.
CouchDB's `_security` model then dictates the authorisation design (ADR 0003).

Accepted costs:

- **Querying is weak.** Mango and map/reduce views, no joins. Acceptable because a project
  is a house: tens or hundreds of devices, small enough to filter client-side.
- **Conflicts are the application's problem.** CouchDB detects them and picks an arbitrary
  but deterministic winner; it does not merge. Anything append-shaped needs an explicit
  strategy (ADR 0010).
- **Revoked access cannot recall replicated data.** Inherent to replication, documented in
  SECURITY.md, and a real consideration given payloads are stored unencrypted (ADR 0005).
- **Bundle size.** PouchDB is not small. Mitigated by code splitting, not eliminated.
