# Email Sign-In (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in to Matter Manager with an email address and a one-time code, on a multi-provider account model, in the Java backend.

**Architecture:** A split-secret flow: `POST /auth/email` mails a 6-digit code and answers a high-entropy challenge id; `POST /auth/email/{challenge}` takes both and answers the same token body `POST /auth/token` answers. Accounts keep one canonical `sub`; provider identities live in a `subjects` map resolved at sign-in (`UserRecords.resolveIdentity`), which also makes the existing Google callback auto-link. Mail leaves through a `MailSender` port whose first adapter is Cloudflare Email Service.

**Tech Stack:** Quarkus 4.0.0.Beta1 (`quarkus-rest` + Jackson 3 `tools.jackson.*`), CouchDB via the in-house `CouchClient`, SmallRye JWT Build (ES256), JUnit 5 + rest-assured + FakeCouch + WireMock.

**Spec:** `/Users/stw/Code/matter-manager/docs/superpowers/specs/2026-10-12-email-signin-design.md` (in the matter-manager repo; this plan executes in `/Users/stw/Code/matter-manager-backend`).

## Global Constraints

- **Repo and branch:** work in `/Users/stw/Code/matter-manager-backend`, branch `feat/email-signin` off up-to-date `origin/main`.
- **No address in any log line, exception message or problem body.** The loggable identity is a subject or `UserRecords.addressTag`-style hash. The plaintext code exists only inside the composed email.
- **Main code uses Jackson 3** (`tools.jackson.databind.*`); only `com.fasterxml.jackson.annotation` annotations and test-side YAML use Jackson 2.
- **`api` package rules (ArchUnit-enforced):** constructor injection only, private methods static, no dependency on `couchdb`; HTTP-facing records outside `domain` carry `@RegisterForReflection`.
- **Drift rule:** every OpenAPI `operationId` maps to exactly one same-named resource method in `io.mattermanager.app.api`, same verb and path.
- **`domain` is pure Java** (JDK only) with a ≥ 0.90 line-coverage gate; the bundle gate is ≥ 0.70.
- **Fast suite:** `./mvnw test` (no Docker). **Full gate:** `./mvnw verify -DskipITs=false` — must pass with zero warnings in the build output before the PR.
- **Commits:** conventional (`feat:`, `test:`, `docs:`), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and no other trailer.
- Copy values from the spec verbatim: code `[0-9]{6}`, challenge 128-bit base64url (22 chars), TTL 10 minutes, 5 attempts, 3 sends per folded address per 15 minutes, `expiresIn` 300, derived subject `"mail:" + first 16 bytes of SHA-256(folded address) as lowercase hex`.

## Review Focus

Spec-implied conditions most likely to bite, each pinned to a test in the owning task:

1. **Two concurrent verifies of one challenge** (double-click, two tabs) must yield at most one session → atomic consume via `ConcurrentMap.remove(key, value)` and the reuse test (Task 5).
2. **A non-string `code` or `email` in the JSON body** (number, object, null) must be a 400/401, never a 500 → type-checked field reads and the wrong-type tests (Task 7).
3. **A caller varying address case/whitespace** must not dodge the send limit → folding before the rate key, pinned by the folded-rate-limit test (Task 7).
4. **An account whose canonical sub is `mail:…` signing in with Google** must land in the same account, not `?signin=failed` → the auto-link callback test (Task 3).
5. **The Cloudflare API failing** (4xx/5xx, timeout) must answer a 500 problem without the address or code in log or body → the failed-send test (Task 7) and the adapter error test (Task 4).

---

### Task 1: Derived mail subject (domain)

**Files:**
- Modify: `src/main/java/io/mattermanager/app/domain/Emails.java`
- Test: `src/test/java/io/mattermanager/app/domain/EmailsTest.java` (exists; extend)

**Interfaces:**
- Consumes: `Emails.fold(String)` (existing).
- Produces: `public static String mailSubject(String email)` — `"mail:" + 32 lowercase hex chars`; later tasks call it from `EmailSignIn`.

- [ ] **Step 1: Write the failing tests** (append to `EmailsTest`)

```java
@Test
void mailSubjectIsStableAndFolded() {
    String a = Emails.mailSubject("Ada@Example.com ");
    assertEquals(a, Emails.mailSubject("ada@example.com"));
    assertTrue(a.startsWith("mail:"));
    assertEquals("mail:".length() + 32, a.length());
    assertTrue(a.substring(5).matches("[0-9a-f]{32}"));
}

@Test
void mailSubjectDiffersPerAddress() {
    assertNotEquals(Emails.mailSubject("ada@example.com"), Emails.mailSubject("bob@example.com"));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `./mvnw test -Dtest=EmailsTest`
Expected: FAIL — `mailSubject` undefined.

- [ ] **Step 3: Implement** (append to `Emails`; JDK-only, keeping the domain pure)

```java
/**
 * The canonical account subject for an address-born account: {@code mail:} + the first 16 bytes
 * of SHA-256 of the folded address, lowercase hex. Deterministic, so a recordless email sign-in
 * carries the same subject every time; not reversible, so it is safe where logs carry subjects.
 */
public static String mailSubject(String email) {
    try {
        byte[] d = java.security.MessageDigest.getInstance("SHA-256")
                .digest(fold(email).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return "mail:" + java.util.HexFormat.of().formatHex(d, 0, 16);
    } catch (java.security.NoSuchAlgorithmException e) {
        throw new IllegalStateException(e); // SHA-256 is mandatory in every JRE
    }
}
```

- [ ] **Step 4: Run to verify pass** — `./mvnw test -Dtest=EmailsTest`
- [ ] **Step 5: Commit** — `feat: derive a stable mail: subject from a folded address`

### Task 2: `by_identity` view and identity resolution (`UserRecords`)

**Files:**
- Modify: `src/main/java/io/mattermanager/app/users/UserRecords.java`
- Test: `src/test/java/io/mattermanager/app/users/UserRecordsTest.java`

**Interfaces:**
- Consumes: `CouchClient.readModifyWrite/getDoc/installDesign`, `SubjectConflictException` (existing, package `users`), `docId`, `addressTag`.
- Produces: `public String resolveIdentity(String provider, String providerSub, String rawEmail)` — returns the canonical subject for the session; throws `SubjectConflictException` on a slot mismatch. The `by_identity` design doc installed by `ensureDatabase()`. **No FakeCouch emitter**: piece 1 never queries the view (precedent: `by_plan_requested` has none either); piece 2 adds the emitter with its first reader.

- [ ] **Step 1: Write the failing tests** (append to `UserRecordsTest`, following its existing seeding style via `couch.docs("matter_manager")`)

```java
@Test
void ensureDatabaseInstallsByIdentity() {
    records.ensureDatabase();
    ObjectNode ddoc = couch.docs("matter_manager").get("_design/by_identity");
    assertNotNull(ddoc);
    String map = ddoc.path("views").path("by_identity").path("map").asString();
    assertTrue(map.contains("doc.subjects"));
    assertTrue(map.contains("'google'")); // the legacy implication
}

@Test
void resolveIdentityWithoutRecordReturnsTheProviderSubject() {
    assertEquals("google|1", records.resolveIdentity("google", "google|1", "ada@example.com"));
    assertTrue(couch.docs("matter_manager").isEmpty() || !couch.docs("matter_manager").keySet().stream()
            .anyMatch(k -> k.startsWith("user:"))); // resolution creates nothing
}

@Test
void resolveIdentityMatchesTheLegacyImpliedGoogleSlotWithoutWriting() {
    seed("ada@example.com", d -> d.put("sub", "google|1")); // legacy: sub only, no subjects map
    long writes = couch.putCount(); // use the test class's existing write-counting helper, or assert the doc is unchanged
    assertEquals("google|1", records.resolveIdentity("google", "google|1", "ada@example.com"));
    assertFalse(couch.docs("matter_manager").get(docIdOf("ada@example.com")).has("subjects"));
}

@Test
void resolveIdentityFillsAnEmptySlotAndKeepsTheCanonicalSub() {
    seed("ada@example.com", d -> d.put("sub", "mail:aaaa")); // email-born account
    assertEquals("mail:aaaa", records.resolveIdentity("google", "google|9", "ada@example.com"));
    ObjectNode doc = couch.docs("matter_manager").get(docIdOf("ada@example.com"));
    assertEquals("google|9", doc.path("subjects").path("google").asString());
    assertEquals("mail:aaaa", doc.path("sub").asString()); // canonical never rebound
}

@Test
void resolveIdentityRefusesAFilledSlotMismatch() {
    seed("ada@example.com", d -> d.put("sub", "google|1"));
    assertThrows(SubjectConflictException.class,
            () -> records.resolveIdentity("google", "google|2", "ada@example.com"));
}
```

(`seed`/`docIdOf` name whatever helpers `UserRecordsTest` already uses for storing and keying docs — reuse them, do not invent parallel ones. If no write-counting helper exists, assert document equality before/after instead.)

- [ ] **Step 2: Run to verify failure** — `./mvnw test -Dtest=UserRecordsTest` — FAIL: no `resolveIdentity`, no `by_identity`.

- [ ] **Step 3: Implement in `UserRecords`**

Constants and the install (extend `ensureDatabase()` after the `by_plan_requested` install):

```java
private static final String BY_IDENTITY = "by_identity";
// Every provider identity of a record: explicit subjects plus the implied legacy Google slot
// (every account predates multi-provider, so a non-mail: sub with no subjects.google IS the
// Google identity). Consumed from piece 2 (GitHub) on; installed now so production databases
// are ready before that deploy.
private static final String BY_IDENTITY_MAP = """
        function (doc) {
          if (doc.type !== 'user') { return }
          if (doc.subjects) {
            for (var p in doc.subjects) { emit([p, doc.subjects[p]], null) }
          }
          if (doc.sub && doc.sub.lastIndexOf('mail:', 0) !== 0 && !(doc.subjects && doc.subjects.google)) {
            emit(['google', doc.sub], null)
          }
        }""";
```

```java
ObjectNode identity = M.createObjectNode();
identity.putObject("views").putObject(BY_IDENTITY).put("map", BY_IDENTITY_MAP);
couch.installDesign(DB, BY_IDENTITY, identity);
```

The resolver:

```java
/**
 * Resolves a provider identity to the account's canonical subject at sign-in, auto-linking by
 * verified address: an empty provider slot in {@code subjects} is filled, a matching one is
 * kept, a mismatch is refused. Creates nothing: with no record, the provider subject IS the
 * canonical subject, and a later {@link #ensure} seeds the record with it.
 *
 * <p>Legacy records carry their Google subject as {@code sub} with no {@code subjects} map; a
 * non-{@code mail:} {@code sub} without {@code subjects.google} is the implied Google slot, and
 * matching it writes nothing.
 *
 * @return the canonical subject for the session's tokens ({@code sub} when the record has one)
 * @throws SubjectConflictException when the provider's slot holds a different subject
 */
public String resolveIdentity(String provider, String providerSub, String rawEmail) {
    ensureDatabase();
    String id = docId(rawEmail);
    Optional<ObjectNode> current = couch.getDoc(DB, id);
    if (current.isEmpty()) {
        return providerSub;
    }
    String stored = slot(current.get(), provider);
    if (stored != null) {
        if (!stored.equals(providerSub)) {
            LOG.warnf("Refused to re-bind a provider slot (provider=%s, stored=%s, claimed=%s, address#%s)",
                    provider, stored, providerSub, addressTag(rawEmail));
            throw new SubjectConflictException();
        }
        String canonical = current.get().path("sub").asString(null);
        return canonical != null ? canonical : providerSub;
    }
    try {
        ObjectNode saved = couch.readModifyWrite(DB, id, doc -> {
            // The record vanished between the read and this write: a fresh identity, not a slot.
            if (!doc.hasNonNull("_rev")) {
                throw new VanishedMidWrite();
            }
            String s = slot(doc, provider);
            if (s != null && !s.equals(providerSub)) {
                throw new SubjectConflictException();
            }
            JsonNode existing = doc.get("subjects");
            ObjectNode subjects = existing instanceof ObjectNode o ? o : doc.putObject("subjects");
            subjects.put(provider, providerSub);
            return doc;
        });
        String canonical = saved.path("sub").asString(null);
        return canonical != null ? canonical : providerSub;
    } catch (VanishedMidWrite gone) {
        return providerSub;
    }
}

/** The provider's stored slot: {@code subjects.<provider>}, or the implied legacy Google slot. */
private static String slot(ObjectNode doc, String provider) {
    String explicit = doc.path("subjects").path(provider).asString(null);
    if (explicit != null) {
        return explicit;
    }
    if (!"google".equals(provider)) {
        return null;
    }
    String sub = doc.path("sub").asString(null);
    return sub != null && !sub.startsWith("mail:") ? sub : null;
}
```

(`VanishedMidWrite` already exists as `clearRequest`'s private control exception — move it to a shared private static final class if the compiler complains about scope; it is file-local either way.)

- [ ] **Step 4: Run to verify pass** — `./mvnw test -Dtest=UserRecordsTest`
- [ ] **Step 5: Commit** — `feat: resolve provider identities to one canonical subject, install by_identity`

### Task 3: Google callback resolves the canonical subject (auto-link both ways)

**Files:**
- Modify: `src/main/java/io/mattermanager/app/auth/AuthService.java:111-121` (the `complete` method)
- Test: `src/test/java/io/mattermanager/app/api/AuthResourceTest.java`

**Interfaces:**
- Consumes: `UserRecords.resolveIdentity("google", who.sub(), who.email())` from Task 2.
- Produces: the handoff token's `sub` is now the canonical subject. No signature changes.

- [ ] **Step 1: Write the failing tests** (append to `AuthResourceTest`; use its existing sign-in helper that drives the stubbed Google flow and its `payload(jwt)` helper)

```java
@Test
void googleSignInOnAMailCanonicalAccountKeepsTheCanonicalSubject() {
    // An account born via email sign-in: canonical sub is mail:…, no subjects map.
    seedUserDoc(EMAIL, d -> d.put("sub", "mail:0123456789abcdef0123456789abcdef"));
    String handoff = signInAndTakeHandoffCookie(); // existing helper flow, Google asserts sub google|1234
    assertEquals("mail:0123456789abcdef0123456789abcdef", payload(handoff).path("sub").asString());
    ObjectNode doc = storedUserDoc(EMAIL);
    assertEquals(SUB, doc.path("subjects").path("google").asString());
    assertEquals("mail:0123456789abcdef0123456789abcdef", doc.path("sub").asString());
}

@Test
void googleSignInWithAForeignSubjectOnABoundAccountFails() {
    seedUserDoc(EMAIL, d -> d.put("sub", "google|other"));
    Response done = completeSignIn(); // existing helper
    assertTrue(done.header("Location").contains("signin=failed"));
    assertNull(cookieLine(done, "mm_handoff"));
}
```

(`seedUserDoc`/`storedUserDoc`/`signInAndTakeHandoffCookie`/`completeSignIn` stand for the test class's existing seeding and flow helpers — `AuthResourceTest` already seeds user docs and completes stubbed sign-ins; reuse those exact helpers and naming. The second test may already exist as the subject-conflict test; if so, keep it and only verify it still passes.)

- [ ] **Step 2: Run to verify failure** — `./mvnw test -Dtest=AuthResourceTest` — the mail-canonical test FAILS today (`signin=failed`, because `ensure` refuses the foreign sub).

- [ ] **Step 3: Implement.** In `AuthService.complete`, replace the accept/log pair and the handoff mint:

```java
// Auto-link by verified address: the session subject is the account's canonical sub, which an
// email-born account keeps for life; Google's subject fills (or must match) its slot.
String canonical = records.resolveIdentity(PROVIDER, who.sub(), who.email());
boolean hasRecord = invitations.accept(canonical, who.email(), who.name());
signInLog.record(canonical, who.email(), PROVIDER, hasRecord);
```

and below:

```java
String handoff = tokens.mintHandoff(canonical, who.email(), who.name()).jwt();
```

`canonical` must be declared before the `try` (next to `returnTo`), since the mint happens after it. `SubjectConflictException` is a `RuntimeException`, so the existing catch already turns it into `?signin=failed`.

- [ ] **Step 4: Run to verify pass** — `./mvnw test -Dtest=AuthResourceTest` (all existing tests must also still pass: for legacy records `resolveIdentity` is a read-only match).
- [ ] **Step 5: Commit** — `feat: google sign-in resolves the canonical subject and auto-links its slot`

### Task 4: Mail port, templates, Cloudflare adapter, config and gate

**Files:**
- Create: `src/main/java/io/mattermanager/app/mail/MailSender.java`
- Create: `src/main/java/io/mattermanager/app/mail/MailException.java`
- Create: `src/main/java/io/mattermanager/app/mail/SignInMail.java`
- Create: `src/main/java/io/mattermanager/app/mail/CloudflareMailSender.java`
- Create: `src/main/java/io/mattermanager/app/config/MailConfig.java`
- Modify: `src/main/java/io/mattermanager/app/config/Features.java`
- Modify: `src/main/java/io/mattermanager/app/config/FeatureGateFilter.java`
- Create: `src/test/java/io/mattermanager/app/testsupport/FakeMailSender.java`
- Test: `src/test/java/io/mattermanager/app/mail/SignInMailTest.java`, `src/test/java/io/mattermanager/app/mail/CloudflareMailSenderTest.java`, extend `src/test/java/io/mattermanager/app/config/FeatureGateFilterTest.java` if one exists (otherwise the gate is covered end-to-end in Task 7)

**Interfaces:**
- Produces:
  - `interface MailSender { void send(Message message); record Message(String to, String subject, String text, String html) {} }`
  - `SignInMail.compose(String to, String locale, String code) → MailSender.Message`
  - `MailConfig` (`mail.api-token` ← `MAIL_API_TOKEN`, `mail.account-id` ← `MAIL_ACCOUNT_ID`, `mail.from` ← `MAIL_FROM`, `mail.api-base` ← `MAIL_API_BASE`, default `https://api.cloudflare.com`)
  - `Features.mail()`; gate `auth/email` → `Features::mail`, matched before `auth`.
  - `FakeMailSender` (`@Alternative`): records `List<MailSender.Message> sent`.

- [ ] **Step 1: Write the failing template tests**

```java
class SignInMailTest {
    @Test
    void composesEnglishByDefault() {
        MailSender.Message m = SignInMail.compose("ada@example.com", "en", "123456");
        assertEquals("ada@example.com", m.to());
        assertEquals("Your Matter Manager sign-in code", m.subject());
        assertTrue(m.text().contains("123456"));
        assertTrue(m.text().contains("10 minutes"));
        assertTrue(m.html().contains("123456"));
    }

    @Test
    void composesFormalGerman() {
        MailSender.Message m = SignInMail.compose("ada@example.com", "de", "123456");
        assertEquals("Ihr Anmeldecode für Matter Manager", m.subject());
        assertTrue(m.text().contains("Ihr Anmeldecode"));
        assertTrue(m.text().contains("10 Minuten"));
    }
}
```

- [ ] **Step 2: Run to verify failure** — `./mvnw test -Dtest=SignInMailTest` — FAIL: classes missing.

- [ ] **Step 3: Implement port, exception and templates**

```java
package io.mattermanager.app.mail;

/**
 * Transport port for one already-composed message. Implementations never log the message body:
 * it carries a sign-in code, and the recipient address is personal data.
 */
public interface MailSender {
    /** @throws MailException when the message was not accepted for delivery */
    void send(Message message);

    record Message(String to, String subject, String text, String html) {}
}
```

```java
package io.mattermanager.app.mail;

/** Delivery failed. Carries status and vendor error code only — never the address or body. */
public class MailException extends RuntimeException {
    public MailException(String summary) {
        super(summary);
    }
}
```

```java
package io.mattermanager.app.mail;

/** The sign-in-code email, in the interface's two languages (formal Sie, as the app). */
public final class SignInMail {
    private SignInMail() {}

    public static MailSender.Message compose(String to, String locale, String code) {
        boolean de = "de".equals(locale);
        String subject = de ? "Ihr Anmeldecode für Matter Manager" : "Your Matter Manager sign-in code";
        String text = de
                ? "Ihr Anmeldecode lautet: " + code + "\n\nEr ist 10 Minuten gültig. Wenn Sie keinen Code angefordert haben, ignorieren Sie diese E-Mail."
                : "Your sign-in code is: " + code + "\n\nIt is valid for 10 minutes. If you did not request a code, ignore this email.";
        String html = de
                ? "<p>Ihr Anmeldecode lautet: <strong>" + code + "</strong></p><p>Er ist 10 Minuten gültig. Wenn Sie keinen Code angefordert haben, ignorieren Sie diese E-Mail.</p>"
                : "<p>Your sign-in code is: <strong>" + code + "</strong></p><p>It is valid for 10 minutes. If you did not request a code, ignore this email.</p>";
        return new MailSender.Message(to, subject, text, html);
    }
}
```

(The code is six digits by construction, so no HTML escaping question arises; say so in a comment only if a reviewer asks.)

- [ ] **Step 4: Write the failing adapter test** (WireMock programmatically, as the repo's Google stub does; `wiremock-standalone` is already a test dependency)

```java
class CloudflareMailSenderTest {
    static WireMockServer wm;

    @BeforeAll static void up() { wm = new WireMockServer(0); wm.start(); }
    @AfterAll static void down() { wm.stop(); }

    private CloudflareMailSender sender() {
        // Construct directly with a test MailConfig (see step 5's package-private constructor).
        return new CloudflareMailSender(testConfig(wm.baseUrl(), "token-1", "acct-1", "signin@matter-manager.io"));
    }

    @Test
    void postsTheCloudflareShape() {
        wm.stubFor(post(urlEqualTo("/client/v4/accounts/acct-1/email/sending/send"))
                .willReturn(okJson("{\"success\":true,\"result\":{\"delivered\":[\"ada@example.com\"]}}")));
        sender().send(SignInMail.compose("ada@example.com", "en", "123456"));
        wm.verify(postRequestedFor(urlEqualTo("/client/v4/accounts/acct-1/email/sending/send"))
                .withHeader("Authorization", equalTo("Bearer token-1"))
                .withHeader("Content-Type", equalTo("application/json"))
                .withRequestBody(matchingJsonPath("$.to", equalTo("ada@example.com")))
                .withRequestBody(matchingJsonPath("$.from.address", equalTo("signin@matter-manager.io")))
                .withRequestBody(matchingJsonPath("$.text"))
                .withRequestBody(matchingJsonPath("$.html")));
    }

    @Test
    void aRefusalIsAMailExceptionWithoutTheAddress() {
        wm.stubFor(post(anyUrl()).willReturn(aResponse().withStatus(400)
                .withBody("{\"success\":false,\"errors\":[{\"code\":1000,\"message\":\"Sender domain not verified\"}]}")));
        MailException e = assertThrows(MailException.class,
                () -> sender().send(SignInMail.compose("ada@example.com", "en", "123456")));
        assertFalse(e.getMessage().contains("ada@example.com"));
        assertTrue(e.getMessage().contains("400"));
    }
}
```

- [ ] **Step 5: Implement config and adapter**

```java
package io.mattermanager.app.config;

import io.smallrye.config.ConfigMapping;
import io.smallrye.config.WithDefault;
import java.util.Optional;

/** Outbound mail ({@code MAIL_API_TOKEN}, {@code MAIL_ACCOUNT_ID}, {@code MAIL_FROM}). */
@ConfigMapping(prefix = "mail")
public interface MailConfig {
    /** @return Cloudflare API token with email-sending permission */
    Optional<String> apiToken();

    /** @return the Cloudflare account id the sending domain is onboarded to */
    Optional<String> accountId();

    /** @return the sender address, on a domain onboarded to Email Sending */
    Optional<String> from();

    /** @return the API base; overridable ({@code MAIL_API_BASE}) so tests point it at a stub */
    @WithDefault("https://api.cloudflare.com")
    String apiBase();
}
```

```java
package io.mattermanager.app.mail;

import io.mattermanager.app.config.Env;
import io.mattermanager.app.config.MailConfig;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Sends through Cloudflare Email Service's REST API
 * ({@code POST /client/v4/accounts/{account}/email/sending/send}).
 *
 * <p>The REST shape differs from the Workers binding: {@code from} uses {@code address}, not
 * {@code email}. Failures carry the HTTP status and Cloudflare's numeric error code only.
 */
@ApplicationScoped
public class CloudflareMailSender implements MailSender {
    private static final JsonMapper M = JsonMapper.builder().build();
    private final MailConfig config;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    @Inject
    public CloudflareMailSender(MailConfig config) {
        this.config = config;
    }

    @Override
    public void send(Message message) {
        ObjectNode body = M.createObjectNode();
        body.put("to", message.to());
        ObjectNode from = body.putObject("from");
        from.put("address", Env.present(config.from()).orElseThrow());
        from.put("name", "Matter Manager");
        body.put("subject", message.subject());
        body.put("text", message.text());
        body.put("html", message.html());
        HttpRequest request = HttpRequest.newBuilder(URI.create(
                        config.apiBase() + "/client/v4/accounts/"
                                + Env.present(config.accountId()).orElseThrow() + "/email/sending/send"))
                .timeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer " + Env.present(config.apiToken()).orElseThrow())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(M.writeValueAsString(body)))
                .build();
        HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (java.io.IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new MailException("mail transport failed (" + e.getClass().getSimpleName() + ")");
        }
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            // Status and vendor code only: the response body may echo the recipient.
            throw new MailException("mail refused (status " + response.statusCode() + ", code " + errorCode(response.body()) + ")");
        }
    }

    private static String errorCode(String body) {
        try {
            return M.readTree(body).path("errors").path(0).path("code").asString("unknown");
        } catch (RuntimeException unparsable) {
            return "unknown";
        }
    }
}
```

Give it a package-private constructor-only test seam by making the `@Inject` constructor the only one; the test builds a `MailConfig` with SmallRye's `new SmallRyeConfigBuilder()` or a tiny anonymous implementation — an anonymous implementation is simpler:

```java
private static MailConfig testConfig(String base, String token, String account, String from) {
    return new MailConfig() {
        public Optional<String> apiToken() { return Optional.of(token); }
        public Optional<String> accountId() { return Optional.of(account); }
        public Optional<String> from() { return Optional.of(from); }
        public String apiBase() { return base; }
    };
}
```

- [ ] **Step 6: Features and gate**

`Features` gains (mirroring the Javadoc style of its neighbours):

```java
@Inject MailConfig mail;

/** @return email sign-in is served (CouchDB, both keys, and the mail sender are all set) */
public boolean mail() {
    return couch() && accessKey()
            && Env.present(jwt.sessionPrivateKey()).isPresent()
            && Env.present(mail.apiToken()).isPresent()
            && Env.present(mail.accountId()).isPresent()
            && Env.present(mail.from()).isPresent();
}
```

`FeatureGateFilter`: insert `new Gate("auth/email", Features::mail)` **before** `new Gate("auth", Features::auth)`, and make the loop first-match-decides:

```java
for (Gate g : GATES) {
    // Segment-wise: /profile and /profile/x are gated, /profiles is not ours to gate.
    if (p.equals(g.prefix()) || p.startsWith(g.prefix() + "/")) {
        // The most specific prefix is listed first and decides alone: /auth/email is served
        // whenever mail is configured, with or without Google, and gated off without it even
        // when Google is configured.
        if (!g.enabled().test(features)) {
            ctx.abortWith(Response.status(404).type(Problem.MEDIA_TYPE)
                    .entity(Problem.of(404, "Not Found")).build());
        }
        return;
    }
}
```

- [ ] **Step 7: `FakeMailSender`** in `testsupport`:

```java
package io.mattermanager.app.testsupport;

import io.mattermanager.app.mail.MailSender;
import jakarta.annotation.Priority;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.inject.Alternative;
import java.util.ArrayList;
import java.util.List;

/** Records what would have been mailed; selected per test profile like {@link FakeCouch}. */
@Alternative
@Priority(1)
@ApplicationScoped
public class FakeMailSender implements MailSender {
    public final List<Message> sent = new ArrayList<>();
    public RuntimeException failWith;

    @Override
    public void send(Message message) {
        if (failWith != null) {
            throw failWith;
        }
        sent.add(message);
    }

    public void reset() {
        sent.clear();
        failWith = null;
    }
}
```

(Match the `@Alternative` selection mechanism FakeCouch actually uses — `@Priority` on the class or the profile's `getEnabledAlternatives()`; copy FakeCouch's, do not mix both.)

- [ ] **Step 8: Run** — `./mvnw test -Dtest='SignInMailTest,CloudflareMailSenderTest'` — PASS; full `./mvnw test` still green.
- [ ] **Step 9: Commit** — `feat: mail port with Cloudflare Email Service adapter, mail feature gate`

### Task 5: The challenge store

**Files:**
- Create: `src/main/java/io/mattermanager/app/auth/EmailChallenges.java`
- Test: `src/test/java/io/mattermanager/app/auth/EmailChallengesTest.java`

**Interfaces:**
- Produces: `Started start(String foldedEmail)` with `record Started(String challenge, String code)`; `Optional<String> redeem(String challenge, String code)` returning the folded address once, on the one matching, unexpired, unexhausted attempt; `forgetAll()` for tests. Package-private `Clock clock` seam (the `UserRecords` pattern).

- [ ] **Step 1: Write the failing tests**

```java
class EmailChallengesTest {
    private final EmailChallenges challenges = new EmailChallenges();

    @Test
    void startMintsDistinctHighEntropyChallengesAndSixDigitCodes() {
        var a = challenges.start("ada@example.com");
        var b = challenges.start("ada@example.com");
        assertNotEquals(a.challenge(), b.challenge());
        assertEquals(22, a.challenge().length());
        assertTrue(a.code().matches("[0-9]{6}"));
    }

    @Test
    void redeemAnswersTheAddressOnceAndNeverAgain() {
        var started = challenges.start("Ada@Example.com");
        assertEquals(Optional.of("ada@example.com"), challenges.redeem(started.challenge(), started.code()));
        assertEquals(Optional.empty(), challenges.redeem(started.challenge(), started.code()));
    }

    @Test
    void redeemRefusesWrongUnknownAndNull() {
        var started = challenges.start("ada@example.com");
        assertEquals(Optional.empty(), challenges.redeem(started.challenge(), "000000"));
        assertEquals(Optional.empty(), challenges.redeem("nope", started.code()));
        assertEquals(Optional.empty(), challenges.redeem(null, started.code()));
        assertEquals(Optional.empty(), challenges.redeem(started.challenge(), null));
    }

    @Test
    void theFifthWrongCodeExhaustsTheChallenge() {
        var started = challenges.start("ada@example.com");
        for (int i = 0; i < 5; i++) {
            assertEquals(Optional.empty(), challenges.redeem(started.challenge(), "000000"));
        }
        assertEquals(Optional.empty(), challenges.redeem(started.challenge(), started.code()));
    }

    @Test
    void anExpiredChallengeIsRefusedAndSwept() {
        var started = challenges.start("ada@example.com");
        challenges.clock = Clock.offset(Clock.systemUTC(), Duration.ofMinutes(11));
        assertEquals(Optional.empty(), challenges.redeem(started.challenge(), started.code()));
        challenges.start("bob@example.com"); // start sweeps
        assertEquals(1, challenges.openCount());
    }
}
```

- [ ] **Step 2: Run to verify failure** — `./mvnw test -Dtest=EmailChallengesTest` — FAIL: class missing.

- [ ] **Step 3: Implement**

```java
package io.mattermanager.app.auth;

import io.mattermanager.app.domain.Emails;
import jakarta.enterprise.context.ApplicationScoped;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Open email sign-in challenges, in memory (the {@link InMemoryRefreshStore} precedent: one
 * instance serves the deployment, and losing ten-minute challenges on restart only means asking
 * for a new code). The secret is split: the challenge id goes back to the requesting client, the
 * code into the mailbox, and neither alone redeems. Codes are stored only as SHA-256 hashes and
 * compared constant-time.
 */
@ApplicationScoped
public class EmailChallenges {
    static final Duration TTL = Duration.ofMinutes(10);
    static final int MAX_ATTEMPTS = 5;

    private record Challenge(String foldedEmail, byte[] codeHash, Instant expiresAt, AtomicInteger attempts) {}

    /** What a started challenge hands the caller: the id for the client, the code for the email. */
    public record Started(String challenge, String code) {}

    private final Map<String, Challenge> open = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();

    /** Decides expiry; replaceable by tests. */
    Clock clock = Clock.systemUTC();

    /** Mints a challenge for an address (folded here, so one address is one rate-limit key upstream). */
    public Started start(String rawEmail) {
        sweep();
        byte[] id = new byte[16];
        random.nextBytes(id);
        String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(id);
        String code = String.format("%06d", random.nextInt(1_000_000));
        open.put(challenge, new Challenge(Emails.fold(rawEmail), sha256(code), clock.instant().plus(TTL), new AtomicInteger()));
        return new Started(challenge, code);
    }

    /**
     * Redeems a challenge: the folded address exactly once, for the matching code within TTL and
     * attempts. Every refusal is the same empty — unknown, expired, consumed, exhausted and wrong
     * are one fact to the caller.
     */
    public Optional<String> redeem(String challenge, String code) {
        if (challenge == null || code == null) {
            return Optional.empty();
        }
        Challenge c = open.get(challenge);
        if (c == null) {
            return Optional.empty();
        }
        if (clock.instant().isAfter(c.expiresAt())) {
            open.remove(challenge);
            return Optional.empty();
        }
        if (!MessageDigest.isEqual(c.codeHash(), sha256(code))) {
            if (c.attempts().incrementAndGet() >= MAX_ATTEMPTS) {
                open.remove(challenge);
            }
            return Optional.empty();
        }
        // remove(key, value): of two concurrent redeems, exactly one wins the session.
        return open.remove(challenge, c) ? Optional.of(c.foldedEmail()) : Optional.empty();
    }

    /** Open challenges, for tests. */
    int openCount() {
        return open.size();
    }

    /** Forgets everything, for tests. */
    public void forgetAll() {
        open.clear();
    }

    private void sweep() {
        Instant now = clock.instant();
        open.entrySet().removeIf(e -> now.isAfter(e.getValue().expiresAt()));
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

- [ ] **Step 4: Run to verify pass** — `./mvnw test -Dtest=EmailChallengesTest`
- [ ] **Step 5: Commit** — `feat: in-memory email sign-in challenges with hashed single-use codes`

### Task 6: Contract additions

**Files:**
- Modify: `src/main/resources/openapi.yaml` (after `/auth/signout`, before `/profile`; plus `components`)
- Modify: `src/test/java/io/mattermanager/app/ContractFixtureTest.java` (the `EXPECTED` operation set)
- Modify: `docs/superpowers/specs/2026-10-09-quarkus-backend-design.md` §7 (the operations table, as the waitlist port did)

**Interfaces:**
- Produces: operations `startEmailSignIn`, `completeEmailSignIn`; schemas `EmailSignInStart`, `EmailChallenge`, `EmailSignInCode`; response `TooManyCodes`. Task 7's resource methods must carry exactly these names.

- [ ] **Step 1: Add the paths** (style of the existing auth entries):

```yaml
  /auth/email:
    post:
      operationId: startEmailSignIn
      tags: [auth]
      summary: Start email sign-in
      description: |
        Mails a six-digit one-time code to the address and answers a single-use challenge id.
        The secret is split: the code goes only to the mailbox and this challenge id only to the
        requesting client, so an intercepted email alone signs nobody in. The answer is the same
        whether or not an account exists - any address may sign in, so there is nothing to
        enumerate. Signing in creates no record.

        At most 3 codes per address per 15 minutes; the code is valid for 10 minutes.
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/EmailSignInStart' }
      responses:
        '202':
          description: The code is on its way; verify it with the challenge id
          content:
            application/json:
              schema: { $ref: '#/components/schemas/EmailChallenge' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '429': { $ref: '#/components/responses/TooManyCodes' }

  /auth/email/{challenge}:
    post:
      operationId: completeEmailSignIn
      tags: [auth]
      summary: Complete email sign-in
      description: |
        Verifies the mailed code against the challenge and answers exactly what
        `POST /auth/token` answers: an access token and a refresh token. The challenge is
        consumed on success. Every failure - unknown, expired, consumed or exhausted challenge,
        and a wrong code alike - is the same 401, so the answer never says which half the caller
        is missing. The fifth wrong code invalidates the challenge.
      security: []
      parameters:
        - { name: challenge, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/EmailSignInCode' }
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
        '400': { $ref: '#/components/responses/BadRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }
```

- [ ] **Step 2: Add the schemas** (under `components/schemas`) **and the response** (under `components/responses`):

```yaml
    EmailSignInStart:
      type: object
      required: [email]
      properties:
        email:
          type: string
          format: email
          description: Where to send the code; also the account's identity once verified.
        locale:
          type: string
          enum: [en, de]
          description: The language of the email. Absent means `en`.

    EmailChallenge:
      type: object
      required: [challenge]
      properties:
        challenge:
          type: string
          description: >-
            Single-use, high-entropy, bound to this request's address. Present it in the path of
            `POST /auth/email/{challenge}`. It never appears in the email.

    EmailSignInCode:
      type: object
      required: [code]
      properties:
        code:
          type: string
          pattern: '^[0-9]{6}$'
          description: The six digits from the email, leading zeros kept.
```

```yaml
    TooManyCodes:
      description: Too many codes requested for this address; wait before trying again
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
```

- [ ] **Step 3: Extend `ContractFixtureTest.EXPECTED`** with `"startEmailSignIn"` and `"completeEmailSignIn"`, and add the two rows to the backend spec's §7 operations table.
- [ ] **Step 4: Run** — `./mvnw test -Dtest=ContractFixtureTest` — PASS. `OpenApiDriftTest` must now FAIL (operations without resource methods); that failure is Task 7's starting point — note it, do not silence it.
- [ ] **Step 5: Commit** — `feat(contract): declare the email sign-in operations`

### Task 7: Sign-in service, resource methods, end-to-end tests

**Files:**
- Create: `src/main/java/io/mattermanager/app/auth/EmailSignIn.java`
- Modify: `src/main/java/io/mattermanager/app/api/AuthResource.java`
- Create: `src/test/java/io/mattermanager/app/testsupport/EmailSignInProfile.java`
- Create: `src/test/java/io/mattermanager/app/api/EmailSignInResourceTest.java`
- Create: `src/test/java/io/mattermanager/app/api/EmailGateTest.java`
- Modify: `src/test/java/io/mattermanager/app/api/ContractValidationTest.java` and `ContractProfile.java`

**Interfaces:**
- Consumes: Tasks 1–6 — `Emails.mailSubject`, `EmailChallenges`, `MailSender`/`SignInMail`, `RateLimiter.check(bucket, key, max, window)`, `TokenFactory.mintAccess/mintRefresh`, `RefreshTokens.remember(sub, email, hash, exp)`, `InMemoryRefreshStore.hashJti`, `UserRecords.findByEmail`, `InvitationRedeemer.accept`, `SignInLog.record`, `AuthService.TokenResponse`, `ProblemException`.
- Produces: `EmailSignIn.start(String email, String locale) → EmailSignIn.Challenge`; `EmailSignIn.verify(String challenge, String code) → AuthService.TokenResponse`; resource methods `startEmailSignIn`, `completeEmailSignIn` on `AuthResource`.

- [ ] **Step 1: Write the failing end-to-end tests.** Test profile first — **no Google configuration**, proving email sign-in stands alone:

```java
package io.mattermanager.app.testsupport;

/** Email sign-in configured, Google NOT: CouchDB (fake), both keys, and the mail vars. */
public class EmailSignInProfile extends FakeCouchProfile {
    @Override
    public Map<String, String> getConfigOverrides() {
        Map<String, String> m = new HashMap<>(super.getConfigOverrides());
        m.put("mail.api-token", "test-token");
        m.put("mail.account-id", "test-account");
        m.put("mail.from", "signin@matter-manager.io");
        // plus whatever key material GoogleSignInProfile supplies for jwt.* — copy those lines,
        // omit every google.* line
        return m;
    }

    @Override
    public Set<Class<?>> getEnabledAlternatives() {
        Set<Class<?>> set = new HashSet<>(super.getEnabledAlternatives());
        set.add(FakeMailSender.class);
        return set;
    }
}
```

(Copy the exact override keys and alternative mechanism from `GoogleSignInProfile`/`FakeCouchProfile` — the names above are indicative, the mechanism is not.)

The test class, modeled on `ProfileResourceTest`/`AuthResourceTest` conventions:

```java
@QuarkusTest
@TestProfile(EmailSignInProfile.class)
class EmailSignInResourceTest {
    private static final String EMAIL = "ada@example.com";

    @Inject FakeCouch couch;
    @Inject UserRecords records;
    @Inject FakeMailSender mail;
    @Inject EmailChallenges challenges;
    @Inject TokenVerifier verifier;
    @Inject SignInLog signInLog;

    private final List<String> logged = new ArrayList<>();

    @BeforeEach
    void fresh() {
        couch.reset();
        records.forgetDatabase();
        mail.reset();
        challenges.forgetAll();
        logged.clear();
        signInLog.sink(logged::add);
    }

    private Response start(String email) {
        return given().contentType(ContentType.JSON).body(Map.of("email", email))
                .post("/auth/email");
    }

    private String codeFromMail() {
        var m = java.util.regex.Pattern.compile("[0-9]{6}").matcher(mail.sent.getLast().text());
        assertTrue(m.find());
        return m.group();
    }

    @Test
    void startMailsACodeAndAnswersAChallenge() {
        Response r = start(" Ada@Example.com ");
        r.then().statusCode(202).header("Cache-Control", containsString("no-store"))
                .body("challenge", matchesPattern("[A-Za-z0-9_-]{22}"));
        assertEquals(1, mail.sent.size());
        assertEquals(EMAIL, mail.sent.getFirst().to()); // folded
        assertTrue(mail.sent.getFirst().text().matches("(?s).*[0-9]{6}.*"));
        assertFalse(r.body().asString().matches(".*[0-9]{6}.*")); // the code never rides the response
    }

    @Test
    void startInGermanUsesTheGermanTemplate() {
        given().contentType(ContentType.JSON).body(Map.of("email", EMAIL, "locale", "de"))
                .post("/auth/email").then().statusCode(202);
        assertTrue(mail.sent.getFirst().subject().startsWith("Ihr Anmeldecode"));
    }

    @Test
    void startRefusesAMalformedAddressAndANonStringEmail() {
        start("not-an-address").then().statusCode(400).contentType("application/problem+json");
        given().contentType(ContentType.JSON).body(Map.of("email", 7)).post("/auth/email")
                .then().statusCode(400);
        assertTrue(mail.sent.isEmpty());
    }

    @Test
    void startAnswersTheSameShapeForKnownAndUnknownAddresses() {
        UserDocs.seed(couch, EMAIL, d -> d.put("sub", "google|1")); // adapt to UserDocs' real API
        Response known = start(EMAIL);
        Response unknown = start("nobody@example.com");
        assertEquals(known.statusCode(), unknown.statusCode());
        assertEquals(known.body().jsonPath().getMap("").keySet(), unknown.body().jsonPath().getMap("").keySet());
    }

    @Test
    void theFourthCodeInTheWindowIsRefusedWhateverTheSpelling() {
        start(EMAIL).then().statusCode(202);
        start("ADA@EXAMPLE.COM").then().statusCode(202);
        start(" ada@example.com").then().statusCode(202);
        start(EMAIL).then().statusCode(429).contentType("application/problem+json");
        assertEquals(3, mail.sent.size());
    }

    @Test
    void verifyAnswersTokensForARecordlessAddressWithTheDerivedSubject() {
        String challenge = start(EMAIL).jsonPath().getString("challenge");
        Response r = given().contentType(ContentType.JSON).body(Map.of("code", codeFromMail()))
                .post("/auth/email/" + challenge);
        r.then().statusCode(200).header("Cache-Control", containsString("no-store"))
                .body("expiresIn", equalTo(300));
        var access = verifier.verify(r.jsonPath().getString("accessToken"), Purpose.ACCESS).orElseThrow();
        assertEquals(Emails.mailSubject(EMAIL), access.sub());
        // The refresh token round-trips at /auth/token, exactly like one minted after Google.
        given().contentType(ContentType.JSON)
                .body(Map.of("refreshToken", r.jsonPath().getString("refreshToken")))
                .post("/auth/token").then().statusCode(200);
        // Signing in created no record.
        assertFalse(couch.docs("matter_manager").keySet().stream().anyMatch(k -> k.startsWith("user:")));
        // One sign-in line, provider email, with the derived subject.
        assertTrue(logged.stream().anyMatch(l -> l.contains("\"provider\":\"email\"")
                && l.contains(Emails.mailSubject(EMAIL))));
    }

    @Test
    void verifyUsesTheCanonicalSubjectAndPlanOfAnExistingRecord() {
        UserDocs.seed(couch, EMAIL, d -> d.put("sub", "google|1").put("plan", "member"));
        String challenge = start(EMAIL).jsonPath().getString("challenge");
        Response r = given().contentType(ContentType.JSON).body(Map.of("code", codeFromMail()))
                .post("/auth/email/" + challenge);
        var access = verifier.verify(r.jsonPath().getString("accessToken"), Purpose.ACCESS).orElseThrow();
        assertEquals("google|1", access.sub());
        assertEquals(List.of("member"), access.claims().get("_couchdb.roles"));
    }

    @Test
    void everyVerifyFailureIsTheSameGeneric401() {
        String challenge = start(EMAIL).jsonPath().getString("challenge");
        String wrongChallenge = given().contentType(ContentType.JSON).body(Map.of("code", "000000"))
                .post("/auth/email/does-not-exist").then().statusCode(401).extract().asString();
        String wrongCode = given().contentType(ContentType.JSON).body(Map.of("code", "000000"))
                .post("/auth/email/" + challenge).then().statusCode(401).extract().asString();
        assertEquals(wrongChallenge, wrongCode); // indistinguishable bodies
        assertFalse(wrongCode.contains(EMAIL));
        // Wrong-type code is the same 401, not a 500.
        given().contentType(ContentType.JSON).body(Map.of("code", 123456))
                .post("/auth/email/" + challenge).then().statusCode(401);
    }

    @Test
    void fiveWrongCodesExhaustThenTheRightCodeIsRefused() {
        String challenge = start(EMAIL).jsonPath().getString("challenge");
        String code = codeFromMail();
        for (int i = 0; i < 5; i++) {
            given().contentType(ContentType.JSON).body(Map.of("code", "000000"))
                    .post("/auth/email/" + challenge).then().statusCode(401);
        }
        given().contentType(ContentType.JSON).body(Map.of("code", code))
                .post("/auth/email/" + challenge).then().statusCode(401);
    }

    @Test
    void aChallengeIsConsumedBySuccess() {
        String challenge = start(EMAIL).jsonPath().getString("challenge");
        String code = codeFromMail();
        given().contentType(ContentType.JSON).body(Map.of("code", code))
                .post("/auth/email/" + challenge).then().statusCode(200);
        given().contentType(ContentType.JSON).body(Map.of("code", code))
                .post("/auth/email/" + challenge).then().statusCode(401);
    }

    @Test
    void aFailedSendIsA500ProblemWithoutTheAddress() {
        mail.failWith = new io.mattermanager.app.mail.MailException("mail refused (status 400, code 1000)");
        Response r = start(EMAIL);
        r.then().statusCode(500).contentType("application/problem+json");
        assertFalse(r.body().asString().contains(EMAIL));
    }

    @Test
    void googleRoutesAre404HereWhileEmailServes() {
        given().redirects().follow(false).get("/auth/google").then().statusCode(404);
    }
}
```

And the reverse gate direction:

```java
@QuarkusTest
@TestProfile(GoogleSignInProfile.class)
@WithTestResource(GoogleStubResource.class)
class EmailGateTest {
    /** Google configured, mail not: email routes are absent, Google's are served. */
    @Test
    void emailRoutesAre404WithoutMailConfig() {
        given().contentType(ContentType.JSON).body(Map.of("email", "ada@example.com"))
                .post("/auth/email").then().statusCode(404).contentType("application/problem+json");
        given().contentType(ContentType.JSON).body(Map.of("code", "123456"))
                .post("/auth/email/abc").then().statusCode(404);
        given().redirects().follow(false).get("/auth/google").then().statusCode(302);
    }
}
```

(Adapt helper names — `UserDocs.seed`, `verifier.verify(...)`'s claim accessors, `couch.docs(...)` — to their real signatures; the assertions are the contract.)

- [ ] **Step 2: Run to verify failure** — `./mvnw test -Dtest='EmailSignInResourceTest,EmailGateTest'` — FAIL: 404s everywhere (no routes), and `OpenApiDriftTest` still red from Task 6.

- [ ] **Step 3: Implement the service**

```java
package io.mattermanager.app.auth;

import io.mattermanager.app.domain.Emails;
import io.mattermanager.app.domain.Plan;
import io.mattermanager.app.mail.MailException;
import io.mattermanager.app.mail.MailSender;
import io.mattermanager.app.mail.SignInMail;
import io.mattermanager.app.problem.Problem;
import io.mattermanager.app.problem.ProblemException;
import io.mattermanager.app.projects.InvitationRedeemer;
import io.mattermanager.app.security.RateLimiter;
import io.mattermanager.app.users.UserRecord;
import io.mattermanager.app.users.UserRecords;
import io.quarkus.runtime.annotations.RegisterForReflection;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import java.time.Duration;
import java.util.Objects;
import java.util.Optional;
import org.jboss.logging.Logger;

/**
 * Email sign-in (#spec 2026-10-12): a mailed one-time code plus a client-held challenge id,
 * answered with the same token body {@code POST /auth/token} answers. Identity is possession of
 * the address, so no {@code subjects} slot is written; the session subject is the record's
 * canonical sub, or {@link Emails#mailSubject} when there is no record. Signing in creates no
 * record. Logs carry subjects, never addresses or codes.
 */
@ApplicationScoped
public class EmailSignIn {
    private static final Logger LOG = Logger.getLogger(EmailSignIn.class);
    static final int MAX_SENDS = 3;
    static final Duration SEND_WINDOW = Duration.ofMinutes(15);
    private static final String PROVIDER = "email";
    private static final Problem BAD_ADDRESS = Problem.of(400, "email must be a valid email address");
    private static final Problem TOO_MANY = Problem.of(429, "Too many codes requested; wait before trying again.");
    private static final Problem FAILED = Problem.of(401, "Sign-in failed");
    private static final Problem NOT_SENT = Problem.of(500, "The sign-in code could not be sent.");

    /** The {@code POST /auth/email} body. */
    @RegisterForReflection
    public record Challenge(String challenge) {}

    @Inject EmailChallenges challenges;
    @Inject MailSender mail;
    @Inject RateLimiter limiter;
    @Inject TokenFactory tokens;
    @Inject RefreshTokens refresh;
    @Inject UserRecords records;
    @Inject InvitationRedeemer invitations;
    @Inject SignInLog signInLog;

    /**
     * Mails a code and answers the challenge id. One answer shape for known and unknown
     * addresses: any address may sign in, so there is nothing to enumerate.
     *
     * @throws ProblemException 400 for a malformed address, 429 beyond 3 codes per address per
     *     15 minutes (on the folded address, so spelling does not mint budget), 500 when the
     *     mail was not accepted
     */
    public Challenge start(String email, String locale) {
        if (!Emails.isValid(email)) {
            throw new ProblemException(BAD_ADDRESS);
        }
        String folded = Emails.fold(email);
        if (!limiter.check("email-send", folded, MAX_SENDS, SEND_WINDOW).allowed()) {
            throw new ProblemException(TOO_MANY);
        }
        EmailChallenges.Started started = challenges.start(folded);
        try {
            mail.send(SignInMail.compose(folded, "de".equals(locale) ? "de" : "en", started.code()));
        } catch (MailException e) {
            // The adapter's message carries status and vendor code only; the unredeemed
            // challenge dies by TTL on its own.
            LOG.errorf("sign-in code not sent (%s)", e.getMessage());
            throw new ProblemException(NOT_SENT);
        }
        return new Challenge(started.challenge());
    }

    /**
     * Verifies the code and issues the session, exactly as the first {@code POST /auth/token}
     * after a Google callback does: refresh minted and remembered as a hash, access minted with
     * the plan read now.
     *
     * @throws ProblemException one generic 401 for every refusal
     */
    public AuthService.TokenResponse verify(String challenge, String code) {
        String email = challenges.redeem(challenge, code)
                .orElseThrow(() -> new ProblemException(FAILED));
        // The canonical subject: the record's for life, derived when there is no record. An
        // operator-created record with no subject behaves as recordless here; its binding
        // follows the same path a Google sign-in takes (ensure, via accept).
        String sub = records.findByEmail(email).map(UserRecord::sub).filter(Objects::nonNull)
                .orElse(Emails.mailSubject(email));
        boolean hasRecord = invitations.accept(sub, email, null);
        signInLog.record(sub, email, PROVIDER, hasRecord);
        MintedToken minted = tokens.mintRefresh(sub, email, null);
        refresh.remember(sub, email, InMemoryRefreshStore.hashJti(minted.jti()), minted.expiresAt());
        Plan plan = records.findByEmail(email).map(UserRecord::plan).orElse(Plan.FREE);
        String access = tokens.mintAccess(sub, email, null, plan).jwt();
        return new AuthService.TokenResponse(access, 300, minted.jwt());
    }
}
```

(Match `RefreshTokens.remember`'s real parameter order to `AuthService.issueToken:153`; it is `(sub, email, hash, expiresAt)` today.)

- [ ] **Step 4: Implement the resource methods.** `AuthResource`'s constructor gains `EmailSignIn emailSignIn`; two methods, named for the drift test, reusing `ProfileResource.textField` (precedent: `CustomerResource` reuses `ProfileResource` helpers):

```java
/** Starts email sign-in: mails a code, answers the challenge id. */
@POST
@Path("/email")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public Response startEmailSignIn(JsonNode body) {
    EmailSignIn.Challenge challenge = emailSignIn.start(
            ProfileResource.textField(body, "email"), ProfileResource.textField(body, "locale"));
    return Response.status(202).entity(challenge).header("Cache-Control", "no-store").build();
}

/** Completes email sign-in: the code against the challenge, answered as {@code issueToken} answers. */
@POST
@Path("/email/{challenge}")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public Response completeEmailSignIn(@PathParam("challenge") String challenge, JsonNode body) {
    AuthService.TokenResponse issued = emailSignIn.verify(challenge, ProfileResource.textField(body, "code"));
    return Response.ok(issued).header("Cache-Control", "no-store").build();
}
```

(If `ProfileResource.textField` is not visible/static-importable across the package as `CustomerResource` uses it, mirror its exact visibility usage. A non-string field reads as null and fails validation downstream — that is the wrong-type behavior the tests pin.)

- [ ] **Step 5: Contract-validation coverage.** In `ContractValidationTest`, add one happy-path call per operation (`startEmailSignIn`: POST a valid body, expect 202; `completeEmailSignIn`: start first, read the code from the injected `FakeMailSender`, then verify, expect 200), update the "all 20" Javadoc to the new total, and extend `ContractProfile` with the mail overrides and the `FakeMailSender` alternative (same keys as `EmailSignInProfile`).

- [ ] **Step 6: Run the full fast suite** — `./mvnw test` — everything green including `OpenApiDriftTest`, `ContractValidationTest`, `ArchitectureTest` (constructor injection, static privates, `@RegisterForReflection` on `EmailSignIn.Challenge`).

- [ ] **Step 7: Commit** — `feat: email sign-in with mailed one-time codes (POST /auth/email, /auth/email/{challenge})`

### Task 8: Docs and the full gate

**Files:**
- Modify: `README.md` (configuration table + a route-group section)
- Modify: `docs/` infra notes if a deployment doc exists (search for where `GOOGLE_*` setup is described and put mail setup beside it)

**Interfaces:** none — documentation and verification.

- [ ] **Step 1: README configuration table** gains:

```markdown
| `MAIL_API_TOKEN`, `MAIL_ACCOUNT_ID`, `MAIL_FROM` | Cloudflare Email Service: API token with email-sending permission, the account id, and the sender address (a domain onboarded to Email Sending). All three set enables `POST /auth/email`; otherwise those routes are absent. `MAIL_API_BASE` overrides the API host for tests. |
```

- [ ] **Step 2: README route-group section** (beside the Google sign-in section):

```markdown
### Email sign-in: `POST /auth/email` and `POST /auth/email/{challenge}`

A signed-out user asks for a code (`{"email": ..., "locale": "en"|"de"}`), receives it by mail,
and presents it with the challenge id from the first answer. The secret is split: the code lives
only in the mailbox, the challenge id only in the requesting client. Success answers exactly what
`POST /auth/token` answers. 3 codes per address per 15 minutes, 10-minute validity, 5 attempts,
one generic 401 for every failure. Signing in creates no record; the session subject is the
record's canonical `sub`, or `mail:<hash>` derived from the folded address when there is none.

One-time setup: onboard the sending domain (`npx wrangler email sending enable matter-manager.io`
or the dashboard, which installs SPF/DKIM/DMARC on the zone) and create an API token with email
sending permission.
```

- [ ] **Step 3: Full gate** — `./mvnw verify -DskipITs=false` with Docker running. Every test green, JaCoCo gates (bundle ≥ 0.70, domain ≥ 0.90) passing, zero warnings in the output. Fix anything it surfaces before committing.
- [ ] **Step 4: Commit** — `docs: email sign-in configuration and operator setup`
- [ ] **Step 5: Push and open the PR** (`gh pr create --base main --head feat/email-signin --body-file …`), body ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Do not merge.

---

## Deliberate scope notes

- **No FakeCouch emitter for `by_identity`** and **no `UserRecord.subjects` component**: nothing in piece 1 reads them (`resolveIdentity` works on the raw document; the view is operator/piece-2 surface). Piece 2 adds both with their first consumer. Precedent: `by_plan_requested` ships without an emitter.
- **No `bindIdentity` beyond `resolveIdentity`**, no linked-methods API: piece 3's settings UI brings the read surface.
- **Refresh rotation** stays as it is (`#209` upstream): verify mints a fresh refresh token, `/auth/token` returns it unrotated, matching Google-flow behavior exactly.
