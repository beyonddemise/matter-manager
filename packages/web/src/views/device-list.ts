import { msg } from '@lit/localize'
import { html, LitElement } from 'lit'

/** The device list. M2-6 replaces the body; the shell does not change when it does. */
export class DeviceListView extends LitElement {
  // Light DOM: Web Awesome's utility classes are global CSS and do not cross a shadow
  // boundary. `static styles` is not used for the same reason — Lit only adopts it into
  // shadow roots. App CSS lives in styles/app.css.
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  override render() {
    return html`
      <div class="wa-stack wa-gap-l">
        <h1>${msg('Devices')}</h1>
        <p class="app-empty">${msg('No devices yet.')}</p>
      </div>
    `
  }
}

customElements.define('device-list-view', DeviceListView)
