/**
 * Giving the browser a turn.
 *
 * An export that never yields is one long task, however many `await`s it contains: awaiting a
 * promise that is already resolved — or one settled by a microtask, which is what
 * `element.updateComplete` is — continues in the *same* task. Nothing is painted, no input is
 * handled, and the page is frozen. That is precisely how a 200-device export came to block the
 * main thread for eight seconds while looking, in the source, like a loop full of `await`s.
 *
 * **Not `setTimeout(…, 0)`.** After five levels of nesting the specification requires a 4ms
 * clamp, and an export yields once per device — so five hundred devices would spend two
 * seconds doing nothing but waiting for timers. A `MessageChannel` message is a task with no
 * clamp, which is the same yield without the tax.
 *
 * @module
 */

/** `scheduler.yield()` where the browser has it: same intent, and it keeps our place in line. */
interface Scheduler {
  readonly yield?: () => Promise<void>
}

const scheduler = (globalThis as { scheduler?: Scheduler }).scheduler

/**
 * Resolves after the browser has had a chance to paint and handle input.
 *
 * Prefers `scheduler.yield()`, which returns control at the *front* of the queue rather than
 * the back — so a long export is not overtaken by every other task on the page and made
 * dramatically slower for being polite.
 */
export function yieldToBrowser(): Promise<void> {
  if (scheduler?.yield !== undefined) return scheduler.yield()

  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
}
