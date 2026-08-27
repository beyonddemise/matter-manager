# M4-8 Rate limiting and security headers (#47)

- [x] Rate limits on the auth endpoints, per client and per endpoint
- [x] CORS restricted to configured origins, validated at startup
- [x] Security headers on every response
- [x] Request body cap — set since the skeleton, now actually watched refusing something
- [x] The web shell's Content-Security-Policy, **measured** against the built bundle
- [x] ADR 0016 for the deployment constraint in-process limiting creates
- [x] Mutation probes: 44/44 caught
- [x] `npm run verify` — 1360 tests, 71 files

---

## No new dependencies

`@fastify/helmet`, `@fastify/cors` and `@fastify/rate-limit` are all good libraries. What each
would have contributed here is a list, a string comparison and a `Map` — which is the test
ADR 0013 sets. The parts worth getting right are the parts a library would not have decided
anyway: which origins, which headers, and what a limit means when the service is scaled out.

## Rate limiting

A fixed window per client per endpoint. Not a token bucket and not a sliding log: the question
at a sign-in endpoint is "has this address tried too many times lately", and a fixed window
answers it in one integer per client. A sliding log answers it more precisely at the cost of
remembering every request — which is the thing an attacker gets to choose the size of.

Two budgets, because the endpoints are used at completely different rates: signing in happens
once, and a page refreshes its access token for as long as it stays open. One shared budget
would either throttle an ordinary session or fail to throttle a sign-in attempt.

Details that are decisions rather than details:

- **The window is not extended by a refused request.** A limiter that restarts its window on a
  rejection lets a client that keeps hammering lock itself out indefinitely, and rewards the one
  that gave up politely by letting it back first. The window belongs to the traffic that was
  allowed.
- **`Retry-After` is never zero.** A client told to come back in no time comes back immediately
  and is refused again, which costs more than the request that was refused.
- **The refusal says nothing.** Not which limit, not the window, not how much is left. It is an
  unauthenticated endpoint, and every number is a hint about what else would work.
- **A full limiter refuses newcomers rather than evicting somebody.** Eviction is a bypass
  anybody can trigger on purpose: make enough noise from enough addresses and the entry counting
  your own attempts is dropped. These are sign-in endpoints, so refusing is the conservative
  answer. Clients already counted are unaffected.
- **Entries expire on read as well as on the sweep.** The sweep runs at most once per window, so
  an expired entry can still be in the map when its owner returns; reading it as live would lock
  somebody out because of the housekeeping schedule rather than anything they did. The probe
  found this — the first version passed only because every test happened to land on a sweep.

**ADR 0016** records what this means for deployment: the count is per process, so *n* instances
enforce the limit *n* times over. That is a decision about how much the limit is worth rather
than a migration, and it is written down so it is a choice rather than a surprise.

## CORS

The browser is the enforcement point. These headers only ever *relax* the same-origin policy, so
withholding them is what refuses a caller — there is no 403 to return.

- **Exact origin comparison.** Prefix matching lets `https://matter.example.evil.test` through;
  substring matching lets `https://evil.test/?x=https://matter.example` through. Both are tested.
- **`Vary: Origin` on every answer, including the refusals.** Without it a shared cache may hand
  the permissive response stored for the real application to a request from anywhere else, and
  the allowlist is then enforced only until something caches.
- **Never a wildcard.** The session travels as a cookie, so `*` would be rejected by browsers
  anyway — and a deployment that configured `*` believing it worked would carry that belief into
  production. `corsPolicy` throws instead, at startup, along with `https://*.matter.example`,
  which is the wildcard somebody actually writes and which no `Origin` header ever matches.
- **`Origin: null` is a value, not an absence.** Sandboxed iframes and `file://` pages send it,
  and it fails the same exact comparison as anything else.
- **Empty means none.** A deployment that forgot `APP_ORIGIN` refuses the application rather
  than admitting the internet.

Preflights are answered from the `onRequest` hook rather than by registering `OPTIONS *`. A
registered route would appear in `registeredRoutes()` as an operation the contract does not
declare, turning the drift check (#39) into a check on Fastify's plumbing — and a preflight for
a path with no route would otherwise 404, which tells a browser the request is forbidden rather
than that the endpoint is not deployed.

## Security headers

Applied in `onRequest`, before every handler, which is why a route that has something cacheable
to say simply says it later. Applying them in `onSend` would quietly undo every such route —
and it would also mean a rate-limited request never got them, because a 429 short-circuits.

**A 429 the browser cannot read is reported to the page as a CORS failure**, so the application
says "something went wrong" instead of "wait a minute", and the user retries — the one thing the
limit was asking them not to do. There is a test.

`referrer-policy: no-referrer` is specific to this service rather than boilerplate: the OAuth
callback arrives as `/auth/google/callback?code=…&state=…`, and a referrer sent from that page
hands the authorization code to whatever it linked to.

HSTS is sent only over TLS, without `preload`. Preload is close to irreversible and applies to
every subdomain of the registered domain including ones this service knows nothing about — the
domain owner's decision, not one to inherit from an API's source. And "over TLS" follows
`trustProxy`: reading `X-Forwarded-Proto` directly would let anyone make this service claim, in
an HSTS header, that a plain connection was encrypted.

Deliberately absent, each with a test saying so: **CORP** (it would block the cross-origin reads
the application depends on, and CORS already governs them — a header set to its most permissive
value to keep the product working is not doing anything) and **Permissions-Policy** (features
are granted to documents; this service returns none, and the page that needs the camera is
served by Cloudflare Pages).

## The web shell's CSP — measured, not written

`packages/web/public/_headers` carried a note deferring this to #47, warning that "a policy
written without testing the Web Awesome and PouchDB bundles against it would either be too loose
to be worth having or would break the application in production only". So it was measured: the
built bundle was served by a small static server applying a candidate policy, loaded in Chromium
across three routes, and the violations were read off the console.

The strict candidate produced 25 violations. Every relaxation in the shipped policy answers one:

| Violation | Relaxation |
|---|---|
| `Applying inline style` — `index.html`'s `<style>`, and style attributes set by Web Awesome | `style-src 'unsafe-inline'` |
| `Loading the stylesheet 'https://fonts.bunny.net/css?family=…'` | `style-src`/`font-src https://fonts.bunny.net` |
| `Connecting to 'https://ka-f.fontawesome.com/…/bars.svg'` and seven more icons | `connect-src https://ka-f.fontawesome.com` |
| `Connecting to 'data:image/svg+xml,…'` — bundled icons fetched the same way | `connect-src data:` |

`script-src` needed **nothing**, which is the part that matters: no `'unsafe-inline'`, no
`'unsafe-eval'`. With those relaxations the three routes load with zero violations.

**The last three rows are a bug, not a policy question**, and it is now #106: an offline-first
application whose icons arrive from a CDN has no icons in a basement, and every visit tells two
third parties that somebody opened it. Fixing that lets those origins be deleted from the
policy.

`scripts/check-deploy-headers.mjs` now guards the result, because measuring it is work nobody is
going to repeat. It treats the policy as a **floor** — tightening it later is not a change the
checker objects to — and fails on: a missing policy, `'unsafe-inline'`/`'unsafe-eval'`/`*` in
`script-src`, a policy with neither `script-src` nor `default-src`, and a missing
`frame-ancestors`, `base-uri` or `object-src`. Those three do not fall back to `default-src`, so
a policy setting only `default-src 'none'` leaves all three unrestricted while reading, in a
report, as though everything were locked down.

## `connect-src` is a trap set for M5

It is `'self'` today because nothing cross-origin is wired yet. **When M5 wires replication, the
API origin and the CouchDB origin have to be added**, or the application will fail to reach
either — in production only. The note is in `_headers` beside the directive.

## Mutation probes

| Module | Result |
|---|---|
| `api/src/security/rate-limit.ts` | 8/8 caught |
| `api/src/security/cors.ts` | 11/11 caught |
| `api/src/security/headers.ts` | 9/9 caught |
| `api/src/security/register.ts` | 10/10 caught (one obsolete, see below) |
| `api/src/security/config.ts` | 6/6 caught |

Three findings from the probe rather than from review:

1. **The expiry check was masked by the sweep.** Every test happened to land on a sweep, so
   "the window never expires" survived. The test now arranges a client whose window passes
   *between* sweeps.
2. **A `Math.max(0, …)` that could not fire.** The clamp guarded a state the line above ruled
   out. Removed — an unreachable guard reads like a decision somebody made.
3. **An "only if unset" guard that could not fire either.** The headers go on in `onRequest`,
   before any handler, so nothing has ever set one. Removed, and the test that covers it now
   says the mechanism is the ordering.
