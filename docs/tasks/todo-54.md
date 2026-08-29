# M5-7 Offline user experience (#54) — the cache half

**This does not close #54.** It builds the one part of it that can be built today, and the
reason the rest cannot is worth stating precisely rather than leaving as a stalled issue.

- [x] `mm-local` extended from the profile to the project list
- [x] `localState` — what this device holds, kept separately from what the server permits
- [x] A refresh of the server list does not reset `localState`
- [x] Access removed from either direction: absent from the list, or a refused replication
- [x] A project nothing was downloaded for is forgotten; a downloaded one is kept and marked
- [x] Mutation probes: 7/7 caught
- [x] `npm run verify` green

## What is blocked, and on what

Three of the five scenarios are about the *interface*: showing sync state, blocking only
genuinely server-bound actions, and listing projects on reload. None of them can be built,
because the application does not use any of the machinery they display. `projectsApi`,
`syncManager`, `replicateProject` and `SyncState` exist, are tested, and are imported by nothing
but their own tests — that is #120.

#120 in turn is not a wiring task. It needs deployment decisions that have not been made: where
the API lives, where CouchDB lives, and how two deployment values reach `public/_headers`, which
is a static asset with no substitution step. That file already says so in a comment, and says
that **both origins must be added in the same change that wires it** or replication fails in
production only, reported as a CSP violation the application cannot see. There is also no
deployed API to point at.

So the honest order is #120 first, and this is the part of #54 that does not depend on how #120
is answered. It is needed under every possible answer.

## The distinction the whole design turns on

The server says what you **may** access. `localState` says what this device **actually holds**.

They are written by different things, at different times, and they diverge constantly — a
project granted on a phone is not downloaded on a laptop. Only the second answers "what can I
open right now", which is the question a user asks when the train goes into a tunnel.

That makes one invariant load-bearing: **the list is re-fetched on every reconnection, and a
refresh must not reset the local half.** A refresh that did would report every project as not
downloaded moments after connectivity returned, on precisely the devices that do hold them, with
no way for anyone to tell it was wrong. The mutation probe for it fails two tests.

The reverse holds too, and is tested: the server's half is taken from the server every time, so
a rename made on somebody else's device arrives.

## Access removed, from two directions

Revocation reaches this browser two ways, and they need different code:

- **Online** — the project is simply absent from the next `GET /projects`.
- **Offline** — nothing is absent, because nothing was fetched. The first news is a 403 from
  replication, which is what `markAccessRemoved` is for.

Both end in the same state, and what that state does depends on `localState`:

- **Never downloaded** → the entry is removed. Nothing of it is here and it may not be opened,
  so listing it offers a door that does not open.
- **Downloaded** → the entry is kept and marked. The data is still on this device, M5-3 requires
  the user be told plainly that it remains, and deleting the row would make a copy they still
  hold invisible and unexplained — which reads as the application having lost it.

The mark is **cleared** by a list that mentions the project again. Being re-granted is ordinary
— a mistake corrected, a role changed twice — and a mark that only ever went on would leave a
project labelled as lost forever.

## What is deliberately not cached

`ServerProject` is four fields, not the whole of `GET /projects`. The owner block is not here,
because nothing offline asks who owns a project, and every field beyond what a reader needs is a
second copy of a schema to keep in step. If M5-8 needs one, it adds one.

## The interface grew, and a test noticed

`local-cache.test.ts` has a structural guard asserting `LocalCache`'s method names **exactly** —
the strong half of "this database is never replicated", since a caller cannot replicate a handle
it is never given. Four new methods failed it, correctly, and the list was updated deliberately
rather than the assertion loosened to a count.

The same widening broke two `LocalCache` stubs in `packages/web/test/profile.test.ts`. Their new
project methods **throw**: those tests are about the profile, and a silent `[]` would let a
later change start reading projects through the stub with nothing saying the test no longer
covers what its name claims.

## Mutation probes

Seven mutants, seven caught, plus a comment-only no-op as a control on the harness.

Two of them appeared to be caught for the wrong reason — only three tests ran, which is a
transform failure, not an assertion. Both were malformed: replacing a ternary left an arrow
function returning a bare object literal, which parses as a block. Rewritten with parentheses
they are genuinely caught. **A mutant that does not compile has not been tested**, and a probe
harness that counts a build failure as a catch will report a clean sweep over tests that never
ran.
