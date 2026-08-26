import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement } from 'lit'
import {
  isLocalePreference,
  LOCALE_NAMES,
  type LocalePreference,
  negotiateLocale,
  readLocalePreference,
  SUPPORTED_LOCALES,
  writeLocalePreference,
} from '../i18n/locale.js'
import { activateLocale } from '../i18n/localization.js'

/**
 * Application settings. One control for now — the language.
 *
 * The colour scheme deliberately stays in the header where M2-2 put it, and theme and palette
 * selection remains issue #70. This view exists because a preference needs somewhere to live,
 * not as a bucket for every future toggle.
 */
export class SettingsView extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    preference: { state: true },
  }

  declare preference: LocalePreference

  constructor() {
    super()
    // Without this the view keeps its English labels after the user picks German - from the
    // very control that did the picking.
    updateWhenLocaleChanges(this)
    this.preference = readLocalePreference(() => localStorage)
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
      </div>
    `
  }
}

customElements.define('settings-view', SettingsView)
