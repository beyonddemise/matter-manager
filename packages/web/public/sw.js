/**
 * The service worker. Hand-written, not generated (ADR 0013).
 *
 * A service worker sits in front of every request the application makes and outlives the page
 * that installed it. It is the last place to want code nobody has read, which is why this file
 * is short enough to read in one sitting and does exactly three things:
 *
 *   1. precaches the shell, so the application opens with no connectivity;
 *   2. serves fingerprinted assets from the cache, because their contents cannot change;
 *   3. **declines to touch anything else at all.**
 *
 * The third is the one that matters most and looks like the least. A `fetch` handler that does
 * not call `respondWith` leaves the request entirely alone — the browser makes it as though no
 * service worker existed. Everything not named here takes that path deliberately:
 *
 * - **Replication must never be intercepted.** A cached `_changes` response would corrupt sync
 *   in a way that is close to undiagnosable: the replication protocol would reason about stale
 *   sequence data and conclude, correctly given what it was told, that it was up to date. The
 *   data loss would appear days later on a different device.
 * - **The API must never be intercepted.** A cached `POST` result or a stale project list is
 *   an application lying about what the server holds.
 * - **Cross-origin requests are not ours to cache.**
 *
 * A classic script, not a module. Module service workers exist in Chromium and not in Safari,
 * and Safari is where this application most needs to work — see the ZXing note in
 * `src/scan/detector.ts` for the same lesson learned once already.
 *
 * Registered by `src/register-sw.ts`. The update flow — telling the user a new version is
 * ready — is M2b-4 (#31); this worker deliberately does **not** call `skipWaiting()`, so that
 * taking an update stays a decision made there rather than one made silently here.
 */

/**
 * Bump when the shape of what is cached changes.
 *
 * Not on every deploy. Fingerprinted assets get new URLs of their own, and the shell is
 * revalidated on every navigation, so a version bump is for changing the *rules* — not the
 * contents. Old caches are deleted on activate.
 */
const CACHE = 'matter-manager-v1'

/**
 * What the application needs to open with no connectivity.
 *
 * Only the shell. The fingerprinted bundles are not listed because their names are decided at
 * build time and this file is not built — and they do not need to be: the first load fetches
 * them, and {@link cacheFirst} keeps them from then on. Listing them would mean a hand-written
 * file that has to be regenerated on every build, which is the generated service worker this
 * project decided against, arriving through a side door.
 */
const SHELL = '/'

/** Fingerprinted by the bundler: a given URL's bytes never change. */
const ASSET_PATH = '/assets/'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // `reload` so that installing a new worker cannot precache a shell the HTTP cache is
      // still holding from the previous deploy. The deployment sends `no-cache` for this
      // document (see `public/_headers`), and this makes the worker independent of that
      // having been got right.
      cache.add(new Request(SHELL, { cache: 'reload' })),
    ),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      )
      // Without this the first page load after installation is uncontrolled: the worker is
      // active but governs nothing until the next navigation, so a user who goes offline
      // immediately after their first visit gets nothing.
      .then(() => self.clients.claim()),
  )
})

/**
 * Whether this is a request for the application's own shell.
 *
 * Keyed on `mode === 'navigate'` rather than on the path, because a hash route
 * (`#/devices/…`) is the same document and the hash never reaches the network at all.
 */
function isNavigation(request) {
  return request.mode === 'navigate'
}

/** Whether this is one of the bundler's fingerprinted files. */
function isAsset(url) {
  return url.pathname.startsWith(ASSET_PATH)
}

/**
 * The shell: network first, cache as the fallback.
 *
 * This way round on purpose, and it is what keeps a user from being stranded on an old build.
 * Cache-first here would mean a returning visitor is served yesterday's HTML — which names
 * yesterday's fingerprinted bundle, which is still validly cached — so the application would
 * be permanently correct and permanently out of date. Going to the network first costs one
 * request that the deployment already marks `no-cache`, and the cached copy is there for
 * exactly the case it is meant for: no connectivity.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE)
      await cache.put(SHELL, response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match(SHELL)
    if (cached !== undefined) return cached
    throw error
  }
}

/**
 * A fingerprinted asset: from the cache if it is there, otherwise fetched and kept.
 *
 * Safe to serve without revalidating precisely because the URL is fingerprinted. A changed
 * file is a different URL, so a cache hit cannot be stale.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached !== undefined) return cached

  const response = await fetch(request)
  // Only a real, complete, same-origin success. An opaque response has no readable status —
  // `ok` is false and `status` is 0 — so caching one would store a failure that then serves
  // forever from a URL that can never be reconsidered.
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Not GET: nothing here is safe to serve from a cache, and a POST to the API least of all.
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Not ours. CouchDB replication lives on another origin, and this is the line that keeps
  // `_changes` out of a cache — see the module note for what that would cost.
  if (url.origin !== self.location.origin) return

  // Same-origin but the server's business, not the shell's. The API arrives in M4; the rule is
  // written now so that it cannot arrive into a worker that was already caching it.
  if (url.pathname.startsWith('/api/')) return

  if (isNavigation(request)) {
    event.respondWith(networkFirst(request))
    return
  }

  if (isAsset(url)) {
    event.respondWith(cacheFirst(request))
  }

  // Everything else — the manifest, icons, anything added later — is left to the browser.
  // Silence here is a decision: a worker that caches by default caches things nobody thought
  // about, and the first anyone hears of it is a user who cannot get a fix.
})
