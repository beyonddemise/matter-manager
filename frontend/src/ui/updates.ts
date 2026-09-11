/**
 * Noticing that a new version is ready, and taking it.
 *
 * A stale service worker serving an old bundle indefinitely is *the* classic PWA production
 * failure, and it is invisible from the outside: the deploy succeeded, the CDN is correct, and
 * users are simply pinned to yesterday's code. Nothing is red anywhere. That is why this is its
 * own module with its own tests rather than a few lines inside the registration.
 *
 * Everything here takes its collaborators as arguments — the registration, the container, even
 * the reload — so the whole flow can be driven in Node against fakes. A browser test cannot
 * produce the situation this exists for: it needs two builds, one already installed.
 *
 * @module
 */

/** What the page and the waiting worker say to each other. One message, in one direction. */
export const SKIP_WAITING = 'matter-manager:skip-waiting'

/**
 * How long to wait for the new worker to take control before reloading anyway.
 *
 * The second half of "never stuck on an old bundle with no way forward". If the waiting worker
 * does not answer — it was discarded, the message was lost, the browser declined — then a
 * plain reload still gets the new version, because the shell is fetched network-first
 * (`public/sw.js`). Without this, a button that did nothing would be the *only* way forward,
 * which is worse than no button.
 */
const CONTROL_TIMEOUT = 3000

/**
 * Calls back when a new version is installed and waiting to take over.
 *
 * @param registration the registration from `registerServiceWorker`
 * @param controlled whether a worker is already controlling this page. **This is the whole
 *   distinction between an update and a first install.** On a first visit a worker also
 *   reaches `installed`, and telling that user "a new version is available" would be an
 *   application announcing itself to someone who has just arrived.
 * @param onReady given the waiting worker, once
 * @returns a function that stops watching
 */
export function watchForUpdate(
  registration: ServiceWorkerRegistration,
  controlled: boolean,
  onReady: (waiting: ServiceWorker) => void,
): () => void {
  if (!controlled) return () => {}

  let announced = false
  const announce = (worker: ServiceWorker) => {
    if (announced) return
    announced = true
    onReady(worker)
  }

  // Already waiting when this page loaded: the update installed during a previous visit and
  // has been sitting there ever since. Without this the user is told only if a *further*
  // version arrives while they watch, which is the case that never happens.
  if (registration.waiting !== null) announce(registration.waiting)

  const onUpdateFound = () => {
    const installing = registration.installing
    if (installing === null) return
    installing.addEventListener('statechange', () => {
      // `installed` and not `activated`: with no `skipWaiting()` in the worker, `activated` is
      // a state it only reaches once the user has agreed. Waiting for it would mean waiting
      // for the thing this callback exists to ask about.
      if (installing.state === 'installed') announce(installing)
    })
  }

  registration.addEventListener('updatefound', onUpdateFound)
  return () => registration.removeEventListener('updatefound', onUpdateFound)
}

/**
 * Takes the update: asks the waiting worker to take over, then reloads.
 *
 * The reload is what actually swaps the bundle — a new worker controlling an old page does not
 * change the JavaScript already running in it. It happens on `controllerchange` so that the
 * reloaded page is served by the *new* worker; reloading immediately would be a race the old
 * worker usually wins, producing a reload that changes nothing and a button that looks broken.
 *
 * @param waiting the worker from {@link watchForUpdate}
 * @param container `navigator.serviceWorker`
 * @param reload what to do once the new worker is in charge
 * @param timeout injectable so a test does not wait three seconds
 */
export function applyUpdate(
  waiting: ServiceWorker,
  container: ServiceWorkerContainer,
  reload: () => void,
  timeout: (run: () => void, ms: number) => unknown = setTimeout,
): void {
  let reloaded = false
  const once = () => {
    // `controllerchange` can fire more than once, and a reload loop is a worse failure than
    // anything this module is fixing: the application would be unusable rather than merely
    // out of date.
    if (reloaded) return
    reloaded = true
    reload()
  }

  container.addEventListener('controllerchange', once, { once: true })
  waiting.postMessage({ type: SKIP_WAITING })
  // The safety net. See {@link CONTROL_TIMEOUT}.
  timeout(once, CONTROL_TIMEOUT)
}

/**
 * Asks the browser to look for a new worker.
 *
 * Called when the page becomes visible again, because that is when someone has come back to an
 * application they may have left open for days — the exact situation in which they are pinned
 * to an old build without knowing it. The browser checks on navigation anyway; an installed PWA
 * often goes a long time without one.
 *
 * Failure is ignored, and the common failure is being offline. There is nothing to tell the
 * user: they are running the version they have, which is the correct outcome.
 */
export async function checkForUpdate(registration: ServiceWorkerRegistration): Promise<void> {
  try {
    await registration.update()
  } catch {
    // Offline, or the request was refused. Neither is actionable.
  }
}
