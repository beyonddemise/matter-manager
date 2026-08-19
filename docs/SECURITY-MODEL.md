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

```
Browser                    API                      Google           CouchDB
   │  GET /auth/google      │                          │                │
   ├───────────────────────►│  authorization code+PKCE │                │
   │                        ├─────────────────────────►│                │
   │  ◄── redirect with session ──────────────────────┤                │
   │                        │                          │                │
   │  POST /auth/token      │                          │                │
   ├───────────────────────►│                          │                │
   │  ◄── RS256 JWT ────────┤                          │                │
   │                        │                          │                │
   │  replication, Authorization: Bearer <jwt>          │                │
   ├────────────────────────────────────────────────────────────────────►│
   │                                        validated with public key    │
```

The JWT's `sub` claim **is** the CouchDB username. CouchDB validates the signature itself
using the public key, so replication never passes through the API — which would otherwise sit
in front of every document write for no security benefit.

The public key is injected at startup via
`PUT /_node/_local/_config/jwt_keys/rsa:_default`, not baked into the image. Key material
therefore never enters the container registry, and rotation does not require redeploying
CouchDB. The consequence to handle: CouchDB rejects every JWT until that call succeeds, so
the API must make it before serving traffic and must fail loudly if it cannot.

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
(`_all_dbs` is blocked at Caddy), and cannot discover projects except through pointers the
API wrote into their own user database.

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
