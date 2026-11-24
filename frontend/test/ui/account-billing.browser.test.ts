import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/card/card.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Plan } from '../../src/domain/plan.js'
import type { Billing, BillingActions, SessionOutcome } from '../../src/ui/billing.js'
import { activateLocale } from '../../src/ui/i18n/localization.js'
import type { SessionState } from '../../src/ui/session.js'
import type { MethodsOutcome, SignInMethodsApi } from '../../src/ui/sign-in-methods.js'
import type { AccountView } from '../../src/ui/views/account.js'
import '../../src/ui/views/account.js'

/**
 * The account page's billing (#263, phase 2): Subscribe and Manage billing, the next billing
 * date and the cancellation, every Stripe answer the page can be given, and the return from
 * Checkout. The redirect is a stub: a test must never navigate the runner away.
 */

const methods: MethodsOutcome = {
  kind: 'methods',
  methods: { google: true, github: false, email: false, passkeys: [] },
}

const api: SignInMethodsApi = {
  read: async () => methods,
  add: async () => ({ kind: 'dismissed' }),
  rename: async () => ({ kind: 'done' }),
  remove: async () => ({ kind: 'done' }),
}

const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_1'
const PORTAL_URL = 'https://billing.stripe.com/p/session/test_1'

/** Billing actions answering `checkout` and `portal` as given, recording each call. */
function actions(
  checkout: SessionOutcome = { kind: 'redirect', url: CHECKOUT_URL },
  portal: SessionOutcome = { kind: 'redirect', url: PORTAL_URL },
) {
  return {
    checkout: vi.fn(async (_plan: Plan) => checkout),
    portal: vi.fn(async () => portal),
  } satisfies BillingActions
}

interface Options {
  readonly plan?: Plan
  readonly offer?: readonly Plan[]
  readonly billing?: Billing
  readonly actions?: BillingActions
  readonly online?: boolean
  readonly session?: SessionState
  readonly checkoutReturn?: 'success' | 'cancel'
}

async function account(options: Options = {}) {
  const redirect = vi.fn()
  const el = (await fixture(html`<account-view
    .api=${api}
    .passkeySupport=${() => false}
    email="ada@example.org"
    plan=${options.plan ?? 'free'}
    .offer=${options.offer}
    .billing=${options.billing}
    .billingActions=${options.actions ?? actions()}
    .redirect=${redirect}
    .online=${options.online ?? true}
    .session=${options.session ?? 'signed-in'}
    .checkoutReturn=${options.checkoutReturn}
  ></account-view>`)) as AccountView
  await waitUntil(
    () => el.querySelector('[data-provider], [data-signed-out]') !== null,
    'the view never loaded',
  )
  return { el, redirect }
}

const text = (element: Element | null | undefined): string =>
  element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

const buttons = (el: Element, selector: string): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>(selector),
]

afterEach(async () => {
  await activateLocale('en')
})

describe('subscribing', () => {
  it('offers each plan for sale above the account’s, the next one loudest', async () => {
    const { el } = await account({ plan: 'free', offer: ['member', 'pro'] })
    const subscribe = buttons(el, '[data-subscribe]')
    expect(subscribe.map((b) => b.getAttribute('data-subscribe'))).toEqual(['member', 'pro'])
    expect(subscribe.map(text)).toEqual(['Subscribe to Home', 'Subscribe to Pro'])
    expect(subscribe.map((b) => b.getAttribute('appearance'))).toEqual(['accent', 'outlined'])
    expect(el.querySelector('[data-manage-billing]')).toBeNull()
  })

  it('offers only what the deployment sells, and nothing at or below the plan', async () => {
    const { el } = await account({ plan: 'member', offer: ['member', 'pro'] })
    expect(buttons(el, '[data-subscribe]').map((b) => b.getAttribute('data-subscribe'))).toEqual([
      'pro',
    ])
  })

  it('starts a Checkout and sends the browser to the page it answers', async () => {
    const billing = actions()
    const { el, redirect } = await account({ offer: ['member', 'pro'], actions: billing })
    ;(el.querySelector('[data-subscribe="pro"]') as HTMLElement).click()
    await waitUntil(() => redirect.mock.calls.length === 1, 'never redirected')
    expect(billing.checkout).toHaveBeenCalledWith('pro')
    expect(redirect).toHaveBeenCalledWith(CHECKOUT_URL)
  })

  it('ignores a second press while the first is on its way', async () => {
    let answer: (outcome: SessionOutcome) => void = () => {}
    const checkout = vi.fn(
      () =>
        new Promise<SessionOutcome>((resolve) => {
          answer = resolve
        }),
    )
    const { el, redirect } = await account({
      offer: ['pro'],
      actions: { checkout, portal: async () => ({ kind: 'unavailable' }) },
    })
    const press = el.querySelector('[data-subscribe="pro"]') as HTMLElement
    press.click()
    press.click()
    await el.updateComplete
    expect(checkout).toHaveBeenCalledTimes(1)
    expect(press.hasAttribute('disabled')).toBe(true)
    answer({ kind: 'redirect', url: CHECKOUT_URL })
    await waitUntil(() => redirect.mock.calls.length === 1)
  })

  it('shows nothing to buy when the deployment sells nothing (a 404) or was never heard', async () => {
    for (const offer of [[], undefined]) {
      const { el } = await account(offer === undefined ? {} : { offer })
      expect(el.querySelector('[data-subscribe]')).toBeNull()
      expect(el.querySelector('[data-manage-billing]')).toBeNull()
      // As before billing existed: no error either.
      expect(el.querySelector('[data-billing-problem]')).toBeNull()
    }
  })

  it('shows nothing to buy when signed out', async () => {
    const { el } = await account({ offer: ['pro'], session: 'signed-out' })
    expect(el.querySelector('[data-subscribe]')).toBeNull()
  })
})

describe('an account with a subscription', () => {
  const ACTIVE: Billing = {
    status: 'active',
    currentPeriodEnd: '2026-12-24T12:00:00Z',
    cancelAtPeriodEnd: false,
  }

  it('says the next billing date and offers Manage billing, not a second Checkout', async () => {
    const { el } = await account({ plan: 'member', offer: ['member', 'pro'], billing: ACTIVE })
    expect(text(el.querySelector('[data-billing-next]'))).toBe('Next billing date: Dec 24, 2026')
    expect(el.querySelector('[data-subscribe]')).toBeNull()
    const manage = el.querySelector('[data-manage-billing]') as HTMLElement
    expect(text(manage)).toBe('Manage billing')
    // The only action, so the one loud one.
    expect(manage.getAttribute('appearance')).toBe('accent')
  })

  it('says when a cancelled subscription ends instead of a billing date', async () => {
    const { el } = await account({
      plan: 'pro',
      offer: ['member', 'pro'],
      billing: { ...ACTIVE, cancelAtPeriodEnd: true },
    })
    expect(text(el.querySelector('[data-billing-ends]'))).toBe(
      'Your subscription ends on Dec 24, 2026.',
    )
    expect(el.querySelector('[data-billing-next]')).toBeNull()
  })

  it('warns when the last payment did not go through', async () => {
    const { el } = await account({
      plan: 'pro',
      offer: ['pro'],
      billing: { ...ACTIVE, status: 'past_due' },
    })
    const warning = el.querySelector('wa-callout[data-billing-payment]')
    expect(warning?.getAttribute('variant')).toBe('warning')
    expect(text(warning)).toContain('Update your payment method under Manage billing')
  })

  it('opens the portal and sends the browser there', async () => {
    const billing = actions()
    const { el, redirect } = await account({
      plan: 'member',
      offer: ['member', 'pro'],
      billing: ACTIVE,
      actions: billing,
    })
    ;(el.querySelector('[data-manage-billing]') as HTMLElement).click()
    await waitUntil(() => redirect.mock.calls.length === 1, 'never redirected')
    expect(billing.portal).toHaveBeenCalled()
    expect(redirect).toHaveBeenCalledWith(PORTAL_URL)
  })

  it('offers a new Checkout beside the portal once the subscription has ended', async () => {
    const { el } = await account({
      plan: 'free',
      offer: ['member', 'pro'],
      billing: { status: 'canceled', cancelAtPeriodEnd: false },
    })
    expect(buttons(el, '[data-subscribe]')).toHaveLength(2)
    expect(el.querySelector('[data-manage-billing]')?.getAttribute('appearance')).toBe('outlined')
    // An ended subscription has no next billing date.
    expect(el.querySelector('[data-billing-next]')).toBeNull()
  })

  it('names no past end date for a subscription that has already ended', async () => {
    // Stripe keeps `cancelAtPeriodEnd` set after the period it ended in.
    const { el } = await account({
      plan: 'free',
      offer: ['pro'],
      billing: {
        status: 'canceled',
        currentPeriodEnd: '2026-10-24T12:00:00Z',
        cancelAtPeriodEnd: true,
      },
    })
    expect(el.querySelector('[data-billing-ends]')).toBeNull()
    expect(el.querySelector('[data-billing-next]')).toBeNull()
  })

  it('gives the buttons back when Back restores the page from the bfcache', async () => {
    const { el, redirect } = await account({ plan: 'member', offer: ['pro'], billing: ACTIVE })
    ;(el.querySelector('[data-manage-billing]') as HTMLElement).click()
    await waitUntil(() => redirect.mock.calls.length === 1, 'never redirected')
    await el.updateComplete
    expect(el.querySelector('[data-manage-billing]')?.hasAttribute('disabled')).toBe(true)

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    await el.updateComplete
    expect(el.querySelector('[data-manage-billing]')?.hasAttribute('disabled')).toBe(false)
  })

  it('shows no portal on a deployment that no longer sells anything', async () => {
    const { el } = await account({ plan: 'pro', offer: [], billing: ACTIVE })
    expect(el.querySelector('[data-manage-billing]')).toBeNull()
  })
})

describe('what Stripe’s answers say', () => {
  it.each([
    [
      { kind: 'already-subscribed' },
      'You already have a subscription. Change it under Manage billing.',
    ],
    [{ kind: 'rate-limited' }, 'Too many attempts. Please wait a minute and try again.'],
    [{ kind: 'unavailable' }, 'Billing could not be reached. Please try again.'],
    [{ kind: 'not-offered' }, 'Billing could not be reached. Please try again.'],
    [{ kind: 'signed-out' }, 'Your session has ended. Please sign in again.'],
  ] satisfies [SessionOutcome, string][])(
    '%j: says so inline, in the live region',
    async (outcome, words) => {
      const { el, redirect } = await account({ offer: ['pro'], actions: actions(outcome) })
      ;(el.querySelector('[data-subscribe="pro"]') as HTMLElement).click()
      await waitUntil(() => el.querySelector('[data-billing-problem]') !== null, 'no problem shown')
      const problem = el.querySelector('[data-billing-problem]') as HTMLElement
      expect(problem.closest('[role="status"]')).not.toBeNull()
      expect(text(problem)).toBe(words)
      expect(redirect).not.toHaveBeenCalled()
      // The button is usable again, and focus is not lost to the page.
      await waitUntil(() => !el.querySelector('[data-subscribe="pro"]')?.hasAttribute('disabled'))
    },
  )

  it('keeps saying why when the refused plan’s offer goes away behind it', async () => {
    const { el } = await account({ offer: ['pro'], actions: actions({ kind: 'not-offered' }) })
    ;(el.querySelector('[data-subscribe="pro"]') as HTMLElement).click()
    await waitUntil(() => el.querySelector('[data-billing-problem]') !== null, 'no problem shown')
    // The shell reloads the offer on `not-offered`; this deployment now sells nothing.
    el.offer = []
    await el.updateComplete
    expect(el.querySelector('[data-subscribe]')).toBeNull()
    expect(text(el.querySelector('[data-billing-problem]'))).toBe(
      'Billing could not be reached. Please try again.',
    )
  })

  it('does not open a Stripe page that answers after the session ended', async () => {
    let answer: (outcome: SessionOutcome) => void = () => {}
    const { el, redirect } = await account({
      plan: 'pro',
      offer: ['pro'],
      billing: { status: 'active', cancelAtPeriodEnd: false },
      actions: {
        checkout: async () => ({ kind: 'unavailable' }),
        portal: () =>
          new Promise<SessionOutcome>((resolve) => {
            answer = resolve
          }),
      },
    })
    ;(el.querySelector('[data-manage-billing]') as HTMLElement).click()
    await el.updateComplete
    el.session = 'signed-out'
    await el.updateComplete
    answer({ kind: 'redirect', url: PORTAL_URL })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(redirect).not.toHaveBeenCalled()
  })

  it('says there is nothing to manage when the portal finds no billing account', async () => {
    const { el } = await account({
      plan: 'pro',
      offer: ['pro'],
      billing: { status: 'canceled', cancelAtPeriodEnd: false },
      actions: actions(undefined, { kind: 'no-billing-account' }),
    })
    ;(el.querySelector('[data-manage-billing]') as HTMLElement).click()
    await waitUntil(() => el.querySelector('[data-billing-problem]') !== null)
    expect(text(el.querySelector('[data-billing-problem]'))).toBe(
      'There is no subscription to manage yet.',
    )
  })
})

describe('offline', () => {
  it('keeps the actions in view but disabled, and says why', async () => {
    const { el } = await account({ offer: ['member', 'pro'], online: false })
    const subscribe = buttons(el, '[data-subscribe]')
    expect(subscribe).toHaveLength(2)
    expect(subscribe.every((b) => b.hasAttribute('disabled'))).toBe(true)
    expect(text(el.querySelector('[data-billing-offline]'))).toBe('Needs a connection')
  })

  it('disables the actions while the session is merely held', async () => {
    const { el } = await account({ offer: ['pro'], session: 'offline-held' })
    expect(el.querySelector('[data-subscribe="pro"]')?.hasAttribute('disabled')).toBe(true)
  })
})

describe('the return from Checkout', () => {
  it('thanks the reader and says the plan follows once Stripe confirms', async () => {
    const { el } = await account({ checkoutReturn: 'success', offer: ['pro'] })
    const note = el.querySelector('wa-callout[data-checkout-return]')
    expect(note?.getAttribute('variant')).toBe('success')
    expect(text(note)).toBe(
      'Thank you. Your plan changes as soon as Stripe confirms the payment, usually within a minute.',
    )
  })

  it('says a cancelled Checkout charged nothing', async () => {
    const { el } = await account({ checkoutReturn: 'cancel', offer: ['pro'] })
    expect(text(el.querySelector('[data-checkout-return]'))).toBe(
      'Checkout was cancelled. Nothing was charged.',
    )
  })
})

describe('in German', () => {
  it('speaks formally', async () => {
    await activateLocale('de')
    const { el } = await account({
      plan: 'member',
      offer: ['member', 'pro'],
      billing: {
        status: 'active',
        currentPeriodEnd: '2026-12-24T12:00:00Z',
        cancelAtPeriodEnd: true,
      },
    })
    expect(text(el.querySelector('[data-manage-billing]'))).toBe('Abrechnung verwalten')
    expect(text(el.querySelector('[data-billing-ends]'))).toBe(
      'Ihr Abonnement endet am 24.12.2026.',
    )
  })

  it('names each plan to subscribe to', async () => {
    await activateLocale('de')
    const { el } = await account({ plan: 'free', offer: ['member', 'pro'] })
    expect(buttons(el, '[data-subscribe]').map(text)).toEqual(['Home abonnieren', 'Pro abonnieren'])
  })
})
