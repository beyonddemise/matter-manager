import type { BrowserContext } from '@playwright/test'
import { expect, test } from './fixtures'

/**
 * Subscribing through Stripe (#263): the account page asks `/billing` what is for sale, Subscribe
 * starts a Checkout, and the browser leaves for the page the API answers — a top-level
 * navigation, which the built site's CSP must allow without naming Stripe. Then the return:
 * `#/account?checkout=success`, said once and taken off the URL.
 *
 * No backend runs here, so the API is answered by routes: a signed-in session, a free profile,
 * an offer, and a Checkout URL on a host that is itself routed, so the journey never reaches the
 * internet. Everything else under `/api` and `/db` answers 404, which every client in the app
 * reads as "not here" without an error.
 */

const CHECKOUT = 'https://checkout.stripe.test/c/pay/cs_test_e2e'

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

/** Answers the API for a signed-in free account on a deployment that sells Home and Pro. */
async function signedInSelling(context: BrowserContext, checkouts: string[]): Promise<void> {
  // First registered, last matched: the specific routes below win over these.
  await context.route('**/api/**', (route) =>
    route.fulfill(json({ title: 'Not Found', status: 404 }, 404)),
  )
  await context.route('**/db/**', (route) =>
    route.fulfill(json({ error: 'not_found', reason: 'missing' }, 404)),
  )
  await context.route('**/api/auth/token', (route) =>
    route.fulfill(json({ accessToken: 'e2e-token', refreshToken: 'e2e-refresh', expiresIn: 3600 })),
  )
  await context.route('**/api/profile', (route) =>
    route.fulfill(
      json({
        sub: 'google|e2e',
        email: 'ada@example.org',
        displayName: 'Ada',
        locale: 'en',
        plan: 'free',
        projectLimit: 1,
      }),
    ),
  )
  await context.route('**/api/projects', (route) => route.fulfill(json([])))
  await context.route('**/api/billing', (route) =>
    route.fulfill(json({ plans: ['member', 'pro'] })),
  )
  await context.route('**/api/billing/checkout', (route) => {
    checkouts.push(route.request().postData() ?? '')
    return route.fulfill(json({ url: CHECKOUT }))
  })
  await context.route('https://checkout.stripe.test/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Stripe Checkout</title><h1>Checkout</h1>',
    }),
  )
}

test('a free account subscribes to Pro through Stripe Checkout, and comes back', async ({
  page,
  context,
}) => {
  const checkouts: string[] = []
  await signedInSelling(context, checkouts)

  await page.goto('/#/account')
  // Upgrade leads here rather than to the waitlist once the deployment sells something.
  await expect(page.locator('[data-upgrade]')).toHaveAttribute('href', '#/account')
  const subscribe = page.locator('account-view [data-subscribe="pro"]')
  await expect(subscribe).toBeEnabled()
  await subscribe.click()

  await page.waitForURL(CHECKOUT)
  await expect(page.locator('h1')).toHaveText('Checkout')
  expect(checkouts.map((body) => JSON.parse(body))).toEqual([{ plan: 'pro' }])

  // Stripe sends the browser back to the backend's STRIPE_RETURN_URL with the query appended.
  await page.goto('/#/account?checkout=success')
  await expect(page.locator('account-view [data-checkout-return]')).toContainText('Thank you')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/account')
})
