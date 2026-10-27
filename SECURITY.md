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

## Deliberate trade-off: only the setup codes are encrypted

In every keyed project (one holding `key:*` documents, which every project created, imported or
adopted since encryption shipped does), the two fields that hold a setup code, `payload` and
`manualCode`, are encrypted at rest with a key per project, in browser IndexedDB and in CouchDB
([ADR 0022](docs/adr/0022-field-encryption-with-key-escrow.md)). Everything else on a device
document is stored in plaintext, as it always was
([ADR 0005](docs/adr/0005-plaintext-payload-storage.md)), so that lists, search, the catalogue
lookup and the conflict merge keep working. A dump of a keyed project reveals the inventory, not
the codes.

Every project is keyed. Projects are born with keys, and the first-run catalogue is keyed and
its devices sealed when it is opened (#331, #336), including one adopted before that fix. A
project copy whose wraps have not replicated in yet refuses every write that carries a plaintext
code and reads any ciphertext as locked (#333). One place still holds plaintext codes at rest,
recorded in ADR 0022:

- **Old revisions in the browser.** When the catalogue's devices are sealed, the revisions
  written before that keep their plaintext bodies in the IndexedDB history until compaction.
  They are not leaves, so they are never replicated.

Two exceptions are deliberate:

- **The server can decrypt every project it holds.** A project can only be taken to the server
  with its key wrapped for the server's escrow key, so the escrow key opens every server
  project's key. That is what lets a new device or a lost browser key be let in without ceremony,
  through the re-wrap endpoint (`POST /escrow`), which is merged on the backend and available
  once the backend is deployed with `ESCROW_KEK`. A local-only project never reaches the server,
  so its codes are on no server at all, and for the same reason it has no recovery: if the
  browser loses its device key before the project is promoted, the codes survive only in an
  export. This is not end-to-end encryption, and the operator is trusted.
- **Exports are plaintext, unless the user sets an archive password.** The project archive is
  the backup of last resort and must import without any device or escrow key. By default it
  holds the codes in clear; the export dialog offers an optional password (#307), which seals
  every entry as a WinZip AE-2 zip (AES-256-CTR with HMAC-SHA1, keys from PBKDF2-HMAC-SHA1 at
  the 1000 iterations the format fixes, so 7-Zip, WinZip and macOS tools open it). The password
  must be at least 12 characters, because 1000 iterations make each guess cheap for an offline
  attacker. Password and file are all a restore needs; nothing recovers a lost password, and
  the dialog says so. File names, sizes and the device count stay visible either way. Legacy
  ZipCrypto is never offered. The password covers the project archive only: the labels and
  inventory PDFs and the Excel sheet always print the codes in clear. Whoever exports any of
  them unprotected is responsible for protecting it.

The security boundary for everything but the codes is therefore still **database isolation plus
transport security**. That places real obligations on anyone operating an instance:

| Control | Requirement |
|---|---|
| Transport | TLS only. No plaintext CouchDB port reachable from the internet. |
| Admin party | Disabled. CouchDB must have an admin configured before first use. |
| `_all_dbs` | Blocked at the reverse proxy. Clients discover projects via their own user database, never by enumeration. |
| Fauxton | Blocked at the reverse proxy in production. |
| Disk | Encrypted volume on the database host. |
| Backups | Encrypted at rest and in transit. A backup of this database is as sensitive as the database. |
| Access review | Revoking project access rewrites `_security`; already-replicated local copies cannot be recalled. Treat revocation as "no new data", not "data withdrawn". |
| `ESCROW_KEK` | Generated once, backed up out of band, never regenerated. See below. |

## The escrow key encryption key: `ESCROW_KEK`

The API's escrow private key is stored in CouchDB (`matter_manager`, document `escrow:keys`),
sealed with AES-256-GCM under `ESCROW_KEK`, an environment variable on the API host. A database
dump is useless without the variable, and the variable is useless without the dump. Holding
both means holding every setup code on the instance.

**Setting it up, once per deployment:**

1. Generate it: `openssl rand -base64 32`. It must decode to exactly 32 bytes, or the API does
   not start.
2. **Back it up out of band before first use**, for example in a password manager or a sealed
   offline record, never beside the database backups. A backup of the database and a backup of
   the KEK in the same place undo the separation.
3. Put it in the API's env file (mode 0600), never on a command line or in a `-e` flag, where
   shell history and `ps` would record it.
4. Start the API. The first start with a KEK generates the escrow key pair and stores it sealed.
   Every later start unwraps it.

**A KEK that does not match is fatal.** If the variable differs from the one that sealed the
stored key, the API refuses to start and says so, naming `ESCROW_KEK` and no secret. It
**never** generates a replacement pair: that would orphan every `key:escrow` wrap in every
project, and escrow recovery would be gone for all of them. The fix is to restore the original
KEK from the backup.

**Never regenerate the KEK.** A new KEK does not open the stored key. To change the KEK, rotate it
with the `rotate-escrow-kek` one-off command, which re-seals the stored key under a new KEK and
touches no project data (matter-manager-backend#31; the step-by-step runbook is in that
repository's README, *Rotating `ESCROW_KEK`*). Rotating the escrow key pair itself is a
different operation, which would re-wrap every project's key, and has not been designed.

Without `ESCROW_KEK`, escrow is off: `GET /escrowkey` answers 404, a project cannot be taken to
the server, and "create as synchronized" keeps the new project local.

## What revocation can and cannot do

When you remove someone's access to a project, they lose the ability to read future changes.
**They keep whatever already replicated to their device.** This is inherent to offline-first
replication, not a defect. If a payload must be considered compromised, the remedy is to
factory-reset the device and re-commission it, which issues a new passcode.

Encryption does not change this. Removing a member does not rotate the project key: their
devices already held it, and the data it protects had already replicated to them.

## Rule for contributors: never log key material

Never log, print, echo in an error, or attach to a bug report any of these, at any level,
including while debugging:

- a setup code (`payload`, `manualCode`), decrypted or not;
- a project DEK, raw or as a `CryptoKey` dump;
- a wrap (`wrapped` of a `key:*` document) or the sealed escrow key (`privateKeyWrapped`);
- `ESCROW_KEK`, a device private key, or the escrow private key.

Log the document id, the kid or the problem `reason` instead. A kid names a public key and is
safe to log. A route that handles any of these gets a test that captures its log output and
finds none of them in it, as the catalogue lookup has for setup codes (ADR 0019).

## Scope

In scope: authentication, authorisation between projects, `validate_doc_update` enforcement,
JWT handling, injection, and dependency vulnerabilities.

Out of scope: attacks requiring physical access to an already-unlocked device belonging to a
legitimate user, and the deliberate trade-offs documented above: plaintext metadata, the
operator's ability to decrypt through escrow, and the export made without a password. Guessing
the password of an archive someone already holds is also out of scope: its strength is the
password's, by the format's design.
