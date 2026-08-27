/**
 * Registering the service worker.
 *
 * Separate from `main.ts` so that the question "does this application install a worker, and
 * under what conditions" has one file to read. A service worker outlives the page that
 * registered it, so registering one is closer to installing software than to loading a script.
 *
 * The worker itself is `public/sw.js`, hand-written and unbundled (ADR 0013). The update
 * flow — noticing a new version and offering it — is M2b-4 (#31); this file only gets the
 * worker installed.
 *
 * @module
 */

/** Where the worker lives. Root scope, because it has to control `/` as well as every route. */
export const SERVICE_WORKER_URL = '/sw.js'

/**
 * Installs the service worker, if this browser and this page can have one.
 *
 * Deliberately quiet about every way it can fail. A registration that does not happen means an
 * application which works exactly as it did before, minus the offline case — so a visible
 * error would report a problem the user cannot act on, about a feature they did not ask for.
 *
 * @param container `navigator.serviceWorker`, passed rather than reached for so that this
 *   tests without a browser and so the "not supported" path is reachable at all — it cannot be
 *   produced in a browser that supports them.
 * @returns the registration, or `undefined` when there is none to be had
 */
export async function registerServiceWorker(
  container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker,
): Promise<ServiceWorkerRegistration | undefined> {
  // Absent in Firefox private windows, in browsers that do not implement them, and on an
  // insecure origin — where the whole API is simply not there rather than failing when used.
  if (container === undefined) return undefined

  try {
    return await container.register(SERVICE_WORKER_URL, { scope: '/' })
  } catch {
    // A blocked registration, storage refused, an origin that disallows workers. Not logged
    // with the URL or anything about the page: this application holds setup passcodes, and a
    // habit of logging context is how one eventually ends up in a log.
    return undefined
  }
}
