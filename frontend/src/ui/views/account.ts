import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, nothing, type TemplateResult } from 'lit'
import type { Plan } from '../../domain/plan.js'
import type { CredentialsLike } from '../passkey-signin.js'
import type { Passkey, SignInMethods, SignInMethodsApi } from '../sign-in-methods.js'

/** Each plan's name, a table so no plan is named by comparison (ADR 0009). */
const PLAN_NAMES: Readonly<Record<Plan, () => string>> = {
  free: () => msg('Free'),
  member: () => msg('Member'),
  pro: () => msg('Pro'),
}

/**
 * How this account signs in: the email and plan, which providers are linked, and the passkeys,
 * which can be added, renamed and deleted here.
 *
 * Light DOM like the other views. The api, the credentials container and the passkey-support
 * test are injected properties (the `settings.ts` seam style): a real authenticator and a real
 * server cannot be made to answer `full` or `signed-out` on demand, and those are the states
 * worth testing.
 *
 * Provider rows are read-only on purpose: linking happens by signing in with the provider, and
 * this page has nothing to add to that. Deleting a passkey needs no confirmation because it is
 * safe by construction — a passkey is only ever added, never the sole way in — and the person
 * can register the device again.
 *
 * Nothing the person's account holds (labels, addresses, ids) is written to a log or an error
 * message; it is only rendered.
 */
export class AccountView extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    api: { attribute: false },
    credentials: { attribute: false },
    passkeySupport: { attribute: false },
    email: {},
    plan: {},
    loaded: { state: true },
    editing: { state: true },
    busy: { state: true },
    announcement: { state: true },
  }

  /** The sign-in-methods calls. Injected by the shell; a test binds a stub. */
  declare api: SignInMethodsApi

  /** Where the passkey ceremony runs. Falls back to `navigator.credentials`. */
  declare credentials?: CredentialsLike

  /** Whether this browser can create a passkey; the add button is absent when it cannot. */
  declare passkeySupport: () => boolean

  /** The cached profile's address, as the header reads it. Injected, never fetched here. */
  declare email?: string

  /** The cached profile's plan. */
  declare plan?: Plan

  /**
   * What the account signs in with. `undefined` until the first read lands, `'signed-out'` when
   * the session is gone, `'unreachable'` when the service could not be asked.
   */
  declare loaded: SignInMethods | 'signed-out' | 'unreachable' | undefined

  /** The id of the passkey whose label is being edited, if any. */
  declare editing: string | undefined

  /** True while a request is in flight, so a second click cannot start a second one. */
  declare busy: boolean

  /** The persistent status region's text. Empty announces nothing. */
  declare announcement: string

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.passkeySupport = () => typeof PublicKeyCredential !== 'undefined'
    this.busy = false
    this.announcement = ''
  }

  override connectedCallback(): void {
    super.connectedCallback()
    void this.refresh()
  }

  /** Reads the methods and shows what came back. */
  private async refresh(): Promise<void> {
    const outcome = await this.api.read()
    this.loaded = outcome.kind === 'methods' ? outcome.methods : outcome.kind
    if (outcome.kind === 'unreachable')
      this.announcement = msg('That did not work. Please try again.')
  }

  /** The signed-in methods, or undefined in any other state. */
  private get methods(): SignInMethods | undefined {
    return typeof this.loaded === 'object' ? this.loaded : undefined
  }

  /** Replaces the passkey list, keeping the providers. */
  private setPasskeys(passkeys: Passkey[]): void {
    const methods = this.methods
    if (methods !== undefined) this.loaded = { ...methods, passkeys }
  }

  /** Runs one request with the busy flag held, so the buttons cannot be pressed twice. */
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.announcement = ''
    try {
      await action()
    } finally {
      this.busy = false
    }
  }

  /**
   * Registers a passkey. `dismissed` is the person closing the sheet — a choice, so nothing is
   * announced. Why `signed-out` replaces the page rather than announcing: every other control
   * here would fail the same way.
   */
  private onAdd = (): Promise<void> =>
    this.run(async () => {
      const outcome = await this.api.add(this.credentials ?? navigator.credentials)
      switch (outcome.kind) {
        case 'added':
          this.setPasskeys([...(this.methods?.passkeys ?? []), outcome.passkey])
          this.announcement = msg('Passkey added.')
          break
        case 'dismissed':
          break
        case 'full':
          this.announcement = msg('This account has reached its limit of passkeys.')
          break
        case 'signed-out':
          this.loaded = 'signed-out'
          break
        case 'unreachable':
          this.announcement = msg('That did not work. Please try again.')
          break
      }
    })

  /** Commits the label typed into the inline input. An empty label is ignored. */
  private commitRename = (passkey: Passkey, input: { value: string }): Promise<void> => {
    const label = input.value.trim()
    if (label === '') return Promise.resolve()
    return this.run(async () => {
      const outcome = await this.api.rename(passkey.id, label)
      if (outcome.kind === 'done') {
        this.setPasskeys(
          (this.methods?.passkeys ?? []).map((p) => (p.id === passkey.id ? { ...p, label } : p)),
        )
        this.editing = undefined
        this.announcement = msg('Passkey renamed.')
      } else if (outcome.kind === 'missing') {
        // Removed on another device: the list is stale, so it is read again.
        this.editing = undefined
        await this.refresh()
      } else if (outcome.kind === 'signed-out') {
        this.loaded = 'signed-out'
      } else {
        this.announcement = msg('That did not work. Please try again.')
      }
    })
  }

  /** Deletes at once. `missing` means it is already gone, which is what was asked for. */
  private onDelete = (passkey: Passkey): Promise<void> =>
    this.run(async () => {
      const outcome = await this.api.remove(passkey.id)
      if (outcome.kind === 'done' || outcome.kind === 'missing') {
        this.setPasskeys((this.methods?.passkeys ?? []).filter((p) => p.id !== passkey.id))
        this.announcement = msg('Passkey deleted.')
      } else if (outcome.kind === 'signed-out') {
        this.loaded = 'signed-out'
      } else {
        this.announcement = msg('That did not work. Please try again.')
      }
    })

  /** Swaps the label for an input and moves focus into it. */
  private startRename(passkey: Passkey): void {
    this.editing = passkey.id
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>('wa-input[data-rename-input]')?.focus()
    })
  }

  private onRenameKey(event: KeyboardEvent, passkey: Passkey): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      void this.commitRename(passkey, event.currentTarget as unknown as { value: string })
    } else if (event.key === 'Escape') {
      this.editing = undefined
    }
  }

  /** One provider's read-only row: its name and whether the account has it. */
  private renderProvider(key: string, name: string, linked: boolean): TemplateResult {
    return html`
      <div class="wa-split" data-provider=${key}>
        <span>${name}</span>
        <span>${linked ? msg('Linked') : msg('Not linked')}</span>
      </div>
    `
  }

  /** The label, or the inline input that replaces it while it is being renamed. */
  private renderLabel(passkey: Passkey): TemplateResult {
    if (this.editing !== passkey.id) return html`<strong>${passkey.label}</strong>`
    return html`
      <div class="wa-cluster wa-gap-xs">
        <wa-input
          data-rename-input
          label=${msg('Passkey name')}
          value=${passkey.label}
          @keydown=${(event: KeyboardEvent) => this.onRenameKey(event, passkey)}
        ></wa-input>
        <wa-button
          data-rename-save
          variant="brand"
          ?disabled=${this.busy}
          @click=${(event: Event) => {
            const input = (event.currentTarget as HTMLElement)
              .closest('[data-passkey]')
              ?.querySelector('wa-input') as unknown as { value: string }
            void this.commitRename(passkey, input)
          }}
        >
          ${msg('Save')}
        </wa-button>
        <wa-button appearance="plain" @click=${() => (this.editing = undefined)}>
          ${msg('Cancel')}
        </wa-button>
      </div>
    `
  }

  private renderPasskey(passkey: Passkey): TemplateResult {
    return html`
      <li class="wa-stack wa-gap-2xs" data-passkey=${passkey.id}>
        ${this.renderLabel(passkey)}
        <span>
          ${msg('Added')}:
          <wa-format-date date=${passkey.createdAt} month="short" day="numeric" year="numeric">
          </wa-format-date>
        </span>
        <span>
          ${msg('Last used')}:
          <wa-format-date date=${passkey.lastUsedAt} month="short" day="numeric" year="numeric">
          </wa-format-date>
        </span>
        <div class="wa-cluster wa-gap-xs">
          <wa-button
            data-rename
            size="s"
            appearance="outlined"
            ?disabled=${this.busy}
            @click=${() => this.startRename(passkey)}
          >
            ${msg('Rename')}
          </wa-button>
          <wa-button
            data-delete
            size="s"
            appearance="outlined"
            variant="danger"
            ?disabled=${this.busy}
            @click=${() => void this.onDelete(passkey)}
          >
            ${msg('Delete')}
          </wa-button>
        </div>
      </li>
    `
  }

  private renderMethods(methods: SignInMethods): TemplateResult {
    return html`
      <wa-card>
        <div class="wa-stack wa-gap-m">
          <h2>${msg('Sign-in methods')}</h2>
          <div class="wa-stack wa-gap-xs">
            ${this.renderProvider('google', 'Google', methods.google)}
            ${this.renderProvider('github', 'GitHub', methods.github)}
            ${this.renderProvider('email', msg('Email'), methods.email)}
          </div>
          <h3>${msg('Passkeys')}</h3>
          <ul class="wa-stack wa-gap-m">
            ${methods.passkeys.map((passkey) => this.renderPasskey(passkey))}
          </ul>
          ${
            this.passkeySupport()
              ? html`<wa-button
                  data-add-passkey
                  variant="brand"
                  ?disabled=${this.busy}
                  @click=${() => void this.onAdd()}
                >
                  ${msg('Add a passkey')}
                </wa-button>`
              : nothing
          }
        </div>
      </wa-card>
    `
  }

  override render() {
    const methods = this.methods
    return html`
      <div class="wa-stack wa-gap-l">
        <h1>${msg('Account')}</h1>
        ${
          this.email === undefined
            ? nothing
            : html`<div class="wa-stack wa-gap-2xs">
                <span data-account-email>${this.email}</span>
                ${this.plan === undefined ? nothing : html`<span data-account-plan>${PLAN_NAMES[this.plan]()}</span>`}
              </div>`
        }
        ${
          this.loaded === 'signed-out'
            ? html`<p data-signed-out>${msg('Sign in to manage how you sign in.')}</p>`
            : methods === undefined
              ? nothing
              : this.renderMethods(methods)
        }
        <p role="status">${this.announcement}</p>
      </div>
    `
  }
}

customElements.define('account-view', AccountView)
