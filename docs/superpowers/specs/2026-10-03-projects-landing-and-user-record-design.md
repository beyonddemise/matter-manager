# Projects landing page, a user record of our own, and a plan CouchDB can enforce — design

Date: 2026-10-03
Status: proposed
Supersedes: phase 2 of `2026-10-01-projects-page-and-plans-design.md`, and that document's
"Where a plan lives" section. Phase 1's `can()` seam, the `-1` sentinel and `withinLimit` stand.

## What this is for

The application lands on a device list belonging to a project the user never chose. This makes
**projects** the landing page: it lists them, shows whether each one is on this device, on the
server or synchronized, and offers what the user's plan allows, in a way that holds up signed
out and offline.

To get there, the plan has to become something CouchDB itself can enforce during replication,
which means it has to be in the access token. The plan therefore moves out of `_users` into a
database of our own. Once that database exists, `_users` has no remaining job, and the backend
stops touching it entirely.

## Decisions taken before the design

| Question | Decision |
| --- | --- |
| Where the user record lives | `matter_manager` database, document `user:<base64url(lowercase(trim(email)))>` |
| Does the backend use `_users`? | **No, not at all**: profile, plan, operator role, invitation lookup and refresh tokens all live on the user record |
| When a record exists | **Only once server interaction requires one** (accepting an invitation, saving a profile, an operator setting a plan). Signing in alone creates nothing; it is logged |
| Plan field | `plan`: `free` \| `member` \| `pro`; missing document, missing field or unknown value means `free` |
| Tier rename | `user` → `member` everywhere |
| Plan in the JWT | As a CouchDB role, `_couchdb.roles: [plan]`, re-read on every token mint; the server still checks limits itself |
| What the role enforces | The project validator refuses writes by a project's **owner** whose token holds neither `member` nor `pro` |
| Free plan | Local only: no server projects of its own; it may write in projects others share with it |
| Shared projects | The owner's plan pays; invited writers are governed by `writers.names` alone |
| Totals | free 1, member 5, pro unlimited: **local and server together**, shared projects not counted |
| Creating (member/pro) | Synchronized when signed in and online, otherwise local-only and promotable later |
| Tokens | `POST /auth/token` returns both: an access token (**5 min**) and a refresh token (30 days, not rotated, stored hashed on the user record, or in server memory for a user who has none yet; deleting the hash revokes it) |
| Logout | Refresh token removed from the record (or memory); the access token's `jti` is denied in memory until it expires |
| Remove from server | Archive; hidden from the list; frees its slot unless a local copy exists; hard-deleted after 90 days by a job tracked as an issue |
| Remove a synced local copy | Only online, only after a completed push; refused otherwise |
| Remove a local-only project | Permanent deletion, confirmed by typing the project name |
| Signed out | Existing projects listed, creation disabled, UX based on the last known plan |
| Project identity on the device | Every project database holds a replicated `project` document naming it and its server database |
| Pro client | An optional free-text `client` on the project |
| Upgrade | A button that opens "It's just alpha — coming soon" |

## Phase A — The user record and the token lifecycle

### The record

```json
{
  "_id": "user:bm90ZXNzZWlAZXhhbXBsZS5jb20",
  "type": "user",
  "sub": "google|1234",
  "email": "someone@example.com",
  "displayName": "Someone",
  "locale": "de",
  "plan": "member",
  "roles": ["customerservice"],
  "refreshTokens": [{ "hash": "<sha256(jti), hex>", "exp": 1790000000, "createdAt": 1787400000 }]
}
```

- **Key derivation** lives in one function, `userKey(email)`: trim, lowercase, UTF-8,
  base64url without padding. Every reader goes through it; a second implementation is how one
  address ends up with two records.
- **`matter_manager` is admin-only.** It is created on first use, the way `ensureRegistry` creates
  `projects`, and its `_security` is written immediately with `admins` and `members` restricted to
  `_admin`. It holds refresh-token hashes and plans, so no user token may ever read it.
- **Lookups are by address, with one view by subject.** Both tokens carry `email`, and
  `PUT /customer` names its target by address. Project participants, however, are stored by
  subject, and member listings resolve *another* participant's subject back to a record, so a
  `by_sub` view (emitting only records whose `sub` is set) answers those. **The caller's own
  record is always read by the address on their access token**, never through the view: a record
  an operator created by address has no `sub` until its owner signs in again, and a person who
  has only signed in has no record at all.
- **`plan`** is narrowed exactly as `toProfile` narrows it today: unknown values are reported and
  read as `free`.
- **`roles`** is set by hand by an operator in Fauxton. `customerservice` is the only role read.
  No endpoint writes `roles`, `sub`, `email`, `type` or `refreshTokens` from a request body. The
  store builds updates by spreading the existing document and applying named fields, as
  `profile/store.ts` does today, and the tests from phase 1 that guard this carry over.

### What moves off `_users`

| Today | After |
| --- | --- |
| `profile/store.ts` reads/writes `org.couchdb.user:<sub>` | Reads/writes the user record |
| `rememberUser` at sign-in | **Logs** the sign-in (below); creates nothing, unless pending invitations make a record necessary |
| `projects/users.ts` `by_email` view on `_users` | Direct `GET user:<key>`; same outcome as today when nobody has that address |
| `customerservice` read from `_users` roles | Read from the record's `roles` |
| `PUT /customer` writes `_users.plan` for a subject | Writes the record's `plan` for an **address**, creating the record if there is none |

**No migration.** There is no live data yet, so existing `_users` documents and project
databases are not carried over; environments are reset when this ships. Records are created by
the first server interaction that needs one (next section), and every project database provisioned afterwards has the `owners` key and
the new validator from birth.

### Records are created on demand, not at sign-in

Many people sign in to look around and never use the product. A record for each of them is a
row of personal data kept for nothing, so **signing in creates no record**. A record is created
the first time one of these needs it, and never otherwise:

| Trigger | Why it needs a record |
| --- | --- |
| Signing in with pending invitations for the address | Accepting them names the user on project databases; the record is where their plan and tokens then live |
| Accepting an invitation later | Same |
| `PATCH /profile` | The user asked the server to keep a display name or locale |
| `PUT /customer` | An operator set a plan, which has nowhere else to live; `sub` is filled in at the user's next sign-in |

`POST /projects` is not a trigger: a user without a record is `free`, and `free` may not own
server projects, so it is refused before anything is written. A user who could create one
already has a record from the operator who gave them the plan.

Without a record, a user is `free` by definition, and `GET /profile` answers from the token's
claims (`sub`, `email`, `name`) with defaults for the rest. All record writes go through one
`ensureRecord(email, sub, name)` so the four triggers cannot create records four ways.

**Sign-ins are logged**, for now as one structured `console.log` line per successful sign-in:
`{ msg: 'sign-in', at, sub, email, provider, hasRecord }`. It goes to stdout like the backend's
other structured logs. An issue tracks replacing it with something with retention and a PII
policy.

### Tokens

| Token | Transport | Lifetime | Claims |
| --- | --- | --- | --- |
| Refresh | Response body; the page keeps it in `mm-local` and sends it in the body of the next `POST /auth/token` | 30 days, not rotated | `purpose:'refresh'`, `sub`, `email`, `name?`, `jti`, `exp`, `iat`; signed with the session key CouchDB never sees |
| Access | Response body | **5 minutes** (`ACCESS_TOKEN_TTL = 300`) | `purpose:'access'`, `sub`, `email`, `name?`, `jti`, `exp`, `iat`, `_couchdb.roles: [plan]`; `name` is the provider's, so a record-less profile has one |

- **Login.** The OIDC callback logs the sign-in, accepts pending invitations (creating the
  record only if there are any), and sets a short-lived (minutes),
  single-use `purpose:'handoff'` cookie, then redirects. A new purpose rather than `flow`:
  `flow` already names the PKCE carrier, and two credentials sharing a purpose are substitutable
  for each other, which is what `purpose` exists to prevent. Sign-in also **requires a verified
  address** (`emailVerified === true`): the record is keyed by it, so an unverified address
  would let somebody claim another person's plan. Tokens
  never travel in the redirect URL, where they would leak into history and referrers.
- **`POST /auth/token` returns both tokens**, `{ accessToken, expiresIn, refreshToken }`, in
  `cache-control: no-store`. It accepts either credential:
  - the **flow cookie** (first call after login): mints a refresh token, stores `sha256(jti)`
    with its `exp` and `createdAt`, and clears the cookie;
  - a **refresh token** in the body (every later call): verifies it and requires `sha256(jti)`
    to be present and unexpired in the store. The same refresh token is returned; it is **not
    rotated**.

  **Where the hash is stored** depends on whether the user has a record: in its
  `refreshTokens` if so, otherwise in an in-memory `Map<hash, { email, exp }>` on the backend.
  `ensureRecord` moves every in-memory entry for the address into the new record, so creating a
  record never signs anybody out. The cost of memory is stated plainly: **a backend restart or
  deploy ends every record-less session**. The next refresh is a 401, the page shows its
  "session ended" toast and signs out keeping local data, and the user signs in again. That falls
  on people who have used nothing that needed the server, which is the reason it is acceptable.

  Either way it reads `plan` (`free` without a record) and mints the access token. A refresh token that verifies
  cryptographically but is no longer stored answers the same 401 as an absent one.
- **Revocation is deletion.** Because a refresh must find its hash, removing an entry from
  `refreshTokens` (by sign-out, or by a database admin in Fauxton) invalidates that
  token at its next use; the access token it last minted lives out its five minutes.
- **Logout: `POST /auth/signout`.** Removes the presented refresh token's hash from wherever it is stored and
  adds the presented access token's `jti` to the deny list until its `exp`. The page deletes the
  refresh token from `mm-local` on **every** sign-out, whether or not local data is removed.
- **The trade-off of a body token.** A refresh token that script can read is one an XSS could
  steal, and without rotation it would work until expiry or revocation. Accepted: the
  application already ships a strict Content-Security-Policy (`frontend/public/_headers`), revocation is one deletion,
  and rotation is tracked as an issue. A body token also removes the CSRF exposure a cookie
  credential on `POST /auth/token` would carry.
- **The deny list** is an in-memory `Map<jti, exp>` checked in `auth/bearer.ts`, pruned on
  insert. It protects the **backend API** only: CouchDB verifies access tokens itself and cannot
  consult it. The 5-minute TTL is what bounds that exposure: a token captured before logout
  replicates for at most five minutes. It is also per-process, which matches today's single
  instance and is tracked as an issue for when that changes.
- **One refresh token per device.** Signing out on one device leaves the others signed in.

### Plan in the token, and what goes stale

The plan is read on every refresh, so an operator's upgrade or downgrade reaches CouchDB within
one access-token lifetime: **five minutes**, with no sign-in required. The backend never trusts
the token's role for its own decisions; `POST /projects` reads the record, as phase 1's
`principalFor` does.

### Phase A — as built

Phase A is implemented. Where the code differs from the text above, the code is right:

- The handoff cookie is `mm_handoff` with `purpose: 'handoff'` (not `flow`, which names the PKCE
  carrier), 120 seconds, single use; its `jti` goes on the deny list.
- Sign-in requires a verified email (`emailVerified === true`); the record is keyed by it.
- The `by_sub` view (`_design/by_sub`) resolves *other* participants by subject and skips
  records with no `sub`. The caller is never resolved through it: `principalFor` and the
  transfer routes (`GET /transfers`, `POST` and `DELETE /transfers/:projectId`) take the caller's
  subject and verified address from the access token and read the record, if any, by address.
- `isLive` is true if the **record or memory** holds the hash (ruling R8), so a record created
  without draining memory (an operator setting a plan) never signs anybody out.
- `POST /auth/signout` answers 500, not 204, when revoking the refresh token fails.
- The client refreshes at `expiresIn − 2×margin` (not one) and when the page becomes visible.
- Frontend browser tests run Lit in production mode.
- `chunkSizeWarningLimit` in `frontend/vite.config.ts` is 700.
- Follow-ups filed: #208 (90-day hard delete), #209 (refresh-token hardening and rotation), #210
  (shared deny list and record-less store), #211 (downgrade grace period), #212 (sign-in log sink).

## Phase B — The plan, enforced

### Limits and policies

`Plan` becomes `'free' | 'member' | 'pro'`. Two facts, two table entries, no tier literals
outside `can.ts` (ADR 0009):

- `PROJECT_LIMITS` stays the **total** a plan may own, local and server together:
  `{ free: 1, member: 5, pro: -1 }`. `GET /profile` reports it as `projectLimit`; the page enforces
  it, because only the page can see local databases.
- A new action, **`project.sync`**, says whether a plan may own server projects at all:
  `free` false, `member` and `pro` true. `POST /projects` gates on `project.sync` and then on
  `project.create`, which counts owned server projects that are **not archived** against the same
  limit. The server bound is necessarily looser than the page's (it cannot see local-only
  projects) and is the part that cannot be bypassed.

**Archived projects stop counting.** This reverses #55's rule. #55 counted them because otherwise
an account could accumulate databases by archiving; the 90-day hard delete now bounds that
accumulation, and "removing a project frees its slot" is what the user is told.

### The validator

Provisioning writes a third key into `_security`, alongside the existing custom `writers` key:

```json
{ "members": { "names": ["<owner>"] }, "writers": { "names": ["<owner>"] }, "owners": { "names": ["<owner>"] } }
```

`infra/couchdb/design-docs/access.js` gains one rule after the `writers` check:

```js
var owners = (secObj && secObj.owners && secObj.owners.names) || []
if (owners.indexOf(userCtx.name) !== -1 &&
    userCtx.roles.indexOf('member') === -1 && userCtx.roles.indexOf('pro') === -1) {
  throw { forbidden: 'Your plan does not include synchronized projects.' }
}
```

- **Why owners only:** an invited writer's plan is irrelevant; the owner's plan pays.
- **Transfer** (`POST /projects/:id/transfer`) rewrites `owners.names` with `members` and
  `writers`, in the same `_security` write.
- **No existing databases are updated** (no live data; see phase A). Provisioning installs both.
- **Reads are not gated.** CouchDB's `_security.members` is an OR of names and roles; a
  downgraded owner keeps reading their server data. Only writes are refused.

### Archive, renamed name, and the `project` document

- `PATCH /projects/:id` with `archived: true` also stamps `archivedAt` on the pointer;
  `archived: false` removes it. An issue tracks the scheduled job that hard-deletes databases and
  pointers whose `archivedAt` is older than 90 days.
- `PATCH /projects/:id` accepts an optional `client` (string, same length rule as `name`).
- Provisioning writes `{ _id: 'project', type: 'project', name, client?, serverDb }` into the new
  database, and `PATCH` updates it with `name` and `client` alongside the pointer, so a
  replicated copy names itself correctly on every device.

### Contract

`openapi.yaml` changes with every route above (token claims are not in the contract; the
`/auth/token`, `/auth/signout`, `/profile`, `/customer` and `/projects` shapes are). The drift
test validates real responses; `SECURITY-MODEL.md` gains the user-record, token and owner-gate
sections, and its "Operator accounts and plans" section is rewritten for the record.

## Phase C — The projects page

### Local projects, and where the truth lives

- **Each project is its own PouchDB database**: `project_local_<uuid>` while it exists only here,
  `project_<id>` once it is on the server. Today's single `project_local` catalogue becomes the
  first local project: on first run it gains a `project` document, and the page asks for its name.
- **The `project` document** (`_id: 'project'`, `type: 'project'`, `name`, `client?`,
  `serverDb?`) is the source of truth for what a database *is*. It replicates, so a device that
  downloads a project knows its name signed out and offline.
- **`mm-local`** (never replicated) gains an index of local project databases and the **last known
  plan and limit**, written on every successful `GET /profile`. A device that has never signed in
  reads `free`. Sign-out with "remove local data" clears both. The refresh token is kept here
  too, and removed on every sign-out.

### Location and status

Derived, never stored, by joining the local index with `GET /projects` (archived rows dropped):

| Local | Server (not archived) | Shown as |
| --- | --- | --- |
| yes | no | **On this device** |
| no | yes | **On the server** |
| yes | yes | **Synchronized** |

A local copy whose server project was archived elsewhere reads as **On this device**. Live
status per project comes from `SyncManager.stateOf()`; `offline` is rendered quietly, never as an
error.

### Actions

| Action | Allowed when | What happens |
| --- | --- | --- |
| Create (member/pro) | signed in, under the total | Online: `POST /projects`, then start replication. Offline: a new local-only database |
| Create (free) | no project yet | A new local-only database |
| Create (signed out) | never | Disabled; "Sign in to create projects". A device that has never signed in is not empty: it always has the first-run local project (below), so the free view asks to **name** it rather than to create one |
| Rename / edit client | always for local-only; online for server projects | Local-only: write the `project` document. Server: `PATCH /projects/:id` |
| Promote to synchronized | member/pro, signed in, online | `POST /projects`, push the local data (reusing `migrate-local.ts`), write `serverDb`. Idempotent on the local database; the control is disabled while it runs. Slot-neutral |
| Download | member/pro, signed in, online | Start replication for a server-only project |
| Remove local copy (synchronized) | **online only** | A one-shot push must complete with nothing pending; then stop replication and destroy the local database. If the push fails or the device is offline, refused with the reason |
| Remove local-only project | always | Permanent: confirmed by typing the project name |
| Remove from server | owner, signed in, online | Archive. Warns that collaborators lose access and that it is deleted permanently after 90 days |

A lapsed owner (`project.sync` false, e.g. downgraded to free) sees their server projects listed
and opens them **read-only** (`useProjectDatabase(dbName, false)`), because the validator would
refuse their writes; local-only projects stay editable. This follows from "writes gated" and
prevents local edits that can never replicate.

### Page states by plan

- **Free.** No project: a card, "Create your project", with a name field and **Create**. One
  project: a card, **Continue with "\<name\>"**, a pen to rename, and an upgrade hint. No sync
  controls.
- **Member.** Exactly `projectLimit` rows. A filled row shows the name with a pen, location, sync
  status, **Open**, and an actions menu (promote or download, remove local copy, remove from
  server). An empty row is an inline name field with **Create**.
- **Pro.** A table with Name, Client, Location, Sync and Actions, sortable by name and client.
  **Add project** opens a dialog with name and optional client; the pen edits both.
- **Every plan.** A **Shared with me** section below, uncounted. Over the limit after a
  downgrade: everything listed and usable, creation hidden, one sentence saying why.

The page decides from `can()` and the reported `projectLimit`, never from a tier literal.

### Cross-cutting states

| State | Effect |
| --- | --- |
| Signed out | Local projects listed under the last known plan; creation and server actions disabled; "Sign in to sync" |
| Signed in, offline | Creation makes a local-only project; promote, download, remove-from-server and remove-synced-local disabled with "Needs a connection"; server-only rows say "Not available offline" and cannot be opened |
| Refresh fails on the network (fetch throws, 5xx, timeout) | Silent retry with exponential backoff and jitter (1 s doubling to a 60 s cap), reset by the `online` event; the user stays signed in and works locally |
| Refresh fails on authentication (401) | A toast, "Your session has ended. Please sign in again.", then local sign-out that **keeps** local data |

### The shell

- `/` is the projects view; the device list moves to `/devices` and shows the open project.
  **Open** sets the current project and navigates there. This is a breaking URL change for
  bookmarks of `/`, noted in the release note.
- Header: an always-visible **Online / Offline** tag (neutral styling for offline), and top
  right the signed-in **email**, or **Sign in** when signed out.
- Left menu: **Sign out** moves here and keeps the existing confirmation with "remove local data".
- **Upgrade** (free and member) opens a dialog: "It's just alpha — coming soon."
- Every new string goes through `msg()` with a German target in `de.xlf`.

## Failure modes, and what answers each

| Failure | Why it would go unnoticed | What answers it |
| --- | --- | --- |
| Two key derivations disagree | One address, two records, plan "randomly" free | `userKey` is the only derivation; a test pins `Foo@Example.com ` and `foo@example.com` to one key |
| `matter_manager` readable by users | Refresh hashes and plans exposed | `_security` written on creation; a test asserts a user token gets 403 |
| A user writes their own plan or roles | `PATCH /profile` looks successful | Named fields only; tests send `plan`, `roles`, `refreshTokens` and assert the stored document is unchanged |
| A revoked refresh token still mints | It still verifies cryptographically | Refresh requires the stored hash; tests sign out, and separately delete the hash directly in the database, and assert the next refresh is 401 |
| Sign-in quietly creates records again | A refactor puts the upsert back in the callback; nothing breaks visibly | A test signs in a new address with no invitations and asserts `matter_manager` has no document for it, and one log line |
| Creating a record signs the user out | Their in-memory refresh hash is left behind | `ensureRecord` moves in-memory entries; a test refreshes with the same token after `PATCH /profile` |
| A denied access token still reaches the API | The signature is valid | `bearer.ts` checks the deny list; a test signs out and reuses the token |
| Removing a synced local copy loses edits | Pending changes vanish with the database | Online-only, after a completed push; a test with pending changes and a failing push asserts refusal and an intact database |
| A network blip signs the user out | Looks like a session bug | Network failures retry; only a 401 signs out; tests cover both |
| Offline shown as an error | Users think the app is broken | Rendered quietly; a test pins the styling |
| `-1` compared instead of tested | Pro could never create | Every read goes through `withinLimit`, page included |

## Tests

- **Backend.** `userKey`; the record store (named-field updates, unknown plan, admin-only
  database); on-demand creation (no record after a plain sign-in, one after each trigger,
  in-memory hashes moved, `GET /profile` from claims without a record, the sign-in log line); `PUT /customer` and `PATCH /profile` against the record; invitations by
  address; token lifecycle (login → refresh → sign-out → refresh refused; deny list; plan change
  visible at next refresh; claims carry `_couchdb.roles`); `project.sync` and `project.create`
  tables including archived rows not counting; `archivedAt`; `client`; the `project` document on
  provision and rename; the drift test; a test that no module references `_users`.
- **Validator.** Owner without role refused; owner with `member` or `pro` allowed; invited writer
  without role allowed; `_admin` bypass unchanged.
- **Frontend (browser tests through the rendered page).** Each plan × signed in/out ×
  online/offline; the location join; create, rename, promote, download and each removal,
  including the refusals; refresh backoff versus 401 toast; shell email, sign-out in the menu,
  upgrade dialog.
- **E2E.** Create a local project offline, go online, promote, open it, record a device.

## Follow-up issues to file

1. Scheduled hard delete of projects archived more than 90 days ago.
2. Server-side refresh-token hardening: optional rotation on use, pruning expired `refreshTokens`
   entries, a cap per account.
3. A deny list and record-less refresh store shared across backend instances (and surviving
   restarts), needed once there is more than one.
4. A read-only grace period for downgraded owners: after a downgrade their server projects stay
   readable for a set period, then are archived and, 90 days later, deleted by the job in (1).
5. Refine sign-in logging: a proper sink, retention, and a PII policy for the address it records
   (today one `console.log` line per sign-in).

## Out of scope

Billing and self-service plan changes; a client entity (client is free text); deleting a
server project outright (archive plus the scheduled job covers it); migrating existing users
or project databases (there is no live data).
