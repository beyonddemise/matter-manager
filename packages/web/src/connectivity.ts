/**
 * Whether the browser believes it has a network.
 *
 * "Believes" is the operative word, and it is why this module says as little as it does.
 * `navigator.onLine` is false only when the browser is certain there is no network at all; it
 * is true for a laptop on a café network that has not been paid for, and for a phone with one
 * bar and no throughput. So it can be trusted to say *offline* and cannot be trusted to say
 * *online*.
 *
 * That asymmetry decides what the indicator is for. It shows a fact the user already suspects,
 * so nothing has to be blocked on it — and nothing is. Every action in this application works
 * offline, because everything is written to a local database first. The indicator explains a
 * *delay in sharing*, not a *loss of function*, which is exactly why it should be unobtrusive.
 *
 * @module
 */

/** What this needs from `window`, which is all this needs from a browser. */
export interface ConnectivitySource {
  readonly onLine?: boolean
  addEventListener(type: 'online' | 'offline', listener: () => void): void
  removeEventListener(type: 'online' | 'offline', listener: () => void): void
}

/**
 * Watches for the browser losing or regaining a network.
 *
 * @param source the event target, and where the initial state is read from
 * @param onChange called immediately with the current state, then on every change. Immediately,
 *   because a page loaded while already offline fires no event at all — and an indicator that
 *   only appears on a *transition* is one that is missing exactly when it is most true.
 * @returns a function that stops watching
 */
export function watchConnectivity(
  source: ConnectivitySource,
  onChange: (online: boolean) => void,
): () => void {
  // `!== false` rather than `=== true`: a source that does not implement `onLine` at all should
  // read as online, because assuming a network exists is the assumption that blocks nothing.
  const report = () => onChange(source.onLine !== false)

  source.addEventListener('online', report)
  source.addEventListener('offline', report)
  report()

  return () => {
    source.removeEventListener('online', report)
    source.removeEventListener('offline', report)
  }
}
