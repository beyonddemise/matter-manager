# Todo — #45 · M4-6 Wire the entitlement seam into the API

Branch: `45-entitlement-seam` (stacked on `43-profile-locale`)

## Acceptance criteria (from the issue)

> Every gated endpoint calls `can(principal, action, project)` — which still returns true.
>
> ```gherkin
> Scenario: no gated action bypasses the seam
>   Then a test enumerates gated actions and asserts each route calls the seam
> ```
>
> **That enumeration test is what makes the seam real rather than decorative.**

## Review

### The map is the feature, not the function

A seam each handler *remembers* to call is a seam with a hole in it the first time somebody
forgets — and the hole is invisible, because an ungated endpoint behaves exactly like a working
one. So the mapping from action to enforcement point is declared **exhaustively, in one place**,
as `Record<Action, Enforcement>`: adding an action to `core` breaks this build until somebody
decides where it is enforced. The same trick `POLICIES` already uses, for the same reason.

### Two of five actions are API actions, and the other three say why

`device.create`, `device.attachPhoto` and `pdf.export` happen entirely in the browser, against a
local database — the API is never asked, so there is nothing here to gate. They are in the map
as `kind: 'client'` **with a stated reason**, because an action silently absent would look
identical to one somebody forgot, and the whole value of the map is that those two cannot be
confused. A test asserts each reason is actually written.

### The honest state today: no gated route exists yet

`POST /projects` and `PUT /projects/{id}/members` are both M5's. So the enumeration asserts the
*correct current state* — neither is registered — in the same "list that must shrink
deliberately" style as the drift check's pending operations.

**Verified by breaking it.** Registering `POST /projects` without a gate makes **three** tests
fail, and one of them says what to do:

```
Error: POST /projects is implemented and gated by project.create, but this test has no way to
observe the gate being called. Give the route an injectable `gate` dependency and assert it here.
```

That is the point of doing this before the first gated route rather than after: the check is
written by somebody thinking about entitlement, not by somebody reading a handler that already
works.

### Two smaller decisions

**The gate throws rather than returning a boolean.** A handler that forgets to check a returned
boolean compiles, runs, and is ungated. Both mistakes are catchable, but only one is catchable
twice, and this is the cheaper half.

**403, never 401.** "We do not know who you are" invites signing in again, which for an
entitlement failure sends the user round a loop that cannot help them.
