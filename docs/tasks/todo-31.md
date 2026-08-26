# Todo — #31 · M2b-4 Service worker updates and offline UX

Branch: `31-sw-updates-offline-ux` (stacked on `30-offline-pwa`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: a new version is picked up
  Then I am told an update is available and can take it
  And I am never stuck on an old bundle with no way forward

Scenario: offline state is visible but not alarming
  Then an unobtrusive indicator is shown
  And no action is blocked except those genuinely requiring a server
```

> **Its own issue on purpose.** A stale service worker serving an old bundle indefinitely is
> *the* classic PWA production failure, and it is invisible to whoever deployed it.
>
> **Test plan:** deploy twice and confirm the second version is actually reached. This cannot
> be verified locally against a single build.

## Plan

- [x] `updates.ts` — notice a waiting version, take it, and check for one
- [x] `connectivity.ts` — whether the browser believes it has a network
- [x] `sw.js` gains a `message` handler; `skipWaiting()` is called from there and nowhere else
- [x] The shell announces both, and blocks nothing
- [x] `main.ts` wires the noticing to the announcing
- [x] Strings through `msg()`, German written

### Tests (each observed failing first)
- [x] an update that installed while the page was open is announced
- [x] one that has been waiting since a previous visit is announced too
- [x] a first-ever install is **not** announced
- [x] accepting asks the waiting worker to take over, and reloads only once it has
- [x] a worker that never answers still gets the user to the new version
- [x] the reload happens exactly once, however many ways it is triggered
- [x] the indicator appears when the network goes, and on a page loaded offline
- [x] nothing is blocked while offline
- [x] the worker steps aside only for the message it is looking for

## Review

**Both scenarios met**, with one caveat the issue itself states: the end-to-end proof needs two
deployments and cannot be produced locally. What *can* be proved is every decision the flow
makes, and those are all in `updates.ts`, driven against fakes — 10/10 mutations caught.

### "Never stuck with no way forward" is three separate mechanisms

1. **The shell is network-first** (#89). A returning visitor always gets fresh HTML naming the
   current bundle, so even a user who ignores the prompt is not pinned.
2. **A check when the page becomes visible.** Someone returning to an application they left
   open for days is exactly the person pinned to an old build. The browser checks on
   navigation; an installed PWA can go a long time without one.
3. **A timeout on taking the update.** If the waiting worker never answers — discarded,
   message lost, browser declined — the page reloads anyway after three seconds, and gets the
   new version through mechanism 1. Without it, a button that does nothing would be the *only*
   way forward, which is worse than no button.

### `controlled` is the whole update-versus-install distinction

A worker reaches `installed` on a first visit too. Announcing "a new version is available" to
someone who has just arrived is an application talking about itself. The check is
`navigator.serviceWorker.controller !== null`, and it is read in `main.ts` **before** anything
is awaited — a first install sets `controller` partway through the flow, so reading it later
classifies a brand-new visitor as an update.

The other half is `registration.waiting`, checked on start-up. An update that installed
yesterday is sitting there right now; without that check the user is told only if a *further*
version arrives while they happen to be watching, which is the case that never happens.

### `skipWaiting()` is called from the message handler and nowhere else

That is the difference between an update the user took and one that happened to them: a worker
skipping waiting on its own replaces the code behind a page already running, which is how a
half-filled form meets a bundle that disagrees with it. The handler checks *which* message,
because a worker receives them from every client in its scope.

### The offline indicator, and why it is a tag rather than a banner

`navigator.onLine` can be trusted to say **offline** and cannot be trusted to say **online** —
it is true for a laptop on a café network that has not been paid for. That asymmetry decides
what the indicator is for: it states a fact the user already suspects, so nothing is blocked on
it, and nothing is. Every action here works offline because every write goes to a local
database first. The indicator explains a delay in *sharing*, not a loss of *function*.

It is reported immediately rather than only on a transition, because a page loaded while
already offline fires no event at all — an indicator that appeared only on a change would be
missing exactly when it is most true.

### One seam that had to exist

`AppShell.takeUpdate` is injectable, and this is not tidiness. The real implementation schedules
a reload of the page it is running in; a browser test that called it would reload the test
browser three seconds later, out of the middle of whatever was running by then — a failure
surfacing in an unrelated file. The shell's test proves the button reaches the seam; what
happens beyond it is `updates.test.ts`'s business.
