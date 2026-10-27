import { msg, str, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, nothing, type TemplateResult } from 'lit'

/**
 * The export dialog on the projects page: plain, or sealed with a password (#307).
 *
 * It decides only what the reader asked for. The archive itself is written by
 * `archive/project-export.ts`; this element ends with an `export-confirm` event carrying the
 * password, or none, and an `export-cancel` when the reader backs out. The page runs the export.
 *
 * **What it says, because the reader cannot find it out later.** Without a password the file
 * holds every setup code in plain text. With one, nothing recovers a lost password — not this
 * application, not the server, not the reader's other devices — so the file is then only as
 * recoverable as the reader's memory, and the dialog says that beside the fields.
 *
 * @module
 */

/**
 * The shortest archive password the export accepts, in characters.
 *
 * Why a floor, and why this one: the archive is WinZip AE-2, whose key derivation is fixed at
 * 1000 rounds of PBKDF2-HMAC-SHA1 (`domain/archive/winzip-aes.ts`) so that 7-Zip, WinZip and
 * macOS tools can open it. A guess then costs about 2000 SHA-1 compressions, so one current GPU
 * tries on the order of ten million passwords a second against a stolen file, with no lockout
 * and no server in the way: the password must carry the strength the derivation does not.
 * Twelve characters is OWASP ASVS's floor for a user-chosen password (V2.1.1), and it rules out
 * the PINs and single words people reach for first; twelve random lowercase letters alone would
 * take that GPU over a century. A length rule rather than character classes, because length is what
 * reliably adds guessing work. The import accepts any password: an archive made elsewhere owes
 * nothing to this rule.
 */
export const ARCHIVE_PASSWORD_MIN_LENGTH = 12

/** Why the typed password cannot be used yet. */
export type PasswordProblem = 'tooShort' | 'mismatch'

/**
 * Whether a password and its confirmation may seal an archive.
 *
 * Length is counted in characters (code points), so `ü` and an emoji count once, as a reader
 * would count them.
 */
export function passwordProblem(
  password: string,
  confirmation: string,
): PasswordProblem | undefined {
  if ([...password].length < ARCHIVE_PASSWORD_MIN_LENGTH) return 'tooShort'
  if (confirmation !== password) return 'mismatch'
  return undefined
}

/** What `export-confirm` carries: the password to seal with, or none for a plain archive. */
export interface ExportConfirmDetail {
  readonly password?: string
}

/** The value a Web Awesome field holds, as a string. */
const fieldText = (event: Event): string =>
  String((event.currentTarget as { value?: unknown }).value ?? '')

/** The dialog. See the module comment. */
export class ProjectExportDialog extends LitElement {
  /** Light DOM, so Web Awesome's global utility classes reach this markup. See `app-shell.ts`. */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    open: { type: Boolean },
    projectName: { attribute: false },
    busy: { type: Boolean },
    protect: { state: true },
    password: { state: true },
    confirmation: { state: true },
  }

  declare open: boolean
  /** The name the page shows for the project being exported. */
  declare projectName: string
  /** Whether the page is running an action; the export button waits for it. */
  declare busy: boolean
  /** Whether the reader chose to protect the file with a password. */
  declare protect: boolean
  declare password: string
  declare confirmation: string

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.open = false
    this.projectName = ''
    this.busy = false
    this.reset()
  }

  /**
   * Forgets everything typed, so a password never outlives the dialog it was typed into. Run on
   * every way out (export, Cancel, Escape), so each opening starts plain and empty.
   */
  private reset(): void {
    this.protect = false
    this.password = ''
    this.confirmation = ''
  }

  /**
   * Hands the choice over. Reached only from the export button, which stays disabled while the
   * page is busy or the password is not usable, so neither is checked again here.
   */
  private confirm(): void {
    const detail: ExportConfirmDetail = this.protect ? { password: this.password } : {}
    this.reset()
    this.dispatchEvent(new CustomEvent('export-confirm', { detail, bubbles: true, composed: true }))
  }

  private cancel(): void {
    this.reset()
    this.dispatchEvent(new CustomEvent('export-cancel', { bubbles: true, composed: true }))
  }

  override render(): TemplateResult {
    const problem = this.protect ? passwordProblem(this.password, this.confirmation) : undefined
    return html`
      <wa-dialog
        data-export-dialog
        label=${msg('Export project')}
        ?open=${this.open}
        @wa-after-hide=${(event: Event) => {
          // Only the dialog's own hide: a field inside it can fire the same event.
          if (event.target === event.currentTarget && this.open) this.cancel()
        }}
      >
        ${
          // The body only while open: a closed dialog's fields still take part in the page's
          // layout, and at phone width they widened the page they are not even shown on.
          this.open ? this.renderBody(problem) : nothing
        }
        <wa-button slot="footer" data-cancel-export appearance="outlined" @click=${() => this.cancel()}>
          ${msg('Cancel')}
        </wa-button>
        <wa-button
          slot="footer"
          data-confirm-export
          variant="brand"
          ?disabled=${this.busy || problem !== undefined}
          @click=${() => this.confirm()}
        >
          ${msg('Export')}
        </wa-button>
      </wa-dialog>
    `
  }

  private renderBody(problem: PasswordProblem | undefined): TemplateResult {
    return html`
        <div class="wa-stack wa-gap-m">
          <p>
            ${msg(
              str`A zip file of “${this.projectName}” with every device and its setup codes, to keep as a backup or to import on another device.`,
            )}
          </p>
          <wa-checkbox
            data-field="protect"
            autofocus
            .checked=${this.protect}
            hint=${msg('Opens with the password in Matter Manager, 7-Zip, WinZip and other zip tools that support AES.')}
            @change=${(event: Event) => {
              this.protect = (event.currentTarget as { checked?: boolean }).checked === true
            }}
          >
            ${msg('Protect with a password')}
          </wa-checkbox>
          ${this.protect ? this.renderPassword(problem) : this.renderPlainWarning()}
        </div>
    `
  }

  /** Said when no password is chosen: what the file holds, in the clear. */
  private renderPlainWarning(): TemplateResult {
    return html`<wa-callout variant="warning" data-plaintext-warning>
      <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
      ${msg('Without a password, the setup codes are in plain text: whoever has the file can commission the devices. Keep it safe.')}
    </wa-callout>`
  }

  private renderPassword(problem: PasswordProblem | undefined): TemplateResult {
    // Said only once there is something to say about: an empty field is not yet a mistake. Every
    // state that keeps Export disabled past that point says why, because a disabled button
    // cannot be focused to ask.
    const said =
      problem === 'tooShort'
        ? this.password === ''
          ? undefined
          : msg(str`The password needs at least ${ARCHIVE_PASSWORD_MIN_LENGTH} characters.`)
        : problem === 'mismatch'
          ? this.confirmation === ''
            ? msg('Repeat the password to export.')
            : msg('The two passwords are not the same.')
          : undefined
    const submit = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && problem === undefined && !this.busy) this.confirm()
    }
    // The warning comes first, so it is read before a password is chosen, also on a phone where
    // the fields push the rest of the dialog below the fold.
    return html`
      <wa-callout variant="warning" data-unrecoverable>
        <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
        ${msg('If the password is lost, the file cannot be opened. Nobody can recover it: not Matter Manager, not the server, not your other devices.')}
      </wa-callout>
      <wa-input
        data-field="password"
        type="password"
        password-toggle
        autocomplete="new-password"
        label=${msg('Password')}
        hint=${msg(str`At least ${ARCHIVE_PASSWORD_MIN_LENGTH} characters. A few unrelated words are easy to remember and hard to guess.`)}
        .value=${this.password}
        @input=${(event: Event) => {
          this.password = fieldText(event)
        }}
      ></wa-input>
      <wa-input
        data-field="confirm-password"
        type="password"
        password-toggle
        autocomplete="new-password"
        label=${msg('Repeat the password')}
        .value=${this.confirmation}
        @input=${(event: Event) => {
          this.confirmation = fieldText(event)
        }}
        @keydown=${submit}
      ></wa-input>
      <p class="app-empty" data-password-problem aria-live="polite">${said ?? nothing}</p>
    `
  }
}

customElements.define('project-export-dialog', ProjectExportDialog)
