# Todo — #43 · M4-5 Profile and locale preference

Branch: `43-profile-locale` (stacked on `44-mm-local-cache`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: a locale preference is saved and applied
  → the API updates my profile document in _users
  → the interface switches immediately without a reload
  → the preference persists across sessions and devices

Scenario: my locale is available offline
  → given my profile was fetched at least once, reloading offline is still German
```

> **The profile is read through `GET /profile`, not from CouchDB directly.** A JWT-authenticated
> browser cannot read `_users` at all — not even its own document; it gets a 403.

## The contract needed an operation it did not have

The contract described `GET /profile` and a `Profile` schema with a `locale` enum, but **no way
to save one** — and the scenario requires saving. So `PUT /profile` was added to
`openapi/matter-manager.yaml`, along with the `BadRequest` response it references.

The drift check (#39) noticed the moment it was added, which is exactly what it is for: the
pending-operations list failed until the new operation was accounted for.

## Review

### Both scenarios met

**Saved and applied.** `PUT /profile` writes the locale into the `_users` document and returns
the profile as stored; the browser applies it without a reload and caches it.

**Available offline.** The cache from #44 answers first, so the *first render* is right rather
than corrected a second later — and when the server cannot be reached at all, the cached answer
simply stands.

### `_users`, and what must survive a write

The document is spread through rather than rebuilt, because `name`, `roles` and `type` are
CouchDB's. **A `_users` document that loses its `type: 'user'` stops being a user and the account
cannot authenticate afterwards; one that loses its roles loses every project.** Both have tests.

Signing in keeps a returning user's locale, display name and roles. The identity provider is
authoritative about *who somebody is* and says nothing about *what they prefer* — which is M4-3's
second scenario, and it belongs here because this is the module that writes the document.

### `auto` is the absence of a preference, not a value

Never stored. Storing it would make "never chose" and "chose to follow the browser" two states
that behave identically — and writing `en` in for a new user would give a German-speaking
visitor an English interface they never asked for. A locale this build no longer has reads as
`auto` too, so dropping a language degrades rather than breaks.

### The subject comes from the session, never from the body

A profile endpoint that accepted an arbitrary `sub` would be an account-takeover primitive: send
somebody else's id, change their settings. There is a test that sends `sub` and `name` in the
body and asserts the write went to the session's user.

### The cache is read first, and the server corrects it

Not the other way round. Awaiting the network before the first paint would put a round trip in
front of an application meant to open offline. When the server disagrees, the interface follows
— which is how a preference set on a phone reaches a laptop. When it agrees, nothing is emitted:
a change event for an unchanged value would re-render the whole interface on every load.

Three failure paths are tested because each is real: an unreadable cache, a cache that will not
accept a write, and a server that cannot be reached. None of them stops the application working.

### Contract-checked responses

Both endpoints' tests validate their responses **against the contract's own schema** rather than
a hand-written shape, so the implementation and `openapi/matter-manager.yaml` cannot drift apart
quietly — using the same validator #39 built.

### Not here

The settings *view* still reads its language from `localStorage`. Wiring the picker to this is
small and belongs with sign-out (#46), where the "signed in or not" question is already being
answered — until there is an account, there is nothing to save a preference to.
