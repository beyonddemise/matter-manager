import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement } from 'lit'

/**
 * What the person chose when asked whether to leave a form holding unsaved input (#356).
 *
 * The seam for drafts (#358): Back from step 1 with input will offer **Save as draft** beside
 * Discard. That is one more member here (`'draft'`), one more button in {@link LeaveDialog}'s
 * footer, and one more case where the form acts on the answer (`AddDeviceView.confirmLeave`);
 * nothing in the shell or the history changes, because they only ever ask "leave or stay?".
 */
export type LeaveChoice = 'stay' | 'discard'

/**
 * Asks whether to leave a form that holds something not yet saved: Stay, or Discard.
 *
 * Stay has the focus when the dialog opens (WCAG 2.2 AA, PRODUCT.md): it is the choice that loses
 * nothing, so Enter or a reflex press cannot throw input away. Closing the dialog any other way -
 * Escape, its close button - is Stay too. `wa-dialog` traps focus while open and returns it to
 * where it was when it closes.
 */
export class LeaveDialog extends LitElement {
  /** Light DOM, so Web Awesome's global utility classes reach this markup. */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    open: { state: true },
  }

  /** Whether the question is on screen. */
  declare open: boolean

  /** Answers the question on screen; set while it is. */
  private settle: ((choice: LeaveChoice) => void) | undefined
  /** The question on screen, so that a second ask while it is open gets the same answer. */
  private pending: Promise<LeaveChoice> | undefined

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.open = false
  }

  /** Opens the dialog, and resolves with the person's choice. */
  ask(): Promise<LeaveChoice> {
    this.pending ??= new Promise((resolve) => {
      this.settle = resolve
      this.open = true
    })
    return this.pending
  }

  /** Resolves the question with `choice` and closes the dialog. Only the first answer counts. */
  private answer(choice: LeaveChoice): void {
    const settle = this.settle
    this.settle = undefined
    this.pending = undefined
    this.open = false
    settle?.(choice)
  }

  override render() {
    return html`
      <wa-dialog
        data-leave-dialog
        label=${msg('Leave without saving?')}
        ?open=${this.open}
        @wa-after-hide=${(event: Event) => {
          // Only the dialog's own closing: events from components inside it bubble here too.
          if (event.target === event.currentTarget) this.answer('stay')
        }}
      >
        <p>${msg('What you entered on this form has not been saved. If you leave, it is lost.')}</p>
        <wa-button
          slot="footer"
          data-leave-stay
          variant="brand"
          autofocus
          @click=${() => this.answer('stay')}
        >
          ${msg('Stay')}
        </wa-button>
        <wa-button
          slot="footer"
          data-leave-discard
          variant="danger"
          appearance="outlined"
          @click=${() => this.answer('discard')}
        >
          ${msg('Discard')}
        </wa-button>
      </wa-dialog>
    `
  }
}

customElements.define('leave-dialog', LeaveDialog)
