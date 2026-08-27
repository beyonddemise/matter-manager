# Todo — #44 · M4-5b The `mm-local` cache

Branch: `44-mm-local-cache` (stacked on `41-google-sign-in`)

**Taken before #43 deliberately.** M4-5's second scenario — "my locale is available offline" —
is unachievable without this, and the issue says so: a JWT-authenticated browser cannot read
`_users` at all, so the value has to be cached or the preference is simply unavailable offline.

## Acceptance criteria (from the issue)

```gherkin
Scenario: my locale survives going offline
Scenario: the cache is cleared on sign-out
```

> **Out of scope:** any authorisation decision. The cache decides what the client *attempts*;
> CouchDB's `_security` decides what succeeds. **A permission check that reads `mm-local` is a
> defect** — treat it as one in review.
>
> **Test plan:** assert the cache is never handed to a replication target (a test that fails if
> anything calls `sync()` on it).

## Review

### "Never replicated" is structural, not only tested

The issue asks for a test that fails if anything calls `sync()`, and there is one — a `Proxy`
that throws on `sync` or `replicate`, with the cache driven through it.

But the stronger guarantee is the **shape**: `LocalCache` exposes `readProfile`, `writeProfile`
and `clear`, and never hands back the PouchDB handle. A caller cannot replicate what it cannot
reach, so "nobody synced it" stops being a thing to remember and becomes a thing that cannot be
expressed. There is an assertion on the interface's surface too, so widening it is a deliberate
edit.

Why it would be wrong rather than merely unnecessary: replicating this would push a **cached
copy of server state** back at the server as though it were user data, and pull other people's
cached state down.

### The authorisation warning, taken literally

The module note says outright that a permission check reading this is a defect, and why: it
would move an authorisation decision onto the machine of the person it is meant to constrain,
where it can be edited in a devtools console. Nothing in this PR reads it for any such purpose,
and the note is there for whoever is tempted at M5.

### Three decisions with a failure behind each

**`clear()` destroys the database rather than deleting documents.** A deleted document leaves a
tombstone that still carries its id, and the point of signing out is that nothing of the previous
user remains in this browser. There is a test for the tombstone specifically.

**The revision is re-read on every write, not remembered.** A cache written from two tabs is
ordinary, and a stale `_rev` there would be a conflict over a value both tabs agree about.

**"Nothing cached" and "the cache is unreadable" stay different facts.** A 404 answers
`undefined`; anything else throws. Reporting the second as the first would silently reset a
user's language on a corrupt database.

### In the browser

`localProfileCache()` sits beside `projectDatabase()` in the one module that opens databases.
`forgetLocalProfileCache()` exists because `clear()` *destroys* the database and a destroyed
PouchDB handle does not come back — a later read through the same object fails rather than
finding an empty cache. Sign-out (#46) calls both.

### Not here

The project-list scenarios, `localState`, and reporting revoked access are M5's, as the issue
says. The profile *endpoint* that fills this cache is #43, next.
