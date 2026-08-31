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
    await waitUntil(() => element.querySelector('[data-sign-out]') !== null, 'no sign-out control')
    ;(element.querySelector('[data-sign-out]') as HTMLElement).click()
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'still signed in')
    expect(element.querySelector('[data-sign-out]')).toBeNull()
  })
})
