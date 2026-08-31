# todo-120 — Seven web modules are written, tested, and never imported

Closes #120 in three parts. **All three are done.**

## Why three parts

Issue 120's acceptance spans a composition root, build-time configuration, a generated `_headers`,
a test that catches an orphaned module, the API's missing Dockerfile, a runnable dev stack,
sign-in and sign-out in the interface, and replication wiring. The issue says it plainly:
*"This is not one bug."* A single change touching authentication is the shape review serves
worst, so it lands in three:

1. **This one — the ground it needs.** The API's missing `Dockerfile`, a one-command dev stack,
   the Vite proxy that makes `/api` and `/db` same-origin, and the configuration both read.
   Nothing is claimed to be wired yet.
2. **Sign-in and sign-out**, against a stubbed provider.
3. **Projects and replication**, and with them the test that fails on a module no entry point
   reaches — which can only pass once the last of the seven is reachable.

## Same-origin, so there are no origins to allow

`_headers` says two deployment origins must be added to `connect-src` when this is wired.
That was written before the topology was settled: the application keeps its Cloudflare Pages
deployment and Pages Functions proxy `/api` and `/db` to the API host, so the browser only ever
talks to its own origin. `connect-src 'self'` already covers it, and there is nothing to
generate into that file.

Development matches: Vite proxies the same two paths, so the same relative URLs work in both.
That is the point — a path that only works in one of them is a bug nobody sees until deploy.

## Google sign-in cannot be exercised here

Without `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` the API serves no
`/auth` routes at all — `composition.ts` returns no provider and `server.ts` registers nothing.
No OAuth client is available for this work, so part two wires sign-in against a stub and says so
rather than implying the real handshake has been seen to work.

Projects and replication are unaffected: their routes take a bearer token this repository's own
key signs, so the dev stack can mint one.

## Tasks

- [x] `packages/api/Dockerfile` — the file `infra/compose.prod.yml` has referenced since M0
- [x] One command that brings up CouchDB, the API and the web application together
- [x] Dev keys generated on first run rather than pasted from a README
- [x] Vite proxies `/api` and `/db`
- [x] `.env.example` says how the two are reached, and something reads it
- [x] The stack verified running end to end, not merely started

## Review

**Part one done.** `npm run verify` clean, 2112 tests pass, and the stack was run rather than
merely written.

### Verified running, not merely started

`/healthz` returning 200 is what an *unconfigured* service returns — L28 is about exactly that
test passing while the deployment served no project routes. So the checks were:

| Through | Result |
| --- | --- |
| `docker run` the image against the CouchDB container | `/healthz` 200 |
| the same container | `POST /projects` **401**, not 404 — the route is registered and wants a token |
| the same container | `/auth/google` 404 — no Google client, exactly as designed |
| `npm run dev:stack`, then the Vite origin | `/api/healthz` → `{"status":"ok"}` |
| the same | `/db/` → CouchDB's welcome document |
| the same | `/api/projects` → 401, so the proxy reaches the API and the API is configured |

The 401 is the load-bearing one. A 404 there would mean the image starts, reports itself
healthy, and serves nothing — which is the failure mode `main.ts` was written to avoid and the
one a health check cannot see.

### `devProxy` takes its environment as an argument

The first version of the test read the resolved Vite config, which calls `loadEnv` — so the
assertions depended on whichever `.env` the machine happened to have. It passed here because
`dev-stack.mjs` had just written one with the default values in it. That is a test that passes
for its author and fails for everybody else, so the proxy construction is a function taking an
env object, and the test supplies its own.

It also covers the case a deployment tool creates: `DEV_API_TARGET=` rendered empty for an unset
value must fall back rather than produce an empty target, which is how `composition.ts` treats
the API's own variables.

### Two things deliberately not done here

**No composition root yet, and no claim that anything is wired.** The seven modules are still
orphaned. Part three brings them in along with the test that fails on a module no entry point
reaches — a test that cannot pass before the last of them is reachable, so writing it now would
mean writing it skipped.

**Nothing generated into `_headers`.** The issue expected two deployment origins to be added to
`connect-src`. The topology settled since: Pages Functions serve `/api` and `/db` from the
application's own origin, so `connect-src 'self'` already covers it and there is no substitution
step to build.

---

# Part two — signing in and out

## The composition root

`packages/web/src/composition.ts`, which is what #120 suggested and what was missing. Every one
of the seven orphaned modules was correct in isolation; what nothing held was the file that
constructs them. That is why each story closed honestly with its module reviewed and its suite
green — from the inside, that is exactly what a finished feature looks like.

Three of the seven are reachable now: `session.ts`, `tokens.ts`, and `endServerSessionVia`.
`profile.ts`, `projects.ts` and the three `sync/` modules follow in part three, with the test
that fails on a module no entry point reaches.

## There is no "am I signed in" endpoint, and there does not need to be

The session is an httpOnly cookie the page cannot read, so the only way to find out is to try to
exchange it — and the exchange is worth doing anyway. Asking and getting are one request.

`POST /api/auth/token` with `credentials: 'include'`. 200 with a token means signed in and the
token is kept; 401 means signed out. **Anything else is not an answer**: being unable to reach
the server is this application's ordinary state, not a session ending, so it reports `signed-out`
without discarding anything rather than putting an error in front of somebody in a basement whose
devices are all present.

A 200 whose body is not a token is treated as signed out too. A status code is not a session, and
believing one would leave the application making requests with no token and blaming the user's
session for the 401s that followed.

## Three states, two controls

`expired` gets the same control as `signed-out` and a different word. The remedy is identical —
sign in again — but "your session ended" and "you are not signed in" are different facts, and the
first reassures somebody whose data is still on the device that nothing has been lost.

Neither control renders until the first answer arrives. Offering "Sign in" to somebody who *is*
signed in, for the moment it takes to find out, is worse than offering nothing for that moment.

## What has not been executed

**The Google handshake.** It needs an OAuth client, and without `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` the API serves no `/auth` routes at all — so in
the dev stack, pressing "Sign in" reaches a 404. That is the API behaving as designed, and it is
also the reason nothing here can claim the round trip works.

Everything on either side of that redirect is tested: what the application sends, what it does
with each answer, and what it shows for each state. The redirect itself is a claim nobody has
checked, and saying so is the point of writing it down.

---

# Part three — projects, replication, and the check that closes it

## Wired means used, not constructed

The temptation in this part was to import the remaining four modules into `composition.ts` and
call the job done. That would have reproduced #120 one level up: a composition root holding
things nothing calls is an orphan with a nicer name, and the reachability check below would have
passed while the application still did nothing with them.

So each is reached by something that has an effect:

| Module | What uses it |
| --- | --- |
| `profile.ts` | the locale follows the profile, so a preference set on a phone reaches a laptop |
| `projects.ts` | the account's projects are listed when a session is found |
| `sync/manager.ts`, `sync/replication.ts`, `sync/remote.ts` | those projects replicate, and the header says what replication is doing |

## The summary shows the worst state, and nothing when idle

A summary saying everything is through while one project cannot reach the server would be
reassuring and wrong — the reader's question is "is everything through?", not "is anything?".

And nothing at all when every project is `idle`. The steady state is everything being fine, and a
badge that is always present says nothing when it matters. Same reasoning as the offline tag it
sits beside.

`offline` is deliberately not an error. The local database is complete and usable; replication
resuming later is exactly what that state means.

## Replication stops before the sign-out, not after

It holds an access token and a live connection to a database the browser is about to be told it
may not read. There is a test that asserts the ordering rather than merely that both happen.

## The check that would have caught this

`scripts/check-module-graph.mjs` walks the import graph from `main.ts` and reports what it never
arrives at. In CI and in `npm run verify`.

**A graph walk rather than a grep**, because reachability is not local. A grep for a module's
name finds its own tests, its own documentation, and the comment explaining why it exists — and
finds an importer that is itself unreachable. That last one is the mechanism that hid these
seven: `db/project-database.ts` mentions `accessToken`, which made `tokens.ts` look used.

Dynamic imports count, and must: the QR fallback, the locale catalogues and every theme are
reached that way on purpose, and treating them as unreachable would make the check fire on the
code most deliberately written.

Watched failing on a fixture where an orphan imports another orphan, which is the case that
matters and the one a simpler check would miss. Both are reported, by name — a count is not
actionable, because the answer differs per module: wire this one, delete that one.
