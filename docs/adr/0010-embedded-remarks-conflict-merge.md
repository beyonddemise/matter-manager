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
| Remarks | Union by remark `id`, ordered by `(createdAt, id)`. Nothing is ever discarded. |
| Scalar fields (name, room, disabled) | Last write wins, ordered by `(updatedAt, _rev)`. |
| Rooms | As scalars, on `path`. A deleted room still referenced by a live device is resurrected as `Unassigned/<old path>` rather than orphaning devices. |
| Audit entries | Never conflict — append-only and immutable, enforced by `validate_doc_update` for both edits *and* deletions. |

Merge functions are pure, taking `(winner, conflicts[])` and returning the merged document.
They are unit-tested exhaustively with no database involved.

### Every ordering has an explicit tie-breaker, and that is not pedantry

"Last write wins by `updatedAt`" is **not a total order**. Two clients writing in the same
millisecond — or with clocks that disagree, which offline devices routinely do — produce
equal keys. An ordering that leaves ties undefined lets each replica pick a different winner,
and then **the replicas never converge**: each is internally consistent, each disagrees with
the other, and no further replication fixes it. That failure is far worse than choosing the
"wrong" winner, because there is no longer a single answer to converge on.

So every ordering here is a pair whose second element is unique:

- **Scalars:** `(updatedAt, _rev)`. CouchDB revision ids are comparable and unique per
  revision, and using them matches CouchDB's own deterministic winner selection.
- **Remarks:** `(createdAt, id)`. Remark ids are client-generated UUIDs, so unique.

The requirement is that the merge be a **pure function of the set of conflicting revisions**,
so that every replica computes an identical result independently, in any order, without
coordination. Any input that is not carried in the documents — local time, arrival order,
which replica ran the merge — breaks that and must not be consulted.

**A known and accepted limitation:** wall-clock ordering means a device with a badly wrong
clock can win a scalar conflict it "should" have lost. Accepted because the alternative is
vector clocks or Lamport timestamps on every document, which is a large amount of machinery
for a house with a few dozen devices — and because the case that actually loses data,
concurrent remarks, is union-merged and therefore immune. Revisit if scalar conflicts turn
out to happen often enough for anyone to notice.

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
