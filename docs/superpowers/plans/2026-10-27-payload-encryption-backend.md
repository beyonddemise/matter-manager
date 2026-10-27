# Payload Encryption — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Quarkus backend holds the escrow key (KEK-wrapped in CouchDB), validates escrow wraps at project provisioning, and re-wraps project DEKs for entitled devices on demand.

**Architecture:** A new `app/escrow/` package owns the escrow key lifecycle and the re-wrap service; `app/crypto/` holds pure JCA primitives shared by both. Endpoints follow the existing resource→service split (ArchUnit-enforced), the OpenAPI contract (operationId = Java method name), and the Features gating pattern: everything is off without `ESCROW_KEK`.

**Tech Stack:** Java (Quarkus 4, native image), JCA only — no new dependencies. CouchDB via the existing `CouchClient`.

**Spec:** `docs/superpowers/specs/2026-10-27-payload-encryption-design.md` (in the `matter-manager` repo — read it first; this plan argues from it).

## Global Constraints

- No new Maven dependencies; JCA only.
- Every new resource method's name equals its operationId; `openapi.yaml` is edited in **both** repos, byte-identical (`cmp` must pass); `ContractFixtureTest.EXPECTED` gains every new operationId.
- `api` package never depends on `couchdb`; constructor injection only; resources delegate to services (ArchUnit).
- Any class holding a static `SecureRandom` goes on `quarkus.native.additional-build-args` run-time init.
- No key material, wrap, DEK, payload or manual code in any log at any level; errors never echo them.
- Errors are RFC 7807 problems via the existing `Problem`/`ProblemException` machinery.
- Full gate: `mvn clean verify` (clean, per lesson "build checks that pass falsely"), zero warnings.

## Review Focus

1. A malformed `ESCROW_KEK` (wrong length, bad base64) or one that fails to unwrap the stored key must be a **fatal startup error naming the variable** — never a silent regeneration. → test in Task 3.
2. `POST /escrow` with a `deviceKeyId` registered to a *different* user must be refused — the server must never wrap a DEK for a key the caller doesn't own. → test in Task 7.
3. A `key:escrow` doc whose `wrapped` is garbage must produce the `escrow-wrap-invalid` problem, not a 500 and not a log line containing the bytes. → test in Task 7.
4. A conflicting `key:*` revision pushed with `new_edits=false` is accepted by CouchDB today; the verify script must **pin** this so an upgrade changing it is noticed. → assertion in Task 2.
5. `POST /projects` with a valid-looking wrap made with a *stale* escrow public key (old kid) must reject provisioning with `escrow-wrap-invalid`, so no project lands on the server unrecoverable. → test in Task 6.

---

### Task 1: JCA crypto primitives and shared test vectors

**Files:**
- Create: `src/main/java/io/mattermanager/app/crypto/Envelope.java`
- Create: `src/test/java/io/mattermanager/app/crypto/EnvelopeTest.java`
- Create: `src/test/resources/crypto-vectors.json` (byte-identical copy of the frontend's `frontend/src/domain/crypto/vectors.json`; frontend Task 2 generates it — coordinate: whichever lands first generates, the other copies)

**Interfaces:**
- Produces (all static on `Envelope`):
  - `byte[] wrapDek(byte[] dek, PublicKey recipient)` — RSA-OAEP, SHA-256 for hash **and** MGF1 via explicit `OAEPParameterSpec` (the JDK default MGF1 digest is the known interop trap).
  - `byte[] unwrapDek(byte[] wrapped, PrivateKey key)`
  - `byte[] gcmSeal(byte[] plain, SecretKey key, byte[] iv, byte[] aad)` → ciphertext including tag; `byte[] gcmOpen(byte[] sealed, SecretKey key, byte[] iv, byte[] aad)`
  - `String kid(byte[] spki)` — first 48 bits of SHA-256(SPKI) in lowercase hex (12 chars), same derivation style as `auth/Keys.java`.

- [ ] **Step 1: Write the failing vector tests** in `EnvelopeTest`: `wrapVectorRoundTrips` (unwrap the vector's `wrapped` with the vector RSA private key → equals vector `dek`), `gcmVectorOpens` (open vector ciphertext with vector key/iv/aad → vector plaintext), `gcmRejectsWrongAad` (expect `AEADBadTagException`), `kidMatchesVector`. Per lesson L1, the vectors file must already exist and be corroborated by the frontend's WebCrypto implementation — two independent implementations agreeing is the anchor. If the frontend task hasn't produced it yet, generate it with a throwaway Node WebCrypto script and verify here.
- [ ] **Step 2: Run** `mvn -q test -Dtest=EnvelopeTest` — expect FAIL (class missing).
- [ ] **Step 3: Implement `Envelope`.** OAEP: `Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding")` **plus** `new OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSpecified.DEFAULT)`.
- [ ] **Step 4: Run** `mvn -q test -Dtest=EnvelopeTest` — expect PASS.
- [ ] **Step 5: Commit** `feat(crypto): JCA envelope primitives with cross-platform vectors`

### Task 2: Validator rule for `key:*` docs, pinned in the access-model script

**Files:**
- Modify: `infra/couchdb/access.js`
- Modify: `infra/couchdb/verify-access-model.sh`

**Interfaces:**
- Produces: validator behaviour later tasks rely on — writers may **create** docs whose `_id` starts with `key:`, only admins may update or delete them; readers can read them.

- [ ] **Step 1: Add assertions to `verify-access-model.sh`** (it runs against a real CouchDB; follow its existing assertion style): writer creates `key:x` → pass; writer updates `key:x` → rejected; writer deletes `key:x` → rejected; reader reads `key:x` → pass; admin updates and deletes → pass; **pin the limitation**: writer PUTs a conflicting revision of `key:x` with `?new_edits=false` → currently **accepted** (assert acceptance, with a comment pointing at the design's decision 10: loud unwrap failure is the mitigation, and this pin exists so a CouchDB upgrade changing the behaviour in either direction is noticed).
- [ ] **Step 2: Run the script against the dev CouchDB** — expect the new `key:*` assertions to FAIL (no rule yet) and the `new_edits=false` pin to pass.
- [ ] **Step 3: Add the rule to `access.js`**: ids matching `^key:` — create allowed for writers, update/delete admin-only (same structural style as the existing `project`-doc and audit rules).
- [ ] **Step 4: Re-run the script** — all assertions pass. Reinstall the design doc in dev (`CouchBootstrap`/`installDesign` path picks it up for new DBs; existing dev DBs are deleted per the spec's no-migration decision).
- [ ] **Step 5: Commit** `feat(couchdb): key:* wrap docs are create-only for writers`

### Task 3: Escrow key lifecycle (`ESCROW_KEK`, `escrow:keys` doc, feature gate)

**Files:**
- Create: `src/main/java/io/mattermanager/app/escrow/EscrowConfig.java` (`@ConfigMapping(prefix="escrow")`, `Optional<String> kek()` ← `ESCROW_KEK`)
- Create: `src/main/java/io/mattermanager/app/escrow/EscrowKeys.java` (`@Startup @ApplicationScoped`)
- Modify: `app/config/ConfigValidator.java` / `StartupValidation.java` (KEK present ⇒ must decode to exactly 32 bytes), `app/config/Features.java` (feature `escrow` ⇔ KEK present), `README.md` env table (`ESCROW_KEK`)
- Test: `src/test/java/io/mattermanager/app/escrow/EscrowKeysTest.java` (uses `FakeCouch`)

**Interfaces:**
- Consumes: `Envelope` (Task 1), `CouchClient` (`getDoc`/`putDoc` on `matter_manager`).
- Produces on `EscrowKeys`: `boolean enabled()`, `String kid()`, `String publicKeySpki()` (base64), `byte[] unwrapDek(byte[] wrapped)`, `byte[] wrapDek(byte[] dek, byte[] recipientSpki)`.
- Doc written: `matter_manager/escrow:keys` exactly as the spec's shape (`type:"escrowKey"`, `kid`, `alg:"RSA-OAEP-256"`, `publicKey`, `privateKeyWrapped:{iv,ct}`, `createdAt`).

- [ ] **Step 1: Write failing tests**: `generatesAndStoresOnFirstBoot` (empty FakeCouch → after init, doc exists with all spec fields, `unwrapDek(wrapDek(dek, publicKey))` round-trips); `loadsExistingKeyOnLaterBoot` (pre-seeded doc → same kid, no new doc revision); `wrongKekIsFatal` (doc seeded under KEK A, boot with KEK B → startup exception whose message contains `ESCROW_KEK` and no key bytes); `disabledWithoutKek` (`enabled()` false, no doc written).
- [ ] **Step 2: Run** `mvn -q test -Dtest=EscrowKeysTest` — FAIL.
- [ ] **Step 3: Implement.** RSA-3072 via `KeyPairGenerator`; private key PKCS#8 sealed with `Envelope.gcmSeal` under the KEK (fresh 12-byte IV, AAD = the doc `_id`). Opposite of `auth/Keys.java`: load-or-create, **never** regenerate over an existing doc. `SecureRandom` handling per the native-image rule.
- [ ] **Step 4: Run** `mvn -q test -Dtest=EscrowKeysTest` — PASS. Also `mvn -q test -Dtest=ConfigValidatorTest` (or the existing config-test class) for the 32-byte rule.
- [ ] **Step 5: Commit** `feat(escrow): KEK-wrapped escrow key pair, load-or-create at startup`

### Task 4: `GET /escrowkey`

**Files:**
- Create: `src/main/java/io/mattermanager/app/api/EscrowResource.java` (path `/escrowkey` for this op; delegates to `EscrowKeys`)
- Modify: `src/main/resources/openapi.yaml` (+ the frontend repo's copy, byte-identical), `ContractFixtureTest.EXPECTED`, `FeatureGateFilter`/`Features` wiring
- Test: `src/test/java/io/mattermanager/app/api/EscrowResourceTest.java`

**Interfaces:**
- Produces: `getEscrowKey()` → 200 `{kid, alg, publicKey}`, public (no auth). Feature off → the route group is hidden (404), matching how other gated features behave.

- [ ] **Step 1: Contract first**: add the path + schema + operationId `getEscrowKey` to both `openapi.yaml` copies.
- [ ] **Step 2: Write failing tests**: `escrowKeyIsPublic` (no bearer → 200, body validates against the contract via `ContractValidationFilter`, `publicKey` equals `EscrowKeys.publicKeySpki()`); `hiddenWhenDisabled` (no KEK → 404).
- [ ] **Step 3: Run** — FAIL. Implement resource. Run — PASS, and `mvn -q test -Dtest=OpenApiDriftTest,ContractFixtureTest` PASS.
- [ ] **Step 4: Commit** `feat(escrow): public escrow key endpoint`

### Task 5: Device keys on the user record + `PUT /profile/devicekeys`

**Files:**
- Modify: `app/users/UserRecord.java` (new `deviceKeys` list + `withDeviceKey`), `app/users/UserRecords.java` (serde), `app/api/ProfileResource.java`, both `openapi.yaml` copies, `ContractFixtureTest`
- Create: `src/main/java/io/mattermanager/app/users/DeviceKey.java` — `record DeviceKey(String kid, String publicKey, String label, Instant createdAt, Instant lastUsedAt)`
- Test: extend the existing user-record and profile resource test classes

**Interfaces:**
- Produces: `registerDeviceKey` (operationId), `PUT /profile/devicekeys`, `@Authenticated`, body `{kid, publicKey, label?}` → 204. `UserRecord.withDeviceKey(DeviceKey)`: appends; same kid refreshes `lastUsedAt` idempotently; list capped at **10**, evicting least-recently-used. Task 7 reads `deviceKeys` to resolve the caller's public key; Task 8 reads it to find kids to clean up.

- [ ] **Step 1: Write failing record tests**: `addsDeviceKey`, `sameKidRefreshesNotDuplicates`, `capsAtTenEvictingLru` (add 11, assert the stalest kid gone — mirror the `refreshTokens`/`passkeys` test style).
- [ ] **Step 2: Contract + failing resource test**: `registerDeviceKeyStoresOnRecord` (PUT → 204, record contains kid), validated by `ContractValidationFilter`.
- [ ] **Step 3: Implement; run the three test classes + drift/fixture tests** — PASS.
- [ ] **Step 4: Commit** `feat(escrow): per-device public keys on the user record`

### Task 6: `POST /projects` validates the escrow wrap

**Files:**
- Modify: `app/api/ProjectsResource.java` (body DTO), `app/projects/Provisioner.java`, both `openapi.yaml` copies (request schema gains optional `escrowWrap: {kid, wrapped}`)
- Create: `src/main/java/io/mattermanager/app/escrow/EscrowService.java` (also used by Task 7)
- Test: extend the projects resource/provisioner tests

**Interfaces:**
- Consumes: `EscrowKeys` (Task 3).
- Produces: `EscrowService.validateWrap(String kid, String wrappedB64)` → throws `ProblemException` `escrow-wrap-invalid` (422) when the kid isn't the current escrow kid or `Envelope.unwrapDek` fails; returns the DEK bytes on success (caller discards — validation only, nothing stored; the wrap's home is the project DB, spec decision 10).
- Behaviour: feature on ⇒ `escrowWrap` **required** (missing → 422 `escrow-wrap-required`), validated before any database is created (so rejection needs no rollback). Feature off ⇒ field ignored, legacy behaviour.

- [ ] **Step 1: Write failing tests**: `provisioningRejectsMissingWrapWhenEscrowOn`, `provisioningRejectsWrapForStaleKid`, `provisioningRejectsGarbageWrap` (valid kid, random bytes), `provisioningAcceptsValidWrap` (wrap made with `EscrowKeys.publicKeySpki()` → 201 and the DB exists), `provisioningIgnoresWrapWhenEscrowOff`.
- [ ] **Step 2: Run — FAIL. Update contract (both copies), implement, run resource tests + drift/fixture** — PASS.
- [ ] **Step 3: Commit** `feat(escrow): provisioning validates the escrow wrap before creating a project db`

### Task 7: `POST /escrow` — re-wrap for an entitled device

**Files:**
- Modify: `app/api/EscrowResource.java`, `app/escrow/EscrowService.java`, both `openapi.yaml` copies, `ContractFixtureTest`, the rate-limit config (`Limits` + its config mapping)
- Test: `EscrowResourceTest` + a log-capture test modelled on the ADR 0019 one

**Interfaces:**
- Consumes: `EscrowKeys`, `Envelope`, `CouchClient`, `ProjectRegistry` (membership via the pointer, 404-for-strangers convention of `ProjectAccess`), `UserRecords.findBySub` (device keys, Task 5).
- Produces: `rewrapProjectKey` (operationId), `POST /escrow`, `@Authenticated`, rate-limited per subject (`Limits.escrow`). Body `{document: <client's project doc>, deviceKeyId}`.
- Flow (spec, endpoint 3): project id from the posted doc's `serverDb` (`project_<uuid>`) → membership else **404** → compare server's `project` doc fields `type,name,client,serverDb` (+ `_rev` when posted) else **409 `document-mismatch`** → read `key:escrow` (missing → **422 `escrow-wrap-missing`**; unwrap fails → **422 `escrow-wrap-invalid`**) → caller's `deviceKeys` must contain `deviceKeyId` else **400 `unknown-device-key`** → wrap for that key, `putDoc` `key:<kid>` as admin (existing identical wrap → no-op) → append audit doc `{type:'audit', action:'escrow-rewrap', sub, kid, at}` → **204**.

- [ ] **Step 1: Contract first** (both copies, operationId `rewrapProjectKey`), then failing tests, one per flow outcome above (seven), plus `rewrapIsIdempotent` (second call → 204, still exactly one `key:<kid>` doc) and `rewrapRefusesForeignDeviceKey` (kid registered to another user → 400) — that last one is Review Focus 2.
- [ ] **Step 2: Log-capture test** `escrowLogsNoKeyMaterial`: run a success and each failure, capture service logs, assert neither the wrap bytes, the DEK, nor `publicKey` values appear (template: the ADR 0019 route test).
- [ ] **Step 3: Run — FAIL. Implement service + resource.** Run all escrow tests + drift/fixture — PASS.
- [ ] **Step 4: Run** `mvn clean verify` — PASS, zero warnings.
- [ ] **Step 5: Commit** `feat(escrow): rewrap endpoint with document comparison and audit`

### Task 8: Member removal deletes the member's wrap docs

**Files:**
- Modify: the members-update path in `app/projects/` (service behind `PUT /projects/{id}/members`)
- Test: extend the existing members tests

**Interfaces:**
- Consumes: `UserRecords.findBySub(...).deviceKeys` (Task 5), `CouchClient.deleteDoc`.

- [ ] **Step 1: Write failing test** `removalDeletesWrapDocs`: project with `key:<kidA>` for the removed user and `key:<kidB>` for another member → after removal, `key:<kidA>` gone, `key:<kidB>` and `key:escrow` intact. And `removalSurvivesEvictedKid`: removed user's record lists no kids → removal still succeeds (cleanup is best-effort by design — spec "Member removal").
- [ ] **Step 2: Run — FAIL. Implement (admin deletes bypass the validator). Run — PASS.**
- [ ] **Step 3: Run** `mvn clean verify` — PASS. **Commit** `feat(escrow): drop wrap docs when a member is removed`
