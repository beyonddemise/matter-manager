# M5-6 Resolve conflicts (#53)

- [x] `packages/data/src/conflicts.ts` — read the losing revisions, merge, write, prune
- [x] The merged document is written **before** the losing revisions are deleted
- [x] Nothing is written when the merge equals the winner; the losers are still pruned
- [x] In-flight resolution shared per document id, and forgotten on failure
- [x] A lost race is re-read and retried, three times, then raised
- [x] `repository.get` and `repository.list` ask for conflicts and resolve before returning
- [x] `watchConflicts()` — the change feed, because a conflict arrives long after the write
- [x] Scenario 1: concurrent remarks all survive, attributed, in chronological order
- [x] Scenario 2: concurrent field edits resolve identically on both devices, ties included
- [x] Scenario 3: `_conflicts` empty afterwards on both devices **and the server**
- [x] Mutation probes: 18/18 caught
- [x] Coverage: `data` at 98% statements, 96% branches, against a 90% gate
- [x] `npm run verify` — 1876 tests, 93 files

---

## The policy was already written; nothing called it

`core/src/sync/merge.ts` has existed since M2 — `mergeDevice`, `mergeRoom`, `mergeRemarks`,
every ordering exhaustively tested — and was imported by nothing but its own tests. So this
issue was never about *how* revisions combine. It was about the four impure steps around that
decision: find the losing revisions, hand them over, write the answer, delete what lost.

That split is why the hard part is a unit test measured in milliseconds and this part is a
handful of databases.

## Tested against real replication, not a fabricated `_conflicts`

Three in-memory PouchDB databases — `deviceA ↔ server ↔ deviceB` — and the real replication
protocol. A conflict is a *shape of the revision tree*; an array of revision ids written by hand
is a fixture asserting against itself. Everything here is produced the way a real conflict is:
two writes committed independently, discovered later through a server.

The Playwright form the issue asks for is deferred to M5-10. It needs a composed application to
drive (#120: replication, sign-in and the projects API are still orphaned modules) and a live
CouchDB. This covers the behaviour more thoroughly than two browser contexts could; it does not
cover *composition*, and that gap is real rather than closed.

## Write, then prune. Never the other way round

Between the two writes the merged document already exists, so an interruption leaves a resolved
document carrying a stale conflict — which the next read clears. The other order has a window in
which the only copy of somebody's remark is a revision that has just been deleted. Same rule as
`_security` before the registry in M5-5: the write that preserves goes first.

There is a test that fails the prune and asserts both remarks are already stored.

## Nothing is written when the merge says what the winner already said

Two people rename a device, nobody adds anything, and CouchDB's winner is already the later
write: the merged document and the stored one are the same document. Writing it anyway would put
a fresh revision on every device that reads a resolved conflict, and replicate each one.

The comparison ignores `_rev` and sorts keys, because two documents differing in key order are
the same document.

## `_conflicts` is an annotation, not a field

Reads ask for it on **every** document, not only where one is expected — a conflict is created
by replication rather than by this browser, so there is no read at which one is not expected.
That makes stripping it part of every read, and returning one would put it straight back into
the next `save`.

The probe found the first version of that test could not fail: it used a fixture where the merge
took its answer from a *losing* revision, which never carried the annotation. The leak only
happens when the merge chooses the winner — the very object the annotation was read onto — so
there is now a second test with two renames and no remarks.

## What the platform will not tell us — a deletion that lost

Verified against PouchDB rather than reasoned about, and the answer changed the design twice:

- A **deleted leaf loses to a live one whatever its generation.** Generation 3 deleted lost to
  generation 2 alive.
- A deleted losing branch appears in **neither `_conflicts` nor the change feed.** CouchDB
  reports those in `_deleted_conflicts`, which PouchDB does not implement. Only
  `get(id, { open_revs: 'all' })` can see one — a second read of every document on every list.
- When **every** branch is deleted, the feed carries a bare tombstone with no conflicts on it.

So `mergeRoom`'s resurrection branch is unreachable through this mechanism: a deleted revision
wins only when every branch is deleted, and then there is no path left to resurrect. "Deleted
here, edited there" always resolves as *the edit survives* — which loses the deletion and
orphans nothing, the safe direction, and is now pinned by a test so that it is a known property
rather than a surprise at M5-9.

Two consequences, both of which removed code rather than adding it:

- `hasLiveDevices` is passed as a documented `false`. Answering it honestly meant listing every
  device on each room conflict to decide a branch that cannot execute.
- A change made earlier in this work was **reverted**: `remove()` briefly wrote a full document
  with `_deleted` so that deletions could be ordered by time in the merge. That justification
  turned out to be false — deletions never reach the merge — and the cost had not been weighed:
  a tombstone retaining `manualCode` and `payload`, which `DeviceDocument` documents as secrets,
  readable on the deleted revision until compaction.

**Worth raising as its own issue:** a deletion silently losing to a concurrent edit is correct
here but invisible to the person who deleted the room. M5-9 owns room deletion and is where the
choice should be made by a person rather than by a merge.

## Mutation probes

18 mutants applied to `conflicts.ts`, `repository.ts` and `project-database.ts`; **18 caught**,
plus a comment-only no-op that survived as a control on the harness itself.

Seven survived the first pass, and every one of them was a missing test rather than a wrong
implementation:

| Survivor | What it exposed |
|---|---|
| `_conflicts` left on the document | The fixture could not reach the leak (above) |
| Resolves every change, conflicted or not | Counted writes, not the asking — an unconflicted document correctly writes nothing either way |
| `since: 0` instead of `since: 'now'` | Nothing pinned the choice to leave the backlog to reads |
| `list` does not ask for conflicts | No test read a conflicted document through the list |
| Rooms never resolved on read | No room conflict anywhere; devices alone would have passed |
| `hasLiveDevices: false` | Unreachable — see above; the call was removed |
| `cancel` not idempotent | Unobservable: PouchDB's own `cancel` tolerates it. The guard was removed and the test now asserts the property being relied on |

The first fixture chosen for "the later write wins" also passed with the merge deleted, because
CouchDB's arbitrary winner happened to be the correct one. The test now asserts its own premise
— that left alone, CouchDB keeps the *earlier* write here — so it fails loudly if that ever
stops being true instead of quietly proving nothing.

## What the coverage gate found that the probes did not

The probes ask "would a wrong implementation be caught". The gate asks "is this reachable at
all", and it found three places where the answer was no:

- a trailing `throw` after a counted retry loop, unreachable because every path out of the body
  returns or throws — rewritten as an unbounded loop so the line does not exist;
- a comparator arm for two identical object keys, which cannot happen;
- a fallback for `JSON.stringify` returning `undefined`, on values that all came through JSON.

All three were deleted rather than tested. The paths that *were* reachable and untested became
tests: a document deleted mid-resolution (the merge is abandoned, not written back — nothing is
resurrected), a retry that finds the conflict already resolved by the other device, a prune
refused per row the way `validate_doc_update` refuses one, a room resolved through the change
feed, a document this application did not write being left alone, and the feed itself failing.

## Dependency

`pouchdb-replication` and its types, as devDependencies of `packages/data`, added to
`allowedDev` in `dependency-policy.json`. It is bundled inside `pouchdb-browser` for the
shipping build, so it adds nothing to the download, and `no-pouchdb-import.test.ts` still proves
`src` imports no PouchDB at all. `npm audit` goes from 10 to 12 moderate advisories: the same
single `uuid` advisory as before, reached by two more paths, in a dev-only dependency.
