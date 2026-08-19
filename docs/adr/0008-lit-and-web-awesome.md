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

## Risk: Web Awesome

Web Awesome is comparatively young, and its licensing and component coverage must be
confirmed as the **first task of M2**, before the UI is built on it — not discovered
halfway through.

The exposure is contained: Web Awesome components are themselves Lit-based, so replacing
the library would mean rewriting markup and styling, not rearchitecting the application.
That containment is part of why Lit is the right base layer regardless of how the component
library question resolves.
