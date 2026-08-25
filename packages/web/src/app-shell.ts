import { msg } from '@lit/localize'
import { html, LitElement, type TemplateResult } from 'lit'
import { matchRoute } from './router/match.js'
import { NAV_ROUTES, ROUTES } from './router/routes.js'
import { applyScheme, readPreference, resolveScheme, writePreference } from './scheme.js'
import './views/device-list.js'
import './views/not-found.js'

/** View id to markup. Explicit rather than dynamic, so an unknown view is a type error. */
const VIEWS: Readonly<Record<string, () => TemplateResult>> = {
  'device-list': () => html`<device-list-view></device-list-view>`,
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
  }

  declare hash: string

  private readonly onHashChange = () => {
    this.hash = window.location.hash
  }

  constructor() {
    super()
    this.hash = window.location.hash
  }

  override connectedCallback(): void {
    super.connectedCallback()
    window.addEventListener('hashchange', this.onHashChange)
  }

  override disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.onHashChange)
    super.disconnectedCallback()
  }

  /** Flips between light and dark, starting from whatever is currently applied. */
  private toggleScheme(): void {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const next =
      resolveScheme(readPreference(localStorage), prefersDark) === 'dark' ? 'light' : 'dark'
    writePreference(localStorage, next)
    applyScheme(document.documentElement, next)
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
          <wa-button
            appearance="plain"
            @click=${this.toggleScheme}
            label=${msg('Switch between light and dark')}
          >
            <wa-icon name="circle-half-stroke"></wa-icon>
          </wa-button>
        </header>

        <nav slot="navigation" class="wa-stack wa-gap-2xs app-nav">
          ${NAV_ROUTES.map(
            (route) => html`
              <a
                href="#${route.path}"
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
