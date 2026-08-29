import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, type TemplateResult } from 'lit'
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
import { readStorageReport, type StorageManagerLike, type StorageReport } from '../storage.js'

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
    preference: { state: true },
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

  declare preference: LocalePreference
  /** Undefined until the first read resolves; the section renders nothing until then. */
  declare storage: StorageReport | undefined

  constructor() {
    super()
    // Without this the view keeps its English labels after the user picks German - from the
    // very control that did the picking.
    updateWhenLocaleChanges(this)
    this.preference = readLocalePreference(() => localStorage)
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
        ${this.renderStorage()}
      </div>
    `
  }
}

customElements.define('settings-view', SettingsView)
