import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/card/card.js'
import '@awesome.me/webawesome-pro/dist/components/format-date/format-date.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CachedPlanMatrix, LocalCache } from '../../src/data/index.js'
import { activateLocale } from '../../src/ui/i18n/localization.js'
import type { CredentialsLike } from '../../src/ui/passkey-signin.js'
import { type PlanMatrix, type PlansApi, resolvePlanMatrix } from '../../src/ui/plans.js'
import type {
  AddOutcome,
  ChangeOutcome,
  MethodsOutcome,
  Passkey,
  SignInMethodsApi,
} from '../../src/ui/sign-in-methods.js'
import type { AccountView } from '../../src/ui/views/account.js'
import '../../src/ui/views/account.js'

/**
 * The Account view: how this account signs in. Every case drives the view through a stubbed
 * sign-in-methods api, because the outcomes that matter (a full account, a closed sheet, a
 * session that ended) cannot be produced on demand by a real server or a real authenticator.
 */

const laptop: Passkey = {
  id: 'p1',
  label: 'Work laptop',
  createdAt: '2026-03-01T10:00:00Z',
  lastUsedAt: '2026-04-02T10:00:00Z',
}
const phone: Passkey = {
  id: 'p2',
  label: 'Phone',
  createdAt: '2026-05-01T10:00:00Z',
  lastUsedAt: '2026-05-02T10:00:00Z',
}

const methods = (over: Partial<{ google: boolean; github: boolean; email: boolean }> = {}) =>
  ({
    kind: 'methods',
    methods: { google: true, github: false, email: true, passkeys: [laptop], ...over },
  }) satisfies MethodsOutcome

/** A stub api; each method can be replaced per test. */
function stubApi(over: Partial<SignInMethodsApi> = {}): SignInMethodsApi {
  return {
    read: vi.fn(async (): Promise<MethodsOutcome> => methods()),
    add: vi.fn(async (): Promise<AddOutcome> => ({ kind: 'added', passkey: phone })),
    rename: vi.fn(async (): Promise<ChangeOutcome> => ({ kind: 'done' })),
    remove: vi.fn(async (): Promise<ChangeOutcome> => ({ kind: 'done' })),
    ...over,
  }
}

const credentials = {} as CredentialsLike

async function account(
  api: SignInMethodsApi,
  support: () => boolean = () => true,
  plan = 'free',
  plans: Partial<Pick<AccountView, 'loadPlans' | 'projectLimit' | 'planProjectLimit'>> = {},
): Promise<AccountView> {
  const element = (await fixture(
    html`<account-view
      .api=${api}
      .credentials=${credentials}
      .passkeySupport=${support}
      .loadPlans=${plans.loadPlans}
      .projectLimit=${plans.projectLimit}
      .planProjectLimit=${plans.planProjectLimit}
      email="ada@example.org"
      plan=${plan}
    ></account-view>`,
  )) as AccountView
  await waitUntil(
    () =>
      element.querySelector('[data-provider]') !== null ||
      element.querySelector('[data-signed-out]') !== null,
    'the view never loaded',
  )
  return element
}

const status = (el: AccountView): string =>
  el.querySelector('[role="status"]')?.textContent?.trim() ?? ''
const rows = (el: AccountView): Element[] => [...el.querySelectorAll('[data-passkey]')]
/** A control inside the n-th passkey row. */
const rowButton = (el: AccountView, row: number, selector: string): HTMLElement =>
  rows(el)[row]?.querySelector(selector) as HTMLElement
const button = (el: AccountView, selector: string): HTMLElement =>
  el.querySelector(selector) as HTMLElement

afterEach(async () => {
  await activateLocale('en')
})

describe('the account view', () => {
  it('shows the email and plan', async () => {
    const el = await account(stubApi())
    expect(el.textContent).toContain('ada@example.org')
    expect(el.textContent).toContain('Free')
  })

  it('names the member tier by its public name, Home', async () => {
    const el = await account(stubApi(), () => true, 'member')
    expect(el.textContent).toContain('Home')
    expect(el.textContent).not.toContain('Member')
  })

  it('has real headings', async () => {
    const el = await account(stubApi())
    expect(el.querySelector('h1')?.textContent).toBe('Account')
    expect(el.querySelector('h2')?.textContent).toContain('Sign-in methods')
  })

  it('shows one read-only row per provider, stating its linked state', async () => {
    const el = await account(stubApi({ read: async () => methods({ github: false }) }))
    const text = (name: string) => el.querySelector(`[data-provider="${name}"]`)?.textContent ?? ''
    expect(text('google')).toContain('Linked')
    expect(text('github')).toContain('Not linked')
    expect(text('email')).toContain('Linked')
    expect(el.querySelector('[data-provider] wa-button, [data-provider] button')).toBeNull()
  })

  it('lists passkeys with label and dates', async () => {
    const el = await account(stubApi())
    const [row] = rows(el)
    expect(row?.textContent).toContain('Work laptop')
    expect(row?.querySelectorAll('wa-format-date').length).toBe(2)
    expect(row?.textContent).toContain('Added')
    expect(row?.textContent).toContain('Last used')
  })

  it('adds a passkey, appends the row and announces it', async () => {
    const api = stubApi()
    const el = await account(api)
    button(el, '[data-add-passkey]').click()
    await waitUntil(() => rows(el).length === 2, 'no new row')
    expect(api.add).toHaveBeenCalledWith(credentials)
    expect(rows(el)[1]?.textContent).toContain('Phone')
    expect(status(el)).not.toBe('')
  })

  it('announces nothing when the sheet is dismissed', async () => {
    const add = vi.fn(async (): Promise<AddOutcome> => ({ kind: 'dismissed' }))
    const el = await account(stubApi({ add }))
    button(el, '[data-add-passkey]').click()
    await waitUntil(() => add.mock.calls.length === 1)
    await el.updateComplete
    expect(status(el)).toBe('')
    expect(rows(el).length).toBe(1)
  })

  it('announces the limit when the account is full', async () => {
    const el = await account(stubApi({ add: async () => ({ kind: 'full' }) }))
    button(el, '[data-add-passkey]').click()
    await waitUntil(() => status(el) !== '')
    expect(status(el)).toContain('limit')
  })

  it('hides the add button without passkey support', async () => {
    const el = await account(stubApi(), () => false)
    expect(el.querySelector('[data-add-passkey]')).toBeNull()
  })

  it('renames through the api, by Enter in the inline input', async () => {
    const api = stubApi()
    const el = await account(api)
    button(el, '[data-rename]').click()
    await el.updateComplete
    const input = el.querySelector('wa-input[data-rename-input]') as HTMLInputElement
    expect(input).not.toBeNull()
    input.value = 'Home laptop'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await waitUntil(() => rows(el)[0]?.textContent?.includes('Home laptop') === true)
    expect(api.rename).toHaveBeenCalledWith('p1', 'Home laptop')
    expect(el.querySelector('wa-input[data-rename-input]')).toBeNull()
  })

  it('renames through the commit button too', async () => {
    const api = stubApi()
    const el = await account(api)
    button(el, '[data-rename]').click()
    await el.updateComplete
    const input = el.querySelector('wa-input[data-rename-input]') as HTMLInputElement
    input.value = 'Desk'
    button(el, '[data-rename-save]').click()
    await waitUntil(() => rows(el)[0]?.textContent?.includes('Desk') === true)
    expect(api.rename).toHaveBeenCalledWith('p1', 'Desk')
  })

  it('deletes at once, removes the row and announces', async () => {
    const api = stubApi()
    const el = await account(api)
    button(el, '[data-delete]').click()
    await waitUntil(() => rows(el).length === 0, 'row still there')
    expect(api.remove).toHaveBeenCalledWith('p1')
    expect(status(el)).not.toBe('')
  })

  describe('focus after a change', () => {
    const twoPasskeys = () =>
      stubApi({
        read: async () => ({
          kind: 'methods',
          methods: { google: true, github: false, email: true, passkeys: [laptop, phone] },
        }),
      })
    const settle = async (el: AccountView) => {
      await el.updateComplete
      await el.updateComplete
    }

    it("returns to that row's Rename button after Save", async () => {
      const el = await account(twoPasskeys())
      rowButton(el, 1, '[data-rename]').click()
      await el.updateComplete
      const input = el.querySelector('wa-input[data-rename-input]') as HTMLInputElement
      input.value = 'Mobile'
      button(el, '[data-rename-save]').click()
      await waitUntil(() => rows(el)[1]?.textContent?.includes('Mobile') === true)
      await settle(el)
      expect(document.activeElement).toBe(rows(el)[1]?.querySelector('[data-rename]'))
    })

    it("returns to that row's Rename button after Cancel", async () => {
      const el = await account(twoPasskeys())
      rowButton(el, 1, '[data-rename]').click()
      await el.updateComplete
      ;(el.querySelector('[data-rename-cancel]') as HTMLElement).click()
      await settle(el)
      expect(document.activeElement).toBe(rows(el)[1]?.querySelector('[data-rename]'))
    })

    it('returns to the Rename button after Escape', async () => {
      const el = await account(twoPasskeys())
      rowButton(el, 0, '[data-rename]').click()
      await el.updateComplete
      el.querySelector('wa-input[data-rename-input]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
      await settle(el)
      expect(document.activeElement).toBe(rows(el)[0]?.querySelector('[data-rename]'))
    })

    it("moves to the next row's Rename button after Delete", async () => {
      const el = await account(twoPasskeys())
      rowButton(el, 0, '[data-delete]').click()
      await waitUntil(() => rows(el).length === 1, 'row still there')
      await settle(el)
      expect(document.activeElement).toBe(rows(el)[0]?.querySelector('[data-rename]'))
      expect(rows(el)[0]?.getAttribute('data-passkey')).toBe('p2')
    })

    it('moves to the heading after deleting the last row when adding is unavailable', async () => {
      const el = await account(stubApi(), () => false)
      button(el, '[data-delete]').click()
      await waitUntil(() => rows(el).length === 0, 'row still there')
      await settle(el)
      expect(el.querySelector('[data-add-passkey]')).toBeNull()
      expect(document.activeElement).toBe(el.querySelector('h1'))
    })

    it('moves to the Add button after deleting the last row', async () => {
      const el = await account(stubApi())
      button(el, '[data-delete]').click()
      await waitUntil(() => rows(el).length === 0, 'row still there')
      await settle(el)
      expect(document.activeElement).toBe(el.querySelector('[data-add-passkey]'))
    })
  })

  it('forgets its methods when the session ends', async () => {
    const el = await account(stubApi())
    el.session = 'signed-in'
    await el.updateComplete
    await waitUntil(() => el.querySelector('[data-provider]') !== null)
    el.session = 'signed-out'
    await el.updateComplete
    expect(el.querySelector('[data-signed-out]')).not.toBeNull()
    expect(el.querySelector('[data-provider]')).toBeNull()
  })

  it('ignores a read that answers after the session ended', async () => {
    let answer: (outcome: MethodsOutcome) => void = () => {}
    const el = await account(stubApi())
    el.api = stubApi({ read: () => new Promise<MethodsOutcome>((resolve) => (answer = resolve)) })
    el.session = 'signed-in'
    await el.updateComplete
    el.session = 'signed-out'
    await el.updateComplete
    answer(methods())
    await new Promise((resolve) => setTimeout(resolve, 0))
    await el.updateComplete
    expect(el.querySelector('[data-provider]')).toBeNull()
    expect(el.querySelector('[data-signed-out]')).not.toBeNull()
  })

  it('offers to import a project, signed in or not', async () => {
    // An import makes a project on this device and needs no account.
    const signedIn = await account(stubApi())
    expect(signedIn.querySelector('project-import-section [data-import]')).not.toBeNull()
    const signedOut = await account(stubApi({ read: async () => ({ kind: 'signed-out' }) }))
    expect(signedOut.querySelector('project-import-section [data-import]')).not.toBeNull()
  })

  it('shows the signed-out state for a signed-out outcome', async () => {
    const el = await account(stubApi({ read: async () => ({ kind: 'signed-out' }) }))
    expect(el.querySelector('[data-signed-out]')?.textContent).toContain(
      'Sign in to manage how you sign in.',
    )
    expect(el.querySelector('[data-provider]')).toBeNull()
  })

  it('shows the signed-out state when a change finds the session ended', async () => {
    const el = await account(stubApi({ remove: async () => ({ kind: 'signed-out' }) }))
    button(el, '[data-delete]').click()
    await waitUntil(() => el.querySelector('[data-signed-out]') !== null)
  })

  it('says so when the service cannot be reached', async () => {
    const el = await account(stubApi({ remove: async () => ({ kind: 'unreachable' }) }))
    button(el, '[data-delete]').click()
    await waitUntil(() => status(el) !== '')
    expect(status(el)).toContain('That did not work')
    expect(rows(el).length).toBe(1)
  })
})

/** The backend's own test fixture, pivoted: see `PlansResourceTest` in matter-manager-backend. */
const MATRIX: PlanMatrix = {
  free: { Projects: 1, Price: 'Free forever' },
  home: { Projects: 3, Price: 'Announced at launch' },
  pro: { Projects: 'Unlimited*', Price: 'Announced at launch' },
}

/** A load that answers at once with `matrix`, the way the cache does. */
const plansFrom =
  (matrix: PlanMatrix) =>
  async (onMatrix: (matrix: PlanMatrix) => void): Promise<void> => {
    onMatrix(matrix)
  }

/**
 * The slice of {@link LocalCache} the plans use, holding `cached`. Everything else throws, so a
 * view that starts reading projects or the profile fails by name (the `plans.test.ts` pattern).
 */
function cacheHolding(cached: CachedPlanMatrix | undefined): LocalCache {
  const unused = (): never => {
    throw new Error('the account plans use no other part of the cache')
  }
  return {
    readProfile: unused,
    writeProfile: unused,
    clearProfile: unused,
    readProjects: unused,
    writeProjects: unused,
    setLocalState: unused,
    markAccessRemoved: unused,
    readLocalProjects: unused,
    addLocalProject: unused,
    updateLocalProject: unused,
    removeLocalProject: unused,
    clear: unused,
    async readPlanMatrix() {
      return cached
    },
    async writePlanMatrix() {},
  }
}

describe('the plans on the account page', () => {
  const comparison = async (el: AccountView) => {
    await waitUntil(() => el.querySelector('[data-plan-table]') !== null, 'no comparison')
  }

  it('lists the plans with their limits from the published matrix', async () => {
    const el = await account(stubApi(), () => true, 'free', { loadPlans: plansFrom(MATRIX) })
    await comparison(el)
    const cards = [...el.querySelectorAll('wa-card[data-plan-card]')]
    expect(cards.map((card) => card.getAttribute('data-plan-card'))).toEqual([
      'free',
      'home',
      'pro',
    ])
    const card = (key: string) =>
      el.querySelector(`[data-plan-card="${key}"]`)?.textContent?.replace(/\s+/g, ' ') ?? ''
    // The matrix's own values, verbatim — never the numbers of a table in code (ADR 0020).
    expect(card('free')).toContain('Projects 1')
    expect(card('home')).toContain('Projects 3')
    expect(card('pro')).toContain('Unlimited*')
    expect([...el.querySelectorAll('h2')].map((h) => h.textContent?.trim())).toContain('Plan')
  })

  it("marks the account's current plan, once per layout", async () => {
    const el = await account(stubApi(), () => true, 'member', { loadPlans: plansFrom(MATRIX) })
    await comparison(el)
    const table = el.querySelector('[data-plan-table]') as HTMLElement
    expect(table.querySelectorAll('[data-your-plan]')).toHaveLength(1)
    expect(table.querySelector('[data-plan-column="home"] [data-your-plan]')).not.toBeNull()
    expect(el.querySelector('[data-plan-card="home"] [data-your-plan]')).not.toBeNull()
    expect(el.querySelector('[data-plan-card="free"] [data-your-plan]')).toBeNull()
  })

  it("shows the account's own limit as a legacy plan where it diverges from the matrix", async () => {
    const el = await account(stubApi(), () => true, 'member', {
      loadPlans: plansFrom(MATRIX),
      projectLimit: 5,
      planProjectLimit: 3,
    })
    await comparison(el)
    expect(el.querySelector('[data-legacy-plan]')?.textContent?.trim()).toBe(
      'Projects your plan includes: 3. Yours: 5 (legacy plan).',
    )
  })

  it('says nothing about a legacy plan when the account holds exactly what the matrix says', async () => {
    const el = await account(stubApi(), () => true, 'member', {
      loadPlans: plansFrom(MATRIX),
      projectLimit: 3,
      planProjectLimit: 3,
    })
    await comparison(el)
    expect(el.querySelector('[data-legacy-plan]')).toBeNull()
  })

  it('renders the plans offline, from the cache', async () => {
    // The real resolver over a cache that holds the matrix and a server that cannot be reached.
    const cache = cacheHolding({ matrix: MATRIX, fetchedAt: '2026-10-01T00:00:00Z' })
    const offline: PlansApi = { read: async () => undefined }
    const el = await account(stubApi(), () => true, 'free', {
      loadPlans: (onMatrix) => resolvePlanMatrix(offline, cache, onMatrix),
    })
    await comparison(el)
    expect(el.querySelector('[data-plan-card="pro"]')?.textContent).toContain('Unlimited*')
  })

  it('shows a calm absent state with neither cache nor connection', async () => {
    const cache = cacheHolding(undefined)
    const offline: PlansApi = { read: async () => undefined }
    const el = await account(stubApi(), () => true, 'free', {
      loadPlans: (onMatrix) => resolvePlanMatrix(offline, cache, onMatrix),
    })
    await el.updateComplete
    expect(el.querySelector('[data-plans-absent]')).not.toBeNull()
    expect(el.querySelector('[data-plan-table]')).toBeNull()
    // Calm: a sentence, not an error.
    expect(el.querySelector('wa-callout')).toBeNull()
  })

  it('lists the plans even when signed out — the comparison is public copy', async () => {
    const el = await account(
      stubApi({ read: async () => ({ kind: 'signed-out' }) }),
      () => true,
      'free',
      {
        loadPlans: plansFrom(MATRIX),
      },
    )
    await comparison(el)
    expect(el.querySelector('[data-signed-out]')).not.toBeNull()
  })

  it('retries the load when connectivity returns and no matrix was heard', async () => {
    // The first load finds neither cache nor server; the matrix is published by the time the
    // browser comes back online, so the retry hears it.
    let published: PlanMatrix | undefined
    const loadPlans = vi.fn(async (onMatrix: (matrix: PlanMatrix) => void): Promise<void> => {
      if (published !== undefined) onMatrix(published)
    })
    const el = await account(stubApi(), () => true, 'free', { loadPlans })
    el.online = false
    await el.updateComplete
    expect(loadPlans).toHaveBeenCalledTimes(1)
    expect(el.querySelector('[data-plans-absent]')).not.toBeNull()

    published = MATRIX
    el.online = true
    await waitUntil(() => el.querySelector('[data-plan-table]') !== null, 'never retried')
    expect(loadPlans).toHaveBeenCalledTimes(2)
  })

  it('queues one retry when connectivity returns during a pending load', async () => {
    // The connect-time load starts offline and is still pending when the browser comes back
    // online. The retry must not run beside it — single-flight — but must not be dropped
    // either: it runs once the pending load settles without a matrix. Exactly once, however
    // many transitions arrive while the load is pending.
    let calls = 0
    let settleFirst: () => void = () => {}
    const loadPlans = vi.fn((onMatrix: (matrix: PlanMatrix) => void): Promise<void> => {
      calls += 1
      if (calls === 1) {
        return new Promise<void>((resolve) => {
          settleFirst = resolve
        })
      }
      onMatrix(MATRIX)
      return Promise.resolve()
    })
    const el = await account(stubApi(), () => true, 'free', { loadPlans })
    el.online = false
    await el.updateComplete
    el.online = true
    await el.updateComplete
    // A second pair of transitions while the same load is still pending: still one queued retry.
    el.online = false
    await el.updateComplete
    el.online = true
    await el.updateComplete
    expect(loadPlans).toHaveBeenCalledTimes(1)

    settleFirst() // the offline load settles with no matrix
    await waitUntil(
      () => el.querySelector('[data-plan-table]') !== null,
      'the queued retry never ran',
    )
    expect(loadPlans).toHaveBeenCalledTimes(2)
  })

  it('does not reload a matrix it already shows when connectivity returns', async () => {
    const loadPlans = vi.fn(plansFrom(MATRIX))
    const el = await account(stubApi(), () => true, 'free', { loadPlans })
    await comparison(el)
    el.online = false
    await el.updateComplete
    el.online = true
    await el.updateComplete
    await el.updateComplete
    expect(loadPlans).toHaveBeenCalledTimes(1)
  })
})

describe('the account view in German at phone width', () => {
  it('translates headings and buttons', async () => {
    await activateLocale('de')
    const host = document.createElement('div')
    host.style.width = '360px'
    document.body.appendChild(host)
    try {
      const el = document.createElement('account-view') as AccountView
      Object.assign(el, {
        api: stubApi(),
        credentials,
        passkeySupport: () => true,
        email: 'ada@example.org',
        plan: 'free',
      })
      host.appendChild(el)
      await waitUntil(() => el.querySelector('[data-provider]') !== null)
      expect(el.querySelector('h1')?.textContent).toBe('Konto')
      expect(el.querySelector('h2')?.textContent).toContain('Anmeldemethoden')
      expect([...el.querySelectorAll('h2')].map((h) => h.textContent?.trim())).toContain('Tarif')
      // No load wired at all: the same calm absent state, in German.
      expect(el.querySelector('[data-plans-absent]')?.textContent?.trim()).toBe(
        'Die Tarife erscheinen hier, sobald dieses Gerät einmal eine Verbindung hatte.',
      )
      expect(el.querySelector('[data-add-passkey]')?.textContent).toContain('Passkey hinzufügen')
      expect(el.querySelector('[data-rename]')?.textContent).toContain('Umbenennen')
      expect(el.querySelector('[data-delete]')?.textContent).toContain('Löschen')
      expect(el.textContent).toContain('Verknüpft')
      // `<account-view>` has no display rule, so it is inline and reports a scrollWidth of 0;
      // the block host is what actually measures the content's width.
      expect(host.clientWidth).toBe(360)
      expect(host.scrollWidth).toBeGreaterThan(0)
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth)
    } finally {
      host.remove()
    }
  })
})
