# 10. Embedded remarks with deterministic merge

Date: 2026-08-19

## Status

Accepted

## Context

Devices carry timestamped remarks — "replaced batteries", "behind the panel, needs the long
screwdriver", "flaky since the firmware update". The requirement is explicit that they live
in the device record rather than as separate documents.

That embedding creates a genuine conflict problem. Two people, both offline, both add a
remark to the same device. On reconnect CouchDB detects a conflict and picks a winner
deterministically — but it does not merge. The losing revision still exists in the revision
tree, but nothing surfaces it, so **one remark silently vanishes from the UI**.

Silent data loss is the worst possible failure here: nobody notices, so nobody reports it,
and trust in the record erodes without an identifiable cause.

Separate remark documents would avoid the problem entirely (independent documents never
conflict with each other), but the requirement is explicit, and there is a real argument for
it: a device and its history replicate, export and delete as one unit.

## Decision

Remarks stay embedded as an array of `{ id, text, authorSub, authorName, createdAt }`.

`packages/core` owns an explicit merge strategy per document type, applied by
`packages/data` whenever a conflict is detected:

| Shape | Strategy |
|---|---|
| Remarks | Union by remark `id`, sorted by `createdAt`. Nothing is ever discarded. |
| Scalar fields (name, room, disabled) | Last write wins by `updatedAt`. |
| Rooms | Last write wins on `path`. A deleted room still referenced by a live device is resurrected as `Unassigned/<old path>` rather than orphaning devices. |
| Audit entries | Never conflict — they are append-only and immutable, enforced by `validate_doc_update`. |

Merge functions are pure, taking `(winner, conflicts[])` and returning the merged document.
They are unit-tested exhaustively with no database involved.

## Consequences

- Concurrent offline remarks all survive. Each carries an author and timestamp, so the
  merged history reads sensibly even when two people were working at once.
- Remark ids must be generated client-side (UUID) rather than by position or count, or the
  union cannot distinguish "the same remark twice" from "two different remarks".
- Conflict resolution must run on **every** change event, not only on user-visible edits.
  Replication produces conflicts asynchronously, long after the write that caused them.
- Losing revisions are deleted after a successful merge, otherwise `_conflicts` grows
  forever and every read pays for it.
- Device documents grow over time. A device with hundreds of remarks is a large document
  that replicates in full on every change. If this becomes a problem, remarks past a
  threshold move to a linked overflow document — but measure before building that.
- **The e2e suite must cover this specific scenario**: two contexts, both offline, both add
  a remark, both reconnect, both remarks present. It is the kind of bug that unit tests can
  miss and users will never report.
