/**
 * Signing out, and what happens when a session simply runs out.
 *
 * **These are two different things and the difference is the whole issue.** Treating an expired
 * token as a sign-out is the easy mistake, and it is catastrophic: it deletes local databases
 * belonging to somebody who never asked for anything to be deleted, including work that has not
 * reached a server yet — which, in an application designed to be used in a basement, is the
 * normal state rather than an edge case.
 *
 * | | Tokens | Local databases | Prompt |
 * |---|---|---|---|
 * | **Sign out** — the user asked | discarded | **removed** | none; they chose this |
 * | **Expired** — nobody asked | discarded | **untouched** | sign in again |
 *
 * The right-hand column is the one to get wrong quietly.
 *
 * @module
 */

/** What the application believes about the current session. */
export type SessionState =
  /** No account, or the user signed out. Everything local to this browser is gone. */
  | 'signed-out'
  | 'signed-in'
  /**
   * The credential is no longer accepted, and nobody chose that.
   *
   * Local data is intact and stays intact. The only thing to do is offer to sign in again.
   */
  | 'expired'

/** What signing out has to reach. Injected so a test does not destroy a real browser's storage. */
export interface SessionDependencies {
  /** Ends the server-side session. The cookie is httpOnly, so only the server can clear it. */
  readonly endServerSession: () => Promise<void>
  /**
   * Removes every database this browser holds for the signed-in user.
   *
   * Deliberately a single call rather than a list: forgetting one of several would leave a
   * previous user's devices on a shared machine, which is precisely what signing out is for.
   */
  readonly removeLocalData: () => Promise<void>
  /** Forgets the in-memory access token. */
  readonly forgetTokens: () => void
}

/**
 * Signs out: discards tokens, ends the server session, and removes local data.
 *
 * Order matters, and this order is the cautious one. The server session is ended **first**, so
 * that a failure part-way through leaves a browser with data it can no longer reach rather than
 * a browser with no data and a live session. Of the two half-finished states, that is the one
 * that does not lose anything.
 *
 * **It never throws.** A sign-out that fails and reports an error leaves the user unsure whether
 * they are signed out — and their reasonable next move, closing the tab, leaves them signed in.
 * Every step is attempted regardless of the ones before it.
 *
 * @returns the problems that occurred, so an interface can say "we could not remove everything"
 *   without pretending the sign-out did not happen
 */
export async function signOut(deps: SessionDependencies): Promise<readonly string[]> {
  const problems: string[] = []

  // First, and unconditionally. The token in memory is the one thing that can be discarded with
  // no possibility of failure, so it is discarded before anything that can fail.
  deps.forgetTokens()

  try {
    await deps.endServerSession()
  } catch {
    problems.push('server')
  }

  try {
    await deps.removeLocalData()
  } catch {
    problems.push('local')
  }

  return problems
}

/**
 * What to do when a token is refused.
 *
 * **Nothing is deleted.** This is the case the issue calls out: a session that expired while the
 * user was offline must not cost them a single unsynced change. They are asked to sign in again
 * and everything they have stays where it is.
 *
 * The token is forgotten because it is no longer good for anything — keeping it would mean
 * retrying a request that cannot succeed — but that is memory, not data.
 */
export function sessionExpired(deps: Pick<SessionDependencies, 'forgetTokens'>): SessionState {
  deps.forgetTokens()
  return 'expired'
}

/**
 * Whether a response means the session has ended.
 *
 * 401 only. **A 403 is not an expiry**: it means the credential was understood and refused, so
 * signing in again produces the same refusal — and prompting for it sends the user round a loop
 * that cannot help them. A network failure is not an expiry either; it is being offline, which
 * this application treats as ordinary.
 */
export function isSessionEnded(status: number): boolean {
  return status === 401
}

/**
 * Builds the "end the server session" step of {@link SessionDependencies}.
 *
 * Kept here, beside the policy it serves, and deliberately free of any PouchDB import — this
 * module has to stay loadable outside a browser, which is also what lets its tests run in plain
 * Node. The `removeLocalData` half comes from `db/project-database.ts`, and the two are put
 * together at the point where a sign-out button exists.
 *
 * `credentials: 'include'` because the session is an httpOnly cookie: the page cannot read it,
 * so it cannot send it any other way, and a request without it would clear nothing while
 * reporting success.
 */
export function endServerSessionVia(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): () => Promise<void> {
  const base = baseUrl.replace(/\/+$/, '')

  return async () => {
    const response = await fetchImpl(`${base}/auth/signout`, {
      method: 'POST',
      credentials: 'include',
    })

    // 401 is not a failure. Being told "you were not signed in" is the state this was asking
    // for, and reporting it as a problem would tell the user something went wrong when the only
    // thing that happened is that they were already out.
    if (!response.ok && response.status !== 401) {
      throw new Error(`The session could not be ended (${response.status}).`)
    }
  }
}
