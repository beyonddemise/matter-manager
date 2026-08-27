# M5-1 Provision a project database (#48)

- [x] `POST /projects` — database, `_security`, `_design/access`, registry pointer
- [x] `GET /projects` — through the participant view, for the caller alone
- [x] Provisioning is atomic, including when the rollback itself fails
- [x] Creating a project refuses when offline, and queues nothing
- [x] The entitlement seam is called, and **watched** being called
- [x] `deleteDb` and the `writers` key added to the CouchDB client
- [x] The drift check now builds a fully-wired server, so "unimplemented" means unimplemented
- [x] Mutation probes: 51/51 caught
- [x] `npm run verify` — 1500 tests, 80 files

---

## The third scenario is the design

> Given database creation succeeds but writing `_security` fails, then the database is removed
> and no pointer is written.

A CouchDB database exists from the moment it is created, and until its `_security` lands it is
readable by **anyone with an account** — in this application, somebody else's home. So the order
of operations is chosen for what each failure leaves behind:

| | Step | If it fails |
|---|---|---|
| 1 | The registry, before anything is created | nothing exists yet |
| 2 | The database | nothing to clean up |
| 3 | **`_security`, immediately** | the database is removed |
| 4 | `_design/access` | the database is removed |
| 5 | The pointer, last | the database is removed |

The window between 2 and 3 is the one dangerous moment, and nothing may widen it — not the
design document, and certainly not a round trip to the registry. There is a test that asserts
`putSecurity` is the *very next* call after `createDb` on that database, and a mutation that
reorders them is caught.

Three things this got right only because they were written down as tests first:

- **A database this service did not create is never rolled back.** `createDb` answers `false`
  on a name collision, and deleting somebody else's project because a random uuid matched it is
  the worst thing this code could do. A uuid collision does not happen — which is exactly why
  that path would never be exercised by accident.
- **A failed rollback gets its own error type.** `OrphanedDatabaseError` names the database,
  because the operator's next action is to go and delete it by hand, and it carries the original
  failure as `cause` — a rollback error that replaced it would leave nobody knowing why
  provisioning failed in the first place.
- **The pointer is written last.** A pointer to a half-made database is a project that appears
  in the list and does not work. An unpointed database is invisible, and step 2's rollback
  removes it.

## Creating a project is the one operation that needs a network

`createProject` refuses immediately when the browser is certain it is offline, and **queues
nothing**. A queued creation is a project the user believes exists: they would name it, put
devices in it, and find later that neither was ever real.

`navigator.onLine` is trusted only when it says *no* — the asymmetry `connectivity.ts` already
established. A `true` means "worth trying", so a `fetch` that then fails reports `unreachable`
rather than `offline`: a captive portal is a different sentence, because the user may be right
about the wifi and wrong about the internet.

Failures are **reasons, not messages**. The view writes the sentence, so it is translated —
which is issue #75, and what happens when a domain module writes English into an interface that
is sometimes German.

## The enumeration test did its job, and then had to be fixed

`gate.test.ts` was written at M4-6 to go red at exactly this moment, with a comment saying so.
It went red — and then passed again, for the wrong reason: it built the server with no
dependencies, so `POST /projects` was not registered and the enumeration had nothing to find.

That is the same failure the test exists to prevent, one level up. It now:

- builds a server with the project routes **wired**, and asserts the implemented gated routes
  are exactly `['POST /projects']`;
- keeps a `DRIVERS` map of how to reach each gated route, **drives** the route, and asserts the
  gate was called with `project.create`;
- still throws loudly for a gated route with no driver, so M5-3's membership endpoint cannot be
  implemented without somebody arriving at this file;
- has a positive control, because a suite of "the gate was called" assertions passes just as
  happily against a recorder nobody wired up.

## The drift check had the same hole

`openapi-drift.test.ts` built `buildServer({ logger: false })` and then reported everything as
"not implemented yet". With routes registered only when their dependencies are supplied, that
list was a list of things the *test* had not configured — indistinguishable from a list of
things nobody had written.

It now builds a fully-wired server. The pending list went from eleven operations to three, and
those three are genuinely M5-3's and M5-5's.

## Decisions that were open, and how they were closed

**`project_<uuid>`, with the hyphens.** ADR 0003 and the contract say so; `docs/DATA-MODEL.md`
had an example with underscores. CouchDB permits hyphens — this repository's own
`verify-access-model.sh` creates `verify-access-model-$$` against a real server — so the example
was corrected. One representation, produced by one function that refuses anything which is not a
lower-case v4 uuid, because the value arrives over HTTP and is then used to **delete** a
database. `../_users` is a project id somebody might send.

**The access rules are read, not embedded.** `infra/couchdb/design-docs/access.js` is the single
copy, and CI's "CouchDB access model" job proves *that file* against a real CouchDB. A copy here
would mean CI verifies a function this service does not install, and the two could drift with
everything green. The loader walks up from `import.meta.dirname` rather than counting `..`,
because this module runs from `src/` under vitest and `dist/src/` when built — and it is checked
at **startup**, so a deployment that did not ship the directory fails immediately rather than at
the moment a user presses the button.

**Bearer, not the session cookie.** The contract declares `bearerAuth` globally. The rule is now
written down in `auth/bearer.ts`: the `mm_session` cookie authorises `/auth/*`, and everything
else takes the access token. It also sidesteps a real problem — the cookie is `SameSite=Lax`, so
an API on a different *site* from the application would never receive it, and the request would
arrive unauthenticated and answer 401 on a page that is signed in.

**The view carries the owner.** `ProjectSummary` requires one and a view row describes a single
participant, so without it the API would read every pointer again to render a list.
`docs/DATA-MODEL.md` was updated to match.

**A pointer with no owner is left out of the list, and logged.** `owner` decides which controls
a project offers — transfer, remove a member — so a summary naming the wrong owner is worse than
a missing one. This API cannot produce such a pointer.

## The registry view is executed, not grepped

The mutation probe caught a test asserting `map` **contained** the string `ownerId`, which passes
for a view emitting `ownerId: undefined`. The view is JavaScript, so the tests now run it with a
captured `emit` and assert the rows it produces: one per participant, keyed on that participant,
each carrying the owner. That version also catches a per-document key, a missing participant
loop, and rows emitted for documents that are not pointers.

## `serverOptions` — absent means absent

`main.ts` passed `{ security }` and nothing else, so the deployed service registered `/healthz`
and no more. `composition.ts` now reads the environment and wires the project routes **only when
both halves are present** — CouchDB to create the database, and a signing key to know who is
asking. Half of what is needed is not most of the way there, and a route that answers with a
misconfiguration error reads as a broken application rather than an incomplete deployment.

Everything that can be wrong with the configuration now throws before anything listens: an
unusable origin, a signing key that is not an EC key, missing design documents.

## Mutation probes

| Module | Result |
|---|---|
| `core/src/projects/ownership.ts` | 5/5 caught |
| `api/src/projects/names.ts` | 4/4 caught |
| `api/src/projects/registry.ts` | 7/7 caught |
| `api/src/projects/provision.ts` | 15/15 caught |
| `api/src/projects/routes.ts` | 10/10 caught |
| `api/src/auth/bearer.ts` | 5/5 caught (one via the route suite) |
| `web/src/projects.ts` | 8/8 caught |

Two survivors, both fixed by better tests rather than by changed code: the `ownerId` string
match described above, and the bearer parser's edge cases, which the route tests could not reach
because they only ever sent a valid token or none. `bearer.test.ts` now covers `Basic`, a raw
token with no scheme, an empty token, two tokens in one header, and a padded header.

## What is still missing

There is no **interface** for creating a project — no button, no list. `projects.ts` is the
client the view will use, and the view arrives with M5-8 (switch and manage projects). The
server side is complete and reachable with a token.

The deployment needs `COUCHDB_URL`, `COUCHDB_ADMIN_USER`, `COUCHDB_ADMIN_PASSWORD`,
`JWT_PRIVATE_KEY` and `JWT_KEY_ID`; without them the project routes are simply not registered.
