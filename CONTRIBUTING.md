# Contributing to Matter Manager

## The one rule that matters

**Every test is observed failing before the code that makes it pass is written.**

A test that has never failed has never been shown to test anything. It is entirely possible
to write a test that passes against an empty implementation, against the wrong module, or
against a typo'd assertion — and you will not find out until the bug it was supposed to
catch ships. Watching it go red first is the only evidence that the test is wired to the
behaviour it claims to check.

This is not a stylistic preference here. It is the reason the project is structured the way
it is.

## Red → Green → Refactor

1. **Red.** Translate the issue's acceptance criteria into a test. Run it. Read the failure
   message — it should describe the missing behaviour, not a `ReferenceError` from a typo.
2. **Green.** The simplest implementation that passes. Not the best one. The simplest.
3. **Refactor.** Improve the design with the tests green. This is where quality is added;
   skipping it is how "simplest thing that passes" becomes technical debt.

Commit at each transition where it helps a reviewer follow the reasoning.

## Where code goes

| If it... | It belongs in |
|---|---|
| is a pure function over plain data | `packages/core` |
| touches PouchDB or CouchDB | `packages/data` |
| renders or handles user input | `packages/web` |
| serves HTTP or talks to Google | `packages/api` |

**`packages/core` must never import a DOM type, a network client, or a database.** If a
piece of logic seems to need one to be tested, it is nearly always two pieces of logic
tangled together: a pure decision and an impure action. Separate them, put the decision in
`core`, and test the decision exhaustively.

## Testing

| Layer | Tool | Coverage gate |
|---|---|---|
| `core` | Vitest, node environment | **90%** |
| `data` | Vitest + `pouchdb-adapter-memory` | 70% |
| `web` | Vitest browser mode + `@open-wc/testing-helpers` | 70% |
| `api` | Vitest + Fastify `.inject()` | 70% |
| end-to-end | Playwright | not gated |

Prefer testing behaviour through public interfaces. A test that reaches into internals will
break during the refactor step, which defeats the purpose of having it.

### Test naming

Describe the behaviour and the condition, not the function:

```ts
// yes
it('rejects a payload whose Base38 length does not match the declared chunk size')

// no
it('tests decodeBase38')
```

## Issues and branches

- Every change starts from an issue. Issues carry acceptance criteria as Given/When/Then.
- Branch as `<issue-number>-<short-slug>`, e.g. `42-base38-decoder`.
- PRs use `Closes #42` and must be green in CI to merge.
- Labels: `type:*`, `area:*`, `size:*`. Milestones M0–M9.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/). Scope is the package:

```
feat(core): decode Base38 chunks into byte buffers
fix(data): merge remark arrays instead of discarding the losing revision
test(core): add spec vectors for the 21-digit manual pairing code
docs(adr): record database-per-project decision
```

## Internationalisation

**Never write a user-visible string literal in a component.** Wrap it in `msg()` from
`@lit/localize` from the first line, even before German translations exist. Retrofitting
i18n across a built UI is miserable work that is never quite finished, and it costs nothing
to do it as you go.

```ts
import { msg, updateWhenLocaleChanges } from '@lit/localize'

class AddDeviceView extends LitElement {
  constructor() {
    super()
    // Without this the component keeps the strings it first rendered with, while the rest of
    // the page changes language around it.
    updateWhenLocaleChanges(this)
  }

  render() {
    return html`<wa-button>${msg('Add device')}</wa-button>`
  }
}
```

`npm run check:i18n` enforces this. It scans `html` templates for text and for user-visible
attributes (`label`, `placeholder`, `title`, `alt`, `aria-label`, `hint`) that are plain
literals. It is a heuristic and cannot see a string built in a helper, so it is a floor rather
than a proof.

### After adding or changing a string

```
npm run i18n     # extract into packages/web/xliff/de.xlf, then regenerate the locale modules
```

Then **write the German** in the new `<trans-unit>` before committing. A unit with no
`<target>` does not fail the build — lit-localize silently falls back to English — so
`check:i18n` fails on it instead. Commit the regenerated files: they are checked in so that a
fresh clone builds without a code-generation step, and `check:i18n` compares them against a
regeneration in a temporary directory to make sure they are current.

Two things are deliberately **not** wrapped in `msg()`:

- **Language names** (`English`, `Deutsch`). A language picker names each option in its own
  language, so that a user stranded in a language they cannot read can still find their own.
  They live in `LOCALE_NAMES` in `packages/web/src/i18n/locale.ts`, as data rather than markup.
- **The generated catalogue** under `packages/web/src/generated/`. Never edit it by hand.

## Runtime dependencies

**Check the platform before reaching for a package.** Runtime dependencies ship to users,
need patching, and widen the supply-chain surface of an application holding commissioning
secrets. `npm run check:deps` fails the build on anything not justified in
`dependency-policy.json` ([ADR 0013](docs/adr/0013-minimal-runtime-dependencies.md)).

| Need | Use | Not |
|---|---|---|
| HTTP, client or server | native `fetch` | `axios`, `node-fetch`, `got` |
| CouchDB from the API | native `fetch` | `nano`, `couchdb` |
| Sign / verify JWT (**server only**) | `node:crypto` | `jose`, `jsonwebtoken` |
| Provider JWKS key | `createPublicKey({ key, format: 'jwk' })` | `jwk-to-pem` |
| Crypto in **shared or browser** code | `@noble/*` | assuming Node and WebCrypto agree |
| Identifiers | `crypto.randomUUID()` | `uuid`, `nanoid` |
| Dates, formatting | `Intl` | `moment`, `date-fns` |
| Cloning, equality | `structuredClone`, plain code | `lodash` |

This is not aspirational. The entire authentication and CouchDB path — ES256 signing and
verification, importing Google's RSA key from JWKS, and every CouchDB call including
`_security` and `_changes` — was verified working on `node:crypto` and `fetch` alone.

**The exception worth knowing.** `node:crypto` and the browser's `SubtleCrypto` are different
APIs that diverge in the fine print: available curves, sync versus promise-returning, key
import, and signature encoding. ES256 alone differs — Node emits DER unless given
`dsaEncoding: 'ieee-p1363'`; WebCrypto emits raw R‖S. Same algorithm, different bytes, no
warning. So `node:crypto` is fine for code that is server-only and stays server-only, and
`@noble/*` is the choice for anything in `core`, in the browser, or that might move. Code
whose correctness depends on which runtime it happens to be executing in is not correct.

`devDependencies` are unrestricted; they do not ship.

If a package really is needed, add it to `dependency-policy.json` with a one-line reason. That
entry is the review gate: the question is not "does it work" but "is the platform genuinely
insufficient".

## Workers

**Service worker** — hand-written, not generated. What we need (precache the app shell,
cache-first for assets) is a short auditable file; a generated one ships a runtime library to
do the same job.

**Web workers** — for work that would otherwise block the interface: large PDF generation, and
the QR decode loop when the ZXing fallback is active. **Measure before adding one.** Workers
cost message-passing and serialisation, which is not free if the work was never slow enough to
notice.

## Credentials

**Never put a token in `.npmrc`.** It references `${WEBAWESOME_NPM_TOKEN}` and must continue
to. This repository is public, so a literal token there is a live credential the moment it is
pushed — CI fails the build if it finds one, but the leak has already happened by then.
Export the variable in your shell instead.

### Web Awesome Pro is required

This project builds its UI on Web Awesome **Pro**, and contributing to the front end needs
your own Pro licence. Without one, `npm ci` fails, and so does CI on a pull request from a
fork — GitHub does not give fork workflows access to secrets.

**That is a decision, not an oversight.** The alternative was restricting the UI to components
in the free build so that a fork could still compile. It was rejected: `data-grid`, `combobox`,
`date-picker` and `file-input` are Pro-only and are the natural components for a device list,
room selection with inline creation, an installation date and photo upload. Designing around
their absence would cost more than the friction it saves.

Two consequences worth stating plainly:

- A failing `npm ci` on a fork is **expected**. It is not a bug to be worked around by
  vendoring the package, adding a free-build code path, or removing the dependency.
- **Never** use `pull_request_target` to give fork workflows access to the secret. It runs
  untrusted code with credentials, trading an inconvenience for a credential compromise.

### The token lives in two stores, not one

`WEBAWESOME_NPM_TOKEN` has to be set **twice** in repository settings, under
*Secrets and variables*:

| Store | Read by | Set it or else |
| --- | --- | --- |
| **Actions** | every run triggered by a push, a **same-repository** pull request, or `workflow_dispatch` | `npm ci` fails with `E401` on the Pro package |
| **Dependabot** | every run triggered by Dependabot, and the updater itself | every Dependabot pull request fails CI, *and* Web Awesome Pro is silently never offered for update |

They are separate on purpose. An update to an untrusted dependency must not be able to reach
the credentials the rest of CI holds, so a Dependabot-triggered run reads only the Dependabot
store — `secrets.WEBAWESOME_NPM_TOKEN` resolves to the empty string if the value is missing
there, however well populated the Actions store is. The run log names which store it used:
`Secret source: Dependabot`.

The updater needs it a second time, through `registries:` in `.github/dependabot.yml`, because
resolving a version range on a private registry is a request Dependabot makes on its own behalf
before any workflow starts. Without it the updater reports
`private_source_authentication_failure` for `@awesome.me/webawesome-pro` and proceeds with the
remaining packages — the failure appears only inside a run log that needs write access to read,
so the visible symptom is no symptom at all: Web Awesome simply never appears in an update, which
looks identical to already being current.

Without a licence, please open an issue describing the change rather than a pull request you
cannot build, and we will work out how to land it. Changes confined to `packages/core` — which
is pure domain logic with no UI dependency — build and test without any of this.

## Handling Matter payloads

Setup passcodes are secrets. Within the codebase:

- **Never log a payload or a passcode**, at any level, including during debugging. Log the
  device id instead.
- Never send a payload to a third-party service. The DCL lookup sends *Vendor ID and
  Product ID only* — never the full payload.
- Do not add analytics or error reporting that could capture document contents.

## Definition of done

- [ ] Test was observed failing before the implementation existed
- [ ] All tests green, coverage gates met
- [ ] `npm run verify` clean
- [ ] User-visible strings wrapped in `msg()`
- [ ] Acceptance criteria in the issue are each demonstrably met
- [ ] Docs or ADR updated if the change alters an architectural decision
