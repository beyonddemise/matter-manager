# 22. Setup codes are encrypted per project, with the key escrowed on the server

Date: 2026-10-28

## Status

Accepted. **Amends [ADR 0005](0005-plaintext-payload-storage.md)**: this is the revisit 0005
scheduled, and it takes 0005's option 1. `payload` and `manualCode` are no longer stored in
plaintext; the rest of each device document still is, and 0005's compensating controls stay
mandatory for it. [ADR 0019](0019-setup-code-to-own-api.md) stands unchanged: a lookup sends the
decrypted code, as it sent the plaintext one. Design: spec 2026-10-27, "Envelope encryption for
commissioning secrets, with server key escrow". Epic #297, backend epic
matter-manager-backend#32.

## Context

ADR 0005 stored setup codes in plaintext and called that "not obviously right at scale". It
named option 1, encrypting only the payload per project, and rejected it for its costs: key
management, a wrap per member, rotation on revocation, and a class of "cannot decrypt" failures
that are miserable to support. Every one of those now has an answer, so the costs no longer
outweigh the exposure: a CouchDB dump, a backup or a stolen laptop profile yields every
commissioning secret in every home the instance holds.

The constraints did not change. Device work must not need connectivity (ADR 0002). A QR code
must render in a basement with no signal. No runtime dependency may be added (ADR 0013). Lists,
search, catalogue lookup and the conflict merge read the metadata, so it must stay readable.

The options were:

1. **End-to-end encryption, the server never able to decrypt.** Rejected: a new device, or a
   browser that lost its key, could only be let in by another member's device being online and
   willing. In a product where one person usually owns every device of a project, a lost
   browser profile would be a lost project.
2. **Server-held keys, decrypted on the server.** Rejected: it breaks offline work, which is the
   product.
3. **Envelope encryption with a server escrow key.** A key per project, generated on the device
   and wrapped once per recipient: each member device and the server's escrow key. The server
   can re-wrap a project key for a member's new device, so recovery needs no ceremony. This is
   the approved design.

## Decision

**Two fields are encrypted, nothing else.** `payload` and `manualCode` are AES-256-GCM
ciphertext at rest in IndexedDB, in CouchDB and in every backup of either. Encryption and
decryption happen at the repository seam (`data/repository.ts`), so the views read and write
plaintext and never see ciphertext.

### Threat model

- **Protected: data at rest.** A stolen IndexedDB, a CouchDB volume or dump, a database backup,
  leaked admin credentials, or `curl` against CouchDB yield ciphertext for the codes. A member
  replicating a project receives ciphertext and a key wrapped only for their own registered
  devices.
- **Not protected, by design: the server operator.** A project can only be taken to the server
  with an escrow wrap the server has validated, so the escrow private key can open the key of
  every project the server holds. This is server-mediated encryption, not end-to-end. That is
  the trade for recovery without ceremony, and it is the trust ADR 0019 already extends when a
  code passes through the API for a lookup. A local-only project never reaches the server, so
  whatever wraps it carries, its codes are on no server at all.
- **Still exposed, knowingly.**
  - Device metadata (`vendorId`, `productId`, `discriminator`, names, rooms) stays plaintext. A
    dump reveals the inventory, not the codes.
  - **The export archive is plaintext unless the user sets an archive password.** It is the
    backup of last resort and must import without any device or escrow key, so by default it
    holds every code in clear, and the menu and the export dialog say so. It is made only from
    an unlocked project at the user's explicit request. Since #307 the dialog offers an
    optional password that makes it a WinZip AE-2 zip (AES-256, PBKDF2 at the format's fixed
    1000 iterations, a 12-character floor); password and file are then all a restore needs,
    and a lost password cannot be recovered. This covers the project archive only: the PDFs
    and the Excel sheet stay plaintext. Once exported, an unprotected file is the user's to
    protect. See DATA-MODEL, *Project export*.
- **Accepted: a writer can deny recovery, never corrupt it silently.** CouchDB's validator sees
  a conflict branch pushed with `new_edits=false` as a create (`oldDoc = null`), so the
  `key:escrow` wrap cannot be made immutable against a member with write access. Such a member
  could add a garbage revision. The effect is loud: RSA-OAEP authenticates, so the wrap fails to
  unwrap, `POST /escrow` answers `422 escrow-wrap-invalid`, and the genuine wrap survives as a
  conflict revision. Locking it down fully would need the server to own the key documents, and
  in this product every project is born in a browser (decision 9 below). The CouchDB contract
  check pins the limitation, so an upgrade that changes it is noticed.

### Key hierarchy

| Key | Type | Lives | Protected by |
|---|---|---|---|
| KEK | 256-bit secret | `ESCROW_KEK` env var on the API host | operations: env file mode 0600, backed up out of band |
| Escrow key pair | RSA-3072 | `matter_manager` doc `escrow:keys`, private key sealed | AES-256-GCM under the KEK, AAD `escrow:keys` |
| Device key pair | RSA-OAEP-3072 / SHA-256, one per browser profile | raw IndexedDB `mm-keys`, private key non-extractable | browser origin isolation; a lost key is recovered through escrow for server projects, once the backend with `POST /escrow` is deployed; never for a local-only project |
| Project DEK | AES-256-GCM | one `key:*` wrap document per recipient, in the project database | RSA-OAEP-256 under each device key and the escrow key |
| Field ciphertext | AES-256-GCM, fresh 96-bit IV | `payload` / `manualCode` on device documents | the project DEK |

A **kid** names every public key: the full SHA-256 of its SPKI DER, 64 lowercase hex characters.
For a device key the server derives it when the key is registered; the request carries no kid.
The browser derives the same value for its own use, and shared test vectors pin that the two
agree. Server derivation plus the full hash means no member can claim another member's kid, or
grind a key pair whose kid collides with one, so an escrow re-wrap can never overwrite another
device's wrap.

### Decisions taken

1. **Local-only projects are encrypted too.** The DEK is wrapped for this device, and for escrow
   too when the escrow public key is already cached.
2. **No migration.** Pre-release databases are deleted. The `enc:v1:` prefix leaves room for a
   later format, not for a migration. The one database that is adopted rather than created, the
   first-run catalogue `project_local`, keys itself and seals its devices when it is opened
   (#331, #336), so a catalogue adopted before that fix is keyed too; see the consequences.
3. **No DEK rotation when a member is removed.** Removal deletes their `key:<kid>` documents with
   the `_security` rewrite (matter-manager-backend#40, not yet shipped). ADR 0003's position
   stands: replicated data cannot be recalled, and the remedy for a compromised code is a
   factory reset.
4. **DEKs are generated on the device, never on the server.** Offline creation needs it. The
   server only re-wraps an existing DEK.
5. **`POST /escrow` carries the client's copy of the `project` document.** The server compares it
   with its own (`type`, `name`, `client`, `serverDb`, and `_rev` when sent) and answers
   `409 document-mismatch` on a difference. This is a check that the caller holds the data, on
   top of the registry membership check, never instead of it.
6. **The escrow private key is stored in CouchDB, sealed by an env KEK.** In plaintext there it
   would fall to every threat that exposes the project databases. With the KEK, a dump is useless
   without the host's environment, and the environment is useless without the dump.
7. **Escrow re-wrap is the only way a key reaches a device.** There is no invite-by-URL flow to
   attach owner-side wrapping to, so a new collaborator, a new device and a lost key take one
   path. No user ever needs another user's public key, and there is no `GET /publickey`.
8. **Promote reuses the local DEK.** The copy into the server-named database is the raw
   replication it was: ciphertext and the `key:*` documents copy as they are. Nothing is
   re-encrypted.
9. **Every project is born locally; the server only provisions.** `POST /projects` creates an
   empty database. The key documents are project content: written by the creating browser,
   reaching the server by replication.
10. **The server validates escrow-wrap integrity but does not own the wrap.** `POST /projects`
    carries the escrow wrap; the server test-unwraps it and refuses the creation with
    `422 escrow-wrap-invalid` (or `escrow-wrap-required` when it is absent). That catches a
    stale cached key or an interop bug before the first sync. At `POST /escrow`, a missing wrap
    (`422 escrow-wrap-missing`) and one that will not unwrap (`422 escrow-wrap-invalid`) are
    distinct problems, never a 500 and never silently served. (`POST /escrow` is
    matter-manager-backend PR #54: merged, available once the backend is deployed with
    `ESCROW_KEK`.) This loud failure is the mitigation for the conflict-branch limitation above.
    The validator rule on `key:*` documents is **create-only for writers**: only the server admin
    may update or delete one.

### How it shipped

The implementation refined the design in these places, and these are the rules now:

- **A field name may not contain `:`.** The AAD is `"<docId>:<fieldName>"`. Document ids
  contain colons (`device:<uuid>`), which is safe only while the field side has none: then the
  last colon splits the two unambiguously. Encrypt and decrypt both refuse such a field name.
- **A database with no `key:*` documents is keyless, and fails closed (#333, #336).** Its wraps
  have not replicated in yet: a pull does not order `key:*` before `device:*`. The key state is
  resolved again when an inbound batch carries a `key:*` document. Until then:
  - **reads:** a document whose `payload` or `manualCode` carries `enc:`, in its winning or any
    losing revision, reads **locked**. That is decided before conflict resolution, so a locked
    read never writes. Ciphertext never reaches a view or the catalogue lookup;
  - **writes:** every write carrying a plaintext code is refused, unconditionally; writes without
    codes pass. There is no scan and no cache, so there is no race between a check and a write;
  - repositories built with no key state at all (`mm-local`-style databases, unit tests) stay
    plaintext.
- **The first-run catalogue keys itself when opened** (`keyCatalogue`, through
  `ensureProjectKeys`). It reuses its own wrap if there is one and mints otherwise, then seals
  every device still holding a plaintext code, conflicted revisions included, so no plaintext
  leaf survives. This is scoped to the catalogue alone: minting into a server copy that is still
  downloading would strand its real DEK. Two tabs racing to mint resolve on the 409 to the
  winner's DEK. "Empty catalogue" (ruling C-R7) now means no user content, ignoring `key:*` and
  `_design/*`, so a device that knows only server projects gets a keyed but unadopted catalogue.
- **Locked means read-only.** A database with wraps for other recipients only is locked. Reads
  omit `payload` and `manualCode` and mark the document `locked: true`. Every write is refused
  (`ProjectLockedError`). A document **read while locked** is refused on save and remove even
  after the key arrives (`StaleLockedDocumentError`): it carries no codes, and saving it would
  store the device without them.
- **Nothing exports a locked project.** The PDF inventory, the labels PDF, the Excel sheet and
  the project archive all refuse, with the same message. Catalogue backfill skips a locked
  project entirely, because a lookup on a missing code would mark the device `unusable` for good.
- **Recovery pulls first.** The client half has shipped. The server half, `POST /escrow`
  (matter-manager-backend PR #54), is merged and available once the backend is deployed with
  `ESCROW_KEK`; until then a locked project stays locked. On a locked open: pull, try the unlock
  again (the wrap may already be there), then `POST /escrow` with the freshly pulled `project` document. On 204, pull and
  unlock. A `409 document-mismatch` is retried once with a re-pulled document; any other refusal
  leaves the project locked until the next open. Recovery waits for this device's key
  registration, which is one shared promise per access token: on a brand-new device the startup
  registration and the first recovery would otherwise race, and the server would answer
  `400 unknown-device-key`.
- **"Create as synced" creates locally, then promotes.** Promotion is the one path to the
  server, so it is the one place the escrow wrap is ensured and sent. When it fails (the server
  has escrow off, so `GET /escrowkey` answers 404, or it cannot be reached), the project is kept
  as a local project and the page says so. Nothing the reader asked for is rolled back.
- **The DEK is unwrapped again on each page load.** It is held in memory per open database and
  never stored.
- **The KEK can be rotated.** A one-off `rotate-escrow-kek` command re-seals the escrow private
  key under a new KEK (matter-manager-backend#31; runbook in [SECURITY.md](../../SECURITY.md)).
  Rotating the escrow key pair itself would mean re-wrapping every project's `key:escrow`, and
  is not designed.

## Consequences

**Gains.**
- A database dump, a backup or a stolen browser profile no longer yields setup codes. The
  concentrated target ADR 0005 named, an installer's instance holding every customer's codes,
  now holds ciphertext.
- Once the backend with `POST /escrow` is deployed, a new device or a lost key on a server
  project recovers with nothing for the user to do beyond being signed in and online once.
  Offline work on an unlocked project is unchanged.
- No dependency was added: WebCrypto in the browser, JCA on the server.

**Costs, accepted knowingly.**
- **The operator can decrypt every project on the server.** The escrow private key is in the
  API's memory. Anyone who holds the KEK, the `matter_manager` database and the project databases
  holds every code in them.
- **The KEK is now irreplaceable.** Losing it orphans every escrow wrap in existence, and the API
  refuses to start rather than regenerate the key pair. It must be backed up out of band, once,
  and never regenerated.
- **A new device that is offline cannot read the codes** of a project it has not unlocked
  before. In place of the QR and manual code, the device page says they will be available after
  the next sync. Until the backend with `POST /escrow` is deployed, the same holds online: the codes are readable
  only in the browsers that hold a wrap, and losing `mm-keys` there loses them on that browser.
- **A local-only project cannot be recovered.** `POST /escrow` re-wraps from the server's copy,
  and a local-only project has none. A `key:escrow` it carries is never sent anywhere before
  promotion, and one born without it can only get one from this device's key. If the browser
  loses `mm-keys` before the project is promoted, the codes survive only in a project export
  the user made.
- **A writer can deny recovery** through a conflict branch, as described above. A support case
  rather than a breach, and a detectable one.
- **New places a secret could be logged:** setup codes, DEKs, wraps and the KEK. None may be
  logged at any level.
- **The first-run catalogue `project_local` was adopted without keys; fixed by #331 and #336.**
  It now keys itself and seals its devices when it is opened, a catalogue indexed before the fix
  included, so it promotes like any other project. Residual gaps:
  - revisions written before the sealing keep their plaintext bodies in the non-leaf IndexedDB
    history until compaction. Replication sends only leaf revisions, so they never reach the
    server;
  - another tab that read the catalogue before it was keyed keeps its plaintext reading until it
    is reloaded; there is no cross-tab key-state signal yet;
  - if keying fails at open (quota, key generation), the catalogue's reads fail too and are
    retried on the next operation, and its writes report the storage failure. It never falls
    back to plaintext.
- 0005's compensating controls (TLS, `_all_dbs` and Fauxton blocked, encrypted volumes and
  backups) stay mandatory: the metadata is still plaintext, and a backup still holds the escrow
  key, sealed.

Revisit this ADR if end-to-end encryption becomes a requirement (an operator who must not be
able to read codes), if the escrow key pair ever needs rotating, or if CouchDB starts calling
the validator with the old revision for a conflict branch, which would let `key:escrow` become
immutable.
