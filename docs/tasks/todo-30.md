# Todo — #30 · M2b-3 Offline-capable PWA

Branch: `30-offline-pwa` (stacked on `29-zxing-fallback`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: the app works with no connectivity
  Given the app has been loaded once
  When the device goes offline
  Then the app opens, lists devices, and accepts new ones

Scenario: it can be installed
  Then the app is installable on Android and iOS with an icon and splash screen
```

> The service worker is hand-written, not generated (ADR 0013) … A service worker sits in front
> of every request and outlives the page that installed it, which makes it the last place to
> want code nobody has read.
>
> That "never intercept replication" clause is not stylistic.

## Plan

- [x] `public/sw.js` — precache the shell, cache-first for fingerprinted assets, and decline
      everything else
- [x] `src/register-sw.ts` — registration, quiet about every way it can fail
- [x] `public/manifest.webmanifest` and icons; iOS's separate meta tags
- [x] `scripts/make-icons.mjs` — the icons, generated and committed
- [x] `_headers` gains rules for the manifest and the icons

### Tests (each observed failing first)
- [x] the shell is precached, past the HTTP cache
- [x] with no network, the shell comes from the cache — and with one, it does not
- [x] fingerprinted assets are served from the cache and kept on first fetch
- [x] a failed or opaque response is never cached
- [x] replication, the API, non-GET requests and cross-origin requests are left untouched
- [x] old caches are cleaned and open pages are claimed

## Review

**Both scenarios met.** The worker is 130 lines including its reasoning, which is the length
the issue asked for.

### Testing the file that actually ships

`public/sw.js` is copied verbatim into the build and is never bundled, so there is nothing to
import next to it. The obvious workaround — a module holding the logic, imported by both the
worker and the tests — would be a second copy free to drift from the one users get, and a
service worker that has drifted from its tests is the worst case there is: it sits in front of
every request and outlives the page.

So the test reads `public/sw.js` and evaluates it with a stubbed `self`, `caches` and `fetch`,
and drives it through its own events. That is possible only because it is a classic script with
no imports — which it has to be anyway, since Safari has no module service workers.

### What the mutation probe found

10 of 13 first time. All three survivors were rules **no test actually exercised**:

- **Network-first for the shell** — the test that proved it started with an empty cache, where
  cache-first falls through to the network anyway. With a cached shell present and the network
  up, the two strategies differ, and that difference is the whole anti-staleness property.
- **The cross-origin check** — the replication tests use cross-origin URLs whose paths are not
  `/assets/`, so they were already declined by the asset rule. What the origin check actually
  guards is a *CDN* path that looks like ours.
- **The API check** — same shape. `/api/projects` is not an asset either. What it guards is a
  **navigation** to an API URL, which without the rule would be answered with the cached
  application shell: the catalogue shown where data was asked for.

Each of those is a rule that reads as obviously necessary and was, until tested, doing nothing.
13/13 after.

### Decisions worth recording

**The precache list is the shell and nothing else.** The fingerprinted bundles' names are
decided at build time, and this file is not built. Listing them would mean a hand-written file
regenerated on every build — which is the generated service worker this project decided against
(ADR 0013), arriving through a side door. They do not need listing: the first load fetches them
and cache-first keeps them.

**The shell is network-first, assets are cache-first.** Opposite strategies for opposite facts.
An asset URL is fingerprinted, so a cache hit *cannot* be stale. The shell's URL never changes,
so a cache hit tells you nothing — and serving one names an old bundle that is still validly
cached, leaving the application permanently correct and permanently out of date.

**`skipWaiting()` is deliberately absent.** Taking an update is a decision, and where that
decision is made is #31.

**The icons are generated and committed.** One design at four sizes and two safe-zone rules, by
a script with no image dependency — a PNG of flat rectangles is a pixel buffer, a zlib stream
and three chunks. Committed rather than built, so a fresh clone needs no code-generation step;
the same reasoning the translation catalogue follows.

The mark is a QR code's finder patterns — what the application is *for*, legible at 48 pixels
where a lightbulb would not be, and impossible to mistake for a hub. Deliberately **not a valid
code**: a scannable one on an app icon invites a scan that decodes to nothing.

### Left for #31

The update flow, and the offline indicator. Also worth noting there: the ZXing chunk is cached
by the asset rule *once fetched*, so scanning works offline for anyone who has scanned once
online — and not for anyone who has not. Whether that chunk belongs in the precache is a
question with a real trade-off (400kB precached for every visitor, most of whom never need it),
and it belongs with the rest of the offline-experience work.
