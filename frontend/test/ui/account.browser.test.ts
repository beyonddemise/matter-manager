import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/card/card.js'
import '@awesome.me/webawesome-pro/dist/components/format-date/format-date.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateLocale } from '../../src/ui/i18n/localization.js'
import type { CredentialsLike } from '../../src/ui/passkey-signin.js'
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
): Promise<AccountView> {
  const element = (await fixture(
    html`<account-view
      .api=${api}
      .credentials=${credentials}
      .passkeySupport=${support}
      email="ada@example.org"
      plan="free"
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
      expect(el.querySelector('[data-add-passkey]')?.textContent).toContain('Passkey hinzufügen')
      expect(el.querySelector('[data-rename]')?.textContent).toContain('Umbenennen')
      expect(el.querySelector('[data-delete]')?.textContent).toContain('Löschen')
      expect(el.textContent).toContain('Verknüpft')
      expect(el.scrollWidth).toBeLessThanOrEqual(host.clientWidth)
    } finally {
      host.remove()
    }
  })
})
