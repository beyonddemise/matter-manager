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
  A-->>U: session established
  U->>A: POST /auth/token
  A-->>U: ES256 JWT — sub = CouchDB username
  U->>C: replication, Authorization: Bearer <jwt>
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
(`infra/couchdb/local.ini`) so it is active from boot; treat changing it as a deployment, not
a configuration tweak.

The API should still confirm its key is in effect before serving traffic and fail loudly if
it is not, rather than issuing tokens that might be ignored.

Tokens are short-lived. On a 401, the client refreshes and retries. **A local write never
blocks on token freshness** — offline writes must always succeed.

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

## What isolation does and does not give you

**Does:** a member of project A cannot read project B, cannot enumerate databases
(`_all_dbs` is blocked at Caddy), and cannot discover projects except through `GET /projects`,
which the API answers from a registry the client can never read directly.

**Two of the three server-side databases are unreachable from a browser**, and this is
load-bearing rather than tidy:

- **`projects`** holds every project's name, address and participant list. CouchDB has no
  row-level read permission, so making it member-readable would disclose all of it to every
  authenticated user.
- **`_users`** holds profiles. Verified: a JWT-authenticated user cannot read even their own
  document, which is why profiles come from `GET /profile`.

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

## Operator requirements

Enumerated in [SECURITY.md](../SECURITY.md) and tracked as M9 issues: TLS only, `_all_dbs`
and Fauxton blocked, admin party disabled, encrypted volume, encrypted backups.

A backup of this database is exactly as sensitive as the database.
