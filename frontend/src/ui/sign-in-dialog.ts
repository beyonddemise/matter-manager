/**
 * The sign-in dialog: a method chooser (Google, or an emailed one-time code), the address step,
 * and the code step — signing in without leaving the page.
 *
 * Plain functions over plain values, rendered inside `<app-shell>`, like `upgrade-dialog.ts`.
 * The shell owns the state (which step, busy, the notice) and subscribes to locale changes, so
 * every `msg()` here follows the language with it. The challenge id never reaches this module:
 * it is shell state, and the view only hands codes and addresses back through the actions.
 *
 * The notice lives in a **persistent** `role="status"` region rendered in every step: a live
 * region that appears together with its content is not announced (#224), so the region is always
 * there and the words arrive into it.
 *
 * @module
 */

import { msg, str } from '@lit/localize'
import { html, type TemplateResult } from 'lit'

/** Which screen the dialog shows, with what that screen needs. The shell owns this. */
export type SignInStep =
  /** The method chooser; `emailUnavailable` after a 404 hid the email option for the session. */
  | { step: 'chooser'; emailUnavailable: boolean }
  /** The address, `busy` while the code is being sent. */
  | { step: 'email'; busy: boolean }
  /** The code, sent to `email`; resend waits out the cooldown. */
  | { step: 'code'; email: string; busy: boolean; resendWaitSeconds: number }

/** What the dialog calls back with. */
export interface SignInActions {
  /** The Google redirect, unchanged from the header's old button. */
  onGoogle(): void
  /** The chooser's email option: show the address step. */
  onEmail(): void
  onSendCode(email: string): void
  onVerify(code: string): void
  onResend(): void
  /** One step back: from the address or the code to the chooser. */
  onBack(): void
  onClose(): void
}

/** The email step's address field, read when Send code is pressed or Enter is typed. */
function emailValue(root: Element | null): string {
  return (root?.querySelector('[data-email-input]') as { value?: string } | null)?.value ?? ''
}

/** The chooser: Google is the surface's one filled brand button; email steps aside politely. */
function chooser(state: { emailUnavailable: boolean }, actions: SignInActions): TemplateResult {
  return html`<div class="wa-stack wa-gap-s">
    <wa-button data-google-sign-in variant="brand" @click=${actions.onGoogle}>
      ${msg('Sign in with Google')}
    </wa-button>
    ${
      state.emailUnavailable
        ? ''
        : html`<wa-button data-email-option appearance="outlined" @click=${actions.onEmail}>
            ${msg('Sign in with email')}
          </wa-button>`
    }
  </div>`
}

/** The address step. Enter in the field submits, like the button. */
function emailStep(state: { busy: boolean }, actions: SignInActions): TemplateResult {
  const send = (event: Event) =>
    actions.onSendCode(emailValue((event.target as HTMLElement).closest('[data-sign-in-dialog]')))
  return html`<div class="wa-stack wa-gap-s">
    <wa-input
      data-email-input
      type="email"
      required
      label=${msg('Email address')}
      autocomplete="email"
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === 'Enter' && !state.busy) send(event)
      }}
    ></wa-input>
    <div class="wa-cluster wa-gap-s">
      <wa-button data-send-code variant="brand" ?disabled=${state.busy} @click=${send}>
        ${msg('Send code')}
      </wa-button>
      <wa-button data-back appearance="plain" @click=${actions.onBack}>${msg('Back')}</wa-button>
    </div>
  </div>`
}

/** The code step: six digits, the address they went to, resend on a cooldown, a way back. */
function codeStep(
  state: { email: string; busy: boolean; resendWaitSeconds: number },
  actions: SignInActions,
): TemplateResult {
  const email = state.email
  return html`<div class="wa-stack wa-gap-s">
    <p data-code-sent>${msg(str`Enter the code we sent to ${email}.`)}</p>
    <wa-otp-input
      data-code-input
      length="6"
      label=${msg('Sign-in code')}
      @wa-complete=${(event: Event) => actions.onVerify((event.target as { value?: string }).value ?? '')}
    ></wa-otp-input>
    <div class="wa-cluster wa-gap-s">
      <wa-button
        data-verify
        variant="brand"
        ?disabled=${state.busy}
        @click=${(event: Event) =>
          actions.onVerify(
            (
              (event.target as HTMLElement)
                .closest('[data-sign-in-dialog]')
                ?.querySelector('[data-code-input]') as { value?: string } | null
            )?.value ?? '',
          )}
      >
        ${msg('Sign in')}
      </wa-button>
      <wa-button
        data-resend
        appearance="plain"
        ?disabled=${state.resendWaitSeconds > 0}
        @click=${actions.onResend}
      >
        ${
          state.resendWaitSeconds > 0
            ? msg(str`Send a new code (${state.resendWaitSeconds})`)
            : msg('Send a new code')
        }
      </wa-button>
      <wa-button data-back appearance="plain" @click=${actions.onBack}>${msg('Back')}</wa-button>
    </div>
  </div>`
}

/** The step's body; the status region below it is shared by all three. */
function body(state: SignInStep, actions: SignInActions): TemplateResult {
  switch (state.step) {
    case 'chooser':
      return chooser(state, actions)
    case 'email':
      return emailStep(state, actions)
    case 'code':
      return codeStep(state, actions)
  }
}

/**
 * The dialog, rendered already `open` (the `upgrade-dialog` pattern: presence in the template is
 * the state). Closing it — Escape, its X — reaches the shell through `onClose`.
 *
 * @param notice the status line: a failure, a cooldown word, or `''` for silence
 */
export function renderSignInDialog(
  state: SignInStep,
  notice: string,
  actions: SignInActions,
): TemplateResult {
  return html`<wa-dialog
    data-sign-in-dialog
    open
    label=${msg('Sign in')}
    @wa-after-hide=${(event: Event) => {
      // Only the dialog's own hide: an element inside it can fire the same event.
      if (event.target === event.currentTarget) actions.onClose()
    }}
  >
    <div class="wa-stack wa-gap-m">
      ${body(state, actions)}
      <output data-sign-in-status role="status">${notice}</output>
    </div>
  </wa-dialog>`
}
