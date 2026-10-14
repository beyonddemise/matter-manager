import '@awesome.me/webawesome-pro/dist/styles/webawesome.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/glossy.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/anodized.css'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/otp-input/otp-input.js'
import { fixture } from '@open-wc/testing-helpers'
import { html, render } from 'lit'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { SOURCE_LOCALE } from '../../src/ui/i18n/locale.js'
import { activateLocale } from '../../src/ui/i18n/localization.js'
import {
  renderSignInDialog,
  type SignInActions,
  type SignInStep,
} from '../../src/ui/sign-in-dialog.js'
import '../../src/ui/styles/app.css'

/** Recording actions: each test asserts against what the view called, nothing else. */
function recording() {
  return {
    onGoogle: vi.fn(),
    onGitHub: vi.fn(),
    onPasskey: vi.fn(),
    onEmail: vi.fn(),
    onSendCode: vi.fn(),
    onVerify: vi.fn(),
    onResend: vi.fn(),
    onBack: vi.fn(),
    onClose: vi.fn(),
  } satisfies SignInActions
}

/** The dialog rendered into a fresh container, queried by its light-DOM contract. */
async function mounted(
  state: SignInStep,
  notice = '',
  actions: SignInActions = recording(),
  online = true,
) {
  const container = await fixture(html`<div></div>`)
  render(renderSignInDialog(state, notice, online, actions), container as HTMLElement)
  await customElements.whenDefined('wa-dialog')
  return container as HTMLElement
}

beforeAll(async () => {
  await Promise.all(
    ['wa-dialog', 'wa-button', 'wa-input', 'wa-otp-input'].map((name) =>
      customElements.whenDefined(name),
    ),
  )
})

/** Every method on: what a fully configured deployment answers. */
const ALL_ON = {
  step: 'chooser',
  google: true,
  github: true,
  email: true,
  passkey: true,
} satisfies SignInStep

describe('the chooser', () => {
  it('offers Google, GitHub, a passkey and email in that order, Google as the one filled brand button', async () => {
    const root = await mounted(ALL_ON)

    const google = root.querySelector('[data-google-sign-in]') as HTMLElement & {
      variant: string
      appearance: string
    }
    expect(google).not.toBeNull()
    expect(google.variant).toBe('brand')
    const filled = [...root.querySelectorAll('wa-button')].filter(
      (button) =>
        (button as HTMLElement & { variant: string }).variant === 'brand' &&
        (button as HTMLElement & { appearance: string }).appearance === 'accent',
    )
    expect(filled).toEqual([google])
    const github = root.querySelector('[data-github-sign-in]') as HTMLElement & {
      appearance: string
    }
    expect(github).not.toBeNull()
    expect(github.appearance).toBe('outlined')
    expect(root.querySelector('[data-passkey-sign-in]')).not.toBeNull()
    expect(root.querySelector('[data-email-option]')).not.toBeNull()
    const order = [...root.querySelectorAll('wa-button')].map((button) =>
      button.hasAttribute('data-google-sign-in')
        ? 'google'
        : button.hasAttribute('data-github-sign-in')
          ? 'github'
          : button.hasAttribute('data-passkey-sign-in')
            ? 'passkey'
            : 'email',
    )
    expect(order).toEqual(['google', 'github', 'passkey', 'email'])
  })

  it.each([
    ['GitHub', { ...ALL_ON, github: false }, '[data-github-sign-in]'],
    ['passkey', { ...ALL_ON, passkey: false }, '[data-passkey-sign-in]'],
    ['email', { ...ALL_ON, email: false }, '[data-email-option]'],
  ] as const)('hides the %s option when the deployment lacks it', async (_name, step, selector) => {
    const root = await mounted(step)

    expect(root.querySelector(selector)).toBeNull()
  })

  it('still offers email when Google is off: a mail-only deployment stays usable', async () => {
    const root = await mounted({
      step: 'chooser',
      google: false,
      github: false,
      email: true,
      passkey: false,
    })

    expect(root.querySelector('[data-google-sign-in]')).toBeNull()
    expect(root.querySelector('[data-github-sign-in]')).toBeNull()
    expect(root.querySelector('[data-email-option]')).not.toBeNull()
  })

  it('wires the choices to their actions', async () => {
    const actions = recording()
    const root = await mounted(ALL_ON, '', actions)
    ;(root.querySelector('[data-google-sign-in]') as HTMLElement).click()
    ;(root.querySelector('[data-email-option]') as HTMLElement).click()

    expect(actions.onGoogle).toHaveBeenCalledTimes(1)
    expect(actions.onEmail).toHaveBeenCalledTimes(1)
    expect(actions.onSendCode).not.toHaveBeenCalled()
  })

  it('clicking GitHub calls onGitHub once and nothing else', async () => {
    const actions = recording()
    const root = await mounted(ALL_ON, '', actions)
    ;(root.querySelector('[data-github-sign-in]') as HTMLElement).click()

    expect(actions.onGitHub).toHaveBeenCalledTimes(1)
    expect(actions.onGoogle).not.toHaveBeenCalled()
    expect(actions.onEmail).not.toHaveBeenCalled()
  })

  it('clicking the passkey button calls onPasskey once and nothing else', async () => {
    const actions = recording()
    const root = await mounted(ALL_ON, '', actions)
    ;(root.querySelector('[data-passkey-sign-in]') as HTMLElement).click()

    expect(actions.onPasskey).toHaveBeenCalledTimes(1)
    expect(actions.onGoogle).not.toHaveBeenCalled()
    expect(actions.onGitHub).not.toHaveBeenCalled()
    expect(actions.onEmail).not.toHaveBeenCalled()
  })
})

describe('the email step', () => {
  it('takes an address with a label and sends it with Send code', async () => {
    const actions = recording()
    const root = await mounted({ step: 'email', busy: false }, '', actions)

    const input = root.querySelector('[data-email-input]') as HTMLElement & { value: string }
    expect(input).not.toBeNull()
    expect(input.getAttribute('type')).toBe('email')
    expect(input.getAttribute('label')).not.toBeNull()
    input.value = 'ada@example.com'
    ;(root.querySelector('[data-send-code]') as HTMLElement).click()

    expect(actions.onSendCode).toHaveBeenCalledWith('ada@example.com')
  })

  it('disables Send while busy, and offers a way back', async () => {
    const actions = recording()
    const root = await mounted({ step: 'email', busy: true }, '', actions)

    expect((root.querySelector('[data-send-code]') as HTMLElement).hasAttribute('disabled')).toBe(
      true,
    )
    ;(root.querySelector('[data-back]') as HTMLElement).click()
    expect(actions.onBack).toHaveBeenCalledTimes(1)
  })
})

describe('the code step', () => {
  const step: SignInStep = {
    step: 'code',
    email: 'ada@example.com',
    busy: false,
    resendWaitSeconds: 0,
  }

  it('shows the address, a six-segment numeric code field, and resend', async () => {
    const root = await mounted(step)

    expect(root.textContent).toContain('ada@example.com')
    const code = root.querySelector('[data-code-input]') as HTMLElement & {
      effectiveLength: number
      type: string
    }
    expect(code.tagName.toLowerCase()).toBe('wa-otp-input')
    expect(code.effectiveLength).toBe(6)
    expect(code.type).toBe('numeric')
    expect(code.getAttribute('label')).not.toBeNull()
    const resend = root.querySelector('[data-resend]') as HTMLElement
    expect(resend.hasAttribute('disabled')).toBe(false)
  })

  it('counts the resend wait down in the button itself, disabled meanwhile', async () => {
    const root = await mounted({ ...step, resendWaitSeconds: 42 })

    const resend = root.querySelector('[data-resend]') as HTMLElement
    expect(resend.hasAttribute('disabled')).toBe(true)
    expect(resend.textContent).toContain('42')
  })

  it('entering six digits calls onVerify once with the code', async () => {
    const actions = recording()
    const root = await mounted(step, '', actions)

    const code = root.querySelector('[data-code-input]') as HTMLElement & { value: string }
    code.value = '123456'
    code.dispatchEvent(new CustomEvent('wa-complete', { bubbles: true }))

    expect(actions.onVerify).toHaveBeenCalledTimes(1)
    expect(actions.onVerify).toHaveBeenCalledWith('123456')
  })

  it('offers resend and back as actions', async () => {
    const actions = recording()
    const root = await mounted(step, '', actions)
    ;(root.querySelector('[data-resend]') as HTMLElement).click()
    ;(root.querySelector('[data-back]') as HTMLElement).click()

    expect(actions.onResend).toHaveBeenCalledTimes(1)
    expect(actions.onBack).toHaveBeenCalledTimes(1)
  })
})

describe('the status region', () => {
  it.each([
    ['chooser', ALL_ON],
    ['email', { step: 'email', busy: false } satisfies SignInStep],
    [
      'code',
      { step: 'code', email: 'a@b.co', busy: false, resendWaitSeconds: 0 } satisfies SignInStep,
    ],
  ] as const)('exists in the %s step, empty and with a notice', async (_name, step) => {
    // Persistent, so a notice arriving later is announced: a live region that appears together
    // with its content is not read (#224).
    const silent = await mounted(step)
    const region = silent.querySelector('[data-sign-in-status]') as HTMLElement
    expect(region).not.toBeNull()
    expect(region.getAttribute('role')).toBe('status')
    expect((region.textContent ?? '').trim()).toBe('')

    const spoken = await mounted(step, 'Something to say')
    expect(spoken.querySelector('[data-sign-in-status]')?.textContent).toContain('Something to say')
  })
})

describe('German, at 360 px', () => {
  afterEach(async () => {
    await page.viewport(414, 896)
    await activateLocale(SOURCE_LOCALE)
  })

  it.each([
    ['chooser, its GitHub button', ALL_ON, 'Mit GitHub anmelden'],
    ['chooser, its passkey button', ALL_ON, 'Mit Passkey anmelden'],
    ['chooser, its email button', ALL_ON, 'Mit E-Mail anmelden'],
    ['email', { step: 'email', busy: false } satisfies SignInStep, 'Code senden'],
    [
      'code',
      {
        step: 'code',
        email: 'langer.name@beispiel-domain.example',
        busy: false,
        resendWaitSeconds: 59,
      } satisfies SignInStep,
      'Neuen Code senden (59)',
    ],
  ] as const)('the %s step speaks Sie and nothing scrolls sideways', async (_name, step, copy) => {
    await page.viewport(360, 640)
    await activateLocale('de')
    const root = await mounted(
      step,
      'Der Anmeldedienst war nicht erreichbar. Bitte versuchen Sie es erneut.',
    )

    expect(root.textContent).toContain(copy)
    const dialog = root.querySelector('[data-sign-in-dialog]') as HTMLElement
    const body = dialog.shadowRoot?.querySelector('[part~="body"]') as HTMLElement
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth)
    for (const button of root.querySelectorAll('wa-button')) {
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
    }
  })
})

describe('offline', () => {
  it.each([
    ['chooser', ALL_ON, '[data-google-sign-in]'],
    ['email', { step: 'email', busy: false } satisfies SignInStep, '[data-send-code]'],
    [
      'code',
      { step: 'code', email: 'a@b.co', busy: false, resendWaitSeconds: 0 } satisfies SignInStep,
      '[data-verify]',
    ],
  ] as const)(
    'the %s step disables its action and says a connection is needed',
    async (_name, step, action) => {
      // Signing in needs the server either way; the existing dialog convention (#224) is
      // disabled actions plus the words, not a failure after the attempt.
      const root = await mounted(step, '', recording(), false)

      expect(root.querySelector('[data-needs-connection]')).not.toBeNull()
      expect((root.querySelector(action) as HTMLElement).hasAttribute('disabled')).toBe(true)
    },
  )
})
