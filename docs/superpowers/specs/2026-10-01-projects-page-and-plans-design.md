# Projects: a landing page, real capacity, and where the data lives — design

Date: 2026-10-01
Status: proposed

## What this is for

There is no way to manage projects. Creating one is an API call nobody can reach from the
interface; switching between them is a `<wa-select>` in the shell that appears only when
`offered.length >= 2`; and nothing anywhere says whether a project's data is on this device, on
the server, or both. The application lands on a device list belonging to a project the user
never chose.

This makes projects the thing you land on and manage, gives the plan a capacity that is
**actually enforced**, and shows for each project where its data lives and what replication is
doing — including the ability to act on it by hand.

## The constraint everything else follows from

**A browser cannot create a database.** CouchDB restricts that to server admins, so every
server-side project exists because `POST /api/projects` provisioned it: `provision.ts` creates
the database with admin credentials, writes `_security` naming the owner *before anything else*
— "until this lands the database is readable by every account in the deployment" — and then
installs the `_design/access` validator.

Three consequences, and the design is mostly their working-out:

1. **The capacity gate is unbypassable rather than merely conventional.** A client that ignores
   the interface still cannot create a database. `POST /projects` is not one of several ways to
   get a project; it is the only one. That makes it the correct and sufficient place for the
   limit, and it is already where the gate sits.
2. **"On this device" → "synchronized" is not a sync operation.** A local-only project has no
   database to replicate into and the browser cannot make one. Promoting it means provisioning
   through the API and then pushing. The control on a local project is therefore a *different
   action* from the one on a synchronized project, with different failure modes — and it is the
   only manual action that can be refused for lack of capacity.
3. **Location is derived, never stored.** Whether a project is local, remote or both is a fact
   about where its databases exist right now, and two devices belonging to one person will
   disagree. A stored field would be a cache of something cheap to observe, wrong on the second
   device, and wrong again after any sync.

## Decisions taken before the design

These were settled in conversation and are recorded because the design does not re-derive them.

| Question | Decision |
| --- | --- |
| Are the limits real? | Yes — enforced, not decorative |
| Plans and capacity | `free` = 1, `user` = 5, `pro` = unlimited |
| Where a plan is stored | A field on the `_users` document |
| Somebody over their limit | Creation refused; everything existing stays fully usable |
| Does the local catalogue count? | Yes, like any other project |
| Do shared projects count? | No — only projects you own |
| What the page shows | Location **and** live sync status |

The local-catalogue answer is worth its own sentence, because it is more coherent than the
alternative and has a sharp edge. "One project" means one project wherever it lives, which makes
promotion **slot-neutral**: moving a local project to the server changes its location and not the
count. The edge is that a free user who used the application before signing in — which is
everybody, since that is what the local catalogue is — has their single slot already occupied,
and cannot create a second project without upgrading. That is the intended pressure, stated
plainly so nobody later reads it as a bug.

## Phase 1 — Plans and capacity

Nothing in this phase is visible. It is fully exercised by tests and `curl`, and phase 2 has no
guesswork in it because the contract below is settled first.

### The policy needs something the signature does not carry

`backend/src/domain/can.ts` has `Plan = 'free'` and `POLICIES['project.create'] = ALLOW`. The
plan type grows to `'free' | 'user' | 'pro'`, and the policy becomes real — but a policy is
`(principal, project?) => boolean`, and deciding whether somebody may create a project requires
knowing **how many they already own**, which neither argument carries.

`can.ts` anticipated policies needing more: its signature exists so "an M8 policy can decide on
the plan and on what the project already contains without this signature changing". For creation
there is no project to inspect, so the count belongs on the actor:

```ts
export interface Principal {
  readonly sub: string
  readonly plan: Plan
  /** Projects this subject owns. Read before the gate, because the gate cannot read. */
  readonly ownedProjects: number
}
```

The cost is real and is not hidden: **`POST /projects` gains a read it does not have today**,
counting owned projects before it may call `gate()`. The alternative — passing a context object
as a third policy argument — spreads the change across every policy and every caller to spare
one query on the one route that needs it.

Limits live beside the policy as a table, not as a conditional:

```ts
export const PROJECT_LIMITS: Readonly<Record<Plan, number>> = Object.freeze({
  free: 1,
  user: 5,
  /**
   * Unlimited, as a sentinel rather than as `Infinity` or an absence.
   *
   * `Infinity` compares correctly and then serialises to `null`, so the API would report
   * something it did not mean. `undefined` forces every reader to handle two shapes. `-1` is
   * one number, survives JSON, and is what the contract describes.
   *
   * **It must be tested before it is compared, never after.** `count >= limit` with `limit`
   * of `-1` is true for every count including zero, so the plan with no limit would be the
   * only one that can never create a project — a failure that is both silent and exactly
   * backwards. Every read of this table goes through {@link withinLimit}.
   */
  pro: -1,
})

/** Whether one more project is allowed. The only place the `-1` sentinel is interpreted. */
export const withinLimit = (owned: number, limit: number): boolean =>
  limit < 0 || owned < limit
```

ADR 0009's rule holds throughout: no component and no handler asks `plan === 'free'`. They ask
`can()`, or they read the limit the API reports.

### Where a plan lives, and who may set it

`plan` joins `locale` and `displayName` on `org.couchdb.user:<sub>`, the document
`backend/src/profile/store.ts` already owns. Absent means `free`, so nothing has to be migrated
and a user who has never been touched by an operator reads correctly.

**What makes a role-based gate sound here is that roles are not user-writable.** `store.ts`
builds every update by spreading the existing document first and then applying named fields, so
`name`, `roles` and `type` are carried through from CouchDB and never taken from a request body
— the file says why, and it is about accounts that stop being able to authenticate. A user
therefore cannot grant themselves the role that would let them set their plan, which is the
property the whole gate rests on. A refactor that replaced those named fields with a spread of
the request body would destroy it silently, and the tests below exist for that refactor rather
than for today's code.

Roles are read from the caller's own `_users` document. The access token carries none today
(`mintToken` writes `purpose`, `sub`, `exp` and `iat`), and adding them would put an
authorization decision into a credential that CouchDB also verifies — two consumers, one claim,
and a change to either affecting both.

Two endpoints, because two different people are asking:

**`PATCH /profile`** replaces `PUT /profile` and keeps its rule that the subject comes from the
session and never from the body — the existing comment calls the alternative "an account-takeover
primitive". `locale` and `displayName` are writable by anybody; **`plan` is accepted only from a
caller holding `_admin` or `customerservice`**, and silently ignoring it for everybody else would
be the wrong refusal: a request that asked for something and was not told it was refused is how a
caller concludes the field does not exist. It answers 403 with a named reason.

PATCH rather than PUT because the semantics were already partial — the current handler treats an
absent `displayName` as "leave it alone" while requiring `locale` on every request, which is a
PATCH wearing a PUT's name. Making it a PATCH also makes `locale` optional, which is the
behaviour the existing comment describes wanting.

**`PUT /customer`** is the operator route, gated on the same two roles, and sets a **named**
subject's plan. It exists because `PATCH /profile` can only ever reach the caller, so without it
a role-holder could upgrade themselves and nobody else — an operator tool that cannot serve a
customer. Keeping it a separate endpoint is what lets `/profile` retain its rule intact: the
subject arrives in a body on a route whose entire purpose is acting on another account, rather
than being smuggled into one whose comment forbids it.

`customerservice` is a plain CouchDB role granted by editing `_users`, and is not grantable
through this API.

> **Superseded, after implementation.** This section and the contract list below say the two
> operator routes accept `_admin` *or* `customerservice`. They were built that way and the
> `_admin` half has been removed; the operator role is `customerservice` alone. `_admin` never
> granted what it appeared to — the role check reads the caller's `_users` document, and a
> CouchDB *server* admin lives in `local.ini [admins]` and has none — while the only account it
> could match is one holding a role that bypasses `validate_doc_update` on every project
> database in the deployment. Left in place above as the record of what was specified; see
> `docs/SECURITY-MODEL.md` § *Operator accounts and plans* for what is true, and do not restore
> it when building the page.

### The API contract

- **`GET /profile`** gains `plan` and `projectLimit`, the latter always a number, with `-1`
  meaning unlimited. The page interprets it through the same rule the policy does rather than
  comparing it directly.
- **`GET /projects`** is unchanged. It already reports each project's role, so the page derives
  the owned count from the list it fetches anyway. One source for each fact: the profile knows
  the plan, the list knows the count.
- **`PATCH /profile`** replaces `PUT /profile`: `locale` and `displayName` optional, `plan`
  accepted only from `_admin` or `customerservice` and refused with a named 403 otherwise.
- **`PUT /customer`** sets a named subject's plan, same two roles, 403 otherwise and 404 for a
  subject with no `_users` document — distinct answers, because "you may not" and "there is no
  such account" send an operator to different places.
- **`POST /projects`** refuses at the limit with a **distinguishable** body. It currently answers
  `reply.code(403).send()` — no body at all — which leaves the page unable to tell "you have used
  all your slots" from "you may not do this", and those deserve different sentences. It gains a
  `title` and a machine-readable reason.

**`PUT` → `PATCH` breaks the existing client.** `frontend/src/ui/profile.ts:72` sends
`method: 'PUT'`, so the two move in the same change or the settings page silently stops saving —
silently because a 404 or 405 from a fire-and-forget save is not something that page currently
surfaces. This is the one place phase 1 reaches into the frontend, and it is a two-line reach
rather than a reason to merge the phases.

`openapi.yaml` at the repository root is the contract of record and changes with these routes.
The drift between it and the running server is caught by `backend/test/openapi-drift.test.ts`,
which walks every operation in the contract and validates real responses against it — a **test**,
not a `scripts/check-*` checker, which matters only because looking in the wrong place and
finding nothing would read as "there is no such guard". ADR 0015 explains why the contract is
checked rather than executed, and `test/support/contract.ts` carries the hand-rolled validator
that does it. A new field on `GET /profile` that the contract does not describe fails there.

## Phase 2 — The projects page

### Landing

`/` becomes the projects view and the device list moves to `/devices`. **This is a breaking URL
change**: anything bookmarked at `/` lands somewhere new, and the navigation's first entry moves.
`ROUTES` is the single registry that navigation renders from, so the edit is local — but the
ordering comment there is load-bearing (`/devices/new` must precede `/devices/:id`) and survives
unchanged.

The device list keeps working exactly as it does; it is reached from a project rather than from
nothing.

### The slot grid

Owned projects render into `projectLimit` positions, filled and empty. An empty slot is an
affordance to create, and on a plan with no limit there are no slots at all — `pro` gets a plain
list, because a grid of one occupied and unbounded empty positions communicates nothing.

Projects shared with the user sit in their own section, outside the grid and uncounted. A free
user can be a member of a colleague's project without it costing them the ability to have their
own, which is the point of counting ownership rather than visibility.

### Location and live status

Location is derived by comparing two lists the page already has:

| In the local catalogue | In `GET /projects` | Shown as |
| --- | --- | --- |
| yes | no | **On this device** |
| no | yes | **On the server** |
| yes | yes | **Synchronized** |

Live status comes from `SyncManager.stateOf(projectId)`, which exists and returns
`'active' | 'idle' | 'offline' | 'stopped'`. The shell already collapses every project's state
into one value with `worstOf()` for its own indicator; the page needs them unreduced, which
requires no new plumbing — only that the page ask per project instead of asking for the worst.

`offline` is rendered quietly. `replication.ts` is explicit that it is **not an error state**:
being offline is ordinary here and the local database is complete and usable. A page that
painted it red would be lying about the application's central promise.

### The manual action, which is not one action

| Location | Control | What it does |
| --- | --- | --- |
| Synchronized | **Sync now** | a one-shot replication |
| On the server | **Download to this device** | starts replication for a project not yet local |
| On this device | **Move to the server** | `POST /projects`, then an initial push |

Only the third consumes capacity, and only the third can be refused — which is why it cannot be
the same button wearing a different label. It is also the largest single piece of work here: it
provisions through the API, then pushes an existing local database into a database that has just
been created, and it has to be safe to attempt twice.

`SyncManager` grows one method for the first row. Replication today is `live: true` and
continuous, so there is no one-shot path; "sync now" against a live replication means a bounded
catch-up the caller can await, not a restart — restarting would throw away the checkpoint, which
is the thing `set()` is idempotent in order to protect.

## Failure modes, and what answers each

| Failure | Why it would go unnoticed | What answers it |
| --- | --- | --- |
| A user grants themselves `pro` | `PATCH /profile` succeeds and nothing looks wrong | `plan` is refused with a 403 for a caller without the role; a test sends it as an ordinary user and asserts both the refusal and that the stored plan is unchanged |
| A refactor makes roles writable | The gate still reads roles, and now the caller sets them | A test writes `roles` through both endpoints and asserts the stored roles are untouched |
| `-1` compared instead of tested | `pro` is the only plan that can never create a project | Every read goes through `withinLimit`; a test covers `pro` at zero, one and many owned projects |
| The limit is enforced in the page only | Creation through the API still works, so the limit is decorative | The gate is on `POST /projects`; the page reads the limit but never decides it |
| Promotion runs twice | A second database, and a local project silently split in two | Promotion is idempotent on the project it targets, and the page disables the control while it runs |
| `offline` shown as an error | Users are told the application is broken when it is working as designed | Rendered quietly, and a test pins that it is not the error styling |
| Bookmarked `/` breaks | Nobody reports it; they just see the wrong page | Stated here and in the release note; `/devices` is a real route, not a redirect |

## Tests

- **Domain**: `PROJECT_LIMITS` and the `project.create` policy at every boundary — at the limit,
  one under, one over, and unlimited — as a table, in the style `can.test.ts` already uses.
- **API**: `POST /projects` answers 201 under the limit and a *named* 403 at it, and never
  refuses on `pro` however many projects exist; `GET /profile` reports plan and limit;
  `PATCH /profile` with `plan` is refused for an ordinary caller, accepted for one holding
  `customerservice`, and in both cases the stored document is checked rather than the response
  believed; `PUT /customer` sets another subject's plan for a role-holder, 403s without the role
  and 404s for an unknown subject; and neither endpoint writes `roles` or `type` whatever the
  body contains.
- **Frontend**: slot rendering for each plan including the unlimited list; the three location
  states from the two lists; live status per project including `offline` rendered quietly; and
  each of the three manual actions, with promotion refused when at capacity.

The frontend tests go through the rendered page rather than through a helper, for the reason
`german-problems.browser.test.ts` gives about itself: a mapping that is never called translates
nothing, and a slot rule that is never rendered communicates nothing.

## Out of scope

Billing and payment; self-service plan changes; project deletion, which remains archive-only
because the API has no `DELETE` and this design does not add one. Inviting members already
exists and is not revisited here beyond leaving shared projects uncounted.
