# Security model

[SECURITY.md](../SECURITY.md) at the repository root is the policy: what to report and how,
and what an operator must do. This document is the mechanism: how authentication and
authorisation actually work.

## What is being protected

A Matter onboarding payload contains a setup passcode. Anyone holding it can commission the
device whenever it is commissionable — the state a factory reset produces. The realistic
threat is an attacker with physical access to a building and a copy of its project data:
factory-reset a device, adopt it onto their own fabric.

The data is roughly as sensitive as a set of spare keys, and it is stored unencrypted by
deliberate decision ([ADR 0005](adr/0005-plaintext-payload-storage.md)). That makes every
control below load-bearing rather than defence-in-depth.

## Authentication

```mermaid
sequenceDiagram
  participant U as Browser
  participant A as Fastify API
  participant G as Google (OIDC)
  participant C as CouchDB

  U->>A: GET /auth/google
  A->>G: authorization code + PKCE
  G-->>A: ID token
  Note over A: verified, then discarded.<br/>Provider tokens are never<br/>used as credentials here.
  A-->>U: mm_handoff cookie (httpOnly, 120 s, single use)
  U->>A: POST /auth/token
  A-->>U: access token (5 min) + refresh token (30 days)
  U->>C: replication, Authorization: Bearer <access token>
  Note over C: validates with the EC public key;<br/>the API is never on this path
  C-->>U: documents
```

The identity provider's own token is **exchanged, not reused**. Every OIDC provider shapes
its claims differently, so accepting them directly would push provider-specific handling into
CouchDB's `_security` and into every authorisation check — and adding Facebook later would
mean revisiting all of it. Exchanging once means we control the claim names and the signing
key.

Tokens are **ES256** (EC P-256), not RS256: much smaller signatures on every replication
request for equivalent security. Verified working against CouchDB 3.5.2, along with correct
rejection of expired tokens, tokens signed by another key, and tokens whose payload was
edited to claim a different `sub`.

The JWT's `sub` claim **is** the CouchDB username. CouchDB validates the signature itself, so
replication never passes through the API — which would otherwise sit in front of every
document write for no security benefit.

### Key handling and rotation

The public key is injected via `PUT /_node/<node>/_config/jwt_keys/ec:<kid>` rather than
baked into the image, so key material never enters the container registry.

**`[jwt_keys]` is applied live**, on the next request. Rotation is therefore zero-downtime:

1. Add the new key under a new `kid`.
2. Begin issuing tokens with it. Tokens carrying the old `kid` keep validating.
3. Remove the old key once no live token references it.

No restart, no interrupted replication. Verified against CouchDB 3.5.2 and guarded in CI by
`infra/couchdb/verify-jwt-model.sh`.

**`[chttpd] authentication_handlers`, by contrast, is read only at startup.** Setting it at
runtime returns `200` and has no effect until the node restarts — and in the meantime every
request authenticates as *anonymous* rather than failing loudly, which is a particularly
unhelpful way to be broken. Production bakes the handler into the image
(`infra/couchdb/00-base.ini`) so it is active from boot; treat changing it as a deployment, not
a configuration tweak.

The API should still confirm its key is in effect before serving traffic and fail loudly if
it is not, rather than issuing tokens that might be ignored.

Access tokens are short-lived and the client refreshes them ahead of expiry (see *User records
and tokens* below). **A local write never blocks on token freshness** — offline writes must
always succeed.

## Authorisation

Four roles. Only two of them exist as far as CouchDB is concerned.

| Role | Read | Write | Manage members | Transfer | Enforced by |
|---|---|---|---|---|---|
| `read` | ✓ | | | | CouchDB |
| `write` | ✓ | ✓ | | | CouchDB |
| `manage` | ✓ | ✓ | ✓ | | API only |
| `owner` | ✓ | ✓ | ✓ | ✓ | API only |

CouchDB cannot express "may change who else has access", so `manage` and `owner` are API
concepts. From the database's point of view they are simply writers.

### How read-only is enforced

CouchDB's `_security` has two tiers, and members can both read and write. There is no native
read-only role. The mechanism relies on two behaviours: CouchDB interprets only `admins` and
`members` and preserves other keys, and validation functions receive the whole `_security`
object.

```jsonc
// project_<uuid>/_security
{
  "members": { "names": ["alice", "bob"], "roles": [] },  // read
  "writers": { "names": ["alice"] }                        // write
}
```

```js
// project_<uuid>/_design/access
function (newDoc, oldDoc, userCtx, secObj) {
  if (userCtx.roles.indexOf('_admin') !== -1) return
  var writers = (secObj && secObj.writers && secObj.writers.names) || []
  if (writers.indexOf(userCtx.name) === -1) {
    throw { forbidden: 'You have read-only access to this project.' }
  }
  ...
}
```

The rejected alternative was a CouchDB role per project carried in the JWT. It works, but an
installer with 200 projects would carry 200 roles in every token on every replication
request.

### Why this is verified in CI

`infra/couchdb/verify-access-model.sh` runs on every push. It is not ceremony.

If a CouchDB upgrade stops preserving unknown `_security` keys, `writers` disappears, the
validation function sees an empty writer list — and, depending on how it fails, read-only
access either breaks entirely or silently becomes read-write. **No application-level test
would catch the second case**, because every line of application code would be behaving
exactly as written. This script is the only thing between that upgrade and a privilege
escalation.

Run it against any new CouchDB version before adopting it.

### Operator accounts and plans

Two operations in the API are not about the caller's own account. Both are authenticated by the
access token (`Authorization: Bearer`) and both are gated by one role.

| Operation | What it reaches | Gate |
|---|---|---|
| `PATCH /profile` with a `plan` field | the **caller's** own plan | holds `customerservice` |
| `PUT /customer` | the plan of **any account named by address** | holds `customerservice` |

A plan decides what an account may do — today, how many projects it may own
([ADR 0009](adr/0009-entitlement-seam-billing-deferred.md)). Setting one is therefore an
entitlement change, and `PUT /customer` is the only operation in this service whose blast radius
is somebody else's account. Everywhere else a hole in a check lets a user grant themselves
something; here it lets one user rewrite another user's entitlements.

**The gate is exact membership of `OPERATOR_ROLES`** (`backend/src/profile/routes.ts`), tested
with `includes` on each of the caller's roles and never by any test over the role's text. A
substring match would turn `customerservices` — somebody else's role — into this one, and a case
fold would turn `Customerservice`, a typo, into it. Either way an account that holds any role
named *near* this one becomes an operator.

**The role is set on the user record by hand, in Fauxton, and cannot be granted through this
API.** Open `matter_manager`, find the record `user:<base64url of the lower-cased address>`, and
add `"roles": ["customerservice"]`. The role is read from the record on every gated request, so
it takes effect immediately and removing it ends it. That the API cannot grant it is the
property the whole gate rests on, and it is structural rather than checked: every write in
`users/records.ts` spreads the stored record and then applies only its own named fields, so
`roles` is carried through verbatim and no request body can reach it. An operator who could set
`roles` could mint more operators, and the role check would then mean nothing.

A caller with no record has no roles, so is refused, and the refusal does not create the record.

**`_admin` is deliberately not an operator role.** It was, briefly, and removing it is a
decision rather than a tidy-up:

- It never granted what it appeared to. The check reads the caller's user record and nothing
  else, while a CouchDB *server* admin is configured in `local.ini [admins]` and has no record at
  all — so the real administrator held no roles as far as this gate was concerned and was refused
  regardless.
- So the only account it could ever admit is one with `roles: ["_admin"]` written into its
  record — and that role gets the unconditional early return from every project database's
  `validate_doc_update` shown above. Holding it does not mean "administrator"; it means "may
  write any document in any project, past every rule in this model".

Granting somebody the ability to change a plan must not require granting them everything. The
way to make an operator is `customerservice`, and there is a test in both
`test/profile/profile.test.ts` and `test/profile/customer.test.ts` asserting that a caller whose
only role is `_admin` is refused, so re-adding it fails the build.

## User records and tokens

**`matter_manager` is admin-only.** It holds plans, operator roles and refresh-token hashes, so
no user token may read it. Its `_security` is written immediately after the database is created,
before its view, because until it lands the database is open to every account in the
deployment (`backend/src/users/database.ts`). Browsers never reach it; the API reads it with its
own credentials.

**Records are keyed by verified address and created on demand.** The key is one derivation
(`users/key.ts`: trimmed, lower-cased, base64url), and sign-in requires the provider to have
verified the address — otherwise somebody could sign in as whoever they typed and inherit that
person's plan. A plain sign-in creates **no** record and writes one log line
(`auth/sign-in-log.ts`; the sink is #212). A record comes into existence only through
`ensureRecord` (a redeemable invitation at sign-in, accepting a transfer, or `PATCH /profile`)
or `PUT /customer`,
which sets a plan by address even before its owner has ever signed in. Such a record has no
`sub`, which is why the `by_sub` view skips records without one — and why the caller's own
record is always read by the verified address on their access token, never by subject. The
token's address is trustworthy for that because `/auth/token` mints only for an address the
provider verified, and the token is signed by this service.

**Tokens.**

| | Lifetime | Carries | Signed with | Stored |
|---|---|---|---|---|
| Access | 5 minutes (`ACCESS_TOKEN_TTL = 300`) | `sub`, `email`, `name?`, `jti`, `_couchdb.roles: [plan]` | the key CouchDB validates | nowhere; held in page memory |
| Refresh | 30 days, **not rotated** | `sub`, `email`, `name?`, `jti` | the session key CouchDB has never been given | `sha256(jti)` on the user record, or in backend memory if there is none |
| Handoff (`mm_handoff` cookie) | 120 seconds, single use | `sub`, `email`, `name?`, `jti` | the session key | the used `jti` goes on the deny list |

`name?` is the provider's display name, present when the provider gave one. It travels from the
handoff to the refresh token to every access token, because a record-less `GET /profile` is built
from the access token's claims and `PATCH /profile` seeds a new record from them.

- **Revocation is deletion.** A refresh is honoured only while its hash is found, so removing the
  entry ends that device's session. `isLive` is true if the record **or** memory holds the hash;
  memory is consulted even when a record exists, so creating a record by a path that does not
  move memory entries onto it (an operator setting a plan) never signs anybody out. Memory entries live until
  their expiry or a restart.
- **Record-less refresh entries live in memory and a restart loses them.** Those users get a 401
  at their next refresh and sign in again, keeping their local data. The cost falls only on
  people who have used nothing that needed the server. A store shared across instances is #210.
- **The handoff's single use is per process.** A used handoff's `jti` goes on the in-memory
  deny list until the handoff's own expiry, so a backend restart within those 120 seconds
  forgets it, and that handoff can be exchanged **once more**. The window is two minutes, the
  cookie is httpOnly and cleared on first use, and a replay yields tokens for the same verified
  person who just signed in; a shared deny list is #210.
- **A fresh handoff wins.** When `POST /auth/token` receives both a handoff cookie that verifies
  and a body refresh token, it honours the handoff: a sign-in just finished, and a stale stored
  token must not end the session it began. The page then replaces its stored refresh token. A
  handoff that does not verify is ignored; a present but malformed body token with no handoff to
  honour is a 401.
- **Sign-out** denies the presented access token, clears the cookies, then revokes the presented
  refresh token. If revocation fails it answers **500**, never 204: the hash is still stored, so
  the refresh token is still a live thirty-day credential, and claiming "signed out" would hide
  that from the one party who could retry.
- **The deny list covers this API only.** CouchDB verifies access tokens itself and never asks
  the API, so a token taken before sign-out keeps replicating until its `exp`. Exposure after
  sign-out is therefore bounded by the five-minute TTL, not by the list. The same TTL bounds how
  stale the plan in `_couchdb.roles` can be. The list is per-process (#210).
- **The refresh token is readable by script.** The page keeps it in `mm-local` so a reload or
  new tab can refresh without a redirect, which means an XSS could steal a credential that works
  until expiry or revocation. **This is accepted**, mitigated by the Content-Security-Policy in
  `frontend/public/_headers` and by revocation being one deletion; rotation on use is tracked in
  #209. Sending it in a request body rather than a cookie removes the CSRF exposure a cookie
  credential on `POST /auth/token` would carry.
- **The client** refreshes at `expiresIn − 2×margin` (one margin for the point where it stops
  handing out the token, one for a slow round trip) and when the page becomes visible. While the
  API is unreachable it backs off from 1 s, doubling to 60 s, with jitter. On a 401 for a stored
  refresh token it shows "session ended" and goes to the expired state, keeping local data.

## What isolation does and does not give you

**Does:** a member of project A cannot read project B, cannot enumerate databases
(`_all_dbs` is blocked at Caddy), and cannot discover projects except through `GET /projects`,
which the API answers from a registry the client can never read directly.

**Two of the three server-side databases are unreachable from a browser**, and this is
load-bearing rather than tidy:

- **`projects`** holds every project's name, address and participant list. CouchDB has no
  row-level read permission, so making it member-readable would disclose all of it to every
  authenticated user.
- **`matter_manager`** holds user records: profiles, plans, roles and refresh-token hashes. It is
  admin-only, which is why profiles come from `GET /profile`. CouchDB's own `_users` is no longer
  used for profiles.

The browser's `mm-local` cache of those responses is never consulted for an authorisation
decision. It determines what the client will *attempt*; `_security` determines what succeeds.

**Does not:** recall data. Revoking access stops future replication; it cannot retrieve what
already synced to someone's device. This is inherent to offline-first replication, not a
defect. Treat revocation as "no new data", never as "data withdrawn". If a payload must be
considered compromised, the remedy is to factory-reset the device, which issues a new
passcode.

## Rules for contributors

- **Never log a payload or passcode.** Not at debug level, not temporarily, not while
  chasing a bug. Log the device id.
- **Never send a payload to a third party.** The DCL lookup sends vendor and product ids
  only.
- **No analytics or error reporting that can capture document contents.**
- **Never compare against a bare owner id.** Route through `isOwner(principal, project)`
  ([ADR 0011](adr/0011-user-owned-org-ready-tenancy.md)).
- **Never gate an action without calling the entitlement seam**
  ([ADR 0009](adr/0009-entitlement-seam-billing-deferred.md)).
- **Never add a role to `OPERATOR_ROLES` without checking what else that role already grants.**
  A role is not a label; it is whatever every `validate_doc_update` in the deployment does with
  it. See *Operator accounts and plans* above for the one that was added on its name alone.
- **Never write a request body onto a user record.** Writes name their fields; see
  `users/records.ts`.

## Operator requirements

Enumerated in [SECURITY.md](../SECURITY.md) and tracked as M9 issues: TLS only, `_all_dbs`
and Fauxton blocked, admin party disabled, encrypted volume, encrypted backups.

A backup of this database is exactly as sensitive as the database.
