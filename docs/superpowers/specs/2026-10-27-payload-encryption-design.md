# Envelope encryption for commissioning secrets, with server key escrow

Date: 2026-10-27
Status: draft, awaiting approval

## Intent

Encrypt the two commissioning secrets on a device document — `payload` and
`manualCode` — everywhere they rest: browser IndexedDB, CouchDB, and every backup
of either. Decryption keys are delivered per device via envelope encryption, and
a server-held escrow key makes onboarding a new device, or recovering from a lost
key, transparent to the user. The UI layer is unaffected; encryption and
decryption happen in the data layer.

This is the revisit that [ADR 0005](../../adr/0005-plaintext-payload-storage.md)
scheduled: "encrypt only the payload field, per project" (its option 1), now that
the costs it listed have answers. A new ADR amending 0005 is part of this work.

## Threat model — what this protects and what it does not

**Protected:** data at rest. A stolen laptop's IndexedDB, a CouchDB volume or
dump, a database backup, leaked admin credentials, or direct `curl` against
CouchDB yield ciphertext for the commissioning secrets. A member replicating a
project they are entitled to receives ciphertext plus a key wrapped only for
their own registered devices.

**Not protected, by design:** the server operator. The escrow private key lets
the backend decrypt any project key, so this is server-mediated encryption, not
end-to-end. That is a deliberate trade for transparent recovery, and it is
consistent with trust the architecture already extends — ADR 0019 lets setup
codes transit the server in memory for the catalogue lookup.

**Still exposed, knowingly:** device metadata (`vendorId`, `productId`,
`discriminator`, names, rooms) stays plaintext so lists, search, catalogue
lookup and sync-time merging keep working. A dump reveals the inventory, not the
commissioning secrets — exactly ADR 0005 option 1's shape.

## Goals

- `payload` and `manualCode` are ciphertext at rest in IndexedDB and CouchDB.
- Zero UI change for the happy path: QR rendering, PDFs, copy buttons, export,
  import, catalogue lookup all behave as today.
- Offline-first survives: local-only projects (never synced, possibly never
  signed in) are encrypted too; reading and writing an already-unlocked project
  needs no connectivity.
- A new device, or a device that lost its keys, recovers access with no user
  ceremony beyond being signed in and online once.
- No new runtime dependencies (ADR 0013): WebCrypto in the browser, JCA on the
  server.

## Non-goals

- End-to-end encryption against the server operator.
- Encrypting metadata, project names, or whole documents (ADR 0005 option 2,
  still rejected).
- DEK rotation on membership change (decided: see "Member removal").
- A device-management UI (the data model supports one later).
- Searching encrypted fields — search already omits them on purpose
  (`domain/documents/browse.ts`).
- Migration of existing data. The product is pre-release; existing databases
  will be deleted. The `enc:v1:` prefix still exists for future format changes.

## Anti-goals

Failure even if it "works": a project creation flow that requires connectivity
where it didn't before; a new npm or Maven dependency; an escrow wrap a project
writer can *silently* corrupt (loud, detectable denial is accepted — decision
10); a plaintext secret in any log.

## Key hierarchy

| Key | Type | Lives | Protected by |
|---|---|---|---|
| KEK | 256-bit secret | `ESCROW_KEK` env var on the API host | ops (env file, backed up once) |
| Escrow key pair | RSA-3072 | `matter_manager` doc, private key wrapped | AES-256-GCM under the KEK |
| Device key pair | RSA-3072, per browser | browser IndexedDB, non-extractable | browser origin isolation; loss is recoverable via escrow |
| Project DEK | AES-256 | one wrap doc per recipient in the project DB | RSA-OAEP under each device public key and the escrow public key |
| Field ciphertext | AES-256-GCM | `payload` / `manualCode` on device docs | the project DEK |

## Decisions taken (who decided in brackets)

1. **Encrypt local-only projects too** [owner]. Same data-layer seam; the DEK is
   wrapped for the own device key only, with the escrow wrap added when the
   project is promoted to the server (or at creation, when the cached escrow
   public key is available).
2. **No data migration** [owner]. Dev-mode databases are deleted; every project
   is encrypted from creation.
3. **No DEK rotation on member removal** [owner]. Removal deletes the member's
   `key:<kid>` wrap docs and updates `_security` (existing path). ADR 0003's
   honest position stands: revocation cannot recall replicated data; the remedy
   for a compromised code is a device factory reset.
4. **DEKs are generated on the device, never on the server** [owner]. Offline
   creation of local projects requires it, and one code path serves both local
   and server projects. The server only (re)wraps existing DEKs via escrow.
5. **`POST /escrow` carries the client's copy of the project document** [owner].
   The server trusts nothing in it except as a claim: it extracts the database
   identity, loads its own copy, and **compares** — a mismatch is rejected. This
   is a prove-you-hold-the-data check layered on top of (never instead of) the
   registry membership check. The posted document contains no secrets.
6. **Escrow private key lives in CouchDB, wrapped by an env KEK** [owner, on
   proposal]. Plaintext in CouchDB would defeat the feature: every at-rest
   threat that exposes project DBs exposes `matter_manager` equally. With the
   KEK indirection, a dump or backup is useless without the host's env, and the
   env alone is useless without the database.
7. **Escrow re-wrap is the only key-delivery mechanism** [proposed, follows from
   the recon]. There is no invite-by-URL flow in the product — invitations are
   server-side documents redeemed at sign-in — so there is nothing for
   owner-side wrapping to attach to. New collaborator, new device, and lost key
   are one identical flow. No user ever needs another user's public key, so no
   `GET /publickey` endpoint exists.
8. **Promote reuses the local DEK** [builder's call, recorded]. Promoting a
   local project to the server keeps today's raw local-to-local replication
   unchanged — ciphertext and the `key:*` docs copy as-is (only the `project`
   doc stays filtered out, as today). No re-encryption pass.
9. **Every project is born locally; the server only provisions.** [owner]
   `POST /projects` creates an empty project database (`_security`, validator,
   `project` doc, registry pointer) so the locally created project can
   replicate into it. There is no server-side authoring of project content, and
   the key docs are project content: the DEK is generated at local creation
   (decision 4), the wrap docs are written locally and **stay in the project
   database**, reaching the server by ordinary replication like every other
   document.
10. **Escrow-wrap integrity is validated by the server, not owned by it**
   [owner]. Two checks, both loud:
   - **At provisioning**, the client sends its escrow wrap with
     `POST /projects`; the server test-unwraps it against the actual escrow
     private key and **rejects the creation on a mismatch** (stale cached
     public key after a rotation, encoding bug, cross-platform interop error —
     all caught before the first sync). The server stores nothing from it; the
     wrap's home remains the project DB.
   - **At `POST /escrow`**, a `key:escrow` revision that fails to unwrap
     (RSA-OAEP authenticates, so garbage fails loudly) is a distinct problem
     response, never silently served.

   Residual risk, accepted knowingly: a malicious *writer* on the project can
   still vandalise `key:escrow` via a replicated conflict branch (the validator
   sees conflict branches as creates, `oldDoc = null`, so "immutable after
   create" cannot be enforced there). The effect is a detectable denial of
   recovery, never silent corruption, and the genuine wrap survives as a
   conflict revision. Builder option: on unwrap failure, `POST /escrow` scans
   the open revisions of `key:escrow` for one that unwraps and repairs the doc
   as admin — self-healing instead of a support case.

## Server side (matter-manager-backend, Quarkus)

### Escrow key lifecycle

- `ESCROW_KEK`: 32 bytes, base64, validated at startup like every other secret
  (`@ConfigMapping` + `StartupValidation`; blank is unset per `Env.present`).
  Missing KEK fails the boot when the feature is enabled; follow the existing
  `Features` gating pattern so a deployment without the variable degrades
  predictably during rollout.
- First boot with a KEK and no stored key: generate RSA-3072, write
  `escrow:keys` to `matter_manager` (shape below), keep the private key in
  memory. Later boots: read, unwrap, keep in memory. A KEK that fails to unwrap
  the stored key is a fatal startup error with a clear message — silently
  regenerating would orphan every wrap in existence. This is the opposite of
  the JWT-keys pattern (`auth/Keys.java`), which regenerates on purpose.
- `matter_manager` doc `escrow:keys`:

  ```jsonc
  {
    "_id": "escrow:keys",
    "type": "escrowKey",
    "kid": "e<first 48 bits of SPKI SHA-256, hex>",   // same derivation style as JWT kids
    "alg": "RSA-OAEP-256",
    "publicKey": "<base64 SPKI>",
    "privateKeyWrapped": { "iv": "<b64>", "ct": "<b64, AES-256-GCM under KEK>" },
    "createdAt": "<ISO>"
  }
  ```

- Native image: any static `SecureRandom` goes on
  `quarkus.native.additional-build-args` run-time init, per the backend
  CLAUDE.md rule (precedent: `OidcFlow`, `GitHubFlow`).

### Endpoints

All three go into **both copies** of `openapi.yaml` (byte-identical), with
operationIds equal to the Java method names (`OpenApiDriftTest`), added to
`ContractFixtureTest.EXPECTED`, and RFC 7807 problems for error cases.

0. **`POST /projects`** (existing) gains `escrowWrap: {kid, wrapped}` in the
   body — validation only (decision 10). The server test-unwraps it with the
   escrow private key; failure or a stale kid rejects the provisioning with a
   problem (`escrow-wrap-invalid`). Nothing from it is stored; the client
   replicates the same wrap into the new database as `key:escrow`. Required
   when the escrow feature is enabled.
1. **`GET /escrowkey`** — public, no auth. Returns `{kid, alg, publicKey}`.
   Clients cache it in `mm-local` for offline project creation.
2. **`PUT /profile/devicekeys`** — authenticated. Body `{kid, publicKey,
   label?}`. Appends to the user record's `deviceKeys` array (shape mirrors
   `passkeys` / `PasskeyCredential`), capped at 10 entries evicting the least
   recently used — the same hygiene as `refreshTokens`. Idempotent for a kid
   already present (refreshes `lastUsedAt`).
3. **`POST /escrow`** — authenticated, rate-limited per subject (new
   `Limits.escrow`). Body `{document: <the client's copy of the project doc>,
   deviceKeyId}`. Flow:
   1. Extract the project identity from the posted document; resolve the
      project. Membership check via the registry exactly as `ProjectAccess`
      does today — a stranger or unknown project gets **404**, never 403
      (existing convention).
   2. Load the server's own `project` doc from the project DB and compare the
      substantive fields (`type`, `name`, `client`, `serverDb`) against the
      posted copy. Mismatch → **409** problem `document-mismatch`. `_rev` is
      compared too when present; a stale rev is a mismatch (the client has just
      pulled, so a fresh client matches).
   3. Read `key:escrow` from the project DB and unwrap the DEK with the escrow
      private key. A missing wrap doc and a wrap that fails to unwrap are each
      a distinct problem response, not a 500 (decision 10; see the builder
      option there for self-healing from conflict revisions).
   4. Look up `deviceKeyId` in the **caller's own** user record `deviceKeys` —
      a kid not registered to the caller is **400**.
   5. Wrap the DEK with that device public key, write `key:<kid>` to the
      project DB as admin (idempotent: an existing identical wrap is a no-op
      204).
   6. Write an audit entry to the project DB (immutable per the existing
      validator rule): `{type:'audit', action:'escrow-rewrap', sub, kid, at}`.
      No key material in the entry, no key material in any log at any level.
   7. Return **204**.

### Member removal

`PUT /projects/{id}/members` removing a participant also deletes every
`key:<kid>` doc whose kid belongs to that user's registered device keys, in the
same operation that rewrites `_security`. Admin deletes bypass the validator.

This cleanup is **best-effort by design**: a kid evicted from the user record's
capped `deviceKeys` list can no longer be matched to its wrap docs, which then
linger. Accepted knowingly — the lingering wrap is only decryptable by a device
that already held the DEK, and ADR 0003 already concedes that replicated data
cannot be recalled. Eviction stays a list trim, never a fan-out over project
databases.

## CouchDB validator change (`infra/couchdb/access.js`)

New rule for ids matching `key:*` in project databases: **writers may create,
only the server admin may update or delete.** Wrap docs arrive by replication
from the creating client (decision 9), so creation must stay open to writers;
the update/delete lock stops casual or buggy overwrites.

Per lesson L2, extend `infra/couchdb/verify-access-model.sh` (runs in CI) with
assertions *before* building on the rule: writer can create `key:x`; writer
cannot update or delete it; reader can read it; admin can update and delete.
Add one more probe that **pins the known limitation**: a writer pushing a
conflicting revision via `new_edits=false` is currently accepted (the validator
sees `oldDoc = null`), which is why decision 10's loud unwrap-failure exists.
Pinning it in CI means a CouchDB upgrade that changes this behaviour — in
either direction — is noticed, not discovered in production.

## Wrap documents (in each project DB)

```jsonc
// _id: "key:escrow"            — the DEK wrapped for the escrow public key
// _id: "key:<device kid>"      — the DEK wrapped for one device key
// Written by the creating client (or by the server, for escrow re-wraps),
// present in every project DB, local and server alike; they replicate like
// any other document.
{
  "type": "projectKey",
  "kid": "<recipient kid>",          // escrow kid or device kid
  "alg": "RSA-OAEP-256",
  "wrapped": "<base64: DEK wrapped with recipient public key>",
  "createdAt": "<ISO>"
}
```

One doc per wrap: add-only, replication-conflict-free in normal operation,
revocation is a delete. These ids sort outside the
`device:` ranges used by `domain/documents/ids.ts`, so existing `_all_docs`
range reads never see them; `repository.list` is unaffected. Export excludes
`key:*` docs (exports are plaintext; the wraps are meaningless outside their
database).

## Client side (frontend)

### Device key

- On startup (`ui/main.ts` vicinity, before DBs are needed): ensure a
  non-extractable RSA-OAEP-3072/SHA-256 key pair exists in a small dedicated
  IndexedDB store (`mm-keys`, raw IndexedDB — PouchDB cannot hold a `CryptoKey`;
  structured clone in IDB can). kid = SPKI-SHA-256-prefix, computed once and
  stored beside the pair.
- `mm-keys` **survives sign-out** [builder's call, recorded]: the key is a
  property of the browser profile, not the account; losing it is always
  recoverable via escrow, but keeping it avoids an escrow round trip and a new
  registration on every sign-in. `removeLocalDatabases` keeps not touching it.
- When signed in and online: ensure the public key is registered
  (`PUT /profile/devicekeys`) and the escrow public key is cached in `mm-local`
  — both fit the existing startup sequence around `startSyncing()`
  (`app-shell.ts`).

### Project keys

- **Creation** is always local (decision 9): generate an AES-256-GCM DEK on
  the device, write `key:<own kid>`, and write `key:escrow` whenever the
  cached escrow public key is available.
- **Going to the server** (promote / first sync): the escrow wrap is a hard
  requirement at this boundary, not at creation. Before calling
  `POST /projects` the client ensures `key:escrow` exists (creating it now
  from the cached public key if the project was born offline — the validator
  permits creates) and sends it for validation (decision 10). Provisioning is
  online by definition (ADR 0003), so the public key is always obtainable at
  this moment; if the server has the feature off (`GET /escrowkey` 404),
  provisioning fails with a clear problem — deploy the backend first (see
  rollout). A project already on the server is thus never without a validated
  escrow wrap.
- **Unlock**: on opening a project, read `key:<own kid>`, RSA-OAEP-decrypt with
  the device private key, import as a non-extractable AES-GCM `CryptoKey`, hold
  in memory keyed by database name (the same memoisation style as
  `project-database.ts` handles).
- **Missing wrap** (new device, lost `mm-keys`): if signed in and online, call
  `POST /escrow` with the just-pulled `project` doc and own kid, then pull and
  unlock — invisible to the user. Until the DEK is available the project is
  **locked**, a typed state with a strict contract (below).

### Locked projects: the data-layer contract

A project handle is either *unlocked* (DEK in memory) or *locked* (encrypted,
no wrap for this device yet). Locked is transient when online — escrow resolves
it without ceremony — and persists only for a new device that is offline. The
contract exists because "each consumer defends itself against ciphertext" is
how secrets end up in a lookup request or a plaintext archive:

- **Reads**: repository `get`/`list` never surface `enc:v1:` strings to
  consumers. On a locked project the two fields come back absent, and the
  returned docs are marked locked (exact typing is the builder's).
- **Writes**: the project is **read-only while locked**. `save`, device
  creation, the rooms rename (which rewrites device docs) and conflict-merge
  writes are all refused — there is no DEK to encrypt with, and writing a doc
  whose decrypted read dropped the ciphertext would destroy the stored secret.
- **Catalogue backfill skips locked projects entirely.** This is load-bearing:
  backfill sends `payload ?? manualCode` to the lookup API, and a failed lookup
  writes `catalogSource: 'unusable'` onto the device permanently. Running it in
  the window before escrow completes would brick lookups with ciphertext.
- **Export is refused while locked** with a clear message — the archive format
  is plaintext, and an archive of ciphertext would fail its own import
  validation.
- **Encrypt is prefix-aware too**: the cipher never double-encrypts a value
  already carrying the `enc:v1:` prefix; it treats that as a programming error
  (throw), since the read contract above means application code can never
  legitimately hold ciphertext.
- QR and manual-code surfaces show a calm "available after next sync" state —
  the one deliberate UI touch in this feature.

### The encryption seam

`data/repository.ts` is the seam — every device read/write already flows
through `put()` and `resolve()`:

- `save`/`saveKeepingUpdatedAt`: encrypt `payload` and `manualCode` before
  `put()`.
- `get`/`list`: decrypt after `resolve()`.
- `data/` stays PouchDB-free and dependency-free: the repository takes an
  injected cipher (encrypt/decrypt pair bound to the project DEK), wired in
  `ui/db/project-database.ts` where repositories are constructed.

Field format: `enc:v1:<base64(iv ‖ ciphertext‖tag)>` with AAD
`"<docId>:<fieldName>"`, binding a ciphertext to its document and field so
values cannot be transplanted. A value without the prefix passes through
untouched (format-versioning headroom, not a migration mechanism).

Paths that bypass the repositories, checked against this design:

- `data/conflicts.ts` merge: operates on stored docs; `mergeDevice` spreads
  `{...latest}` and never inspects the two fields, so ciphertext rides through
  as an opaque atom. The builder verifies this with a test, not by reading.
- Promote (`ui/project-actions.ts`): raw replication unchanged; adds the two
  wrap docs on the server DB (decision 8).
- `ui/tokens.ts`, `local-cache.ts`: no device docs, untouched.

### Flows that keep working unchanged

- QR + manual code display, enlarged QR, copy button (`ui/views/device.ts`) —
  read through repositories, see plaintext.
- PDFs (`ui/pdf/labels.ts`, `inventory.ts`) — client-side (ADR 0007), read
  decrypted docs.
- Catalogue lookup and backfill (ADR 0019) — `catalog-backfill.ts` reads
  through the repository; `add-device.ts` sends the not-yet-saved form value.
- Export: `devices.list()` decrypts; archives stay plaintext by design (the
  backup of last resort, and the import validator re-derives and checks codes).
- Import: rebuilds via `planNewDevice` → `save`, so re-encryption is free.
- Search: already omits both fields.

## Cryptography (builder's calls, recorded; test vectors are mandatory)

- Fields: AES-256-GCM, fresh 96-bit random IV per encryption, AAD as above.
- Wrapping: RSA-OAEP with SHA-256 for **both** the hash and MGF1. Known trap:
  Java's `"RSA/ECB/OAEPWithSHA-256AndMGF1Padding"` defaults MGF1 to SHA-1 in
  some providers while WebCrypto uses SHA-256 — the Java side must pass an
  explicit `OAEPParameterSpec`. RSA over ECDH because both runtimes have it
  natively as a single-shot operation; ECDH would mean hand-rolling HKDF on
  both sides with zero dependencies allowed.
- Per lesson L1: fixed cross-platform test vectors, committed in both repos —
  ciphertext produced by WebCrypto must decrypt under JCA and vice versa, for
  both the field cipher and the wrap. Each vector corroborated by an
  independent implementation before a test asserts it.

## Documentation obligations

- New ADR amending ADR 0005 (and recording the escrow trust decision).
- `DATA-MODEL.md`: `key:*` docs, `escrow:keys`, `deviceKeys` on the user
  record, the `enc:v1:` field format.
- `SECURITY.md` / SECURITY-MODEL contributor rules: the escrow private key and
  DEKs never appear in logs; `ESCROW_KEK` handling; the KEK is backed up once,
  out of band.
- Backend `README.md` env-var table: `ESCROW_KEK`.

## Left to the builder

- Exact problem-type names and the error catalogue for the three endpoints,
  following the existing `Problem` conventions.
- `mm-keys` IndexedDB schema details and the WebCrypto module's home
  (`domain/crypto/` suggested, mirroring `domain/matter/`).
- Whether the unlocked DEK is additionally cached in `mm-keys` across page
  loads or re-unwrapped per session (either is acceptable).
- The exact typing of the locked read state and the visual form of the
  "available after next sync" affordance (the contract above is fixed; its
  rendering is not).
- Test strategy details beyond the mandated vectors and validator assertions:
  `FakeCouch` behaviour for the new docs, route tests asserting no key material
  in logs (the ADR 0019 log-capture test is the template).

## Rollout

Backend first, with `ESCROW_KEK` set, so `GET /escrowkey` and the
`POST /projects` wrap validation exist before any client needs them. Then the
frontend. Taking a project to the server hard-requires a validated escrow wrap
(see "Going to the server"); since existing dev databases are deleted rather
than migrated, no mixed plaintext/ciphertext state ever exists on the server.
