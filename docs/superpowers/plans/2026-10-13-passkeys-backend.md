# Passkeys (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usernameless passkey sign-in (`POST /auth/passkey/options` + `POST /auth/passkey`), passkey management and `GET /auth/sign-in-methods` for the account view, and a `passkeys` flag in `/auth/methods`.

**Architecture:** `PasskeyFlow` wraps webauthn4j (options, ceremony verification) the way `OidcFlow` wraps the Google dance; challenges ride the signed `mm_flow` carrier (`TokenFactory.mintFlow`); credentials live in a `passkeys` array on the user record (the `refreshTokens` pattern); sign-in completion answers `AuthService.TokenResponse` exactly as `EmailSignIn.verify` does. The WebAuthn `userHandle` is the canonical sub, so sign-in resolves the record through `UserRecords.findBySub` — no new view.

**Tech Stack:** Quarkus 4 (quarkus-rest, Jackson 3 `tools.jackson.*`), `com.webauthn4j:webauthn4j-core` 0.31.11.RELEASE (+ `webauthn4j-test` for the emulator, test scope), FakeCouch, JaCoCo gates (bundle ≥0.70, domain ≥0.90).

**Spec:** `/Users/stw/Code/matter-manager/docs/superpowers/specs/2026-10-13-passkeys-design.md` (as amended: Account view). **Repo:** `/Users/stw/Code/matter-manager-backend`, branch `feat/passkeys` off `main`. Frontend counterpart: `2026-10-13-passkeys-frontend.md`.

## Global Constraints

- **No challenge, credential id, label, public key or address in any log line, problem body or notice.** `SignInException`/problem codes are the only loggable failure detail.
- Every sign-in refusal is one indistinguishable 401 (`Problem.of(401, "Sign-in failed")`, the `EmailSignIn.FAILED` shape).
- `userVerification: required` on both ceremonies; attestation policy `none`; `residentKey: required` at registration; at most 10 passkeys per account; label at most 64 characters.
- Challenges: 32 random bytes, `TokenFactory.mintFlow` carrier in the `Cookies.FLOW` (`mm_flow`) cookie, claims `provider: "passkey"` plus `kind: "signin"` or `kind: "register"`; the register carrier also carries `bind: <caller's sub>`.
- `rpId` = the host of `APP_ORIGIN`; expected origin = `APP_ORIGIN` exactly.
- ArchUnit rules hold: resources constructor-inject; `@RegisterForReflection` on response records; drift law: resource method name == operationId.
- The contract in `src/main/resources/openapi.yaml` is the record; matter-manager's root copy mirrors it byte-identically (frontend plan's mirror task carries the same YAML verbatim).
- Verify bar: `./mvnw verify -DskipITs=false` green, zero warnings read from the log; **plus `scripts/native-build.sh --build-only` green before the PR** — webauthn4j's native-image reflection is this piece's proving burden, and per-PR CI does not build native.
- Commits: conventional, ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Review Focus

1. **A valid assertion whose `userHandle` names account A but whose credential id belongs to account B** must be refused (the credential must be found in the resolved record's own array) → Task 5's `refusesAnotherAccountsCredential`.
2. **A sign-in carrier presented at the registration endpoint, and vice versa** must be refused by the `kind` claim even though signature and TTL are valid → Task 5's `refusesACarrierOfTheWrongKind` and Task 6's `refusesASignInCarrierAtRegistration`.
3. **A record deleted between options and completion** (`findBySub` answers empty) must be the same 401, never an NPE → Task 5's `refusesWhenTheRecordIsGone`.
4. **A registration completion from a different session than the one that fetched options** (carrier `bind` ≠ caller's sub) must be refused → Task 6's `refusesACarrierBoundToAnotherAccount`.
5. **`/auth/methods` on a mail-only deployment** must answer `passkeys: true` (the flag needs only session prerequisites, not Google/GitHub) → Task 6's assertion in the existing mail-profile `AuthMethodsTest`.

---

### Task 1: Feature flag and route gates

**Files:**
- Modify: `src/main/java/io/mattermanager/app/config/Features.java` (add `passkeys()`, extend `session()`)
- Modify: `src/main/java/io/mattermanager/app/config/FeatureGateFilter.java` (three gate rows)
- Test: `src/test/java/io/mattermanager/app/api/PasskeyGateTest.java`

**Interfaces:**
- Produces: `Features.passkeys(): boolean`; gates `auth/passkey`, `auth/passkeys`, `auth/sign-in-methods` listed **before** `auth`.
- Consumes: the private prerequisites `Features.github()` composes (couch, access key, session key, app origin) — read that method and reuse its terms minus the GitHub config.

- [ ] **Step 1: Write the failing gate test.** A profile with no CouchDB config (`FakeCouchProfile` has couch; use the bare default test profile the existing gate tests use for "unconfigured" — read `EmailGateTest` and copy its unconfigured-profile choice):

```java
package io.mattermanager.app.api;

import static io.restassured.RestAssured.given;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;

/** Passkey routes are absent when sessions cannot be served — the EmailGateTest pattern. */
@QuarkusTest
class PasskeyGateTest {

    @Test
    void passkeyRoutesAnswer404WhenSessionsAreUnconfigured() {
        given().post("/auth/passkey/options").then().statusCode(404);
        given().post("/auth/passkey").then().statusCode(404);
        given().get("/auth/passkeys").then().statusCode(404);
        given().get("/auth/sign-in-methods").then().statusCode(404);
    }
}
```

(If the bare `@QuarkusTest` default profile configures sessions, pin whatever profile `EmailGateTest` uses for its 404 case; the assertion set stays.)

- [ ] **Step 2: Run to verify failure** — `./mvnw test -Dtest=PasskeyGateTest` — FAIL (405/401, not 404: no gate rows yet).
- [ ] **Step 3: Implement.** `Features.java`, below `github()` (same prerequisite terms, no provider config):

```java
    /** @return passkey sign-in is served (CouchDB, both keys, session key and app origin — no provider config needed) */
    public boolean passkeys() {
        return couch() && accessKey()
                && Env.present(jwt.sessionPrivateKey()).isPresent()
                && Env.present(app.origin()).isPresent();
    }
```

and `session()` becomes `return auth() || mail() || github() || passkeys();` (Javadoc unchanged in intent). `FeatureGateFilter.java`, beside the GitHub rows, before the broad `auth` row:

```java
            // Passkeys need no provider config: they are served wherever sessions can be minted at all.
            new Gate("auth/passkey", Features::passkeys),
            new Gate("auth/passkeys", Features::passkeys),
            // The account view's answer: served wherever any sign-in method exists, like auth/methods.
            new Gate("auth/sign-in-methods", Features::session),
```

- [ ] **Step 4: Run** — `./mvnw test -Dtest=PasskeyGateTest` — PASS (gated paths 404; no resources exist yet, which the gate hides).
- [ ] **Step 5: Commit** — `feat(config): passkey feature flag and route gates`

### Task 2: Passkey credentials on the user record

**Files:**
- Modify: `src/main/java/io/mattermanager/app/users/UserRecords.java`
- Create: `src/main/java/io/mattermanager/app/users/PasskeyCredential.java`
- Test: `src/test/java/io/mattermanager/app/users/UserRecordsPasskeyTest.java` (the `UserRecordsTest` FakeCouch harness — copy its seeding helpers)

**Interfaces:**
- Produces:

```java
/** One stored credential; publicKey is the COSE key, base64url. */
@RegisterForReflection
public record PasskeyCredential(String id, String publicKey, long signCount,
        List<String> transports, String label, String createdAt, String lastUsedAt) {}

// on UserRecords:
public List<PasskeyCredential> passkeys(String rawEmail)                    // [] when no record
public void addPasskey(String rawEmail, PasskeyCredential credential)      // IllegalStateException: no record; ProblemException 409 "Too many passkeys" at 10
public boolean renamePasskey(String rawEmail, String credentialId, String label)  // false: no record or no such id
public boolean removePasskey(String rawEmail, String credentialId)         // false: no record or no such id
public boolean touchPasskey(String rawEmail, String credentialId, long signCount, String lastUsedAt)  // false: no record or no such id
```

- Consumes: `couch.readModifyWrite`, `couch.getDoc`, `docId` — the `refreshTokens` array idiom verbatim (see `addRefresh`/`removeRefresh`).

- [ ] **Step 1: Write the failing tests** — seed a record as `UserRecordsTest` does, then: add → `passkeys()` answers it field-for-field; add an 11th (seed ten) → `ProblemException` 409; add with no record → `IllegalStateException`; rename changes only the label; rename/remove/touch an unknown id → false, document unchanged; remove → list shrinks, other entries intact; touch updates only `signCount` and `lastUsedAt`; unknown stored fields on the doc survive every write (assert a `"custom": true` field after add+rename+remove).
- [ ] **Step 2: Run to verify failure** — `./mvnw test -Dtest=UserRecordsPasskeyTest` — FAIL: methods missing.
- [ ] **Step 3: Implement** on `UserRecords`, mirroring `addRefresh`: read-modify-write, rebuild the `passkeys` `ArrayNode` keeping entries verbatim, append/replace/drop the one entry; `doc.remove("passkeys")` when empty; node fields exactly the record's component names. `read(...)` is NOT extended — passkeys stay doc-level, answered by these methods only (the `UserRecord` record is session/profile state and does not grow).
- [ ] **Step 4: Run** — PASS; also `./mvnw test -Dtest=UserRecordsTest` (untouched behavior).
- [ ] **Step 5: Commit** — `feat(users): passkey credentials stored on the user record`

### Task 3: PasskeyFlow — options, carriers and ceremony verification

**Files:**
- Modify: `pom.xml` (add `com.webauthn4j:webauthn4j-core` 0.31.11.RELEASE; `com.webauthn4j:webauthn4j-test` same version, scope test — if `webauthn4j-test`'s version lags, pin the newest available and say so in the commit)
- Create: `src/main/java/io/mattermanager/app/auth/PasskeyFlow.java`
- Test: `src/test/java/io/mattermanager/app/auth/PasskeyFlowTest.java`

**Interfaces:**
- Consumes: `TokenFactory.mintFlow(Map)`, `TokenVerifier.verify(jwt, Purpose.FLOW)`, `AppOrigins` (for `APP_ORIGIN`), `PasskeyCredential` (Task 2), `SignInException`.
- Produces:

```java
public record Options(String optionsJson, String carrier) {}     // what the endpoint answers + the mm_flow value
public record Registered(String id, String publicKey, long signCount, List<String> transports) {}  // verified attestation; the service adds label and timestamps to build the PasskeyCredential
public record Asserted(String userHandle, String credentialId, long signCount) {}

public Options signInOptions()
public Options registrationOptions(String bindSub, String userHandle, String email, List<PasskeyCredential> exclude)
public Registered verifyRegistration(String responseJson, String carrier, String bindSub)   // SignInException on everything
public Asserted verifyAssertion(String responseJson, String carrier, PasskeyLookup lookup)  // SignInException on everything
public interface PasskeyLookup { Optional<PasskeyCredential> find(String userHandle, String credentialId); }
```

- [ ] **Step 1: Write the failing tests** using the webauthn4j-test emulator (`com.webauthn4j.test.EmulatorUtil`, `com.webauthn4j.test.client.ClientPlatform`) — the Spring-world pattern: create a `ClientPlatform` against the flow's own options, produce a registration response JSON, feed it to `verifyRegistration`; then produce an assertion for the stored credential and feed `verifyAssertion`. Tests: round-trip registration → `Registered` carries the credential id and COSE key, `signCount` ≥ 0; assertion → `Asserted` with the minted userHandle and bumped signCount; a sign-in carrier at `verifyRegistration` (and a register carrier at `verifyAssertion`) → `SignInException`; a tampered challenge (mint options twice, present response built against the first with the second's carrier) → `SignInException`; `lookup` answering empty → `SignInException`. *(If the emulator's class names moved in 0.31.x, rule on the nearest equivalent from `webauthn4j-test`'s current API and ledger it; the test intent is fixed.)*
- [ ] **Step 2: Run to verify failure** — class missing.
- [ ] **Step 3: Implement.** `@ApplicationScoped`; `WebAuthnManager.createNonStrictWebAuthnManager()` held in a field (attestation `none` needs no trust anchors); a `SecureRandom` as an **instance** field — **never static: v0.3.0 failed its native build on exactly that** — and `io.mattermanager.app.auth.PasskeyFlow` added to `quarkus.native.additional-build-args` `--initialize-at-run-time` list in `application.properties` beside `OidcFlow` and `GitHubFlow` anyway (belt and braces; the comment there explains why). Options are built as Jackson 3 `ObjectNode`s (this class owns its JSON shape; webauthn4j's Jackson 2 stays internal to parsing responses): sign-in options `{challenge, rpId, userVerification: "required", timeout: 300000}`; registration options `{challenge, rp: {id, name: "Matter Manager"}, user: {id: base64url(userHandle), name: email, displayName: email}, pubKeyCredParams: [{type:"public-key", alg:-7},{type:"public-key", alg:-257}], authenticatorSelection: {residentKey: "required", userVerification: "required"}, attestation: "none", excludeCredentials: [...]}`. Carriers: `tokens.mintFlow(Map.of("provider","passkey","kind",..., "challenge", b64url, "bind", sub?))`; verification: `verifier.verify(carrier, Purpose.FLOW)` then claim checks (one `SignInException(STATE)` for every carrier failure), then `webAuthnManager.parseRegistrationResponseJSON`/`parseAuthenticationResponseJSON` + `verify(...)` with `ServerProperty(new Origin(appOrigin), rpId, new DefaultChallenge(challengeBytes), null)`; registration parameters `userVerificationRequired=true`; assertion parameters likewise with the stored credential rebuilt via `CredentialRecordImpl`/the COSE key bytes; every `DataConversionException`/`VerificationException` becomes `SignInException(VERIFICATION)` with a fixed message. `rpId` = `URI.create(appOrigin).getHost()`.
- [ ] **Step 4: Run** — `./mvnw test -Dtest=PasskeyFlowTest` — PASS.
- [ ] **Step 5: Commit** — `feat(auth): PasskeyFlow — WebAuthn options, carriers and ceremony verification`

### Task 4: Contract — seven operations, three schema changes

**Files:**
- Modify: `src/main/resources/openapi.yaml`
- Modify: `src/test/java/io/mattermanager/app/ContractFixtureTest.java` (EXPECTED set)

- [ ] **Step 1: Extend EXPECTED** by `"startPasskeySignIn", "completePasskeySignIn", "getSignInMethods", "startPasskeyRegistration", "createPasskey", "renamePasskey", "deletePasskey"`; run `./mvnw test -Dtest='ContractFixtureTest,OpenApiDriftTest'` — FAIL.
- [ ] **Step 2: Add to the contract.** After the `/auth/github/callback` block:

```yaml
  /auth/passkey/options:
    post:
      operationId: startPasskeySignIn
      tags: [auth]
      summary: Begin passkey sign-in
      description: |
        Answers WebAuthn request options (usernameless: no allowCredentials) and sets the
        challenge carrier cookie. The ceremony's result goes to `POST /auth/passkey`.
      security: []
      responses:
        '200':
          description: WebAuthn request options (Level 3 JSON)
          content:
            application/json:
              schema: { type: object }

  /auth/passkey:
    post:
      operationId: completePasskeySignIn
      tags: [auth]
      summary: Complete passkey sign-in
      description: |
        Verifies the assertion against the carrier cookie's challenge; the `userHandle` names
        the account. Answers the same token body `POST /auth/token` answers. Every refusal —
        unknown credential, wrong challenge, regressed counter, failed verification — is the
        same 401.
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, description: The WebAuthn authentication response (Level 3 JSON) }
      responses:
        '200':
          description: A new access token, and the refresh token to present at `POST /auth/token`
          content:
            application/json:
              schema:
                type: object
                required: [accessToken, expiresIn, refreshToken]
                properties:
                  accessToken: { type: string }
                  expiresIn: { type: integer, description: Seconds until expiry }
                  refreshToken: { type: string }
        '401': { $ref: '#/components/responses/Unauthorized' }

  /auth/sign-in-methods:
    get:
      operationId: getSignInMethods
      tags: [auth]
      summary: How this account signs in
      description: |
        The signed-in account's linked providers (explicit subjects plus the born provider the
        canonical sub's namespace names; email is always true — the address is the key) and its
        passkeys.
      responses:
        '200':
          description: Linked methods and passkeys
          headers:
            Cache-Control:
              schema: { type: string }
              description: private, no-store — per-user data
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SignInMethods' }

  /auth/passkeys:
    post:
      operationId: createPasskey
      tags: [auth]
      summary: Register a passkey
      description: |
        Verifies the attestation against the registration carrier (bound to this account) and
        stores the credential. Refused with 409 when the account already holds 10.
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, description: The WebAuthn registration response (Level 3 JSON) }
      responses:
        '201':
          description: Stored
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Passkey' }
        '401': { description: The ceremony could not be verified }

  /auth/passkeys/options:
    post:
      operationId: startPasskeyRegistration
      tags: [auth]
      summary: Begin passkey registration
      description: |
        Answers WebAuthn creation options (resident key required, this account's existing
        credentials excluded) and sets the registration carrier cookie, bound to this account.
      responses:
        '200':
          description: WebAuthn creation options (Level 3 JSON)
          content:
            application/json:
              schema: { type: object }

  /auth/passkeys/{id}:
    patch:
      operationId: renamePasskey
      tags: [auth]
      summary: Rename a passkey
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [label]
              properties:
                label: { type: string, maxLength: 64 }
      responses:
        '200':
          description: Renamed
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Passkey' }
        '404': { description: No such passkey on this account }
    delete:
      operationId: deletePasskey
      tags: [auth]
      summary: Delete a passkey
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '204': { description: Deleted; that credential refuses sign-in from now on }
        '404': { description: No such passkey on this account }
```

`AuthMethods` gains `passkeys` (`required: [google, github, email, passkeys]`, property `passkeys: { type: boolean }`; description sentence unchanged). Beside it:

```yaml
    Passkey:
      type: object
      required: [id, label, createdAt, lastUsedAt]
      properties:
        id: { type: string, description: Credential id, base64url }
        label: { type: string }
        createdAt: { type: string, format: date-time }
        lastUsedAt: { type: string, format: date-time }

    SignInMethods:
      type: object
      required: [google, github, email, passkeys]
      description: How one account signs in — linked providers and its passkeys.
      properties:
        google: { type: boolean }
        github: { type: boolean }
        email: { type: boolean }
        passkeys:
          type: array
          items: { $ref: '#/components/schemas/Passkey' }
```

*(No `GET /auth/passkeys`: the account view reads the list from `GET /auth/sign-in-methods` — one fetch renders the page, and a second list operation would be YAGNI.)*

- [ ] **Step 3: Run** — fixture passes; drift FAILS on the new operationIds (no resources yet) — Task 5/6's green. Commit together with Task 5 if hooks run tests per commit; otherwise **Step 4: Commit** — `docs(contract): passkey sign-in, management and the sign-in-methods answer`

### Task 5: Sign-in — PasskeyService and the public pair

**Files:**
- Create: `src/main/java/io/mattermanager/app/auth/PasskeyService.java`
- Create: `src/main/java/io/mattermanager/app/api/PasskeyResource.java`
- Create: `src/test/java/io/mattermanager/app/testsupport/PasskeyProfile.java` (`FakeCouchProfile` + `app.origin` + the rate-limit overrides — copy `GitHubSignInProfile` minus the OAuth config)
- Test: `src/test/java/io/mattermanager/app/api/PasskeyResourceTest.java`

**Interfaces:**
- Consumes: `PasskeyFlow` (Task 3), `UserRecords.findBySub`/`findByEmail`/`passkeys`/`addPasskey` (Task 2), `InvitationRedeemer.accept`, `SignInLog.record`, `TokenFactory`, `RefreshTokens`/`InMemoryRefreshStore`, `Cookies`, `CurrentUser`.
- Produces: `PasskeyService.signInOptions(): PasskeyFlow.Options`; `PasskeyService.completeSignIn(String responseJson, String carrier): AuthService.TokenResponse`; resource methods `startPasskeySignIn`, `completePasskeySignIn` on `@Path("/auth")` `PasskeyResource` (constructor-injected `PasskeyService service, CurrentUser user`).

- [ ] **Step 1: Write the failing resource tests.** Harness: `@QuarkusTest @TestProfile(PasskeyProfile.class)`; drive the ceremonies with the Task 3 emulator (`ClientPlatform`) against the HTTP answers — fetch options, build the response JSON, POST it with the `mm_flow` cookie from the options answer. Seed records through FakeCouch as `GitHubResourceTest.seedUser` does. Registration for test setup goes through the Task 6 endpoints once they exist; **until then, seed the credential document directly** (write the `passkeys` array entry FakeCouch-side from the emulator's registration data) — the test helper `registeredCredential(emulator)` does that. Tests:
  - `signsInWithoutAUsername`: seed record (sub `mail:abc`, email, one credential) → options → assertion with userHandle `mail:abc` → 200 `TokenResponse`; access token's `sub` is `mail:abc`, `_couchdb.roles` carries the plan; `POST /auth/token` with the refresh token works; `signInLog` line carries `"provider":"passkey"`; `lastUsedAt`/`signCount` updated on the stored entry.
  - `refusesAnotherAccountsCredential` (Review Focus 1): two seeded accounts; assertion carries A's userHandle with B's credential → 401, nothing changed.
  - `refusesARegressedSignCount`: stored signCount 10, assertion presenting 3 → 401 (emulator counter pinned low, or stored entry seeded high).
  - `refusesACarrierOfTheWrongKind` (Review Focus 2): a register-kind carrier at `/auth/passkey` → 401.
  - `refusesAMismatchedChallenge`: options twice, response built against the first presented with the second's cookie → 401.
  - `refusesWhenTheRecordIsGone` (Review Focus 3): delete the seeded doc between options and completion → 401.
  - `failuresAreIndistinguishable`: the 401 bodies above are byte-identical.
- [ ] **Step 2: Run to verify failure** — 404 (drift also still red).
- [ ] **Step 3: Implement.** `PasskeyService.completeSignIn`: `flow.verifyAssertion(json, carrier, (handle, credId) -> records.findBySub(handle).flatMap(r -> records.passkeys(r.email()).stream().filter(c -> c.id().equals(credId)).findFirst()))` — then re-find the record by sub (gone → `SignInException`), check `asserted.signCount()` strictly greater than stored when stored > 0 (both-zero authenticators are legal), persist the new count + `lastUsedAt` via Task 2's `UserRecords.touchPasskey`, then the `EmailSignIn.verify` tail verbatim with provider `"passkey"`: `invitations.accept(sub, email, null)`, `signInLog.record(...)`, `mintRefresh` + `refresh.remember`, plan read, `mintAccess`, `new AuthService.TokenResponse(access, 300, minted.jwt())`. Every `SignInException`/`RuntimeException` → `ProblemException(Problem.of(401, "Sign-in failed"))`, logging only the problem code as `EmailSignIn` does. Resource: `startPasskeySignIn` answers the options JSON with `Cache-Control: no-store` and `cookies().set(Cookies.FLOW, options.carrier(), 600)`; `completePasskeySignIn` answers 200 + body, clearing the flow cookie on success and failure alike.
- [ ] **Step 4: Run** — `./mvnw test -Dtest=PasskeyResourceTest` — PASS.
- [ ] **Step 5: Commit** — `feat(auth): usernameless passkey sign-in over the account model`

### Task 6: Management, the sign-in-methods answer, and the methods flag

**Files:**
- Modify: `src/main/java/io/mattermanager/app/auth/PasskeyService.java`, `src/main/java/io/mattermanager/app/api/PasskeyResource.java`
- Modify: `src/main/java/io/mattermanager/app/api/AuthResource.java` (`AuthMethods` record + `getAuthMethods`)
- Modify: `src/test/java/io/mattermanager/app/api/AuthMethodsTest.java` (+ the mail-only profile's assertion)
- Test: extend `src/test/java/io/mattermanager/app/api/PasskeyResourceTest.java` (management describe)

**Interfaces:**
- Produces: resource methods `startPasskeyRegistration`, `createPasskey`, `renamePasskey`, `deletePasskey`, `getSignInMethods` (all `@Authenticated`, `CurrentUser` for sub/email — `ProfileResource.requireEmail(user)` first); `AuthResource.AuthMethods(boolean google, boolean github, boolean email, boolean passkeys)` answered with `features.passkeys()`.
- Consumes: Task 2's `UserRecords` methods, `UserRecords.ensure` (a record must exist before a credential can be stored), Task 3's flow, the `slot`-style born-provider logic (compute linked providers as `subjects.<p>` present OR canonical sub prefixed `<p>:`).

- [ ] **Step 1: Write the failing tests** (same file, authenticated via the harness's minted access token — copy how `ProfileResource` tests authenticate):
  - `registersRenamesAndDeletes`: options → emulator → `POST /auth/passkeys` 201 with a dated default label → `GET /auth/sign-in-methods` lists it → rename 200 (label changed, 65-char label refused 400) → delete 204 → the list empties → sign-in with it 401.
  - `refusesASignInCarrierAtRegistration` (Review Focus 2) and `refusesACarrierBoundToAnotherAccount` (Review Focus 4: mint options as user A, complete as user B) → 401.
  - `refusesTheEleventh`: ten seeded → options/`POST` → 409.
  - `registrationEnsuresARecord`: a recordless email-born session (token sub `mail:…`, no doc) adds a passkey → record created by `ensure`, credential on it.
  - `signInMethodsAnswersTheAccount`: seed `sub: "github:8341702"`, `subjects: {google: "g-1"}`, one passkey → `{google: true, github: true (born), email: true, passkeys: [one summary]}`, `Cache-Control: private, no-store`.
  - In `AuthMethodsTest` (mail profile): `body("passkeys", is(true))` joins the existing assertions (Review Focus 5).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Registration: `records.ensure(user.sub(), user.email(), user.name())` first; default label `"Passkey added " + DateTimeFormatter.ISO_LOCAL_DATE.format(...)`; `createdAt`/`lastUsedAt` ISO-8601 now. `getSignInMethods` computes born provider from the canonical sub's prefix (`sub.substring(0, sub.indexOf(':'))`) plus `subjects` keys — mirror `UserRecords.slot`'s reading (add a package-visible `UserRecords.linkedProviders(email): Set<String>` rather than re-parsing in the resource). `AuthMethods` gains the fourth component; `getAuthMethods` passes `features.passkeys()`.
- [ ] **Step 4: Run** — `./mvnw test -Dtest='PasskeyResourceTest,AuthMethodsTest,PasskeyGateTest,OpenApiDriftTest,ContractFixtureTest'` — ALL PASS (drift now green).
- [ ] **Step 5: Commit** — `feat(auth): passkey management, GET /auth/sign-in-methods and the methods flag`

### Task 7: Full gate, native proof, docs and PR

- [ ] **Step 1:** `./mvnw verify -DskipITs=false` — green, zero warnings read from the log; fix what it surfaces (ArchUnit on the new classes, contract validation, JaCoCo).
- [ ] **Step 2:** `scripts/native-build.sh --build-only` — green. This is the piece's proving burden: webauthn4j reflection failures surface HERE, not in per-PR CI. Expect to add `@RegisterForReflection(targets = …)` entries or a `reflect-config.json` cribbed from the `quarkus-security-webauthn` extension's config for webauthn4j's data classes; ledger what was needed.
- [ ] **Step 3:** README: the passkey routes need no new variables (note under the auth section); mention `rpId` derives from `APP_ORIGIN`.
- [ ] **Step 4:** Push `feat/passkeys`, PR to `main` via `--body-file`, body noting: deploy adds no config; frontend PR follows; ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and the session URL. Do not merge.

---

## Deliberate scope notes

- No passkey-born accounts, no provider unlinking, no attestation metadata (manager is non-strict, policy `none`), no conditional mediation.
- `webauthn4j-test`'s emulator API is pinned by intent, not by name: if 0.31.x moved `EmulatorUtil`/`ClientPlatform`, rule on the current equivalent and ledger it.
- Spec Testing list → owning test: register→list→signout→signin→token (`signsInAndHandsOff` + `registersRenamesAndDeletes`), regressed signCount (`refusesARegressedSignCount`), Google carrier at completion (`refusesACarrierOfTheWrongKind` — carrier kind covers cross-provider since only passkey kinds exist for Purpose.FLOW with provider "passkey"; a literal Google carrier is the same STATE refusal, asserted in `PasskeyFlowTest`), registration carrier from another session (`refusesACarrierBoundToAnotherAccount`), delete→refuses (`registersRenamesAndDeletes` tail), 11th refused (`refusesTheEleventh`), rename caps label (`registersRenamesAndDeletes`), methods flag per profile (`AuthMethodsTest` + `PasskeyResourceTest` methods assertion), gates 404 (`PasskeyGateTest`), drift+fixture (Task 4), JaCoCo (Task 7), native gate (Task 7).
