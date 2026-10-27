import './project-import.js'
// Rendered by this view and by nothing in the shell, so imported here (#214): it travels in
// this view's lazy chunk rather than in the entry chunk every visitor parses before first paint.
import '@awesome.me/webawesome-pro/dist/components/format-date/format-date.js'
import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit'
import type { Plan } from '../../domain/plan.js'
import type { CredentialsLike } from '../passkey-signin.js'
import type { SessionState } from '../session.js'
import type { Passkey, SignInMethods, SignInMethodsApi } from '../sign-in-methods.js'

/**
 * Each plan's public name, a table so no plan is named by comparison (ADR 0009). The `member`
 * tier is marketed as "Home" (see `MARKETING_TIERS` in `domain/plan.ts`); the internal tier name
 * never reaches the reader.
 */
const PLAN_NAMES: Readonly<Record<Plan, () => string>> = {
  free: () => msg('Free'),
  member: () => msg('Home'),
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
    session: {},
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
   * What the shell believes about the session. Optional: a view mounted without it reads once on
   * connect. Why it exists: a reload on this page mounts the view before the token refresher's
   * first exchange, so the connect-time read finds nobody signed in; the view reads again when
   * the session becomes `signed-in`.
   */
  declare session?: SessionState

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
    // A view that arrives already signed-in is read by `willUpdate`, so it is not read twice.
    if (this.session !== 'signed-in') void this.refresh()
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has('session')) return
    if (this.session === 'signed-in') void this.refresh()
    else if (this.session !== undefined) this.forget()
  }

  /**
   * Drops everything the ended session loaded and shows the signed-out state. Why bumping
   * `reads`: a read still in flight would otherwise answer after sign-out and put the previous
   * account's methods back on screen.
   */
  private forget(): void {
    this.reads++
    this.loaded = 'signed-out'
    this.editing = undefined
    this.announcement = ''
  }

  /** Counts reads, so an answer to an older read never overwrites a newer one. */
  private reads = 0

  /** Reads the methods and shows what came back. */
  private async refresh(): Promise<void> {
    const read = ++this.reads
    const outcome = await this.api.read()
    if (read !== this.reads) return
    this.loaded = outcome.kind === 'methods' ? outcome.methods : outcome.kind
    if (outcome.kind === 'unreachable')
      this.announcement = msg('That did not work. Please try again.')
  }

  /** The signed-in methods, or undefined in any other state. */
  private get methods(): SignInMethods | undefined {
    return typeof this.loaded === 'object' ? this.loaded : undefined
  }

  /** Where focus goes once the DOM has caught up and no request holds the buttons disabled. */
  private pendingFocus: (() => Element | null | undefined) | undefined

  /**
   * Moves focus after a change. Why deferred: the control that had focus (Save, Cancel, Delete)
   * is removed by the re-render, which would drop focus to `<body>` (WCAG 2.4.3); and while a
   * request is in flight every button is disabled, which cannot take focus, so the move waits
   * for `run` to release the busy flag.
   */
  private focusAfterRender(find: () => Element | null | undefined): void {
    this.pendingFocus = find
    if (!this.busy) void this.flushFocus()
  }

  /** Applies the pending focus move, once the render that follows the latest change is done. */
  private async flushFocus(): Promise<void> {
    await this.updateComplete
    const find = this.pendingFocus
    this.pendingFocus = undefined
    ;(find?.() as HTMLElement | null | undefined)?.focus()
  }

  /** The Rename button of the row for `id`. */
  private renameButton(id: string): Element | null {
    return this.querySelector(`[data-passkey="${CSS.escape(id)}"] [data-rename]`)
  }

  /** Ends editing and returns focus to the row's Rename button. */
  private stopEditing(id: string): void {
    this.editing = undefined
    this.focusAfterRender(() => this.renameButton(id))
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
      if (this.pendingFocus !== undefined) void this.flushFocus()
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
        this.stopEditing(passkey.id)
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
        const before = this.methods?.passkeys ?? []
        const next = before[before.findIndex((p) => p.id === passkey.id) + 1]
        this.setPasskeys(before.filter((p) => p.id !== passkey.id))
        this.announcement = msg('Passkey deleted.')
        // The next row stands where the deleted one was; with none left, the Add button, which
        // is absent when this browser cannot make passkeys, so the heading is the fallback.
        this.focusAfterRender(() =>
          next === undefined
            ? (this.querySelector('[data-add-passkey]') ?? this.querySelector('h1'))
            : this.renameButton(next.id),
        )
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
      this.stopEditing(passkey.id)
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
        <wa-button
          data-rename-cancel
          appearance="plain"
          @click=${() => this.stopEditing(passkey.id)}
        >
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
        <h1 tabindex="-1">${msg('Account')}</h1>
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
        <!-- Signed in or not: an import makes a project on this device and needs no account. -->
        <project-import-section></project-import-section>
      </div>
    `
  }
}

customElements.define('account-view', AccountView)
