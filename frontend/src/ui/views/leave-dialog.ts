import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement } from 'lit'

/**
 * What the person chose when asked whether to leave a form holding unsaved input (#356), and,
 * since #358, whether to keep it as a draft.
 *
 * Nothing in the shell or the history knows about `'draft'`: they only ever ask "leave or
 * stay?", and the form turns a draft into "leave" once it has saved one
 * (`AddDeviceView.confirmLeave`).
 */
export type LeaveChoice = 'stay' | 'discard' | 'draft'

/**
 * Whether the question offers **Save as draft** (#358).
 *
 * - `'none'`: the form has no drafts to offer.
 * - `'offer'`: what is entered can be kept as a draft.
 * - `{ refused }`: it cannot, and `refused` says why (already translated) - a setup code that
 *   does not read, say. Said rather than the button merely left out, so the person knows why
 *   the choice is not there and can Stay to fix it.
 */
export type DraftOption = 'none' | 'offer' | { readonly refused: string }

/**
 * Asks whether to leave a form that holds something not yet saved: Stay, Discard, and where the
 * form allows it Save as draft.
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
    draft: { state: true },
    discardLabel: { attribute: false },
  }

  /** Whether the question is on screen. */
  declare open: boolean
  /** What the question on screen offers about a draft. */
  declare draft: DraftOption
  /**
   * The Discard button's words, when the form means something narrower than "everything": a
   * reopened draft discards only the changes, and the draft stays (#358).
   */
  declare discardLabel: string | undefined

  /** Answers the question on screen; set while it is. */
  private settle: ((choice: LeaveChoice) => void) | undefined
  /** The question on screen, so that a second ask while it is open gets the same answer. */
  private pending: Promise<LeaveChoice> | undefined

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.open = false
    this.draft = 'none'
    this.discardLabel = undefined
  }

  /**
   * Opens the dialog, and resolves with the person's choice.
   *
   * @param draft whether to offer Save as draft; see {@link DraftOption}
   */
  ask(draft: DraftOption = 'none'): Promise<LeaveChoice> {
    this.pending ??= new Promise((resolve) => {
      this.settle = resolve
      this.draft = draft
      this.open = true
    })
    return this.pending
  }

  /**
   * Takes the question away unanswered, because the form let go of its input on its own (a
   * project switch, a Save landing) while it was open. Resolves as Stay: the person chose
   * nothing, and whoever asked then reads where the browser is (`AppShell.settleLeave`).
   */
  withdraw(): void {
    this.answer('stay')
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
    const draft = this.draft
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
        <div class="wa-stack wa-gap-m">
          <p>${msg('What you entered on this form has not been saved. If you leave, it is lost.')}</p>
          ${draft === 'offer' ? html`<p>${msg('Save it as a draft to finish it later.')}</p>` : ''}
          ${
            typeof draft === 'object'
              ? html`
                  <wa-callout variant="neutral" data-leave-draft-refused>
                    <wa-icon slot="icon" name="circle-info"></wa-icon>
                    <div class="wa-stack wa-gap-3xs">
                      <strong>${msg('It cannot be saved as a draft yet.')}</strong>
                      <span>${draft.refused}</span>
                    </div>
                  </wa-callout>
                `
              : ''
          }
        </div>
        <wa-button
          slot="footer"
          data-leave-stay
          variant="brand"
          autofocus
          @click=${() => this.answer('stay')}
        >
          ${msg('Stay')}
        </wa-button>
        ${
          draft === 'offer'
            ? html`
                <wa-button
                  slot="footer"
                  data-leave-draft
                  appearance="outlined"
                  @click=${() => this.answer('draft')}
                >
                  ${msg('Save as draft')}
                </wa-button>
              `
            : ''
        }
        <wa-button
          slot="footer"
          data-leave-discard
          variant="danger"
          appearance="outlined"
          @click=${() => this.answer('discard')}
        >
          ${this.discardLabel ?? msg('Discard')}
        </wa-button>
      </wa-dialog>
    `
  }
}

customElements.define('leave-dialog', LeaveDialog)
