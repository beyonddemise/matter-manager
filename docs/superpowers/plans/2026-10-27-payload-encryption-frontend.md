# Payload Encryption — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `payload` and `manualCode` are AES-GCM ciphertext at rest in IndexedDB and CouchDB, encrypted/decrypted at the repository seam, with per-device RSA key pairs and transparent escrow recovery.

**Architecture:** A pure WebCrypto module in `domain/crypto/` (mirrors `domain/matter/` in style); a per-browser device key in a tiny raw-IndexedDB store `mm-keys`; per-project DEKs delivered as `key:*` wrap docs inside each project database; a `FieldCipher` injected into `data/repository.ts` so every consumer above the seam only ever sees plaintext or a typed locked state.

**Tech Stack:** TypeScript, Lit, PouchDB (existing). WebCrypto + raw IndexedDB only — no new dependencies (ADR 0013).

**Spec:** `docs/superpowers/specs/2026-10-27-payload-encryption-design.md` — read it first; this plan argues from it.

## Global Constraints

- No new npm dependencies (`dependency-policy.json` stays untouched).
- `data/` never imports PouchDB and stays framework-free; crypto lives in `domain/`, wiring in `ui/`.
- Field format exactly `enc:v1:<base64(iv ‖ ciphertext‖tag)>`; AAD exactly `"<docId>:<fieldName>"`; encrypted fields are exactly `payload` and `manualCode`.
- Never log, cache, or echo a plaintext code, a DEK, or a wrap outside the paths the spec names.
- Any UI-touching task: the implementer loads the `webawesome-design` and `webawesome` skills first (project CLAUDE.md rule); new user-facing strings go through lit-localize (`npm run i18n`).
- `openapi.yaml` stays byte-identical with the backend repo's copy.
- Full gate from `frontend/`: `npm ci && npm run verify` — zero warnings (lesson: "zero warnings" is the passing condition).
- Test commands: `npx vitest run <file>` from `frontend/`.

## Review Focus

1. Catalogue backfill against a locked project must not stamp `catalogSource: 'unusable'` — a transient key gap must never permanently disable lookups. → test in Task 6.
2. A conflict merge of two revisions of an encrypted device must carry ciphertext through unchanged (opaque atom) and still decrypt afterwards. → test in Task 5.
3. Export→import round trip: export of an **unlocked** project yields plaintext codes that re-import and re-encrypt; export of a **locked** project is refused, never a ciphertext archive. → tests in Task 6.
4. Sign-out (`removeLocalDatabases`) must not delete the device key — otherwise every sign-in triggers escrow and registration churn. → test in Task 3.
5. `decryptField` on a value without the `enc:` prefix passes it through; `encryptField` on a value **with** the prefix throws — double encryption is a programming error that must fail loudly, not corrupt data. → tests in Task 2.

---

### Task 1: Mirror the OpenAPI contract

**Files:**
- Modify: `openapi.yaml` (repo root) — copy the backend repo's updated file **byte-identically** once backend Tasks 4–7 have landed it (`cmp ../matter-manager-backend/src/main/resources/openapi.yaml openapi.yaml`).
- Check: whether a types-generation step still exists (`scripts/`, root `package.json`) — if it does, run it; if not, note that in the commit message.

- [ ] **Step 1: Copy, `cmp`, run `npm run verify`** (the contract is checked, not executed — ADR 0015). **Commit** `chore(contract): mirror escrow endpoints`

### Task 2: WebCrypto module with shared vectors

**Files:**
- Create: `frontend/src/domain/crypto/envelope.ts`
- Create: `frontend/src/domain/crypto/vectors.json` (the cross-platform fixture; byte-identical with backend `src/test/resources/crypto-vectors.json` — whichever repo's task lands first generates it, the other copies)
- Test: `frontend/src/domain/crypto/envelope.test.ts`

**Interfaces (produces):**
- `generateDek(): Promise<CryptoKey>` — AES-GCM 256, `extractable: true` (it must be wrappable).
- `encryptField(dek: CryptoKey, docId: string, field: string, value: string): Promise<string>` → `enc:v1:…`; **throws** on input already prefixed `enc:`.
- `decryptField(dek: CryptoKey, docId: string, field: string, stored: string): Promise<string>` — passes through values without the `enc:` prefix.
- `wrapDek(dek: CryptoKey, recipientSpkiB64: string): Promise<string>` / `unwrapDek(wrappedB64: string, privateKey: CryptoKey): Promise<CryptoKey>` — RSA-OAEP SHA-256.
- `deriveKid(spkiB64: string): Promise<string>` — first 48 bits of SHA-256(SPKI), 12 lowercase hex chars (matches the backend's `Envelope.kid`).

- [ ] **Step 1: Write failing tests**: `fieldRoundTrips`, `wrongAadFailsToDecrypt` (same dek, different docId → rejects), `plaintextPassesThrough`, `doubleEncryptThrows`, `wrapRoundTrips`, `kidMatchesVector`, and the vector assertions (encrypt/decrypt and wrap/unwrap against `vectors.json`). Vectors per lesson L1: corroborated by the backend JCA implementation before any test asserts them — generate here, hand the file to backend Task 1, and treat agreement of the two implementations as the anchor.
- [ ] **Step 2: Run** `npx vitest run src/domain/crypto/envelope.test.ts` — FAIL. Implement. Run — PASS.
- [ ] **Step 3: Commit** `feat(crypto): webcrypto envelope with cross-platform vectors`

### Task 3: Device key in `mm-keys`

**Files:**
- Create: `frontend/src/ui/db/device-key.ts`
- Modify: nothing in `removeLocalDatabases` (`ui/db/project-database.ts`) — the point is that it keeps **not** touching `mm-keys`; pin that with a test.
- Test: `frontend/src/ui/db/device-key.test.ts` (vitest env with IndexedDB; follow however existing PouchDB-touching tests provide it)

**Interfaces (produces):**
- `type DeviceKey = { kid: string; publicKeySpki: string; privateKey: CryptoKey }`
- `ensureDeviceKey(): Promise<DeviceKey>` — raw IndexedDB database `mm-keys`, object store `keys`, record id `device`; generates RSA-OAEP-3072/SHA-256 with a **non-extractable** private key on first call; idempotent afterwards (same kid).

- [ ] **Step 1: Write failing tests**: `createsOnceThenStable` (two calls → same kid), `privateKeyNotExtractable` (`privateKey.extractable === false`), `survivesSignOut` (call `removeLocalDatabases()`, then `ensureDeviceKey()` → same kid).
- [ ] **Step 2: Run — FAIL. Implement. Run — PASS. Commit** `feat(crypto): per-browser device key in mm-keys`

### Task 4: Startup wiring — register the key, cache the escrow key

**Files:**
- Create: `frontend/src/ui/escrow-client.ts`
- Modify: `frontend/src/ui/app-shell.ts` (the signed-in/online path around `startSyncing()`), `frontend/src/data/local-cache.ts` (new `cache:escrowkey` entry)
- Test: `frontend/src/ui/escrow-client.test.ts`

**Interfaces:**
- Consumes: `ensureDeviceKey()` (Task 3); the bearer-fetch style of `ui/projects.ts`.
- Produces:
  - `registerDeviceKey(): Promise<void>` — `PUT /profile/devicekeys {kid, publicKey}`; errors are logged-silent (retried next startup), never block sync.
  - `fetchEscrowKey(): Promise<EscrowKeyInfo | null>` — `GET /escrowkey`; 404 (feature off) → `null`.
  - `cachedEscrowKey(): Promise<EscrowKeyInfo | null>` from `mm-local`; `type EscrowKeyInfo = { kid: string; alg: string; publicKey: string }`.

- [ ] **Step 1: Write failing tests**: `registersOnStartupWhenOnline`, `cachesEscrowKeyForOffline` (fetch once → `cachedEscrowKey()` serves it with fetch stubbed out), `toleratesEscrowDisabled` (404 → null, no throw, nothing cached).
- [ ] **Step 2: Run — FAIL. Implement + wire into `app-shell` after the first successful `refreshed` outcome. Run — PASS. Commit** `feat(escrow): device key registration and escrow key cache`

### Task 5: Project keyring, wrap docs, and the repository cipher

**Files:**
- Create: `frontend/src/domain/documents/keys.ts` (the `projectKey` doc type + ids `key:escrow`, `key:<kid>`)
- Create: `frontend/src/ui/db/keyring.ts`
- Modify: `frontend/src/data/repository.ts`, `frontend/src/ui/db/project-database.ts` (`projectRepositories` gains the cipher), `frontend/src/ui/local-projects.ts` (creation + import write key docs)
- Test: `frontend/src/data/repository.test.ts` (extend), `frontend/src/ui/db/keyring.test.ts`

**Interfaces:**
- `data/repository.ts` (produces, consumed by every later task):
  - `type FieldCipher = { encrypt(docId: string, field: string, value: string): Promise<string>; decrypt(docId: string, field: string, value: string): Promise<string> }`
  - `type KeyState = { kind: 'unlocked'; cipher: FieldCipher } | { kind: 'locked' }`
  - `repository<T>(database, type, now, resolve, keyState?)` — omitted `keyState` = plaintext (unit tests, `mm-local`). Unlocked: encrypt `payload`/`manualCode` on `save`/`saveKeepingUpdatedAt`, decrypt on `get`/`list`. Locked: `get`/`list` return docs with the two fields **absent** and `locked: true` set (exact typing is the implementer's, per spec); `save`, `saveKeepingUpdatedAt` and `remove` throw `ProjectLockedError` (exported from `data/`).
- `ui/db/keyring.ts` (produces):
  - `unlockProject(db): Promise<CryptoKey | null>` — read `key:<own kid>`, `unwrapDek`; `null` = locked.
  - `createProjectKeys(db, escrow: EscrowKeyInfo | null): Promise<CryptoKey>` — `generateDek()`, write `key:<own kid>`, plus `key:escrow` when `escrow` given. Wrap-doc shape exactly per spec (`type:'projectKey'`, `kid`, `alg:'RSA-OAEP-256'`, `wrapped`, `createdAt`).
  - `ensureEscrowWrap(db, escrow: EscrowKeyInfo): Promise<{ kid: string; wrapped: string }>` — creates `key:escrow` if missing (needs the unlocked DEK), returns the wrap for the provisioning body (Task 8).
- `projectRepositories(db, keyState)` — `ui/db/project-database.ts` resolves the key state once per opened DB (memoised beside the existing handles) and re-resolves on the escrow recovery event (Task 7).

- [ ] **Step 1: Write failing repository tests**: `encryptsOnSaveDecryptsOnRead` (stored raw doc has `enc:v1:` prefixes; `get`/`list` return plaintext), `listDecryptsEveryDoc`, `lockedReadsOmitSecrets` (fields absent, `locked` set, **no `enc:` string anywhere in the returned object**), `lockedWritesThrow` (all three methods), `conflictMergeCarriesCiphertext` (two conflicting revisions of an encrypted doc → `resolve` + repository `get` still decrypts; pins Review Focus 2), `tombstoneStaysBare` (`remove` on unlocked writes no secret fields — existing behaviour kept).
- [ ] **Step 2: Write failing keyring tests**: `createThenUnlockRoundTrips`, `unlockWithoutWrapIsNull`, `escrowWrapWrittenWhenAvailable`, `ensureEscrowWrapIdempotent`.
- [ ] **Step 3: Run both files — FAIL. Implement.** Keep `data/` free of WebCrypto imports: the `FieldCipher` instance is built in `ui/db/` from `domain/crypto`.
- [ ] **Step 4: Wire creation**: `createLocalProject` and `importLocalProject` call `createProjectKeys` (escrow info from `cachedEscrowKey()`, null tolerated) before the first device write.
- [ ] **Step 5: Run — PASS**, then `npm run verify`. **Commit** `feat(crypto): encrypt payload and manualCode at the repository seam`

### Task 6: Gate the consumers on the locked state

**Files:**
- Modify: `frontend/src/ui/catalog-backfill.ts` (skip locked projects), `frontend/src/ui/archive/project-export.ts` (refuse locked), `frontend/src/ui/views/rooms.ts` + `frontend/src/ui/views/device-form.ts` + `frontend/src/ui/views/edit-device.ts` (surface `ProjectLockedError` as the existing problem-string pattern), `frontend/src/ui/views/device.ts` (QR + manual code: "available after next sync" state), `frontend/src/ui/i18n/problems.ts` + xliff (new strings — lesson L44: never merge-join xliff)
- Test: extend `catalog-backfill` and `project-export` test files; a view test for the locked device state

**Interfaces:**
- Consumes: `locked` docs and `ProjectLockedError` (Task 5).

- [ ] **Step 1: Write failing tests**: `backfillSkipsLockedProject` (locked → lookup fetch never called **and no `catalogSource` write happens** — pins Review Focus 1), `exportRefusesLocked` (typed error, no archive produced), `exportImportRoundTripsPlaintext` (unlocked export → archive codes are plaintext `MT:` / digits → import into a fresh encrypted project → stored docs are `enc:v1:`, read back plaintext; pins Review Focus 3).
- [ ] **Step 2: Run — FAIL. Implement the gates.**
- [ ] **Step 3: UI state** (load `webawesome-design` + `webawesome` skills first): in `device.ts`, when the doc is locked, QR pane and manual-code row render one calm localized "Available after next sync" state — reuse the existing empty/pending affordance style; no new component.
- [ ] **Step 4: `npm run i18n`, run all touched test files + `npm run verify` — PASS. Commit** `feat(crypto): locked-project gates for backfill, export and views`

### Task 7: Escrow recovery

**Files:**
- Modify: `frontend/src/ui/escrow-client.ts` (add the rewrap call), `frontend/src/ui/db/project-database.ts` (recovery hook on locked open)
- Test: extend `escrow-client.test.ts`

**Interfaces:**
- Consumes: `unlockProject` (Task 5), `cachedEscrowKey`/bearer fetch (Task 4), `pullOnce` (`ui/sync/replication.ts`).
- Produces: `recoverProjectKey(db, projectDoc): Promise<boolean>` — `POST /escrow {document: projectDoc, deviceKeyId: kid}`; 204 → `pullOnce` → `unlockProject` again → true; 4xx → false (stay locked, no retry loop; next project open retries). Wired so an `openProject` that finds the project locked and the app online + signed-in triggers recovery once, then re-resolves the key state and fires the existing `PROJECT_CHANGED`-style refresh so open views re-render unlocked.

- [ ] **Step 1: Write failing tests**: `recoversTransparently` (stubbed 204 + wrap doc appears on pull → resolves true, project unlocked), `staysLockedOn4xx` (403/409 → false, exactly one request — no loop), `offlineDoesNotCall` (no fetch when offline).
- [ ] **Step 2: Run — FAIL. Implement. Run — PASS. Commit** `feat(escrow): transparent key recovery on locked open`

### Task 8: Going to the server — provisioning wrap and promote

**Files:**
- Modify: `frontend/src/ui/projects.ts` (POST /projects body gains `escrowWrap`), `frontend/src/ui/project-actions.ts` (promote: `ensureEscrowWrap` before provisioning; replication filter unchanged)
- Test: extend the projects/promote test files

**Interfaces:**
- Consumes: `ensureEscrowWrap` (Task 5), `cachedEscrowKey`/`fetchEscrowKey` (Task 4).
- Behaviour: before `POST /projects`, ensure `key:escrow` exists in the source DB (create from the cached/fetched escrow key — provisioning is online by definition, so `fetchEscrowKey()` is the fallback when the cache is empty) and send its `{kid, wrapped}` as `escrowWrap`. `fetchEscrowKey()` returning `null` (backend feature off) → fail provisioning with a clear localized problem. Promote's local-to-local filter still excludes only the `project` doc — `key:*` docs must replicate.

- [ ] **Step 1: Write failing tests**: `provisioningSendsEscrowWrap` (body contains `{kid, wrapped}` matching the source DB's `key:escrow`), `offlineBornProjectGetsWrapAtPromote` (local DB without `key:escrow` → promote creates it first), `promoteCarriesKeyDocs` (after promote, survivor DB contains `key:escrow` and `key:<kid>`, and devices still decrypt — the DEK is reused, spec decision 8), `escrowDisabledFailsProvisioning`.
- [ ] **Step 2: Run — FAIL. Implement. Run — PASS, then `npm run verify`. Commit** `feat(escrow): validated escrow wrap travels with provisioning`

### Task 9: Documentation

**Files:**
- Create: `docs/adr/0022-field-encryption-with-key-escrow.md` (amends ADR 0005; records: threat model incl. the accepted conflict-branch denial, key hierarchy, the decisions table from the spec)
- Modify: `docs/DATA-MODEL.md` (`key:*` docs, `escrow:keys`, `deviceKeys`, `enc:v1:` format), `SECURITY.md` (ESCROW_KEK runbook: generation, out-of-band backup, fatal-on-mismatch; never log codes/keys)

- [ ] **Step 1: Write all three** (lesson L45: new sections go before the next heading — `grep -n '^#'` against main afterwards).
- [ ] **Step 2: `npm run verify` still green. Commit** `docs: ADR 0022 field encryption with key escrow`
