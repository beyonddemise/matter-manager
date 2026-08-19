# 8. Lit and Web Awesome, no SPA framework

Date: 2026-08-19

## Status

Accepted

## Context

The frontend must run on phone, tablet and desktop, work offline as an installed PWA, and
stay maintainable by a very small team over years. React and Angular were excluded by the
project owner at the outset.

## Decision

Lit web components with Web Awesome for the component library, bundled by Vite, deployed to
Cloudflare Pages.

## Consequences

- Standards-based. Web components are a platform feature, so the churn cycle that forces
  periodic rewrites in framework-land largely does not apply. For a project expected to be
  maintained slowly over years, that is the decisive property.
- Small runtime, which matters for a PWA loaded over poor connections.
- Lit's reactive properties and templating are enough for this application's complexity.
  There is no global state problem here worth a state management library: the local database
  *is* the state, and components subscribe to it.
- Shadow DOM encapsulates styling but complicates global theming and makes some testing
  approaches awkward. `@open-wc/testing-helpers` covers the common cases.
- A smaller ecosystem than React. Expect to write things that would be an npm install
  elsewhere.

## Web Awesome Pro

**Licensing resolved (2026-08-19): the project owner holds a Web Awesome Pro licence.**

Distribution is not what it first appears, and the difference matters:

| Package | Registry | Notes |
|---|---|---|
| `@awesome.me/webawesome` | public npm **and** `npm.webawesome.com` | Free build. Identical `sha512-WM8kyP+A…` integrity on both — the private registry merely mirrors it. |
| `@awesome.me/webawesome-pro` | `npm.webawesome.com` only | Pro build. Returns `E404` on public npm. |

So the private registry is genuinely required, and it is required for the `-pro` package
specifically. Authentication is a **Bearer** token against `https://npm.webawesome.com/` —
not Font Awesome's `npm.fontawesome.com`, which rejects the same token.

`.npmrc` routes the `@awesome.me` scope there and reads `WEBAWESOME_NPM_TOKEN` from the
environment. The token is never written to the file: this repository is public, and a
literal token in `.npmrc` would be a live credential the moment it was pushed. CI enforces
this with a grep that fails the build.

**A concrete payoff already banked:** `<wa-qr-code>` ships with the library, verified present
in `@awesome.me/webawesome-pro@3.11.0`. Reproducing a Matter QR on screen — the core of the
product — needs no QR library and no hand-rolled encoder. Its encoder is bundled inside the
component rather than separately importable, which matters only for PDF embedding (see
[ADR 0007](0007-client-side-pdf.md)).

### Two consequences to plan around

**Fork pull requests cannot install.** GitHub does not expose secrets to workflows triggered
by pull requests from forks, so an outside contributor's PR will fail at `npm ci`. This is
inherent to a public repository with a private dependency. Options, to decide in M2:
accept it and review fork PRs locally; or keep the UI's Pro usage isolated enough that a
free-build fallback is viable. Not decided here because it depends on how much Pro is
actually used.

**Component coverage is still unverified.** The licence question is answered; whether the
components needed (form validation, dialog, drawer, tab group, dark mode) behave as required
is not. That remains the first task of M2.

The exposure stays contained: Web Awesome components are themselves Lit-based, so replacing
the library would mean rewriting markup and styling, not rearchitecting the application.
That containment is part of why Lit is the right base layer regardless.
