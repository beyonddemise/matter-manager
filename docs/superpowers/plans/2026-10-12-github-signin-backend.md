# GitHub Sign-In (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /auth/github` + `GET /auth/github/callback` sign a GitHub account into the piece-1 account model, and `GET /auth/methods` tells clients which sign-in methods this deployment serves.

**Architecture:** A mirror of the Google pair: a self-contained `GitHubFlow` (authorize URL + PKCE S256 + signed `mm_flow` carrier; code exchange; `/user` and `/user/emails` reads), joining `AuthService` at a shared `finishSignIn` tail — `resolveIdentity("github", id, verifiedPrimaryEmail)`, invitations, `SignInLog`, handoff cookie. `AuthMethods` answers the same `Features` predicates that gate the routes.

**Tech Stack:** Quarkus 4 (quarkus-rest, Jackson 3 `tools.jackson.*`), `java.net.http`, WireMock + FakeCouch in tests, JaCoCo gates (bundle ≥0.70, domain ≥0.90).

**Spec:** `/Users/stw/Code/matter-manager/docs/superpowers/specs/2026-10-12-github-signin-design.md`. **Repo:** `/Users/stw/Code/matter-manager-backend`, branched off `feat/email-signin` (PR #7) — this piece consumes `resolveIdentity` and the first-match gate from it. Frontend counterpart: `2026-10-12-github-signin-frontend.md` (ships after).

> **Amended 2026-10-13**, after the whole-branch review (the code merged in matter-manager-backend
> PR #8 is the record):
>
> - A record-less GitHub sign-in mints the **namespaced** canonical subject `github:<id>` (spec
>   Decision 5 as amended), never the bare numeric id — Task 3's original `signsInAndHandsOff`
>   expectation was the review's Critical and is corrected below.
> - The spec's "GitHub-first then Google" auto-link direction was missing from Task 3's test
>   list (the gap that hid the Critical; see `docs/tasks/lessons.md`). It is covered in
>   `UserRecordsTest.aGitHubBornAccountLaterLinksGoogleInsteadOfLockingItOut` at
>   `resolveIdentity` — the single joining point both providers' HTTP tails share, each tail
>   being proven by its own resource suite.
> - The spec's "no-email refused" line is owned by `GitHubFlowTest.refusesAnEmptyOrMalformedList`
>   (flow level); its HTTP failure shape rides the same `UNVERIFIED` path that
>   `refusesAnUnverifiedPrimary` pins over full HTTP.
> - Superseded later the same day (backend PR #9): Google's bare-sub exception and the legacy
>   heuristic were removed entirely — every record-less sign-in namespaces, `google:…` included,
>   and the born provider's slot is implied by the canonical sub's namespace. A full-HTTP
>   GitHub-then-Google test (`aGitHubBornAccountLaterSignsInWithGoogleOntoTheSameRecord`) landed
>   with it.

## Global Constraints

- Branch `feat/github-signin` off `feat/email-signin`; rebase onto `main` if #7 merges first.
- **No address, access token, code, state or verifier in any log line, problem body or response.** `SignInException` problem codes are the only loggable failure detail. The GitHub access token exists only inside the callback handler.
- Scope `user:email`, PKCE `S256` only, state checked constant-time — exactly `OidcFlow`'s posture.
- ArchUnit rules hold: constructor-free `@Inject` fields in `api`, static private helpers, `@RegisterForReflection` on response records.
- Drift law: resource method name == operationId (`startGitHubSignIn`, `completeGitHubSignIn`, `getAuthMethods`).
- The contract in `src/main/resources/openapi.yaml` is the record; matter-manager's root copy mirrors it (frontend plan Task 5).
- Verify bar: `./mvnw verify -DskipITs=false` green; JaCoCo gates hold.
- Commits: conventional, ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Review Focus

1. **A GitHub account whose only verified address is non-primary** must be refused (spec: primary AND verified) → Task 3's `rejectsNonPrimaryVerified` test.
2. **A flow carrier minted for Google must not resume a GitHub callback** (or vice versa) → Task 2's provider-claim test.
3. **`/auth/methods` on a mail-only deployment** (Google unconfigured) must answer 200 with `google: false` — not 404 → Task 5's gate matrix test.
4. **A GitHub API answer with a 200 but non-JSON or field-missing body** must fail the sign-in, never NPE → Task 2's malformed-answer tests.
5. **`subjects.github` write-once under race** (two concurrent first sign-ins) — `resolveIdentity`'s `readModifyWrite` covers it; Task 3's conflict test pins the 409-shaped refusal surfaces as `?signin=failed`.

---

### Task 1: Configuration, feature flag and gates

**Files:**
- Create: `src/main/java/io/mattermanager/app/config/GitHubConfig.java`
- Modify: `src/main/java/io/mattermanager/app/config/Features.java` (add `github()`, extend `session()`)
- Modify: `src/main/java/io/mattermanager/app/config/FeatureGateFilter.java` (two gate rows)
- Test: `src/test/java/io/mattermanager/app/api/GitHubGateTest.java`

**Interfaces:**
- Produces: `GitHubConfig { Optional<String> clientId(); Optional<String> clientSecret(); String redirectUri() — Optional; String webBase() default "https://github.com"; String apiBase() default "https://api.github.com" }`; `Features.github(): boolean`; gates `auth/github → Features::github` and `auth/methods → Features::session` listed **before** `auth`.

- [ ] **Step 1: Write the failing gate test**

```java
package io.mattermanager.app.api;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.is;

import io.mattermanager.app.testsupport.EmailSignInProfile;
import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.TestProfile;
import org.junit.jupiter.api.Test;

/**
 * GitHub routes are absent when GitHub is unconfigured, while the rest of auth keeps working —
 * the EmailGateTest pattern. The mail profile configures email and Google, not GitHub.
 */
@QuarkusTest
@TestProfile(EmailSignInProfile.class)
class GitHubGateTest {

    @Test
    void gitHubRoutesAnswer404WhenUnconfigured() {
        given().redirects().follow(false).get("/auth/github").then().statusCode(404);
        given().redirects().follow(false).get("/auth/github/callback").then().statusCode(404);
    }

    @Test
    void methodsStillAnswersAndSaysSo() {
        given().get("/auth/methods").then().statusCode(200)
                .body("github", is(false));
    }
}
```

- [ ] **Step 2: Run to verify failure** — `./mvnw test -Dtest=GitHubGateTest` — FAIL (404 on `/auth/methods` too: no gate row, no resource yet; the first test may pass by accident of the broad auth gate — read the output and note which assertion carries the failure).
- [ ] **Step 3: Implement**

`GitHubConfig.java`:

```java
package io.mattermanager.app.config;

import io.smallrye.config.ConfigMapping;
import io.smallrye.config.WithDefault;
import java.util.Optional;

/** GitHub OAuth App ({@code GITHUB_CLIENT_ID}, {@code GITHUB_CLIENT_SECRET}, {@code GITHUB_REDIRECT_URI}). */
@ConfigMapping(prefix = "github")
public interface GitHubConfig {
    /** @return OAuth App client id */
    Optional<String> clientId();

    /** @return OAuth App client secret */
    Optional<String> clientSecret();

    /** @return registered callback URL ({@code .../api/auth/github/callback}) */
    Optional<String> redirectUri();

    /** @return github.com, overridable ({@code GITHUB_WEB_BASE}) so tests point authorize/token at a stub */
    @WithDefault("https://github.com")
    String webBase();

    /** @return api.github.com, overridable ({@code GITHUB_API_BASE}) for the same reason */
    @WithDefault("https://api.github.com")
    String apiBase();
}
```

`Features.java` — add below `mail()`, and extend `session()`:

```java
    /** @return GitHub sign-in is served (CouchDB, both keys, session key, app origin, and the OAuth App are all set) */
    public boolean github() {
        return couch() && accessKey()
                && Env.present(jwt.sessionPrivateKey()).isPresent()
                && Env.present(app.origin()).isPresent()
                && Env.present(gitHub.clientId()).isPresent()
                && Env.present(gitHub.clientSecret()).isPresent()
                && Env.present(gitHub.redirectUri()).isPresent();
    }
```

with `@Inject GitHubConfig gitHub;` beside the other configs, and `session()` becomes
`return auth() || mail() || github();` (its Javadoc keeps saying: whatever mints a session must
also refresh and end it).

`FeatureGateFilter.java` — two rows before the `auth/token` row, keeping the comment style:

```java
            // Before "auth", like auth/email: GitHub is served whenever it is configured, with or without Google.
            new Gate("auth/github", Features::github),
            // Discovery answers wherever any sign-in method exists: a chooser needs it before any session does.
            new Gate("auth/methods", Features::session),
```

- [ ] **Step 4: Run** — `./mvnw test -Dtest=GitHubGateTest` — the gate test's `/auth/github` assertions PASS; `methodsStillAnswersAndSaysSo` still FAILS (no resource yet — that is Task 5's green; leave the test `@Disabled("until Task 5")` is **not** allowed: instead move `methodsStillAnswersAndSaysSo` to Task 5's test file and keep only the 404 test here, so this task ends green). Final state of this task: `GitHubGateTest` holds only `gitHubRoutesAnswer404WhenUnconfigured`, passing.
- [ ] **Step 5: Commit** — `feat(config): GitHub OAuth App config, feature flag and route gates`

### Task 2: GitHubFlow — the dance, the exchange, and the identity reads

**Files:**
- Create: `src/main/java/io/mattermanager/app/auth/GitHubFlow.java`
- Test: `src/test/java/io/mattermanager/app/auth/GitHubFlowTest.java` (pure parts) — the HTTP halves are covered end to end in Task 3's resource test over WireMock.

**Interfaces:**
- Consumes: `TokenFactory.mintFlow(Map)`, `TokenVerifier.verify(jwt, Purpose.FLOW)`, `GitHubConfig`, `SignInException`.
- Produces:

```java
public record Started(URI authorizeUrl, String carrier) {}
public record Resumed(String verifier, String returnTo) {}
/** The two identity facts the account model needs; nothing else leaves the flow. */
public record GitHubIdentity(String id, String email) {}

public Started begin(String returnTo)
public Resumed resume(String carrier, String returnedState)   // refuses a carrier minted for another provider
public String exchange(String code, Resumed flow)             // -> the GitHub access token (never logged, never stored)
public GitHubIdentity identity(String accessToken)            // /user + /user/emails; primary && verified, else UNVERIFIED
```

- [ ] **Step 1: Write the failing tests** (pure parts: the provider claim and the email pick)

```java
package io.mattermanager.app.auth;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** The parts of the GitHub flow that run without a network: carrier hygiene and the email pick. */
class GitHubFlowTest {
    private static final JsonMapper M = JsonMapper.builder().build();

    @Test
    void picksThePrimaryVerifiedAddress() {
        var emails = M.readTree(
                """
                [{"email":"old@example.com","primary":false,"verified":true},
                 {"email":"ada@example.com","primary":true,"verified":true}]
                """);
        assertEquals("ada@example.com", GitHubFlow.primaryVerified(emails).orElseThrow());
    }

    @Test
    void refusesAPrimaryTheProviderDidNotVerify() {
        var emails = M.readTree(
                """
                [{"email":"side@example.com","primary":false,"verified":true},
                 {"email":"ada@example.com","primary":true,"verified":false}]
                """);
        assertTrue(GitHubFlow.primaryVerified(emails).isEmpty());
    }

    @Test
    void refusesAnEmptyOrMalformedList() {
        assertTrue(GitHubFlow.primaryVerified(M.readTree("[]")).isEmpty());
        assertTrue(GitHubFlow.primaryVerified(M.readTree("{\"message\":\"rate limited\"}")).isEmpty());
    }
}
```

- [ ] **Step 2: Run to verify failure** — `./mvnw test -Dtest=GitHubFlowTest` — FAIL: class missing.
- [ ] **Step 3: Implement** `GitHubFlow.java`. Deliberately a sibling of `OidcFlow`, not a refactor of it: the two providers share a *shape* (state + PKCE + signed carrier) but not a protocol (OIDC id_token vs two REST reads), and coupling them would make every Google change a GitHub review. The small statics (`form`, `random`, `challenge`, `sha256`) are duplicated with a comment saying where the twin lives.

```java
package io.mattermanager.app.auth;

import io.mattermanager.app.config.GitHubConfig;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Authorization code with PKCE against GitHub (an OAuth App on github.com; Enterprise Server has no PKCE and is out of
 * scope). The shape mirrors {@link OidcFlow} deliberately without sharing code: the two providers share a dance, not a
 * protocol — Google answers an ID token, GitHub answers an access token that two REST reads turn into an identity.
 *
 * <p>The carrier claims include {@code provider: "github"}, and {@link #resume} refuses a carrier without it: a flow
 * started at one provider must not complete at another's callback, even though the code exchange would fail anyway —
 * defense in depth is cheaper than reasoning about what a confused deputy could do with a half-finished flow.
 *
 * <p>The GitHub access token is returned to the caller, used for the two reads, and discarded. It is never stored and
 * never logged.
 */
@ApplicationScoped
public class GitHubFlow {
    private static final JsonMapper M = JsonMapper.builder().build();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
    /** {@code user:email} opens {@code GET /user/emails}; {@code GET /user} answers the id with any token. */
    static final String SCOPES = "user:email";
    private static final String PROVIDER = "github";

    /** Where to send the browser, and the signed carrier to set as the {@code mm_flow} cookie. */
    public record Started(URI authorizeUrl, String carrier) {}

    /** What came back across the redirect. */
    public record Resumed(String verifier, String returnTo) {}

    /** The two identity facts the account model needs; nothing else leaves this class. */
    public record GitHubIdentity(String id, String email) {}

    @Inject GitHubConfig config;
    @Inject TokenFactory tokens;
    @Inject TokenVerifier verifier;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    /** Starts a sign-in; {@code returnTo} is collapsed to a local path exactly as the Google flow does. */
    public Started begin(String returnTo) {
        String state = random(32);
        String codeVerifier = random(48);

        Map<String, String> q = new LinkedHashMap<>();
        q.put("client_id", config.clientId().orElseThrow());
        q.put("redirect_uri", config.redirectUri().orElseThrow());
        q.put("scope", SCOPES);
        q.put("state", state);
        q.put("code_challenge", challenge(codeVerifier));
        q.put("code_challenge_method", "S256");
        URI url = URI.create(config.webBase() + "/login/oauth/authorize?" + form(q));

        String carrier = tokens.mintFlow(Map.of(
                "provider", PROVIDER, "state", state, "verifier", codeVerifier,
                "returnTo", OidcFlow.safeReturnTo(returnTo))).jwt();
        return new Started(url, carrier);
    }

    /**
     * Reads and checks the carrier against the state GitHub sent back, refusing a carrier minted for another provider.
     *
     * @throws SignInException (STATE) for a missing, expired, forged, mismatched or foreign carrier — one answer for all
     */
    public Resumed resume(String carrier, String returnedState) {
        if (carrier == null || returnedState == null) {
            throw state("The sign-in could not be matched to a request from this app.");
        }
        VerifiedToken flow = verifier.verify(carrier, Purpose.FLOW)
                .orElseThrow(() -> state("The sign-in request is no longer valid."));
        if (!PROVIDER.equals(flow.claims().get("provider"))) {
            throw state("The sign-in request was started with a different provider.");
        }
        Object expected = flow.claims().get("state");
        Object codeVerifier = flow.claims().get("verifier");
        if (!(expected instanceof String s) || !(codeVerifier instanceof String v)) {
            throw state("The sign-in request could not be read.");
        }
        if (!MessageDigest.isEqual(s.getBytes(StandardCharsets.UTF_8), returnedState.getBytes(StandardCharsets.UTF_8))) {
            throw state("The sign-in did not come from a request this app started.");
        }
        Object returnTo = flow.claims().get("returnTo");
        return new Resumed(v, returnTo instanceof String r ? OidcFlow.safeReturnTo(r) : "/");
    }

    /**
     * Exchanges the code for GitHub's access token, server to server with the client secret and the PKCE verifier.
     *
     * @throws SignInException (EXCHANGE) when GitHub refuses or answers unreadably; the body is never logged (it carries
     *     the token)
     */
    public String exchange(String code, Resumed flow) {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("client_id", config.clientId().orElseThrow());
        f.put("client_secret", config.clientSecret().orElseThrow());
        f.put("code", code);
        f.put("redirect_uri", config.redirectUri().orElseThrow());
        f.put("code_verifier", flow.verifier());
        JsonNode body = post(config.webBase() + "/login/oauth/access_token", form(f));
        String token = body.path("access_token").asString("");
        if (token.isEmpty()) {
            throw exchange("The identity provider refused the sign-in ("
                    + body.path("error").asString("no_token") + ").");
        }
        return token;
    }

    /**
     * The numeric user id and the primary, verified address — the only two facts that leave this class.
     *
     * @throws SignInException (IDENTITY) when {@code /user} has no id; (UNVERIFIED) when no primary verified address
     *     exists — records are keyed by the address, so one GitHub did not vouch for would let somebody sign in as
     *     whoever they claimed
     */
    public GitHubIdentity identity(String accessToken) {
        JsonNode user = get(config.apiBase() + "/user", accessToken);
        long id = user.path("id").asLong(0);
        if (id <= 0) {
            throw new SignInException(SignInException.Problem.IDENTITY, "The provider's account answer had no id.");
        }
        Optional<String> email = primaryVerified(get(config.apiBase() + "/user/emails", accessToken));
        return new GitHubIdentity(String.valueOf(id),
                email.orElseThrow(() -> new SignInException(SignInException.Problem.UNVERIFIED,
                        "The provider did not verify this address.")));
    }

    /** The {@code primary && verified} address, or empty — also empty for a body that is not a list. */
    static Optional<String> primaryVerified(JsonNode emails) {
        if (!emails.isArray()) {
            return Optional.empty();
        }
        for (JsonNode e : emails) {
            if (e.path("primary").asBoolean(false) && e.path("verified").asBoolean(false)) {
                String address = e.path("email").asString("");
                return address.isEmpty() ? Optional.empty() : Optional.of(address);
            }
        }
        return Optional.empty();
    }

    private JsonNode post(String url, String formBody) {
        return send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/x-www-form-urlencoded").header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(formBody)).build());
    }

    private JsonNode get(String url, String accessToken) {
        return send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer " + accessToken)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28").GET().build());
    }

    /** One place for the transport failures, so every call answers EXCHANGE without logging a body. */
    private JsonNode send(HttpRequest request) {
        HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw exchange("The sign-in was interrupted.");
        } catch (Exception e) {
            throw exchange("The identity provider could not be reached.");
        }
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw exchange("The identity provider refused (" + response.statusCode() + ").");
        }
        try {
            return M.readTree(response.body());
        } catch (RuntimeException e) {
            throw exchange("The identity provider's answer was not readable.");
        }
    }

    // The twins of OidcFlow's statics, duplicated by decision: a shared util would couple two providers' reviews.
    private static String form(Map<String, String> params) {
        StringBuilder sb = new StringBuilder();
        params.forEach((k, v) -> {
            if (sb.length() > 0) {
                sb.append('&');
            }
            sb.append(URLEncoder.encode(k, StandardCharsets.UTF_8)).append('=').append(URLEncoder.encode(v, StandardCharsets.UTF_8));
        });
        return sb.toString();
    }

    private static String random(int bytes) {
        byte[] b = new byte[bytes];
        RANDOM.nextBytes(b);
        return B64.encodeToString(b);
    }

    private static String challenge(String codeVerifier) {
        try {
            return B64.encodeToString(MessageDigest.getInstance("SHA-256").digest(codeVerifier.getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static SignInException state(String message) {
        return new SignInException(SignInException.Problem.STATE, message);
    }

    private static SignInException exchange(String message) {
        return new SignInException(SignInException.Problem.EXCHANGE, message);
    }
}
```

Note: `OidcFlow.safeReturnTo` is already package-visible (`static String`); reusing it is the one
sanctioned share — it is provider-independent URL hygiene. The Google carrier gains **no**
provider claim (legacy carriers must keep resuming); only the GitHub side filters, which is
enough: a GitHub carrier never resumes at Google *with a wrong state*, and a Google carrier is
refused at GitHub by the missing claim.

- [ ] **Step 4: Run** — `./mvnw test -Dtest=GitHubFlowTest` — PASS.
- [ ] **Step 5: Commit** — `feat(auth): GitHubFlow — PKCE dance, code exchange, verified-primary identity`

### Task 3: AuthService + resource: the two routes, joined at the shared tail

**Files:**
- Modify: `src/main/java/io/mattermanager/app/auth/AuthService.java` (extract `finishSignIn`, add `startGitHub`/`completeGitHub`)
- Modify: `src/main/java/io/mattermanager/app/api/AuthResource.java` (two methods)
- Create: `src/test/java/io/mattermanager/app/testsupport/GitHubStub.java`, `GitHubStubResource.java`, `GitHubSignInProfile.java` (the `GoogleStub`/`GoogleStubResource`/`GoogleSignInProfile` pattern: WireMock serving `POST /login/oauth/access_token`, `GET /user`, `GET /user/emails`; profile sets `github.client-id`, `github.client-secret`, `github.redirect-uri`, `github.web-base`, `github.api-base` at the stub, plus the FakeCouch/app-origin base — copy the Google trio and adjust names and endpoints; `@InjectGitHubStub` annotation mirrors `@InjectGoogleStub`)
- Test: `src/test/java/io/mattermanager/app/api/GitHubResourceTest.java`

**Interfaces:**
- Consumes: `GitHubFlow` (Task 2), `UserRecords.resolveIdentity`, `InvitationRedeemer.accept`, `SignInLog.record`, `TokenFactory.mintHandoff`, `Cookies`.
- Produces: `AuthService.startGitHub(String returnTo): SignInRedirect`; `AuthService.completeGitHub(String code, String state, String error, String flowCookie): CallbackResult`; resource methods `startGitHubSignIn`, `completeGitHubSignIn` (names are the drift law).

- [ ] **Step 1: Write the failing resource tests.** Mirror `AuthResourceTest`'s harness (its `begin`/`callback` helpers, adjusted to `/auth/github`); the stub's happy path answers the token exchange with `{"access_token":"gh-token","token_type":"bearer"}`, `/user` with `{"id": 8341702, "login": "ada"}`, `/user/emails` with a primary+verified `ada@example.com`. Tests, each a `@Test` over the full HTTP flow:
  - `signsInAndHandsOff`: begin → callback with the echoed state → 302 to app origin, `mm_handoff` set, `mm_flow` cleared; then `POST /auth/token` answers a pair whose access token's `sub` is `github:8341702` (no record: the canonical subject is minted namespaced per spec Decision 5; `subjects.github` still keeps the bare id) and whose `_couchdb.roles` carries `free`; the sign-in log line carries `provider=github`.
  - `linksIntoAnEmailBornAccount`: seed FakeCouch with a user record `sub: "mail:abc…", email: ada@example.com, no subjects`; the flow answers a token whose `sub` is the record's `mail:` sub, and the stored record gains `subjects.github = "8341702"`.
  - `refusesASecondGitHubIdentityOnTheSameAddress`: seed the record with `subjects.github = "999"`; callback redirects `?signin=failed`, no handoff, nothing changed.
  - `refusesAnUnverifiedPrimary`: `/user/emails` answers primary+unverified → `?signin=failed`, no handoff, and the sign-in log stays empty.
  - `rejectsNonPrimaryVerified`: emails `[ {verified non-primary}, {primary unverified} ]` → `?signin=failed` (Review Focus 1).
  - `refusesACarrierMintedForGoogle` (Review Focus 2): the profile configures Google too (config only; no Google stub is needed, because `GET /auth/google` mints its carrier without any network). Begin at `/auth/google`, take that response's `mm_flow` value and its consent-screen `state`, and present **both** at `/auth/github/callback?code=x&state=<that state>` → `?signin=failed`, no handoff: the state matches its own carrier, and only the missing `provider: "github"` claim refuses it.
  - `refusesAMismatchedState`: begin at `/auth/github` twice; present the first flow's cookie with the second's state → `?signin=failed`.
  - `cancelAtConsent`: callback with `error=access_denied` → 302 to `/`, both cookies cleared, nothing written, sign-in log empty.
  - `malformedUserAnswerFails`: `/user` answers `{}` → `?signin=failed` (Review Focus 4).
- [ ] **Step 2: Run to verify failure** — `./mvnw test -Dtest=GitHubResourceTest` — FAIL: 404 (no routes).
- [ ] **Step 3: Implement.**

In `AuthService`, extract the Google tail into one private method and use it from both providers
(the Google path's behavior is unchanged — same log line, same cookies, same redirects):

```java
    /** The provider-independent tail: resolve, redeem, log, hand off. Throws SignInException upward. */
    private CallbackResult finishSignIn(String provider, String providerSub, String email, String name,
            String returnTo, Cookies cookies) {
        String canonical = records.resolveIdentity(provider, providerSub, email);
        boolean hasRecord = invitations.accept(canonical, email, name);
        signInLog.record(canonical, email, provider, hasRecord);
        String handoff = tokens.mintHandoff(canonical, email, name).jwt();
        return new CallbackResult(URI.create(origin() + returnTo),
                List.of(cookies.clear(Cookies.FLOW), cookies.set(Cookies.HANDOFF, handoff, (int) HANDOFF_SECONDS)));
    }
```

`complete(...)` (Google) calls it after verifying the address; the new GitHub pair:

```java
    @Inject GitHubFlow gitHub;

    /** Starts GitHub sign-in: the consent-screen URL and the flow cookie (600 s). */
    public SignInRedirect startGitHub(String returnTo) {
        GitHubFlow.Started started = gitHub.begin(returnTo);
        return new SignInRedirect(started.authorizeUrl(), cookies().set(Cookies.FLOW, started.carrier(), 600));
    }

    /** Completes GitHub sign-in; failure shapes are byte for byte the Google callback's. */
    public CallbackResult completeGitHub(String code, String state, String error, String flowCookie) {
        Cookies cookies = cookies();
        List<NewCookie> cleared = List.of(cookies.clear(Cookies.FLOW), cookies.clear(Cookies.HANDOFF));
        if (error != null || code == null) {
            return new CallbackResult(URI.create(origin() + "/"), cleared);
        }
        try {
            GitHubFlow.Resumed resumed = gitHub.resume(flowCookie, state);
            GitHubFlow.GitHubIdentity who = gitHub.identity(gitHub.exchange(code, resumed));
            // GitHub has no display name this flow asks for (scope user:email): the record's name, when one is ever
            // kept, comes from the profile the user edits, not from the provider.
            return finishSignIn("github", who.id(), who.email(), null, resumed.returnTo(), cookies);
        } catch (RuntimeException e) {
            LOG.warnf("sign-in did not complete (%s)",
                    e instanceof SignInException s ? s.problem() : "unknown:" + e.getClass().getSimpleName());
            return new CallbackResult(URI.create(origin() + "/?signin=failed"), cleared);
        }
    }
```

(`SubjectConflictException` is a `RuntimeException` and lands in the same catch, exactly as it
does for Google — a conflicting identity is a failed sign-in to the browser, and the warn line
carries only the class-derived code. Check what `complete(...)` logs for it today and keep that.)

In `AuthResource`, below the Google pair, same idiom:

```java
    /**
     * Starts GitHub sign-in.
     *
     * @return 302 to GitHub's consent screen with the flow cookie
     */
    @GET
    @Path("/github")
    public Response startGitHubSignIn(@QueryParam("returnTo") String returnTo) {
        AuthService.SignInRedirect r = auth.startGitHub(returnTo);
        return Response.status(302).header("Location", r.location().toString()).cookie(r.flowCookie()).build();
    }

    /**
     * Completes GitHub sign-in.
     *
     * @return 302 to the application, with the handoff cookie on success and no handoff on failure
     */
    @GET
    @Path("/github/callback")
    public Response completeGitHubSignIn(@QueryParam("code") String code, @QueryParam("state") String state,
            @QueryParam("error") String error, @CookieParam("mm_flow") String flowCookie) {
        AuthService.CallbackResult r = auth.completeGitHub(code, state, error, flowCookie);
        Response.ResponseBuilder b = Response.status(302).header("Location", r.location().toString());
        r.cookies().forEach(b::cookie);
        return b.build();
    }
```

- [ ] **Step 4: Run** — `./mvnw test -Dtest='GitHubResourceTest,AuthResourceTest'` — PASS (the Google suite proves the extraction changed nothing).
- [ ] **Step 5: Commit** — `feat(auth): GitHub sign-in routes joining the canonical-subject tail`

### Task 4: Contract — three operations and the AuthMethods schema

**Files:**
- Modify: `src/main/resources/openapi.yaml`
- Modify: `src/test/java/io/mattermanager/app/ContractFixtureTest.java` (EXPECTED set)

- [ ] **Step 1: Extend EXPECTED** by `"getAuthMethods", "startGitHubSignIn", "completeGitHubSignIn"`; run `./mvnw test -Dtest='ContractFixtureTest,OpenApiDriftTest'` — FAIL (counts and names).
- [ ] **Step 2: Add to the contract.** `/auth/methods` before `/auth/google`; the GitHub pair right after the Google pair, shaped like it:

```yaml
  /auth/methods:
    get:
      operationId: getAuthMethods
      tags: [auth]
      summary: Which sign-in methods this deployment serves
      description: |
        Answered from the same feature flags that gate the routes, so it never advertises a
        method whose route would 404. Public: a sign-in chooser needs it before any session
        exists. Later sign-in methods extend this object.
      security: []
      responses:
        '200':
          description: One flag per method
          headers:
            Cache-Control:
              schema: { type: string }
              description: public, max-age=300 — it changes only on redeploy
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AuthMethods' }

  /auth/github:
    get:
      operationId: startGitHubSignIn
      tags: [auth]
      summary: Begin GitHub sign-in
      description: Redirects to GitHub's consent screen using authorization code + PKCE (S256).
      security: []
      responses:
        '302':
          description: Redirect to GitHub

  /auth/github/callback:
    get:
      operationId: completeGitHubSignIn
      tags: [auth]
      summary: Complete GitHub sign-in
      description: |
        The identity is the account's numeric id; the address is the **verified primary** from
        `GET /user/emails` — an account without one is refused. Auto-links into the canonical
        account by that address, exactly as the Google callback does.
      security: []
      parameters:
        - { name: code, in: query, required: true, schema: { type: string } }
        - { name: state, in: query, required: true, schema: { type: string } }
      responses:
        '302':
          description: |
            Redirect to the web app with the two-minute, single-use, `HttpOnly` `mm_handoff`
            cookie set on success. On failure — a refused state, an unverified or missing
            primary address, or a provider slot already bound to another GitHub account — the
            redirect carries `?signin=failed` and no handoff.
```

and under `components/schemas`, beside `EmailSignInStart`:

```yaml
    AuthMethods:
      type: object
      required: [google, github, email]
      properties:
        google: { type: boolean }
        github: { type: boolean }
        email: { type: boolean }
      description: >-
        One flag per sign-in method this deployment serves. A later method is a new required
        field here and in the mirror at once.
```

- [ ] **Step 3: Run** — `./mvnw test -Dtest='ContractFixtureTest,OpenApiDriftTest'` — the fixture passes; drift FAILS on `getAuthMethods` (no resource method yet) — that failure belongs to Task 5 and proves the law works; proceed directly to Task 5 before committing, and commit both together there if the repo's hooks run tests per commit. Otherwise: **Step 4: Commit** — `docs(contract): /auth/methods and the GitHub sign-in pair` (acceptable red-on-drift for one commit only if the repo's verify is per-PR; if per-commit, fold into Task 5's commit).

### Task 5: `GET /auth/methods`

**Files:**
- Modify: `src/main/java/io/mattermanager/app/api/AuthResource.java` (one method + response record)
- Test: `src/test/java/io/mattermanager/app/api/AuthMethodsTest.java`

**Interfaces:**
- Consumes: `Features` (Task 1).
- Produces: `getAuthMethods(): Response` answering `AuthMethods(google, github, email)` with `Cache-Control: public, max-age=300` (the `PlansResource.PUBLIC_CACHE` constant's value; reuse or mirror it).

- [ ] **Step 1: Write the failing tests** — three profiles, one truth each (the gate matrix):

```java
package io.mattermanager.app.api;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.is;

import io.mattermanager.app.testsupport.EmailSignInProfile;
import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.TestProfile;
import org.junit.jupiter.api.Test;

/** Mail and Google configured, GitHub not: the answer mirrors the gates, and is cacheable. */
@QuarkusTest
@TestProfile(EmailSignInProfile.class)
class AuthMethodsTest {

    @Test
    void answersEachFlagFromItsGate() {
        given().get("/auth/methods").then().statusCode(200)
                .header("Cache-Control", is("public, max-age=300"))
                .body("google", is(true))
                .body("github", is(false))
                .body("email", is(true));
    }
}
```

plus, in Task 3's `GitHubResourceTest` (GitHub + Google configured, mail not):
`given().get("/auth/methods").then().body("github", is(true)).body("email", is(false));` — and
**Review Focus 3** in a mail-only profile (clone `EmailSignInProfile` without the Google
overrides as `MailOnlyProfile` if none exists):
`given().get("/auth/methods").then().statusCode(200).body("google", is(false)).body("email", is(true));`

- [ ] **Step 2: Run to verify failure** — 404.
- [ ] **Step 3: Implement** in `AuthResource`:

```java
    /** One flag per sign-in method. */
    @RegisterForReflection
    public record AuthMethods(boolean google, boolean github, boolean email) {}

    @Inject Features features;

    /**
     * Which sign-in methods this deployment serves — the same predicates that gate the routes,
     * so this can never advertise a method whose route would 404.
     */
    @GET
    @Path("/methods")
    public Response getAuthMethods() {
        return Response.ok(new AuthMethods(features.auth(), features.github(), features.mail()))
                .header("Cache-Control", "public, max-age=300").build();
    }
```

- [ ] **Step 4: Run** — `./mvnw test -Dtest='AuthMethodsTest,GitHubResourceTest,GitHubGateTest,OpenApiDriftTest,ContractFixtureTest'` — PASS.
- [ ] **Step 5: Commit** — `feat(auth): GET /auth/methods, the chooser's capability answer`

### Task 6: Full gate, docs and PR

- [ ] **Step 1:** `./mvnw verify -DskipITs=false` — green, JaCoCo gates hold. Fix anything it surfaces (ArchUnit on the new classes, contract validation on the new tests' responses).
- [ ] **Step 2:** README/infra docs: the three new variables (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI`) beside the mail ones, with the one-time OAuth-App registration note (callback URL `https://<app>/api/auth/github/callback`).
- [ ] **Step 3:** Push `feat/github-signin`, open the PR **based on `feat/email-signin`** (re-base to `main` once #7 merges); body notes the deploy order (methods + GitHub ship together; the frontend chooser falls back gracefully against an older API) and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`, via `--body-file`. Do not merge.

---

## Deliberate scope notes

- No GitHub Enterprise Server, no name claim from GitHub (profile names are the user's own), no linked-methods UI (piece 3).
- `AuthMethods` deliberately omits a version/passkeys field — piece 3 adds `passkeys` as a new required flag in both contract copies at once.
- The Google flow's carrier gains no provider claim in this piece (legacy carriers in flight must keep resuming); tightening it is a one-line follow-up once a release has passed.
