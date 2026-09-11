import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement } from 'lit'

/** Shown when no route matched. Offers a way back, per the story's second scenario. */
export class NotFoundView extends LitElement {
  constructor() {
    super()
    // Subscribes this component to locale changes; without it the view keeps rendering the
    // strings that were active when it first rendered.
    updateWhenLocaleChanges(this)
  }

  protected override createRenderRoot(): HTMLElement {
    return this
  }

  override render() {
    return html`
      <div class="wa-stack wa-gap-m">
        <h1>${msg('Page not found')}</h1>
        <p>${msg('That address does not match anything in this application.')}</p>
        <a class="app-back" href="#/">${msg('Back to devices')}</a>
      </div>
    `
  }
}

customElements.define('not-found-view', NotFoundView)
