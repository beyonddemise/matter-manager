# todo-57 — Release 1.0 readiness

Closes #57 · closes #146 · closes #147 · manual half split to #148.

## What was automatable, and what was not

#57 lists six things. Three could be machine-checked, three cannot be checked from this
repository at all — devices, a live instance, and a backup restored into a clean environment.
Those are #148, written out with what each one needs rather than left as a line item.

The automatable half turned out to be one thing: **the end-to-end suite**. `e2e/README.md` has
described it since M2, and `ci.yml` says an e2e job "is added in M2, once there is a UI to
drive". Neither happened. The workspace held a README and a `package.json`.

## It found two defects on the way in

Both are the reason to have it, and neither was reachable from any unit test.

### The offline indicator could never appear (#146)

`watchConnectivity` reads `source.onLine`; the shell passed `window`. `onLine` is a property of
**`navigator`** — the *events* fire on `window`. Two different objects, one of them used for
both.

It failed silently because of a default that is right: *"a source that does not implement
`onLine` should read as online, because assuming a network blocks nothing"*. `undefined !== false`
is `true`, so the application reported a network however offline the browser was.

No unit test could catch it: every one injects a source, and every injected source has the
property. The suites proved the watcher works, and could not observe the single place that hands
it the wrong object.

### The application did not open offline after a single visit (#147)

ADR 0002's central promise, and it did not hold. Two independent causes, one symptom:

1. **A worker does not control the page that registered it.** So the visit that installs it
   fetches its scripts outside the worker's reach and they never enter the cache. Precaching only
   `/` meant the application opened offline from the *third* visit — one to install, one online
   for `cacheFirst` to populate `/assets/`, and only then.
2. **`Vary: Origin`.** Even once precached, the assets were not served: the worker's own precache
   fetch carries no `Origin` header while the page's script request does, so
   `caches.match(request)` never matched.

The second only became visible after the first was fixed.

`install` now reads the shell it just precached and caches the `/assets/` URLs it names — parsed
rather than generated, so the worker stays hand-written (ADR 0013) — with each asset added
separately, because `cache.addAll` rejects if any one request fails and would leave an install
that cached nothing. `cacheFirst` matches with `ignoreVary: true`, since the URL is the whole
identity of a fingerprinted asset, which is the premise of the `/assets/` rule already.

## What the suite covers

Eight journeys, driving the **built** site rather than the dev server, because what they are for
is precisely what differs between them: the service worker, the shipped bundle, and a real
IndexedDB surviving a reload.

- a code that cannot be scanned is typed, filed, and found again
- it survives a reload — the one thing every unit test takes on trust
- a room typed on the form becomes a room
- a device recorded with **no connectivity at all**
- it is still there when connectivity returns
- the offline indicator appears, and stops
- the application **opens** with the network gone

Chromium only, and deliberately: iOS Safari's storage eviction is the reason #112 exists, and
Playwright's WebKit is not iOS Safari. That stays in #148, written down rather than implied.

## The conflict journey is not here

`e2e/README.md` also asks for two contexts editing the same device offline. It needs two
**signed-in** browsers, and signing in needs an OAuth client this repository does not have — the
same gap #120 recorded. It is in #148 with the credential it waits on.

Conflict behaviour itself is not untested: `packages/data` drives it through three replicating
databases, which is where #53 put it and where #125 proved the resurrection signal.

## Tasks

- [x] A Playwright configuration, driving the built site
- [x] The journeys `e2e/README.md` names, less the one needing an account
- [x] `npm run e2e` in CI, after the build
- [x] Fix the two defects the suite found, with tests that fail without the fixes
- [x] Confirm German and English are complete — 164 units, none untranslated
- [x] Split the manual drill into #148 with what each item needs

## Review

`npm run verify`, `check:offline`, `check:graph`, `probe:runtime` clean; 2262 unit tests and 8
journeys pass.

Both fixes were verified by reverting them and watching the suite go red, which is the only way
to know a journey tests the thing it is named for.
