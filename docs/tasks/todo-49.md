# M5-2 Replicate projects (#49)

- [x] `replicateProject` — live, retrying, bidirectional, with an honest state
- [x] `remoteProject` — the CouchDB counterpart, with the token read per request
- [x] `syncManager` — one replication per project, matched to the list as it changes
- [x] The three scenarios, tested against **two real databases in a real browser**
- [x] Mutation probes: 24/24 caught
- [x] `npm run verify` — 1548 tests, 83 files

---

## Tested against real replication, not a fake

The replication tests run in the `web` browser project against two real `pouchdb-browser`
databases. That is the only way the third scenario can be checked at all: "resumes from where it
stopped" is a property of PouchDB's checkpoint documents, and a test against a stub would be
proving that the stub resumes.

So the resume test does the real thing — sync three devices, cancel, add a fourth, sync again —
and counts what crosses on the second run through the remote's own change feed. **One document,
not four.** There is a control beside it asserting that the *first* sync moves all three, because
"only one document moved" passes just as happily against a replication that moved nothing.

## The bug this would have shipped with

`paused` is the event PouchDB emits when a live sync stops transferring. The obvious reading is
that `paused()` means "caught up" and `paused(error)` means "cannot reach the server", and that
is what this module did first.

It is wrong, and the offline test is what found it. Against `http://127.0.0.1:1/nowhere` the
events are, verbatim from a debug run in Chromium:

```
["paused(-)","paused(-)"]
```

No error, no `error` event, no `change`, no `active`. **A sync that has never once reached the
server emits exactly what a sync that is fully caught up emits.** Reading that as `idle` would
have shown a user a project marked up-to-date that had never synchronised — the one failure they
cannot detect for themselves, on the feature whose whole promise is that their work is safe.

So the ambiguous case is resolved by **asking**: on a `paused` with no error, `remote.info()`
decides between `idle` and `offline`. It costs one request per pause, and a pause is what
happens when things settle rather than something that happens per document. A `paused(error)`
is unambiguous and needs no round trip.

That is also why `Reachable` exists as an interface: the remote is not just a thing to sync
against, it is the thing to ask.

## One guard, at the one place state changes

The probe is a request in flight. It goes out while the sync is running and can resolve after
`cancel()` — and reporting that answer would move a stopped replication back to `idle`, an
interface saying "up to date" about something nobody is running.

The first version guarded this in two places, `report` and `classifyPause`. The mutation probe
reported the `report` guard as SURVIVED, which is what two mechanisms doing one job always looks
like: neither is load-bearing, so removing either changes nothing. It is now one check, in
`report`, with a test that cancels while a deliberately slow probe is outstanding.

## What the probe caught that the tests had not

| Mutation | Why it survived at first |
|---|---|
| `live: false` | The liveness test wrote its document immediately after starting, so a one-shot sync would still carry it. It now waits for `idle` — the first pass finishing — before writing. |
| `retry: false` | Nothing covered it. Proving it behaviourally needs a server that fails and then works, which a browser test cannot arrange, so there is one test that asserts the **options** — the only place in this file that looks at a call rather than an outcome, and it says so. |
| a cancelled sync keeps reporting | Two guards; see above. |
| every project's changes reported under one id | `onIncoming` was untested at the manager level. |

## The token is read per request

An access token lives about an hour. A replication lives as long as the tab. A remote built with
the token held at construction would work, keep working, and then quietly stop — and because
`retry` is on, it would stop by **retrying forever**, which reports as "offline" on a perfectly
good network. The `fetch` wrapper calls `token()` on every request.

The credential goes in a header and never in the URL. CouchDB accepts
`https://user:password@host`, and a URL is logged, sent as a referrer and kept in history in
ways a header is not.

## The manager: matching the list, not rebuilding it

`set(projects)` makes the running replications match exactly, and is **idempotent**. That is the
third scenario again at a different level: the project list is re-fetched whenever connectivity
returns, and restarting every replication on every reconnection would discard the checkpoint each
one holds and re-scan every database — on precisely the connection least able to afford it.

Departures are stopped **before** arrivals are started. A project somebody has just been removed
from must not still be replicating while the two lists are being reconciled: CouchDB would refuse
it, and the interface would then show a project as permanently "offline" rather than gone.

State is remembered per project and forgotten when one stops — a stale `idle` for a project the
user no longer has would show it as synced and present.

## What is deliberately not here

- **No conflict resolution.** `mergeDevice` and `mergeRemarks` already exist and replication
  produces the conflicts they merge; presenting them to a user is M5-6.
- **No interface.** Nothing calls `syncManager` yet — the project list comes from `GET /projects`
  (#48) and the surface that shows it is M5-8. The wiring is one call with the pieces that now
  exist.
- **No `localState` in `mm-local`.** `docs/DATA-MODEL.md` describes `not-downloaded | syncing |
  downloaded` per project; `SyncState` is the live half of that, and persisting it is M5-7's
  offline experience.

## Mutation probes

| Module | Result |
|---|---|
| `web/src/sync/replication.ts` | 8/8 caught |
| `web/src/sync/remote.ts` | 7/7 caught |
| `web/src/sync/manager.ts` | 7/7 caught |

One probe came back INCONCLUSIVE rather than SURVIVED — a mutant that did not compile — and was
rewritten until it did. That distinction is L3, and it earned its keep again here: the first
version of the "token captured once" mutation was silently not testing anything.
