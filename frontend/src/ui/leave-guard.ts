/**
 * Leaving a view that holds unsaved input (#356): the contract between the shell, which owns
 * navigation, and a view that would lose something if it were navigated away from.
 *
 * The view marks itself with {@link LEAVE_GUARD} and implements {@link LeaveGuard}; the shell
 * finds it among what it renders, and asks it before a navigation would replace it. Found in the
 * shell's own tree rather than registered somewhere global, so a view the shell is not showing
 * can never hold the shell back.
 *
 * @module
 */

/** The attribute a view carries while it implements {@link LeaveGuard}. */
export const LEAVE_GUARD = 'data-leave-guard'

/** A view that may hold input that leaving it would lose. */
export interface LeaveGuard {
  /**
   * Whether leaving now would lose something the person entered. Asked first, synchronously, so
   * that a navigation nothing would be lost to goes ahead without a dialog.
   */
  holdsInput(): boolean
  /** Asks the person whether to leave; resolves `true` to leave, `false` to stay. */
  confirmLeave(): Promise<boolean>
  /**
   * Puts the view's own address back after the browser has already moved away from it (Back, an
   * address typed in) and the person chose to stay.
   */
  restoreAddress(): void
}

/** The guarding view inside `root`, if one is rendered there. */
export function leaveGuardIn(root: ParentNode): LeaveGuard | undefined {
  return root.querySelector<Element & LeaveGuard>(`[${LEAVE_GUARD}]`) ?? undefined
}

/**
 * Whether two hashes are the same page: the same route, whatever their queries say. A query is
 * the page's own state (a list's room filter, the add form's step), and moving within it is not
 * leaving.
 */
export function samePage(a: string, b: string): boolean {
  const path = (hash: string) => (hash.split('?')[0] ?? '').replace(/^#/, '').replace(/\/$/, '')
  return path(a) === path(b)
}

/**
 * The in-app address a click is following, or `undefined` for anything else.
 *
 * Read from the event's composed path, because a `<wa-button href>` renders its link inside its
 * shadow root, where the shell's listener sees only the host. A click meant for a new tab or
 * window (a modifier key, another button, a `target`) leaves this page alone, so it is not
 * followed here.
 */
export function followedAddress(event: MouseEvent): string | undefined {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return undefined
  }
  // The first element on the path with an `href`: an `<a>`, or the `<wa-button>` host itself.
  const link = event
    .composedPath()
    .find((target): target is Element => target instanceof Element && target.hasAttribute('href'))
  if (link === undefined || (link.getAttribute('target') ?? '') !== '') return undefined
  const href = link.getAttribute('href')
  return href?.startsWith('#') ? href : undefined
}
