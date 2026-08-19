# 5. Store Matter payloads unencrypted

Date: 2026-08-19

## Status

Accepted — with mandatory compensating controls

## Context

A Matter onboarding payload contains a setup passcode. Anyone holding it can commission the
device it belongs to whenever that device is commissionable — which is the state a factory
reset produces. The data is roughly as sensitive as a set of spare keys.

Offline-first means those payloads sit in browser IndexedDB, unencrypted by default, on
every device that has ever synced the project. They also sit in CouchDB.

Options considered:

1. **Encrypt only the payload field, per project.** Metadata stays searchable; a database
   dump or stolen laptop profile leaks the inventory but not the commissioning secrets.
   Costs: key management, key wrapping per member, rotation on revocation, no server-side
   PDF, and a class of "cannot decrypt" failures that are miserable to support.
2. **Encrypt whole documents.** Strongest, but defeats CouchDB views and Mango entirely.
   Every filter becomes a client-side scan after decrypting the whole project.
3. **Plaintext, with isolation and transport security as the boundary.**
4. **Payload server-side only.** Rejected outright: it breaks the product. Reproducing a QR
   code in a basement with no signal is the entire point.

## Decision

Store payloads unencrypted. The security boundary is per-project database isolation
(ADR 0003) plus transport security, not encryption at rest.

## Consequences

This is a real trade-off with real exposure, so the compensating controls are requirements,
not recommendations. They are tracked as M9 issues and enumerated in SECURITY.md:

- TLS only; no plaintext CouchDB port reachable from the internet
- `_all_dbs` and Fauxton blocked at the reverse proxy
- CouchDB admin party disabled
- Encrypted volume on the database host
- Encrypted backups — a backup of this database is as sensitive as the database

Consequences to accept knowingly:

- **An installer's instance holds the commissioning secrets for every customer's home.** It
  is a concentrated target, and it is the strongest argument for revisiting option 1 if the
  product gains professional users.
- **Revocation cannot recall replicated data.** Someone who had access keeps what already
  synced. The only real remedy for a compromised payload is factory-resetting the device,
  which issues a new passcode.
- Never log a payload or passcode, at any level, including while debugging. Never add
  analytics or error reporting that could capture document contents.

Revisit this ADR if the product gains professional installers, multi-tenant hosting, or any
regulatory obligation. The decision is right for a self-hosted or single-operator instance;
it is not obviously right at scale.
