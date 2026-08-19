# Security Policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/beyonddemise/matter-manager/security/advisories/new).
Please do not open a public issue for a vulnerability.

Expect an acknowledgement within 72 hours.

## What this application stores, and why it is sensitive

A Matter commissioning QR payload contains a **setup passcode**. Anyone holding that payload
can commission the device it belongs to, if that device is in a commissionable state — which
is exactly the state a factory reset produces.

So the threat is concrete: an attacker with physical access to a home and a copy of its
Matter Manager project can factory-reset a device and adopt it onto their own fabric. The
data is roughly as sensitive as a set of spare keys.

## Deliberate trade-off: payloads are stored unencrypted

Payloads are stored in plaintext, in browser IndexedDB and in CouchDB. This was chosen
knowingly ([ADR 0005](docs/adr/0005-plaintext-payload-storage.md)) so that search, views,
support and debugging stay straightforward.

The security boundary is therefore **database isolation plus transport security**, not
encryption at rest. That places real obligations on anyone operating an instance:

| Control | Requirement |
|---|---|
| Transport | TLS only. No plaintext CouchDB port reachable from the internet. |
| Admin party | Disabled. CouchDB must have an admin configured before first use. |
| `_all_dbs` | Blocked at the reverse proxy. Clients discover projects via their own user database, never by enumeration. |
| Fauxton | Blocked at the reverse proxy in production. |
| Disk | Encrypted volume on the database host. |
| Backups | Encrypted at rest and in transit. A backup of this database is as sensitive as the database. |
| Access review | Revoking project access rewrites `_security`; already-replicated local copies cannot be recalled. Treat revocation as "no new data", not "data withdrawn". |

## What revocation can and cannot do

When you remove someone's access to a project, they lose the ability to read future changes.
**They keep whatever already replicated to their device.** This is inherent to offline-first
replication, not a defect. If a payload must be considered compromised, the remedy is to
factory-reset the device and re-commission it, which issues a new passcode.

## Scope

In scope: authentication, authorisation between projects, `validate_doc_update` enforcement,
JWT handling, injection, and dependency vulnerabilities.

Out of scope: attacks requiring physical access to an already-unlocked device belonging to a
legitimate user, and the deliberate plaintext-at-rest decision documented above.
