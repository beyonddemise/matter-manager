import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, type TemplateResult } from 'lit'
import { matchRoute } from './router/match.js'
import { NAV_ROUTES, ROUTES } from './router/routes.js'
import {
  applyScheme,
  readPreference,
  resolveScheme,
  type SchemePreference,
  writePreference,
} from './scheme.js'
import './views/device-list.js'
import './views/not-found.js'
import './views/settings.js'

/**
 * View id to markup. `Record<string, …>` accepts any key, so a route whose `view` has no
 * entry here is not a type error - it silently falls through to the not-found view at
 * render time. The actual guard against that drift is the hand-maintained assertion in
 * `routes.test.ts` that every registered route's view exists.
 */
const VIEWS: Readonly<Record<string, () => TemplateResult>> = {
  'device-list': () => html`<device-list-view></device-list-view>`,
  settings: () => html`<settings-view></settings-view>`,
}

/**
 * The cycle order for the scheme toggle: light → dark → system → light.
 *
 * Three stops, not two - the design explicitly calls for "follow the system" to be a
 * reachable choice from the header control, not just the unset default. Collapsing the
 * button to a light/dark flip (as an earlier version did) makes "system" a state a user can
 * fall out of but never choose again through the UI.
 */
const SCHEME_CYCLE: readonly SchemePreference[] = ['light', 'dark', 'system']

/** Icon for each scheme preference, so the button's own icon shows what is currently applied. */
const SCHEME_ICON: Readonly<Record<SchemePreference, string>> = {
  light: 'sun',
  dark: 'moon',
  system: 'circle-half-stroke',
}

/**
 * The application shell.
 *
 * `<wa-page>` owns the layout, the sticky regions, the desktop sidebar and the mobile drawer.
 * Navigation is written once into `slot="navigation"` and rendered in both views by the
 * component; there is deliberately no second copy and no hand-rolled drawer.
 */
export class AppShell extends LitElement {
  /**
   * Light DOM, and this is load-bearing rather than a preference.
   *
   * `<wa-page>` reads `--menu-width` and its own `view` attribute from document CSS, and the
   * `wa-stack` / `wa-cluster` / `wa-split` / `wa-mobile-only` utilities are global selectors.
   * None of that crosses a shadow boundary. Custom properties *do* inherit, so a shadow root
   * yields a page where the tokens look right and the layout silently does not happen.
   */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    hash: { state: true },
    schemePreference: { state: true },
  }

  declare hash: string
  declare schemePreference: SchemePreference

  private readonly onHashChange = () => {
    this.hash = window.location.hash
  }

  constructor() {
    super()
    // Every component that renders a `msg()` needs this, and a component that forgets keeps
    // its old strings while its neighbours change - a silent failure, hence the test in
    // `i18n.browser.test.ts` that switches locale and checks each view's text.
    updateWhenLocaleChanges(this)
    this.hash = window.location.hash
    // Read once at construction. The write side (`cycleScheme`) keeps this field and
    // storage in sync itself, so there is no need to re-read on every render.
    this.schemePreference = readPreference(() => localStorage)
  }

  override connectedCallback(): void {
    super.connectedCallback()
    window.addEventListener('hashchange', this.onHashChange)
  }

  override disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.onHashChange)
    super.disconnectedCallback()
  }

  /** Advances the preference one step around light → dark → system → light. */
  private cycleScheme(): void {
    const currentIndex = SCHEME_CYCLE.indexOf(this.schemePreference)
    const next = SCHEME_CYCLE[(currentIndex + 1) % SCHEME_CYCLE.length] as SchemePreference

    writePreference(() => localStorage, next)
    this.schemePreference = next

    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    applyScheme(document.documentElement, resolveScheme(next, prefersDark))
  }

  /**
   * The accessible label for the scheme toggle, describing what the *next* activation will
   * select rather than the state it is in now - the icon already shows the current state, so
   * naming it again in the label would be redundant, not additionally informative.
   */
  private schemeToggleLabel(): string {
    const currentIndex = SCHEME_CYCLE.indexOf(this.schemePreference)
    const next = SCHEME_CYCLE[(currentIndex + 1) % SCHEME_CYCLE.length] as SchemePreference
    switch (next) {
      case 'light':
        return msg('Switch to light scheme')
      case 'dark':
        return msg('Switch to dark scheme')
      case 'system':
        return msg('Switch to system scheme')
    }
  }

  override render() {
    const match = matchRoute(this.hash, ROUTES)
    const view = match ? VIEWS[match.route.view] : undefined

    return html`
      <wa-page>
        <header slot="header" class="wa-split app-header">
          <div class="wa-cluster">
            <wa-button data-toggle-nav appearance="plain" class="wa-mobile-only">
              <wa-icon name="bars" label=${msg('Menu')}></wa-icon>
            </wa-button>
            <strong>${msg('Matter Manager')}</strong>
          </div>
          <wa-button data-scheme-toggle appearance="plain" @click=${this.cycleScheme}>
            <wa-icon name=${SCHEME_ICON[this.schemePreference]} label=${this.schemeToggleLabel()}></wa-icon>
          </wa-button>
        </header>

        <nav slot="navigation" class="wa-stack wa-gap-2xs app-nav">
          ${NAV_ROUTES.map(
            (route) => html`
              <a
                href="#${route.path}"
                class="wa-cluster wa-gap-s"
                data-drawer="close"
                aria-current=${match?.route === route ? 'page' : 'false'}
              >
                <wa-icon name=${route.icon ?? ''}></wa-icon>
                ${route.label?.()}
              </a>
            `,
          )}
        </nav>

        <main class="app-main">${view ? view() : html`<not-found-view></not-found-view>`}</main>
      </wa-page>
    `
  }
}

customElements.define('app-shell', AppShell)
