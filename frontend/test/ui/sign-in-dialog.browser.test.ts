import '@awesome.me/webawesome-pro/dist/styles/webawesome.css'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/otp-input/otp-input.js'
import { fixture } from '@open-wc/testing-helpers'
import { html, render } from 'lit'
import { beforeAll, describe, expect, it, vi } from 'vitest'
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
    onEmail: vi.fn(),
    onSendCode: vi.fn(),
    onVerify: vi.fn(),
    onResend: vi.fn(),
    onBack: vi.fn(),
    onClose: vi.fn(),
  } satisfies SignInActions
}

/** The dialog rendered into a fresh container, queried by its light-DOM contract. */
async function mounted(state: SignInStep, notice = '', actions: SignInActions = recording()) {
  const container = await fixture(html`<div></div>`)
  render(renderSignInDialog(state, notice, actions), container as HTMLElement)
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

describe('the chooser', () => {
  it('offers Google and email, Google as the one filled brand button', async () => {
    const root = await mounted({ step: 'chooser', emailUnavailable: false })

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
    expect(root.querySelector('[data-email-option]')).not.toBeNull()
  })

  it('offers only Google when email sign-in is unavailable', async () => {
    const root = await mounted({ step: 'chooser', emailUnavailable: true })

    expect(root.querySelector('[data-google-sign-in]')).not.toBeNull()
    expect(root.querySelector('[data-email-option]')).toBeNull()
  })

  it('wires the two choices to their actions', async () => {
    const actions = recording()
    const root = await mounted({ step: 'chooser', emailUnavailable: false }, '', actions)
    ;(root.querySelector('[data-google-sign-in]') as HTMLElement).click()
    ;(root.querySelector('[data-email-option]') as HTMLElement).click()

    expect(actions.onGoogle).toHaveBeenCalledTimes(1)
    expect(actions.onEmail).toHaveBeenCalledTimes(1)
    expect(actions.onSendCode).not.toHaveBeenCalled()
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
    ['chooser', { step: 'chooser', emailUnavailable: false } satisfies SignInStep],
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
    expect(spoken.querySelector('[data-sign-in-status]')?.textContent).toContain(
      'Something to say',
    )
  })
})
