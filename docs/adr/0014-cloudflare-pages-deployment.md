# 14. Deploy to Cloudflare Pages by direct upload, and pin the caching contract

Date: 2026-08-27

## Status

Accepted

## Context

The web application is a static bundle: Vite output, no server rendering, no runtime the host
has to provide. It needs somewhere to be served from, with a preview per pull request so that
a change to a QR-rendering page can be looked at rather than reasoned about.

Two things make the choice less obvious than "any static host".

**The application becomes a PWA at M2b.** A service worker will control what a returning user
loads. A service worker is fetched like any other file, and a browser that has cached one
cannot be given a new one until that cache entry expires — the update check is itself a
request, and a request served from cache is not a check. So a wrong `Cache-Control` on
`/sw.js` does not produce a stale page for an hour; it produces a stale application for as
long as the header said, with no way for the user to find out and no reason for them to think
of clearing storage. The same applies, less permanently, to `index.html`: it names which
fingerprinted bundle to load, so caching it pins every asset around it.

**Whoever deploys is the last person to see the problem.** Their own browser revalidated, so
they get the new version immediately. This failure is invisible from the inside, which is what
separates it from ordinary bugs and is why it needs something other than care.

## Decision

**Cloudflare Pages, deployed by direct upload from GitHub Actions** — not through Cloudflare's
Git integration.

The site is built by this repository's own pipeline: same Node version from `.nvmrc`, same
lockfile, same Web Awesome Pro token, same `check:deploy` gate. Cloudflare's Git integration
would be a second build system with its own opinions about all four, and therefore a second
place for "it works on main" to stop being true. `wrangler pages deploy` uploads a directory
that has already been built and checked here.

`--branch` decides production from preview: a deployment on the project's production branch is
production, anything else is a preview at `<branch>.matter-manager.pages.dev`.

**The caching contract lives in `packages/web/public/_headers` and is enforced by a checker.**

| Path | Cache-Control | Why |
|---|---|---|
| `/assets/*` | `public, max-age=31536000, immutable` | Vite fingerprints these. The bytes behind a URL never change. |
| `/index.html`, `/` | `no-cache` | Names which bundle to load. Cached, it names an old one forever. |
| `/sw.js` | `no-cache` | A cached service worker cannot be replaced by a newer one. |

`scripts/check-deploy-headers.mjs` resolves the effective rules for those paths and fails the
build on a contract that would deploy a stale application. It runs in CI *and* in the deploy
workflow, because the two are different events: CI gates merging, and this gates shipping.

The checker requires **every** matching rule to satisfy the contract, not just the last one.
That follows from Cloudflare's documented behaviour rather than from caution: a request
matching several rules "will inherit all rules' headers", and "if a header is applied twice in
the `_headers` file, the values are joined with a comma separator". There is no last-one-wins.
A `/*` rule adding `max-age=604800` next to the shell's `no-cache` yields
`no-cache, max-age=604800`, which is not a decision anyone made.

The service worker rule is in place **before the service worker exists**. That is the point:
M2b-3 must not be able to arrive into a deployment that has already made updating it
impossible.

## Consequences

**A fork gets no deployment.** GitHub does not give fork workflows access to secrets, the same
constraint that already makes `npm ci` fail on a fork (see CONTRIBUTING). The job is skipped by
condition rather than left to fail, so a red cross on a fork's pull request means something is
actually wrong. `pull_request_target` is **not** an option here and will not become one: it
runs untrusted code with the credentials, trading an inconvenience for a credential compromise.

**A branch name is checked against an allowlist before it reaches the deploy command.** Git
permits `;`, `&`, `|`, `$`, `(`, `)` and backticks in a ref name, and the name ends up in a
command line. Forks are already excluded, so this is not reachable by a stranger — but "only
people we trust could exploit it" is not a security property, and the allowlist costs one step.

The check is also what makes the *other* half safe. The branch is substituted into the action's
`command` input by the workflow rather than left as `$BRANCH` for a shell to expand, because
whether the action uses a shell is the action's business and not ours — passing `$BRANCH` would
deploy to a branch literally named that if it does not. Substituting is only acceptable because
the value has already been refused unless it matches `[A-Za-z0-9._/-]`.

**The Pages project must be created before the first deploy.** `wrangler pages deploy` can
create one interactively; an Actions runner is not a TTY, so it errors instead of prompting.
One-time, from a machine with the API token:

```sh
npx wrangler pages project create matter-manager --production-branch=main
```

A Direct Upload project's production branch **cannot be changed from the dashboard** — it is
set at creation, or afterwards through the Update Project API. Getting it wrong at creation
means every deploy is a preview and nothing is ever live, which looks like a broken workflow
rather than a wrong setting.

**Two organisation secrets are required**, in addition to the existing repository-level
`WEBAWESOME_NPM_TOKEN`:

| Secret | What |
|---|---|
| `CLOUDFLARE_API_TOKEN` | An API token with **Account → Cloudflare Pages → Edit**. Nothing else; this token can only publish the site. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account the project lives in. |

They are held at the organisation because the account is the organisation's, not this
repository's: a second repository publishing to it should not mean a second copy of the token
to rotate. The cost is one more way to be wrong — an organisation secret has a repository
access list, and a repository left off it reads `secrets.CLOUDFLARE_API_TOKEN` as the empty
string rather than failing. That is why the deploy job checks both values before it builds,
instead of letting wrangler report a missing token four minutes later.

**They are passed through `env:`, not through the action's `apiToken`/`accountId` inputs.**
`wrangler-action` sets `process.env.CLOUDFLARE_API_TOKEN` from `getInput("apiToken")`
unconditionally, and an unsupplied input is `""`, not undefined — so passing them both ways
is not redundancy, it is the input silently overwriting the environment.

**No SPA fallback is needed.** The router is hash-based (`#/devices/<uuid>`), so every request
is for `/` and there are no deep paths for the host to rewrite. A `_redirects` file would be
answering a question this application does not ask.

**A Content-Security-Policy is deliberately not part of this.** `_headers` sets
`X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options`, which are unambiguous. A CSP
needs the Web Awesome and PouchDB bundles tested against it, and one written without that would
either be too loose to be worth having or would break the application in production only. It
belongs with the API's security headers (#47).

## References

- [Cloudflare Pages: headers](https://developers.cloudflare.com/pages/configuration/headers/)
- [Direct Upload with continuous integration](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
- [`wrangler pages deploy`](https://developers.cloudflare.com/workers/wrangler/commands/pages/)
- [ADR 0008](0008-lit-and-web-awesome.md) — why the bundle is what it is
