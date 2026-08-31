import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { describe, expect, it, vi } from 'vitest'
import type { SessionState } from '../src/session.js'
import '../src/app-shell.js'

/**
 * #120's last acceptance line: signing in and out is reachable from the interface.
 *
 * Until now `identity.ts` returned `LOCAL_AUTHOR_SUB = 'local'` unconditionally and there was no
 * sign-in control anywhere — which was the offline-first default working exactly as intended,
 * and also the reason nothing had ever needed a session.
 *
 * The real Google handshake is **not** exercised here and has never been executed: it needs an
 * OAuth client, and without one the API serves no `/auth` routes at all. What is tested is
 * everything this application is responsible for on either side of that redirect.
 */

/**
 * Signs out through the confirmation.
 *
 * Two steps since #55, because signing out now asks a question: everything the account put here
 * goes, and the catalogue that predates the account goes only if the reader says so.
 */
async function signOut(
  element: HTMLElement,
  options: { alsoRemoveLocal?: boolean } = {},
): Promise<void> {
  await waitUntil(() => element.querySelector('[data-sign-out]') !== null, 'not signed in')
  ;(element.querySelector('[data-sign-out]') as HTMLElement).click()
  await waitUntil(
    () => element.querySelector('[data-confirm-sign-out]') !== null,
    'no confirmation',
  )

  if (options.alsoRemoveLocal === true) {
    const box = element.querySelector('[data-remove-local]') as HTMLElement & { checked: boolean }
    box.checked = true
  }
  ;(element.querySelector('[data-confirm-sign-out]') as HTMLElement).click()
  await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'still signed in')
}

const shell = async (session: SessionState, overrides: Record<string, unknown> = {}) => {
  const element = (await fixture(html`
    <app-shell
      .readSession=${async () => session}
      .signIn=${overrides.signIn ?? (() => {})}
      .signOutOf=${overrides.signOutOf ?? (async () => [])}
      .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
    ></app-shell>
  `)) as HTMLElement & { updateComplete: Promise<unknown> }
  await element.updateComplete
  return element
}

describe('the sign-in control', () => {
  it('offers to sign in when there is no session', async () => {
    const element = await shell('signed-out')
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in control')
    expect(element.querySelector('[data-sign-in]')?.textContent?.trim()).toBe('Sign in')
  })

  it('offers to sign out when there is one', async () => {
    const element = await shell('signed-in')
    await waitUntil(() => element.querySelector('[data-sign-out]') !== null, 'no sign-out control')
    expect(element.querySelector('[data-sign-in]')).toBeNull()
  })

  it('says an expired session ended, rather than that you were never signed in', async () => {
    // The remedy is the same - sign in again - but they are different facts, and this one
    // reassures somebody whose devices are still on the device that nothing has been lost.
    const element = await shell('expired')
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in control')
    expect(element.querySelector('[data-sign-in]')?.textContent).toContain('Session ended')
  })

  it('shows neither until the answer arrives', async () => {
    // Offering "Sign in" to somebody who is signed in, for the moment it takes to find out, is
    // worse than offering nothing for that moment.
    const element = (await fixture(html`
      <app-shell
        .readSession=${() => new Promise<SessionState>(() => {})}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
      ></app-shell>
    `)) as HTMLElement
    expect(element.querySelector('[data-sign-in]')).toBeNull()
    expect(element.querySelector('[data-sign-out]')).toBeNull()
  })

  it('leaves the page to sign in', async () => {
    const signIn = vi.fn()
    const element = await shell('signed-out', { signIn })
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in control')
    ;(element.querySelector('[data-sign-in]') as HTMLElement).click()
    expect(signIn).toHaveBeenCalledOnce()
  })

  it('ends up signed out even when signing out reported problems', async () => {
    // `signOut` never throws and always leaves the browser signed out: it forgets the token
    // first, unconditionally, and attempts every later step regardless. A button still saying
    // "Sign out" after that would be the interface disagreeing with itself.
    const element = await shell('signed-in', {
      signOutOf: async () => ['the local data could not be removed'],
    })
    await signOut(element)
    expect(element.querySelector('[data-sign-out]')).toBeNull()
  })
})

describe('what happens once there is a session', () => {
  /** The shell, with every outward reach injected. */
  const wired = async (overrides: Record<string, unknown>) => {
    const element = (await fixture(html`
      <app-shell
        .readSession=${async () => 'signed-in' as const}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .followLocale=${overrides.followLocale ?? (async () => undefined)}
        .listProjects=${overrides.listProjects ?? (async () => [])}
        .makeSync=${overrides.makeSync ?? (() => stubSync())}
      ></app-shell>
    `)) as HTMLElement & { updateComplete: Promise<unknown> }
    await element.updateComplete
    return element
  }

  const stubSync = (record?: { set?: unknown[]; stopped?: boolean }) => ({
    set: (projects: unknown[]) => {
      if (record) record.set = projects
    },
    running: () => [],
    stateOf: () => undefined,
    stopAll: () => {
      if (record) record.stopped = true
    },
  })

  it('replicates the projects the account has', async () => {
    const record: { set?: unknown[]; stopped?: boolean } = {}
    await wired({
      listProjects: async () => [{ projectId: 'p1', dbName: 'project_p1' }],
      makeSync: () => stubSync(record),
    })
    await waitUntil(() => record.set !== undefined, 'replication never started')
    expect(record.set).toEqual([{ projectId: 'p1', dbName: 'project_p1' }])
  })

  it('starts nothing when the account has no projects', async () => {
    // Not an error and not a state worth showing. A manager with an empty list is a manager
    // doing nothing, and constructing one to do nothing is just something else to stop.
    let made = false
    await wired({
      listProjects: async () => [],
      makeSync: () => {
        made = true
        return stubSync()
      },
    })
    expect(made).toBe(false)
  })

  it('does not start replication when the project list arrives after sign-out', async () => {
    let resolveProjects:
      | ((projects: readonly { projectId: string; dbName: string }[]) => void)
      | undefined
    const projects = new Promise<readonly { projectId: string; dbName: string }[]>((resolve) => {
      resolveProjects = resolve
    })
    let made = false
    const element = (await fixture(html`
      <app-shell
        .readSession=${async () => 'signed-in' as const}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .followLocale=${async () => undefined}
        .listProjects=${() => projects}
        .makeSync=${() => {
          made = true
          return stubSync()
        }}
        .signOutOf=${async () => []}
      ></app-shell>
    `)) as HTMLElement

    await signOut(element)
    resolveProjects?.([{ projectId: 'p1', dbName: 'project_p1' }])
    await Promise.resolve()

    expect(made).toBe(false)
  })

  it('carries on when the project list cannot be fetched', async () => {
    // There is nothing the reader can do about it and nothing they lose by it: their devices
    // are on this device. Replication resuming later is what the summary's `offline` is for.
    const element = await wired({
      listProjects: async () => {
        throw new Error('offline')
      },
    })
    expect(element.querySelector('[data-sign-out]')).not.toBeNull()
  })

  it('shows the worst state, not the most reassuring one', async () => {
    // A summary saying everything is through while one project cannot reach the server would
    // be reassuring and wrong.
    const element = await wired({
      listProjects: async () => [
        { projectId: 'p1', dbName: 'a' },
        { projectId: 'p2', dbName: 'b' },
      ],
      makeSync: (onState: (id: string, state: string) => void) => {
        queueMicrotask(() => {
          onState('p1', 'idle')
          onState('p2', 'offline')
        })
        return stubSync()
      },
    })
    await waitUntil(() => element.querySelector('[data-syncing]') !== null, 'no summary')
    expect(element.querySelector('[data-syncing]')?.textContent).toContain('Waiting to sync')
  })

  it('says nothing at all when everything is through', async () => {
    // The steady state is everything being fine, and a badge that is always there says nothing
    // when it matters.
    const element = await wired({
      listProjects: async () => [{ projectId: 'p1', dbName: 'a' }],
      makeSync: (onState: (id: string, state: string) => void) => {
        queueMicrotask(() => onState('p1', 'idle'))
        return stubSync()
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(element.querySelector('[data-syncing]')).toBeNull()
  })

  it('stops replicating before signing out, not after', async () => {
    // Replication holds an access token and a live connection to a database this browser is
    // about to be told it may not read.
    const record: { set?: unknown[]; stopped?: boolean } = {}
    let stoppedBeforeSignOut = false
    const element = (await fixture(html`
      <app-shell
        .readSession=${async () => 'signed-in' as const}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .followLocale=${async () => undefined}
        .listProjects=${async () => [{ projectId: 'p1', dbName: 'a' }]}
        .makeSync=${() => stubSync(record)}
        .signOutOf=${async () => {
          stoppedBeforeSignOut = record.stopped === true
          return []
        }}
      ></app-shell>
    `)) as HTMLElement
    await signOut(element)
    expect(stoppedBeforeSignOut).toBe(true)
  })
})

describe('a session that ends while startup is still in flight', () => {
  const stubSync = (record?: { set?: unknown[]; stopped?: boolean }) => ({
    set: (projects: unknown[]) => {
      if (record) record.set = projects
    },
    running: () => [],
    stateOf: () => undefined,
    stopAll: () => {
      if (record) record.stopped = true
    },
  })

  it('does not start replicating after the user has signed out', async () => {
    // Found by review. `listProjects` is a network request that outlives the call: signing out
    // while it is in flight would otherwise build a replication manager *after* the sign-out
    // that stopped the previous one - replicating with a token that has been forgotten, against
    // a database this browser has just been told it may not read.
    let release: (projects: readonly unknown[]) => void = () => {}
    const record: { set?: unknown[]; stopped?: boolean } = {}

    const element = (await fixture(html`
      <app-shell
        .readSession=${async () => 'signed-in' as const}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .followLocale=${async () => undefined}
        .listProjects=${() =>
          new Promise((resolve) => {
            release = resolve
          })}
        .makeSync=${() => stubSync(record)}
        .signOutOf=${async () => []}
      ></app-shell>
    `)) as HTMLElement

    await signOut(element)

    // The project list arrives only now, after the sign-out has completed.
    release([{ projectId: 'p1', dbName: 'a' }])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(record.set).toBeUndefined()
  })

  it('ignores a locale the account it belonged to has left', async () => {
    // The profile answers whenever it answers. Applying it afterwards would set the interface
    // language from an account that is no longer signed in.
    let applyLocale: (locale: string) => void = () => {}
    let applied = false

    const element = (await fixture(html`
      <app-shell
        .readSession=${async () => 'signed-in' as const}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .followLocale=${async (onChange: (locale: string) => void) => {
          applyLocale = (locale) => {
            applied = true
            onChange(locale)
          }
        }}
        .listProjects=${async () => []}
        .signOutOf=${async () => []}
      ></app-shell>
    `)) as HTMLElement

    await signOut(element)

    applyLocale('de')
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The callback ran; what matters is that the shell declined to act on it. Asserting the
    // callback never fires would be testing the stub rather than the guard.
    expect(applied).toBe(true)
    expect(document.documentElement.lang).not.toBe('de')
  })
})
