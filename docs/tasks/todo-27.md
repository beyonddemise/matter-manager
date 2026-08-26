# Todo — #27 · M2-10 Deploy to Cloudflare Pages

Branch: `27-cloudflare-pages` (stacked on `26-timestamped-remarks`)

## Acceptance criteria (from the issue)

> **Done when:** pushes to `main` deploy automatically, PRs get preview deployments, and the
> service worker updates without users having to clear storage.
>
> **Watch for:** a stale service worker serving an old bundle indefinitely is the classic PWA
> deployment failure, and it is invisible to whoever deployed it.

## The part that needs thinking about

There is no service worker yet — it arrives at M2b-3 (#30). So the third clause is not "make
the service worker update"; it is **do not build the deployment that makes updating
impossible**, before anything depends on it. That is a caching contract, and it is the half of
the problem that lives in the deployment rather than in the application:

| Path | Cache-Control | Why |
|---|---|---|
| `/assets/*` | `immutable`, a year | Vite fingerprints these. A given URL's bytes never change. |
| `/index.html`, `/` | revalidate every time | The shell names which fingerprinted bundle to load. Cached, it names an old one forever. |
| `/sw.js` | revalidate every time | A cached service worker cannot be replaced by a new one. This is the failure the issue names. |

The hazard is not writing this wrongly today. It is someone later adding a broad `/*` rule with
`immutable`, which silently pins the shell and the worker, and produces exactly the invisible
failure the issue warns about. So the contract gets a checker, in the shape this repository
already uses for `check-npmrc` and `check-i18n`.

## Plan

- [x] Confirm Cloudflare's `_headers` semantics from the docs before writing a matcher that
      assumes them (lesson L1: no protocol behaviour from memory)
- [x] `packages/web/public/_headers` — the contract above
- [x] `scripts/check-deploy-headers.mjs` — resolves the effective `Cache-Control` for the
      critical paths the way Cloudflare does, and fails closed. `--scan <dir>` mode so it can
      be exercised over fixtures.
- [x] Wire into `npm run verify` and CI
- [x] `.github/workflows/deploy.yml` — production on `main`, preview per PR
- [x] Forks get no deployment, for the same reason they get no `npm ci`: no secrets. Skipped
      explicitly rather than failing.
- [x] ADR for the hosting decision and the caching contract
- [x] Document the required repository secrets

### Tests (each observed failing first)
- [x] the checker passes the real `_headers`
- [x] it catches a `/*` rule that makes the shell immutable — written last *and* written first
- [x] it catches a service worker with a long `max-age`
- [x] it catches a missing rule for the shell entirely
- [x] it catches fingerprinted assets left uncached (the performance half)
- [x] it fails closed on a line it cannot parse
- [x] a `:placeholder` rule reaching the shell is resolved the way Cloudflare resolves it

## Review

**All three clauses met.** Pushes to `main` deploy, PRs from this repository get a preview at
`<branch>.matter-manager.pages.dev`, and the caching contract that makes a service-worker
update possible is in place *before* the service worker exists.

**What the research changed.** The checker was first written to avoid modelling Cloudflare's
rule-override order, on the reasoning that a contradictory pair is a bug whichever side wins.
Checking the documentation turned that caution into a fact worth stating plainly: there is no
override order. "An incoming request which matches multiple rules' URL patterns will inherit
all rules' headers", and "if a header is applied twice in the `_headers` file, the values are
joined with a comma separator". So `/*` with `max-age=604800` next to the shell's `no-cache`
does not replace it — it produces `no-cache, max-age=604800`. Requiring every matching rule to
satisfy the contract independently is not conservatism, it is the correct model.

**Eleven green tests, five of them green for the wrong reason.** The mutation probe caught 3/8
on the first run. The survivors were all real gaps:

- the broad-rule test only ever placed the offending rule *last*, so a checker that inspected
  one rule would have passed it
- the unparsable-`Cache-Control` test asserted the exit code, which a `TypeError` also
  produces — it could not tell a considered refusal from a crash
- nothing exercised `immutable` on the shell, a short `max-age` on the assets, or a
  `:placeholder` rule

Four cases added and one assertion strengthened; 8/8 caught. The `:placeholder` case is the one
worth keeping in mind: `/:file.js` reaches `/sw.js`, which is not obvious from reading it.

**Two security decisions.** A branch name is checked against an allowlist before it reaches the
deploy command — git permits `;`, `&`, `|`, `$` and backticks in a ref name, and the name is
interpolated into a command a shell runs. Forks are excluded from the job entirely, so this is
not reachable by a stranger, but "only people we trust could exploit it" is not a security
property. And `pull_request_target` is not used, will not be, and the workflow says so.

**Not done here, deliberately:** a Content-Security-Policy. It needs the Web Awesome and
PouchDB bundles tested against it, and one written without that would either be too loose to be
worth having or break in production only. It belongs with #47.

**Needs a human once:** the two Cloudflare repository secrets, and
`npx wrangler pages project create matter-manager --production-branch=main`. Until then the
deploy job fails on a missing token; everything it gates is green.
