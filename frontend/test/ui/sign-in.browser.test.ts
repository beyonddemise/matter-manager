import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/otp-input/otp-input.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailSignIn, StartOutcome, VerifyOutcome } from '../../src/ui/email-signin.js'
import type { SessionState } from '../../src/ui/session.js'
import '../../src/ui/app-shell.js'
import type { LocalProjectEntry } from '../../src/data/index.js'
import type { LocalProjectDependencies } from '../../src/ui/local-projects.js'
import {
  refresherNeverAnswering,
  refresherReporting,
  refresherSignedOutThenRefreshed,
} from './refresher-stub.js'
import { destroyProjectStores, isolatedProjectStore } from './support/project-store.js'

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

afterEach(async () => {
  await destroyProjectStores()
})

/** A store whose index already lists `entries`. */
async function storeListing(
  ...entries: readonly LocalProjectEntry[]
): Promise<LocalProjectDependencies> {
  const store = isolatedProjectStore()
  for (const entry of entries) await store.cache().addLocalProject(entry)
  return store
}

/** A downloaded copy of the server project `p1`. */
const COPY: LocalProjectEntry = {
  dbName: 'project_p1',
  name: 'Beta',
  projectId: 'p1',
  role: 'owner',
  createdAt: '2026-10-01T00:00:00.000Z',
}

const shell = async (session: SessionState, overrides: Record<string, unknown> = {}) => {
  const element = (await fixture(html`
    <app-shell
      .refresher=${refresherReporting(session)}
      .signIn=${overrides.signIn ?? (() => {})}
      .signOutOf=${overrides.signOutOf ?? (async () => [])}
      .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
      .projectStore=${isolatedProjectStore()}
    ></app-shell>
  `)) as HTMLElement & { updateComplete: Promise<unknown> }
  await element.updateComplete
  return element
}

/** What a stub replication manager was asked. */
interface Recorded {
  set?: unknown[]
  stopped?: boolean
  /** Whether it was handed a list after it was stopped: a replication outliving its session. */
  setAfterStop?: boolean
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
        .refresher=${refresherNeverAnswering}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .projectStore=${isolatedProjectStore()}
      ></app-shell>
    `)) as HTMLElement
    expect(element.querySelector('[data-sign-in]')).toBeNull()
    expect(element.querySelector('[data-sign-out]')).toBeNull()
  })

  it('opens the method chooser; Google in it starts the redirect and closes the dialog', async () => {
    const signIn = vi.fn()
    const element = await shell('signed-out', { signIn })
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in control')
    ;(element.querySelector('[data-sign-in]') as HTMLElement).click()
    await waitUntil(
      () => element.querySelector('[data-sign-in-dialog][open]') !== null,
      'no chooser',
    )
    expect(signIn).not.toHaveBeenCalled()
    ;(element.querySelector('[data-google-sign-in]') as HTMLElement).click()

    expect(signIn).toHaveBeenCalledOnce()
    await waitUntil(() => element.querySelector('[data-sign-in-dialog]') === null, 'still open')
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
        .refresher=${refresherReporting('signed-in')}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .projectStore=${overrides.store ?? isolatedProjectStore()}
        .followLocale=${overrides.followLocale ?? (async () => undefined)}
        .listProjects=${overrides.listProjects ?? (async () => [])}
        .makeSync=${overrides.makeSync ?? (() => stubSync())}
      ></app-shell>
    `)) as HTMLElement & { updateComplete: Promise<unknown> }
    await element.updateComplete
    return element
  }

  const stubSync = (record?: Recorded) => ({
    set: (projects: unknown[]) => {
      if (!record) return
      record.set = projects
      if (record.stopped) record.setAfterStop = true
    },
    running: () => [],
    stateOf: () => undefined,
    stop: () => {},
    pushNow: async () => {},
    suspend: () => {},
    resume: () => {},
    stopAll: () => {
      if (record) record.stopped = true
    },
  })

  it('replicates the copies of the account’s projects that are on this device', async () => {
    const record: Recorded = {}
    await wired({
      store: await storeListing(COPY),
      listProjects: async () => [
        { projectId: 'p1', dbName: 'project_p1', name: 'Beta', role: 'owner', archived: false },
        { projectId: 'p2', dbName: 'project_p2', name: 'Gamma', role: 'owner', archived: false },
      ],
      makeSync: () => stubSync(record),
    })
    await waitUntil(() => (record.set?.length ?? 0) > 0, 'replication never started')
    // Not p2: listed, but not downloaded here, and replicating it would download it.
    expect(record.set).toEqual([{ projectId: 'p1', dbName: 'project_p1' }])
  })

  it('replicates nothing when nothing of the account is on this device', async () => {
    // The manager is built all the same: the projects page needs it to push while promoting.
    const record: Recorded = {}
    await wired({ listProjects: async () => [], makeSync: () => stubSync(record) })
    await waitUntil(() => record.set !== undefined, 'replication never set')
    expect(record.set).toEqual([])
  })

  it('does not start replication when the project list arrives after sign-out', async () => {
    let resolveProjects: ((projects: readonly unknown[]) => void) | undefined
    const projects = new Promise<readonly unknown[]>((resolve) => {
      resolveProjects = resolve
    })
    const record: Recorded = {}
    const element = (await fixture(html`
      <app-shell
        .refresher=${refresherReporting('signed-in')}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .projectStore=${isolatedProjectStore()}
        .followLocale=${async () => undefined}
        .listProjects=${() => projects}
        .makeSync=${() => stubSync(record)}
        .signOutOf=${async () => []}
      ></app-shell>
    `)) as HTMLElement

    await signOut(element)
    resolveProjects?.([
      { projectId: 'p1', dbName: 'project_p1', name: 'Beta', role: 'owner', archived: false },
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(record.stopped).toBe(true)
    expect(record.setAfterStop).toBeUndefined()
  })

  it('carries on when the project list cannot be fetched', async () => {
    // There is nothing the reader can do about it and nothing they lose by it: their devices
    // are on this device. Replication resuming later is what the status bar's "Sync pending" is
    // for.
    const element = await wired({
      listProjects: async () => {
        throw new Error('offline')
      },
    })
    expect(element.querySelector('[data-sign-out]')).not.toBeNull()
  })

  it('stops replicating before signing out, not after', async () => {
    // Replication holds an access token and a live connection to a database this browser is
    // about to be told it may not read.
    const record: Recorded = {}
    let stoppedBeforeSignOut = false
    const element = (await fixture(html`
      <app-shell
        .refresher=${refresherReporting('signed-in')}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .projectStore=${isolatedProjectStore()}
        .followLocale=${async () => undefined}
        .listProjects=${async () => [{ projectId: 'p1', dbName: 'a', name: 'Beta', role: 'owner', archived: false }]}
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
  const stubSync = (record?: Recorded) => ({
    set: (projects: unknown[]) => {
      if (!record) return
      record.set = projects
      if (record.stopped) record.setAfterStop = true
    },
    running: () => [],
    stateOf: () => undefined,
    stop: () => {},
    pushNow: async () => {},
    suspend: () => {},
    resume: () => {},
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
    const record: Recorded = {}

    const element = (await fixture(html`
      <app-shell
        .refresher=${refresherReporting('signed-in')}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .projectStore=${isolatedProjectStore()}
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
    release([{ projectId: 'p1', dbName: 'a', name: 'Beta', role: 'owner', archived: false }])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(record.stopped).toBe(true)
    expect(record.setAfterStop).toBeUndefined()
  })

  it('ignores a locale the account it belonged to has left', async () => {
    // The profile answers whenever it answers. Applying it afterwards would set the interface
    // language from an account that is no longer signed in.
    let applyLocale: (locale: string) => void = () => {}
    let applied = false

    const element = (await fixture(html`
      <app-shell
        .refresher=${refresherReporting('signed-in')}
        .connectivity=${{ addEventListener: () => {}, removeEventListener: () => {}, onLine: true }}
        .projectStore=${isolatedProjectStore()}
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

describe('signing in with an emailed code', () => {
  /** An email client whose two calls a test scripts and records. */
  function fakeEmailAuth(
    start: (email: string, locale: string) => Promise<StartOutcome> | StartOutcome,
    complete: (challenge: string, code: string) => Promise<VerifyOutcome> | VerifyOutcome,
  ) {
    const starts: Array<{ email: string; locale: string }> = []
    const completes: Array<{ challenge: string; code: string }> = []
    const client: EmailSignIn = {
      start: async (email, locale) => {
        starts.push({ email, locale })
        return start(email, locale)
      },
      complete: async (challenge, code) => {
        completes.push({ challenge, code })
        return complete(challenge, code)
      },
    }
    return { client, starts, completes }
  }

  const stubManager = () => ({
    set: () => {},
    running: () => [],
    stateOf: () => undefined,
    stop: () => {},
    pushNow: async () => {},
    suspend: () => {},
    resume: () => {},
    stopAll: () => {},
  })

  /**
   * A signed-out shell with the email client injected and replication observable. The refresher
   * behaves like the real one around an email sign-in: `signed-out` at startup, `refreshed` once
   * restarted over the stored refresh token — so a shell that forgets the restart stays
   * signed out, exactly as it would in production.
   */
  const emailShell = async (client: EmailSignIn, overrides: Record<string, unknown> = {}) => {
    const makeSync = vi.fn(() => stubManager())
    const refresher = refresherSignedOutThenRefreshed()
    const element = (await fixture(html`
      <app-shell
        .refresher=${refresher.factory}
        .signIn=${overrides.signIn ?? (() => {})}
        .connectivity=${{
          addEventListener: () => {},
          removeEventListener: () => {},
          onLine: overrides.onLine ?? true,
        }}
        .projectStore=${isolatedProjectStore()}
        .followLocale=${async () => undefined}
        .listProjects=${async () => []}
        .makeSync=${makeSync}
        .emailAuth=${client}
      ></app-shell>
    `)) as HTMLElement & { updateComplete: Promise<unknown> }
    await element.updateComplete
    return { element, makeSync, refresher: refresher.counters }
  }

  /** Through the chooser to the email step, address filled, code requested. */
  const requestCode = async (element: HTMLElement, email = 'ada@example.com') => {
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in control')
    ;(element.querySelector('[data-sign-in]') as HTMLElement).click()
    await waitUntil(
      () => element.querySelector('[data-sign-in-dialog][open]') !== null,
      'no chooser',
    )
    const dialog = element.querySelector('[data-sign-in-dialog]') as HTMLElement
    ;(dialog.querySelector('[data-email-option]') as HTMLElement).click()
    await waitUntil(() => dialog.querySelector('[data-email-input]') !== null, 'no email step')
    const input = dialog.querySelector('[data-email-input]') as HTMLElement & { value: string }
    input.value = email
    ;(dialog.querySelector('[data-send-code]') as HTMLElement).click()
    return dialog
  }

  /** Types the full code, which fires the otp input's completion. */
  const typeCode = (dialog: HTMLElement, code: string) => {
    const field = dialog.querySelector('[data-code-input]') as HTMLElement & { value: string }
    field.value = code
    field.dispatchEvent(new CustomEvent('wa-complete', { bubbles: true }))
  }

  it('signs in in place: session flips, sync starts once, focus and announcement follow', async () => {
    const { client, starts, completes } = fakeEmailAuth(
      () => ({ kind: 'challenge', challenge: 'c-1' }),
      () => ({ kind: 'signed-in', expiresIn: 300 }),
    )
    const { element, makeSync, refresher } = await emailShell(client)

    const dialog = await requestCode(element)
    await waitUntil(() => dialog.querySelector('[data-code-input]') !== null, 'no code step')
    expect(starts).toEqual([{ email: 'ada@example.com', locale: 'en' }])
    expect(dialog.textContent).toContain('ada@example.com')

    typeCode(dialog, '123456')
    await waitUntil(() => element.querySelector('[data-sign-out]') !== null, 'never signed in')
    expect(completes).toEqual([{ challenge: 'c-1', code: '123456' }])
    expect(element.querySelector('[data-sign-in-dialog]')).toBeNull()
    expect(makeSync).toHaveBeenCalledTimes(1)
    // The restart is what keeps the session alive past the first token's 300 seconds: a faked
    // `refreshed` outcome would flip the session and then let the token die unrefreshed.
    expect(refresher.starts).toBe(2)
    expect(refresher.stops).toBe(1)
    expect(element.querySelector('[data-status-announcement]')?.textContent?.trim()).toBe(
      'Signed in.',
    )
    await waitUntil(
      () => document.activeElement === element.querySelector('[data-scheme-toggle]'),
      'focus went nowhere',
    )
  })

  it('moves focus into each step: the address field, then the code field', async () => {
    const { client } = fakeEmailAuth(
      () => ({ kind: 'challenge', challenge: 'c-1' }),
      () => ({ kind: 'failed' }),
    )
    const { element } = await emailShell(client)
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in control')
    ;(element.querySelector('[data-sign-in]') as HTMLElement).click()
    await waitUntil(
      () => element.querySelector('[data-sign-in-dialog][open]') !== null,
      'no chooser',
    )
    const dialog = element.querySelector('[data-sign-in-dialog]') as HTMLElement
    ;(dialog.querySelector('[data-email-option]') as HTMLElement).click()
    await waitUntil(
      () => document.activeElement === dialog.querySelector('[data-email-input]'),
      'focus never reached the address',
    )
    const input = dialog.querySelector('[data-email-input]') as HTMLElement & { value: string }
    input.value = 'ada@example.com'
    ;(dialog.querySelector('[data-send-code]') as HTMLElement).click()
    await waitUntil(
      () => document.activeElement === dialog.querySelector('[data-code-input]'),
      'focus never reached the code',
    )
  })

  it('does not ask the server about a code that is not six digits', async () => {
    const { client, completes } = fakeEmailAuth(
      () => ({ kind: 'challenge', challenge: 'c-1' }),
      () => ({ kind: 'signed-in', expiresIn: 300 }),
    )
    const { element } = await emailShell(client)
    const dialog = await requestCode(element)
    await waitUntil(() => dialog.querySelector('[data-code-input]') !== null, 'no code step')

    const field = dialog.querySelector('[data-code-input]') as HTMLElement & { value: string }
    field.value = '123'
    ;(dialog.querySelector('[data-verify]') as HTMLElement).click()
    await waitUntil(
      () =>
        dialog.querySelector('[data-sign-in-status]')?.textContent?.includes("didn't work") ===
        true,
      'no message for the short code',
    )
    expect(completes).toHaveLength(0)
  })

  it('disables the actions and says a connection is needed while offline', async () => {
    const { client } = fakeEmailAuth(
      () => ({ kind: 'challenge', challenge: 'c-1' }),
      () => ({ kind: 'failed' }),
    )
    const { element } = await emailShell(client, { onLine: false })
    await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'no sign-in control')
    ;(element.querySelector('[data-sign-in]') as HTMLElement).click()
    await waitUntil(
      () => element.querySelector('[data-sign-in-dialog][open]') !== null,
      'no chooser',
    )
    const dialog = element.querySelector('[data-sign-in-dialog]') as HTMLElement

    expect(dialog.querySelector('[data-needs-connection]')).not.toBeNull()
    expect(
      (dialog.querySelector('[data-google-sign-in]') as HTMLElement).hasAttribute('disabled'),
    ).toBe(true)
  })

  it('hides the email option and keeps Google when start answers 404', async () => {
    const { client } = fakeEmailAuth(
      () => ({ kind: 'unavailable' }),
      () => ({ kind: 'failed' }),
    )
    const { element } = await emailShell(client)

    const dialog = await requestCode(element)
    await waitUntil(() => dialog.querySelector('[data-email-option]') === null, 'option stayed')
    expect(dialog.querySelector('[data-google-sign-in]')).not.toBeNull()
    expect(dialog.querySelector('[data-sign-in-status]')?.textContent).toContain(
      'Email sign-in is not available yet.',
    )
  })

  it('keeps the code step on a wrong code, with the one failure message', async () => {
    const { client, completes } = fakeEmailAuth(
      () => ({ kind: 'challenge', challenge: 'c-1' }),
      () => ({ kind: 'failed' }),
    )
    const { element } = await emailShell(client)

    const dialog = await requestCode(element)
    await waitUntil(() => dialog.querySelector('[data-code-input]') !== null, 'no code step')
    typeCode(dialog, '000000')
    await waitUntil(
      () =>
        dialog
          .querySelector('[data-sign-in-status]')
          ?.textContent?.includes("That code didn't work") === true,
      'no failure message',
    )

    expect(dialog.querySelector('[data-code-input]')).not.toBeNull()
    expect(element.querySelector('[data-sign-out]')).toBeNull()
    expect(completes).toHaveLength(1)
  })

  it('sends one verify however often the completion fires while one is in flight', async () => {
    let release: (outcome: VerifyOutcome) => void = () => {}
    const { client, completes } = fakeEmailAuth(
      () => ({ kind: 'challenge', challenge: 'c-1' }),
      () =>
        new Promise<VerifyOutcome>((resolve) => {
          release = resolve
        }),
    )
    const { element } = await emailShell(client)
    const dialog = await requestCode(element)
    await waitUntil(() => dialog.querySelector('[data-code-input]') !== null, 'no code step')

    typeCode(dialog, '123456')
    typeCode(dialog, '123456')
    ;(dialog.querySelector('[data-verify]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(completes).toHaveLength(1)
    release({ kind: 'failed' })
  })

  it('a sign-in that lands after the dialog closed is still committed', async () => {
    let release: (outcome: VerifyOutcome) => void = () => {}
    const { client } = fakeEmailAuth(
      () => ({ kind: 'challenge', challenge: 'c-1' }),
      () =>
        new Promise<VerifyOutcome>((resolve) => {
          release = resolve
        }),
    )
    const { element, makeSync } = await emailShell(client)
    const dialog = await requestCode(element)
    await waitUntil(() => dialog.querySelector('[data-code-input]') !== null, 'no code step')
    typeCode(dialog, '123456')
    ;(dialog as HTMLElement & { open: boolean }).open = false
    await waitUntil(() => element.querySelector('[data-sign-in-dialog]') === null, 'still open')

    release({ kind: 'signed-in', expiresIn: 300 })

    // The client already holds and stored the tokens: a shell that kept saying "Sign in" over
    // live credentials would be lying, and the next reload would sign in silently anyway. So
    // the session flips and sync starts — the dialog stays gone, and the change is announced.
    await waitUntil(() => element.querySelector('[data-sign-out]') !== null, 'never committed')
    expect(makeSync).toHaveBeenCalledTimes(1)
    expect(element.querySelector('[data-status-announcement]')?.textContent?.trim()).toBe(
      'Signed in.',
    )
  })

  it('a failure that lands after the dialog closed stays silent', async () => {
    let release: (outcome: VerifyOutcome) => void = () => {}
    const { client } = fakeEmailAuth(
      () => ({ kind: 'challenge', challenge: 'c-1' }),
      () =>
        new Promise<VerifyOutcome>((resolve) => {
          release = resolve
        }),
    )
    const { element, makeSync } = await emailShell(client)
    const dialog = await requestCode(element)
    await waitUntil(() => dialog.querySelector('[data-code-input]') !== null, 'no code step')
    typeCode(dialog, '123456')
    ;(dialog as HTMLElement & { open: boolean }).open = false
    await waitUntil(() => element.querySelector('[data-sign-in-dialog]') === null, 'still open')

    release({ kind: 'failed' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(element.querySelector('[data-sign-out]')).toBeNull()
    expect(makeSync).not.toHaveBeenCalled()
    expect(element.querySelector('[data-status-announcement]')?.textContent?.trim()).toBe('')
  })

  it('says the service was unreachable when verifying offline', async () => {
    const { client } = fakeEmailAuth(
      () => ({ kind: 'challenge', challenge: 'c-1' }),
      () => ({ kind: 'unreachable' }),
    )
    const { element } = await emailShell(client)
    const dialog = await requestCode(element)
    await waitUntil(() => dialog.querySelector('[data-code-input]') !== null, 'no code step')

    typeCode(dialog, '123456')
    await waitUntil(
      () =>
        dialog
          .querySelector('[data-sign-in-status]')
          ?.textContent?.includes('could not be reached') === true,
      'no unreachable message',
    )
    expect(dialog.querySelector('[data-code-input]')).not.toBeNull()
  })
})
