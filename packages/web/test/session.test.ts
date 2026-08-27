import { describe, expect, it } from 'vitest'
import {
  endServerSessionVia,
  isSessionEnded,
  type SessionDependencies,
  sessionExpired,
  signOut,
} from '../src/session.js'

/** Records what each step was asked to do, and can be told to fail any of them. */
function deps(failing: { server?: boolean; local?: boolean } = {}) {
  const done: string[] = []
  const dependencies: SessionDependencies = {
    endServerSession: async () => {
      if (failing.server === true) throw new Error('offline')
      done.push('server')
    },
    removeLocalData: async () => {
      if (failing.local === true) throw new Error('storage refused')
      done.push('local')
    },
    forgetTokens: () => done.push('tokens'),
  }
  return { dependencies, done }
}

describe('signing out', () => {
  it('discards tokens, ends the server session and removes local data', async () => {
    // The issue's first scenario, in full. The user asked for this, so removing what is here is
    // what they asked for.
    const { dependencies, done } = deps()

    expect(await signOut(dependencies)).toEqual([])
    expect(done).toEqual(['tokens', 'server', 'local'])
  })

  it('forgets the token before anything that can fail', async () => {
    // The one step that cannot fail, done first — so a sign-out that goes wrong later has at
    // least stopped this tab using the credential.
    const { dependencies, done } = deps({ server: true, local: true })
    await signOut(dependencies)

    expect(done).toEqual(['tokens'])
  })

  it('ends the server session before removing local data', async () => {
    // The cautious order. A failure part-way through leaves a browser with data it can no longer
    // reach, rather than a browser with no data and a live session — of the two half-finished
    // states, that is the one that loses nothing.
    const { dependencies, done } = deps()
    await signOut(dependencies)

    expect(done.indexOf('server')).toBeLessThan(done.indexOf('local'))
  })

  it('removes local data even when the server cannot be reached', async () => {
    // Signing out on a train has to work. The cookie will be refused eventually anyway; what
    // matters on a shared machine is that the data goes.
    const { dependencies, done } = deps({ server: true })

    expect(await signOut(dependencies)).toEqual(['server'])
    expect(done).toContain('local')
  })

  it('never throws, whatever fails', async () => {
    // A sign-out that reports an error leaves the user unsure whether they are signed out — and
    // their reasonable next move, closing the tab, leaves them signed in.
    const { dependencies } = deps({ server: true, local: true })

    await expect(signOut(dependencies)).resolves.toEqual(['server', 'local'])
  })

  it('says what it could not do rather than pretending it did not happen', async () => {
    const { dependencies } = deps({ local: true })

    expect(await signOut(dependencies)).toEqual(['local'])
  })
})

describe('a session that simply ran out', () => {
  it('deletes nothing', async () => {
    // **The scenario that matters.** Treating an expiry as a sign-out deletes local databases
    // belonging to somebody who never asked for anything to be deleted — including work that
    // has not reached a server, which in this application is the normal state rather than an
    // edge case.
    const { dependencies, done } = deps()

    sessionExpired(dependencies)

    expect(done).toEqual(['tokens'])
    expect(done).not.toContain('local')
    expect(done).not.toContain('server')
  })

  it('reports a state the interface can prompt from', async () => {
    const { dependencies } = deps()
    expect(sessionExpired(dependencies)).toBe('expired')
  })

  it('is not the same state as signing out', async () => {
    // Two words, two behaviours. Collapsing them into one is exactly the mistake.
    const { dependencies } = deps()
    expect(sessionExpired(dependencies)).not.toBe('signed-out')
  })
})

describe('ending the session on the server', () => {
  /** A `fetch` that records its call and answers with the given status. */
  function stubFetch(status: number) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const impl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(null, { status })
    }) as unknown as typeof fetch
    return { calls, impl }
  }

  it('posts to the sign-out endpoint', async () => {
    const { calls, impl } = stubFetch(204)
    await endServerSessionVia('https://api.example', impl)()

    expect(calls[0]?.url).toBe('https://api.example/auth/signout')
    expect(calls[0]?.init?.method).toBe('POST')
  })

  it('sends the cookie', async () => {
    // The session is httpOnly, so this is the only way it travels. Without it the request goes
    // out unauthenticated, clears nothing, and answers as though it had worked.
    const { calls, impl } = stubFetch(204)
    await endServerSessionVia('https://api.example', impl)()

    expect(calls[0]?.init?.credentials).toBe('include')
  })

  it('does not build a doubled slash from a base url that has one', async () => {
    const { calls, impl } = stubFetch(204)
    await endServerSessionVia('https://api.example/', impl)()

    expect(calls[0]?.url).toBe('https://api.example/auth/signout')
  })

  it('treats being told "you were not signed in" as success', async () => {
    // Which is the state the caller was asking for. Reporting it as a problem would say
    // something went wrong when the only thing that happened is that they were already out.
    await expect(
      endServerSessionVia('https://api.example', stubFetch(401).impl)(),
    ).resolves.toBeUndefined()
  })

  it('reports a server failure', async () => {
    // So `signOut` can say "we could not remove everything" rather than claiming a sign-out the
    // server never performed.
    await expect(endServerSessionVia('https://api.example', stubFetch(500).impl)()).rejects.toThrow(
      /500/,
    )
  })

  it('lets a network failure through, for `signOut` to catch', async () => {
    const offline = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    await expect(endServerSessionVia('https://api.example', offline)()).rejects.toThrow()
  })
})

describe('what counts as the session ending', () => {
  it('is a 401', () => {
    expect(isSessionEnded(401)).toBe(true)
  })

  it('is not a 403', () => {
    // The credential was understood and refused, so signing in again produces the same refusal
    // — and prompting for it sends the user round a loop that cannot help them.
    expect(isSessionEnded(403)).toBe(false)
  })

  it.each([[0], [200], [404], [500], [502]])('is not a %i', (status) => {
    // A network failure in particular. Being offline is ordinary here, and treating it as an
    // expiry would prompt for sign-in every time somebody walked into a basement.
    expect(isSessionEnded(status)).toBe(false)
  })
})
