import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, type TemplateResult } from 'lit'
import { projects } from '../composition.js'
import { localCatalogue, openProject } from '../db/project-database.js'
import {
  isLocalePreference,
  LOCALE_NAMES,
  type LocalePreference,
  negotiateLocale,
  readLocalePreference,
  SUPPORTED_LOCALES,
  writeLocalePreference,
} from '../i18n/locale.js'
import { activateLocale, getLocale } from '../i18n/localization.js'
import { migrateLocalCatalogue } from '../migrate-local.js'
import { readStorageReport, type StorageManagerLike, type StorageReport } from '../storage.js'
import {
  loadAndApplyLook,
  PALETTES,
  type Palette,
  readPalettePreference,
  readThemePreference,
  THEMES,
  type Theme,
  writePalettePreference,
  writeThemePreference,
} from '../theme.js'

/**
 * Application settings: the language, and what the browser has promised about this data.
 *
 * The colour scheme deliberately stays in the header where M2-2 put it, and theme and palette
 * selection remains issue #70. This view exists because a preference needs somewhere to live,
 * not as a bucket for every future toggle.
 *
 * The storage section is not a preference and has no control. It is here because the answer to
 * "is my data safe on this device" differs per browser and per device, nothing else reveals it,
 * and for an offline-first application it is a question with a real answer (#112).
 */
export class SettingsView extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    storageManager: { attribute: false },
    lookLoader: { attribute: false },
    listProjects: { attribute: false },
    moveLocal: { attribute: false },
    localCount: { state: true },
    movable: { state: true },
    moving: { state: true },
    moved: { state: true },
    preference: { state: true },
    theme: { state: true },
    palette: { state: true },
    storage: { state: true },
  }

  /**
   * Where the storage standing is read from.
   *
   * Bound by a test to a stub; left unset in the application, where it falls back to
   * `navigator.storage`. A browser refuses persistence when it decides to, and no test can make
   * that decision go a particular way - yet refusal is the state most users on most engines are
   * in, so the common case is only reachable through something injectable. Same reasoning as
   * `repositories` on the device forms.
   */
  declare storageManager?: () => StorageManagerLike | undefined

  /**
   * How a theme's and palette's stylesheets are fetched.
   *
   * Bound by a test, unset in the application. Injectable for one reason: the guard against a
   * stale load applying its classes last is only reachable when two loads overlap *and* the
   * older one resolves second, and nothing about a real `import()` lets a test arrange that.
   * A guard with no test that can fail is a guard nobody will notice removing.
   */
  declare lookLoader?: (theme: Theme, palette: Palette) => Promise<unknown>

  /** Injected by tests; unset in the application, where these reach the real API and databases. */
  declare listProjects?: () => Promise<
    readonly {
      projectId: string
      dbName: string
      name: string
      role: string
      archived: boolean
    }[]
  >
  declare moveLocal?: (dbName: string) => Promise<{ devicesMoved: number; localCleared: boolean }>

  /** How many devices are in the catalogue on this device. Zero means nothing to move. */
  declare localCount: number
  /** Projects this account may write to, which are the ones worth offering as a destination. */
  declare movable: readonly { projectId: string; dbName: string; name: string }[]
  declare moving: boolean
  declare moved: { devicesMoved: number; localCleared: boolean } | undefined

  declare preference: LocalePreference
  declare theme: Theme
  declare palette: Palette

  /** Undefined until the first read resolves; the section renders nothing until then. */
  declare storage: StorageReport | undefined

  constructor() {
    super()
    // Without this the view keeps its English labels after the user picks German - from the
    // very control that did the picking.
    updateWhenLocaleChanges(this)
    this.preference = readLocalePreference(() => localStorage)
    this.theme = readThemePreference(() => localStorage)
    this.palette = readPalettePreference(() => localStorage)
    this.localCount = 0
    this.movable = []
    this.moving = false
  }

  /**
   * Applies a chosen look, loading its stylesheet first.
   *
   * The order matters and is the whole subtlety here: swapping the class before the stylesheet
   * has arrived leaves the document naming a theme nothing defines, which renders as Web
   * Awesome's bare defaults for as long as the fetch takes - a flash of an unstyled application
   * on the one screen where somebody is looking at how it is styled.
   */
  private async changeLook(theme: Theme, palette: Palette): Promise<void> {
    // Set before the await, so the picker shows what was chosen at once rather than after a
    // stylesheet arrives. The shared theme-level guard ensures the last look requested is also
    // the one applied, including when the startup load is still pending.
    this.theme = theme
    this.palette = palette

    await loadAndApplyLook(document.documentElement, theme, palette, this.lookLoader)
  }

  private async onThemeChange(event: Event): Promise<void> {
    const value = (event.target as { value?: unknown }).value
    // Read defensively: the value arrives from a DOM property rather than from our own code, so
    // anything unrecognised is ignored rather than stored and applied.
    if (typeof value !== 'string' || !(THEMES as readonly string[]).includes(value)) return
    writeThemePreference(() => localStorage, value as Theme)
    await this.changeLook(value as Theme, this.palette)
  }

  private async onPaletteChange(event: Event): Promise<void> {
    const value = (event.target as { value?: unknown }).value
    if (typeof value !== 'string' || !(PALETTES as readonly string[]).includes(value)) return
    writePalettePreference(() => localStorage, value as Palette)
    await this.changeLook(this.theme, value as Palette)
  }

  /**
   * The theme and palette pickers.
   *
   * Names are not translated. They are Web Awesome's own product names for its themes and
   * palettes, in the same category as the language names in `LOCALE_NAMES` - translating
   * "glossy" to "glänzend" would name something the documentation does not.
   */
  private renderLook(): TemplateResult {
    return html`
      <wa-select
        data-field="theme"
        label=${msg('Theme')}
        hint=${msg('Only combinations that meet the AA contrast standard are offered.')}
        value=${this.theme}
        @change=${this.onThemeChange}
      >
        ${THEMES.map((theme) => html`<wa-option value=${theme}>${theme}</wa-option>`)}
      </wa-select>

      <wa-select
        data-field="palette"
        label=${msg('Palette')}
        value=${this.palette}
        @change=${this.onPaletteChange}
      >
        ${PALETTES.map((palette) => html`<wa-option value=${palette}>${palette}</wa-option>`)}
      </wa-select>
    `
  }

  override connectedCallback(): void {
    super.connectedCallback()
    // Read on every visit rather than cached: persistence can be granted after the fact - a
    // Chromium user who engages more with the site, or a Firefox user who answers the prompt
    // late - and a figure from the last visit would be quietly wrong.
    //
    // `readStorageReport` prompts nothing and never rejects, so there is nothing to handle.
    void readStorageReport(this.storageManager ?? (() => navigator.storage)).then((report) => {
      this.storage = report
    })

    void this.readMovable()
  }

  /**
   * Whether there is anything to move, and anywhere to move it.
   *
   * Both halves are needed before the offer is worth making: an empty local catalogue has
   * nothing to move, and an account with no writable project has nowhere to put it. Neither is
   * an error, so neither is reported - the section simply is not there.
   */
  private async readMovable(): Promise<void> {
    try {
      this.localCount = (await localCatalogue().devices.list()).length
    } catch {
      // An unreadable catalogue is not something to offer to move.
      this.localCount = 0
    }
    if (this.localCount === 0) return

    try {
      const all = await (this.listProjects ?? (() => projects().list()))()
      this.movable = all
        .filter((project) => !project.archived && project.role !== 'read')
        .map(({ projectId, dbName, name }) => ({ projectId, dbName, name }))
    } catch {
      // Offline, or signed out. Nowhere to move it to right now, which is not a failure.
      this.movable = []
    }
  }

  /**
   * Moves the catalogue on this device into the chosen project.
   *
   * Nothing is lost if this fails: `migrateLocalCatalogue` writes before it removes, so the
   * worst outcome is the devices existing in both places.
   */
  private async onMove(): Promise<void> {
    const select = this.querySelector('[data-move-target]') as { value?: unknown } | null
    const target = this.movable.find((project) => project.projectId === select?.value)
    if (target === undefined) return

    this.moving = true
    try {
      // The database chosen, not the one currently open. They are usually different: somebody
      // moving their local catalogue into a project is, by definition, looking at the local one.
      const move =
        this.moveLocal ??
        ((dbName: string) => migrateLocalCatalogue(localCatalogue(), openProject(dbName)))
      const moved = await move(target.dbName)
      this.moved =
        moved.localCleared && moved.devicesMoved === 0 && this.moved?.devicesMoved
          ? { ...moved, devicesMoved: this.moved.devicesMoved }
          : moved
      if (moved.localCleared) this.localCount = 0
    } catch {
      // Reported as nothing having moved rather than as an error the reader can act on: the
      // local catalogue is untouched, and trying again later is the whole remedy.
      this.moved = { devicesMoved: 0, localCleared: false }
    } finally {
      this.moving = false
    }
  }

  /** The offer to move the local catalogue, when there is one worth making. */
  private renderMove(): TemplateResult | '' {
    if (this.moved !== undefined && (this.moved.localCleared || this.moved.devicesMoved === 0)) {
      return html`
        <section class="wa-stack wa-gap-2xs" data-move-done>
          <h2>${msg('Devices on this device')}</h2>
          <p>
            ${
              this.moved.devicesMoved === 0
                ? msg('Nothing was moved. Everything is still on this device.')
                : msg('The devices were moved into the project.')
            }
          </p>
        </section>
      `
    }

    if (this.localCount === 0 || this.movable.length === 0) return ''

    return html`
      <section class="wa-stack wa-gap-2xs" data-move-local>
        <h2>${msg('Devices on this device')}</h2>
        <p>
          ${
            this.moved?.localCleared === false
              ? msg(
                  'The devices were moved into the project, but they are still on this device. Try again to finish removing them from this device.',
                  { id: 'migration-incomplete' },
                )
              : msg(
                  'These devices are stored only in this browser. Moving them into a project shares them with everyone who has access to it, and keeps them on your other devices.',
                )
          }
        </p>
        <wa-select data-move-target label=${msg('Move them into')} value=${this.movable[0]?.projectId ?? ''}>
          ${this.movable.map(
            (project) => html`<wa-option value=${project.projectId}>${project.name}</wa-option>`,
          )}
        </wa-select>
        <div>
          <wa-button data-move variant="brand" ?disabled=${this.moving} @click=${this.onMove}>
            ${msg('Move them')}
          </wa-button>
        </div>
      </section>
    `
  }

  /**
   * What the browser has promised, in a sentence rather than a status word.
   *
   * `best-effort` is the common case on most engines, so it must not read as a fault. It names
   * the one thing the user can actually do about it - installing the application, which every
   * engine weighs - rather than leaving them with a warning and no remedy.
   */
  private persistenceMessage(): string {
    switch (this.storage?.persistence) {
      case 'persisted':
        return msg(
          'This browser has agreed to keep your devices. They will not be removed unless you delete them.',
        )
      case 'best-effort':
        return msg(
          'This browser has not promised to keep your devices, and may remove them if it runs short of space. Installing this application to your home screen or desktop makes that much less likely.',
        )
      default:
        return msg('This browser does not say whether your devices are kept.')
    }
  }

  /** Bytes as the reader's locale writes them. Absent when the browser declined to estimate. */
  private spaceUsed(): string | undefined {
    const { usage, quota } = this.storage ?? {}
    if (usage === undefined) return undefined

    const megabytes = (bytes: number): string =>
      new Intl.NumberFormat(getLocale(), {
        style: 'unit',
        unit: 'megabyte',
        maximumFractionDigits: 1,
      }).format(bytes / 1_000_000)

    return quota === undefined ? megabytes(usage) : `${megabytes(usage)} / ${megabytes(quota)}`
  }

  /** The storage section, or nothing at all until the first read resolves. */
  private renderStorage(): TemplateResult | '' {
    if (this.storage === undefined) return ''

    const used = this.spaceUsed()
    return html`
      <section class="wa-stack wa-gap-2xs" data-storage>
        <h2>${msg('Storage on this device')}</h2>
        <p data-storage-persistence>${this.persistenceMessage()}</p>
        ${
          used === undefined
            ? ''
            : html`<p class="app-empty" data-storage-usage>${msg('Space used')}: ${used}</p>`
        }
      </section>
    `
  }

  /**
   * A radio group reports its new value on `change`. The value is read defensively because it
   * arrives from a DOM property rather than from our own code: anything unrecognised is
   * ignored rather than stored, so a stray event cannot leave an unloadable locale persisted.
   */
  private async onLanguageChange(event: Event): Promise<void> {
    const value = (event.target as { value?: unknown }).value
    if (!isLocalePreference(value)) return

    writeLocalePreference(() => localStorage, value)
    this.preference = value
    await activateLocale(negotiateLocale(value, navigator.languages))
  }

  override render() {
    return html`
      <div class="wa-stack wa-gap-l">
        <h1>${msg('Settings')}</h1>
        <wa-radio-group
          label=${msg('Language')}
          value=${this.preference}
          @change=${this.onLanguageChange}
        >
          <wa-radio value="auto">${msg('Automatic (browser language)')}</wa-radio>
          ${SUPPORTED_LOCALES.map(
            (locale) => html`<wa-radio value=${locale}>${LOCALE_NAMES[locale]}</wa-radio>`,
          )}
        </wa-radio-group>
        ${this.renderLook()}
        ${this.renderMove()}
        ${this.renderStorage()}
      </div>
    `
  }
}

customElements.define('settings-view', SettingsView)
