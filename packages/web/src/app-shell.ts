import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, type TemplateResult } from 'lit'
import {
  beginSignIn,
  endSession,
  followProfileLocale,
  projectSync,
  projects,
  type ReplicatingProject,
  readSessionState,
} from './composition.js'
import { type ConnectivitySource, watchConnectivity } from './connectivity.js'
import { negotiateLocale } from './i18n/locale.js'
import { activateLocale } from './i18n/localization.js'
import { matchRoute } from './router/match.js'
import { NAV_ROUTES, ROUTES } from './router/routes.js'
import {
  applyScheme,
  readPreference,
  resolveScheme,
  type SchemePreference,
  writePreference,
} from './scheme.js'
import type { SessionState } from './session.js'
import type { SyncManager } from './sync/manager.js'
import type { SyncState } from './sync/replication.js'
import { applyUpdate } from './updates.js'
import './views/add-device.js'
import './views/device-list.js'
import './views/device.js'
import './views/edit-device.js'
import './views/not-found.js'
import './views/settings.js'

/**
 * View id to markup, given whatever the route captured.
 *
 * `Record<string, …>` accepts any key, so a route whose `view` has no entry here is not a type
 * error - it silently falls through to the not-found view at render time. The actual guard
 * against that drift is the hand-maintained assertion in `routes.test.ts` that every registered
 * route's view exists.
 *
 * Every entry takes the parameters even where it ignores them, so adding a parameter to an
 * existing route is a change to one line rather than to this signature.
 */
type ViewParams = Readonly<Record<string, string>>

const VIEWS: Readonly<Record<string, (params: ViewParams) => TemplateResult>> = {
  'add-device': () => html`<add-device-view></add-device-view>`,
  device: (params) => html`<device-view uuid=${params.id ?? ''}></device-view>`,
  'device-list': () => html`<device-list-view></device-list-view>`,
  'edit-device': (params) => html`<edit-device-view uuid=${params.id ?? ''}></edit-device-view>`,
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
    session: { state: true },
    syncing: { state: true },
    readSession: { attribute: false },
    listProjects: { attribute: false },
    makeSync: { attribute: false },
    followLocale: { attribute: false },
    signIn: { attribute: false },
    signOutOf: { attribute: false },
    hash: { state: true },
    schemePreference: { state: true },
    online: { state: true },
    updateReady: { attribute: false },
    connectivity: { attribute: false },
    takeUpdate: { attribute: false },
  }

  declare hash: string
  declare schemePreference: SchemePreference

  /**
   * What this browser believes about the session.
   *
   * `undefined` until the first answer arrives, which is why the control renders nothing at
   * first: offering "Sign in" to somebody who *is* signed in, for the moment it takes to find
   * out, is worse than offering nothing for that moment.
   */
  declare session: SessionState | undefined

  /**
   * What replication is doing across every project, or `undefined` when none is running.
   *
   * The worst state wins, because a summary that reported `idle` while one project was
   * unreachable would be reassuring and wrong. `offline` is not an error - the local database
   * is complete and usable - so it is shown as quietly as the connectivity tag beside it.
   */
  declare syncing: SyncState | undefined

  /** Injected by tests. Unset in the application, where these reach the real API. */
  declare readSession?: () => Promise<SessionState>
  declare listProjects?: () => Promise<readonly ReplicatingProject[]>
  declare makeSync?: (onState: (id: string, state: SyncState) => void) => SyncManager
  declare followLocale?: (onChange: (locale: string) => void) => Promise<unknown>
  declare signIn?: () => void
  declare signOutOf?: () => Promise<readonly string[]>
  /** What the browser last said about the network. See `connectivity.ts` on trusting it. */
  declare online: boolean
  /**
   * The worker waiting to take over, once there is one.
   *
   * Set from outside — `main.ts` owns the registration and watches it — rather than watched
   * from in here. The shell is where the update is *announced*; noticing one is a different
   * concern with different tests, and one that has to keep working if this component is ever
   * replaced.
   */
  declare updateReady: ServiceWorker | undefined
  /** Bound by a test to a network it controls; `window` otherwise. */
  declare connectivity?: ConnectivitySource
  /**
   * What accepting the update does.
   *
   * A seam, and a necessary one rather than a tidy one: the real thing schedules a reload of
   * the page it is running in. A test that called it would reload the test browser three
   * seconds later, out of the middle of whatever was running by then — a failure appearing in
   * an unrelated file, which is the worst kind to chase.
   */
  declare takeUpdate?: (waiting: ServiceWorker) => void

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
    this.online = true
    this.updateReady = undefined
  }

  private stopWatchingNetwork: (() => void) | undefined

  override connectedCallback(): void {
    super.connectedCallback()
    window.addEventListener('hashchange', this.onHashChange)
    this.stopWatchingNetwork = watchConnectivity(this.connectivity ?? window, (online) => {
      this.online = online
    })

    // Not awaited, and nothing waits for it. The application is local-first: every view works
    // without a session, so holding the shell back on a network request would delay the whole
    // interface to answer a question that changes one button.
    void (this.readSession ?? readSessionState)().then((state) => {
      this.session = state
      if (state === 'signed-in') void this.startSyncing()
    })
  }

  override disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.onHashChange)
    this.stopWatchingNetwork?.()
    this.stopWatchingNetwork = undefined
    super.disconnectedCallback()
  }

  /**
   * Takes the waiting update.
   *
   * The reload is the point: a new worker controlling an old page does not change the
   * JavaScript already running in it. `updates.ts` owns the sequencing, including the case
   * where the worker never answers.
   */
  private onTakeUpdate(): void {
    const waiting = this.updateReady
    if (waiting === undefined) return

    const take =
      this.takeUpdate ??
      ((worker: ServiceWorker) =>
        applyUpdate(worker, navigator.serviceWorker, () => {
          window.location.reload()
        }))
    take(waiting)
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

  /**
   * Signing in, or out, or nothing at all until the answer arrives.
   *
   * `expired` gets the same control as `signed-out` and a different word. The remedy is
   * identical - sign in again - but "your session ended" and "you are not signed in" are
   * different facts, and the first one reassures somebody whose data is still on the device
   * that nothing has been lost.
   */
  /**
   * What replication is doing, when it is doing anything.
   *
   * Nothing at all when it is `idle`: the steady state is everything being fine, and a badge
   * that is always present says nothing when it matters. Same reasoning as the offline tag.
   */
  private renderSyncing(): TemplateResult | '' {
    if (this.syncing === undefined || this.syncing === 'idle') return ''

    return html`
      <wa-tag data-syncing variant="neutral" size="s">
        <wa-icon slot="start" name="arrows-rotate"></wa-icon>
        ${this.syncing === 'offline' ? msg('Waiting to sync') : msg('Syncing')}
      </wa-tag>
    `
  }

  private renderSession(): TemplateResult | '' {
    if (this.session === undefined) return ''

    if (this.session === 'signed-in') {
      return html`
        <wa-button data-sign-out appearance="plain" @click=${this.onSignOut}>
          ${msg('Sign out')}
        </wa-button>
      `
    }

    return html`
      <wa-button data-sign-in appearance="plain" @click=${this.onSignIn}>
        ${this.session === 'expired' ? msg('Session ended - sign in again') : msg('Sign in')}
      </wa-button>
    `
  }

  /**
   * Starts replicating this account's projects, and follows the profile's locale.
   *
   * Both are deliberately fire-and-forget. Every view works from the local database, so holding
   * the interface back on either would delay everything to improve something that is already
   * correct - which is the same trade the locale and the scheme make at startup.
   *
   * A failure to list projects is not reported. There is nothing the reader can do about it and
   * nothing they lose by it: their devices are on this device, and replication resuming later is
   * what `offline` in the summary is for.
   */
  private async startSyncing(): Promise<void> {
    void (this.followLocale ?? followProfileLocale)((locale) => {
      void activateLocale(negotiateLocale(locale as never, navigator.languages))
    })

    let mine: readonly ReplicatingProject[]
    try {
      mine = await (this.listProjects ?? (() => projects().list()))()
    } catch {
      return
    }
    if (mine.length === 0) return

    this.sync = (this.makeSync ?? ((onState) => projectSync(onState)))((projectId, state) => {
      this.states.set(projectId, state)
      this.syncing = worstOf([...this.states.values()])
    })
    this.sync.set(mine.map((project) => ({ projectId: project.projectId, dbName: project.dbName })))
  }

  /** One replication per project, and what each is doing. */
  private sync: SyncManager | undefined
  private states = new Map<string, SyncState>()

  private onSignIn = (): void => {
    ;(this.signIn ?? beginSignIn)()
  }

  private onSignOut = async (): Promise<void> => {
    // The state is set whatever happened, because `signOut` never throws and always leaves the
    // browser signed out: it forgets the token first, unconditionally, and every later step is
    // attempted regardless of the ones before it. Leaving the button saying "Sign out" after
    // that would be the interface disagreeing with itself.
    // Before the sign-out, not after. Replication holds an access token and a live connection
    // to a database this browser is about to be told it may not read; leaving it running would
    // mean requests going out on behalf of somebody who has just left.
    this.sync?.stopAll()
    this.sync = undefined
    this.states.clear()
    this.syncing = undefined

    await (this.signOutOf ?? endSession)()
    this.session = 'signed-out'
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
          <div class="wa-cluster wa-gap-s">
            <!-- Unobtrusive on purpose. Nothing in this application is blocked by being
                 offline: every write goes to a local database first, so this explains a delay
                 in sharing rather than a loss of function. A banner would overstate it. -->
            ${
              this.online
                ? ''
                : html`<wa-tag data-offline variant="neutral" size="s">
                    <wa-icon slot="start" name="plug-circle-xmark"></wa-icon>
                    ${msg('Offline')}
                  </wa-tag>`
            }
            ${this.renderSyncing()}
            ${this.renderSession()}
            <wa-button data-scheme-toggle appearance="plain" @click=${this.cycleScheme}>
              <wa-icon name=${SCHEME_ICON[this.schemePreference]} label=${this.schemeToggleLabel()}></wa-icon>
            </wa-button>
          </div>
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

        <main class="wa-stack wa-gap-m app-main">
          <!-- Offered, never applied by itself. Reloading out from under someone mid-form is
               how an update becomes something that happened to them. -->
          ${
            this.updateReady === undefined
              ? ''
              : html`
                  <wa-callout variant="brand" data-update-available>
                    <wa-icon slot="icon" name="arrows-rotate"></wa-icon>
                    <div class="wa-split wa-gap-m">
                      <span>${msg('A new version of Matter Manager is ready.')}</span>
                      <wa-button data-take-update size="s" @click=${this.onTakeUpdate}>
                        ${msg('Reload')}
                      </wa-button>
                    </div>
                  </wa-callout>
                `
          }
          ${view && match ? view(match.params) : html`<not-found-view></not-found-view>`}
        </main>
      </wa-page>
    `
  }
}

customElements.define('app-shell', AppShell)

/**
 * The state worth reporting when several replications disagree.
 *
 * Worst wins. A summary saying `idle` while one project cannot reach the server would be
 * reassuring and wrong, and the reader's question is "is everything through?" rather than "is
 * anything through?".
 */
function worstOf(states: readonly SyncState[]): SyncState | undefined {
  const order: readonly SyncState[] = ['offline', 'stopped', 'active', 'idle']
  return order.find((state) => states.includes(state))
}
