# M4-7 Sign out and session expiry (#46)

- [x] `POST /auth/signout` in the contract, and in the API
- [x] `packages/web/src/session.ts` — sign-out and expiry, kept apart on purpose
- [x] `packages/web/src/tokens.ts` — the in-memory access token, so `forgetTokens` means something
- [x] `removeLocalDatabases()` — the real removal, by name rather than by open handle
- [x] Mutation probes on all four: 23/23 caught
- [x] `npm run verify` — 1263 tests, 66 files

---

## The two scenarios are two different operations

The issue says the second scenario is the important one, and it is right. The whole module is
arranged around keeping them apart:

| | Tokens | Local databases | What the user sees |
|---|---|---|---|
| **Sign out** — the user asked | discarded | **removed** | nothing; they chose this |
| **Expired** — nobody asked | discarded | **untouched** | a prompt to sign in again |

Collapsing the two is a one-line mistake — `catch (401) { signOut() }` reads perfectly well —
and it destroys unsynced work belonging to somebody who never asked for anything to be deleted.
In an application designed to be used in a basement, unsynced is the *normal* state.

Two things make the mistake hard to make here rather than merely discouraged:

- `sessionExpired` takes `Pick<SessionDependencies, 'forgetTokens'>`. It is not given the means
  to delete anything, so the mistake does not compile. The probe confirms it: widening the
  parameter and adding `void deps.removeLocalData()` is caught.
- `isSessionEnded` is **401 only**. A 403 is a refusal that signing in again cannot fix, and a
  network failure is being offline, which is ordinary. Prompting on either sends the user round
  a loop that cannot help them.

## `signOut` never throws

A sign-out that reports an error leaves the user unsure whether they are signed out, and their
reasonable next move — closing the tab — leaves them signed in. Every step is attempted whatever
the ones before it did, and the return value is the list of what could not be done, so the
interface can say "we could not remove everything" without pretending the sign-out did not
happen.

The order is the cautious one: tokens first (the only step that cannot fail), then the server
session, then local data. A failure part-way through leaves a browser with data it can no longer
reach rather than a browser with no data and a live session — of the two half-finished states,
that is the one that loses nothing.

Signing out **offline still removes local data**. The cookie will be refused eventually anyway;
what matters on a shared machine is that the data goes.

## Removing by name, not by handle

`removeLocalDatabases()` destroys `project_local` and `mm-local` **by name**. Destroying the
memoised handles instead would remove only what this page happened to have opened — a user who
reloads and signs out from the settings page without visiting the device list would keep every
device on disk while the interface said they had signed out. There is a test that never opens
the database at all.

Both are attempted with `Promise.allSettled` rather than sequential `await`s: stopping at the
first failure leaves the second database intact, which is the same "signed out but the data is
still here" state. Failures are collected into an `AggregateError` so `signOut` can report them.

The memoised handles are forgotten **before** the destroys and unconditionally. A destroyed
PouchDB handle does not come back — a later read through the same object fails rather than
finding an empty database — and if a destroy fails the handle may point at something half gone.

## Where the access token lives

`tokens.ts` holds it in a module-scoped variable and nowhere else. Of the three credentials in
this application it is the only one the page can read, because PouchDB has to put it in an
`Authorization` header; the PKCE carrier and the session are httpOnly cookies precisely because
nothing in the page needs them (todo-41). In `localStorage` the token survives the tab, is
readable by any script that ever runs on the origin, and grants direct access to that user's
database.

The change that breaks this is a *reasonable-sounding* one — "keep people signed in across a
reload" — so there is a test that watches web storage and fails if anything is written to it,
with a positive control that fails if the spy is not attached.

An expired token is reported as **absent**, not as an error: needing a new one is ordinary, and
the caller's response is the same either way. There is a 30-second margin, because a token with
two seconds left is not worth sending — the request may arrive after it dies, and the 401 then
looks like a server problem rather than an expiry.

## The endpoint

`POST /auth/signout` has to be a server operation: the session cookie is httpOnly, so the page
cannot clear it, and a page that merely forgot its own token would still be signed in on the
next request. It clears the flow carrier too — a half-finished sign-in left behind at sign-out
is a PKCE verifier lying around for a flow nobody is going to complete.

**No session check.** Signing out when already signed out is not an error, and answering 401
would leave a user who is confused about their state unable to reach a state they are certain
about. The browser side agrees: `endServerSessionVia` treats 401 as success.

### What it does not do

It does not revoke an access token that has already been issued — that token stays
cryptographically valid until it expires. There is a test that says so out loud rather than
leaving the impression that sign-out is a revocation. This is why the access token is
short-lived; real revocation belongs with M5's project work, not here.

## What is left, and why

The pieces are wired to each other but not yet to a button, because there is no sign-in UI in
the browser yet — M4-3 built the server flow, and no issue in M4 or M5 adds the surface. The
composition is two lines when it lands:

```ts
signOut({
  endServerSession: endServerSessionVia(apiBaseUrl),
  removeLocalData: removeLocalDatabases,
  forgetTokens,
})
```

`session.ts` deliberately imports no PouchDB, which is what lets it be tested in plain Node; the
`removeLocalData` half comes from `db/project-database.ts`, and the two meet at the button.

`tokens.ts` gets its first real consumer at **#49 (replicate projects)**, which is what needs an
`Authorization` header.

## Mutation probes

| Module | Result |
|---|---|
| `web/src/session.ts` (policy) | 7/7 caught |
| `web/src/session.ts` (`endServerSessionVia`) | 6/6 caught |
| `web/src/tokens.ts` | 8/8 caught |
| `web/src/db/project-database.ts` | 6/6 caught |
| `api/src/auth/routes.ts` (sign-out) | 3/3 caught |

Two of the token probes only started failing after the test was rewritten — see **L26** in
`lessons.md`. A test that wrote *and* read through the default clock passed happily when that
clock was mutated to milliseconds and when it was frozen at zero, because a consistently wrong
clock is consistently wrong on both sides of the comparison. The fix was to write through the
default and read through a clock known to be in seconds.
