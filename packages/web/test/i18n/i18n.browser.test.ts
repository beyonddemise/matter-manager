import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/radio/radio.js'
import '@awesome.me/webawesome-pro/dist/components/radio-group/radio-group.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../../src/app-shell.js'
import { targetLocales } from '../../src/generated/locale-codes.js'
import { LOCALE_STORAGE_KEY, SOURCE_LOCALE } from '../../src/i18n/locale.js'
import { activateLocale, getLocale, LOCALE_LOADERS } from '../../src/i18n/localization.js'

interface Updatable {
  updateComplete?: Promise<unknown>
}

/** Builds the shell, awaiting the same two upgrade boundaries `app-shell.browser.test.ts` does. */
const shell = async (hash: string) => {
  window.location.hash = hash
  await Promise.all([
    customElements.whenDefined('wa-page'),
    customElements.whenDefined('wa-radio-group'),
  ])
  const element = await fixture(html`<app-shell></app-shell>`)
  await (element.querySelector('wa-page') as (HTMLElement & Updatable) | null)?.updateComplete
  return element
}

const originalLang = document.documentElement.lang

beforeEach(async () => {
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  await activateLocale(SOURCE_LOCALE)
})

afterEach(async () => {
  await activateLocale(SOURCE_LOCALE)
  document.documentElement.lang = originalLang
  window.location.hash = ''
  localStorage.removeItem(LOCALE_STORAGE_KEY)
})

describe('activating a locale', () => {
  it('loads the catalogue and reports the new locale', async () => {
    await activateLocale('de')
    expect(getLocale()).toBe('de')
  })

  it('tells the document what language it is in', async () => {
    // Not decoration: this is what a screen reader reads the page with, what the browser
    // hyphenates and spell-checks by, and what `:lang()` matches. index.html ships lang="en".
    await activateLocale('de')
    expect(document.documentElement.lang).toBe('de')

    await activateLocale('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('is safe to call again with the locale already active', async () => {
    await activateLocale('de')
    await expect(activateLocale('de')).resolves.toBeUndefined()
    expect(getLocale()).toBe('de')
  })

  it('bundles a loader for every target locale', () => {
    // A locale added to lit-localize.json but not to the loader map would configure fine and
    // then fail only when someone actually selected it.
    expect([...LOCALE_LOADERS].sort()).toEqual([...targetLocales].sort())
  })
})

describe('German reaches the screen', () => {
  it('translates the navigation and the view', async () => {
    const element = await shell('#/')
    expect(element.textContent).toContain('Devices')

    await activateLocale('de')
    await (element as HTMLElement & Updatable).updateComplete
    await (element.querySelector('device-list-view') as (HTMLElement & Updatable) | null)
      ?.updateComplete

    // The empty state only renders once the list has read the database, and it is that
    // sentence - a child component's own string - which this test is really about.
    const list = element.querySelector('device-list-view') as
      | (HTMLElement & { loaded?: boolean })
      | null
    await waitUntil(() => list?.loaded === true, 'the device list never finished its first read')
    await (list as (HTMLElement & Updatable) | null)?.updateComplete

    // Both at once: the navigation link is the shell's own template, the empty-state sentence
    // belongs to a child component with its own subscription. One passing while the other
    // fails is precisely the "a component forgot updateWhenLocaleChanges" bug.
    expect(element.textContent).toContain('Geräte')
    expect(element.textContent).toContain('Noch keine Geräte.')
    expect(element.textContent).not.toContain('No devices yet.')
  })

  it('translates the not-found view', async () => {
    await activateLocale('de')
    const element = await shell('#/nope')
    expect(element.textContent).toContain('Seite nicht gefunden')
  })

  it('translates an attribute, not only element text', async () => {
    // wa-icon's `label` is the accessible name of an icon-only button. An attribute that stops
    // being translated is invisible on screen and only wrong to a screen reader.
    const element = await shell('#/')
    await activateLocale('de')
    await (element as HTMLElement & Updatable).updateComplete

    const menuIcon = element.querySelector('[data-toggle-nav] wa-icon')
    expect(menuIcon?.getAttribute('label')).toBe('Menü')
  })
})

describe('the settings view', () => {
  const settings = async () => {
    const element = await shell('#/settings')
    const view = element.querySelector('settings-view') as (HTMLElement & Updatable) | null
    await view?.updateComplete
    return { element, view }
  }

  it('offers automatic plus every supported language', async () => {
    const { view } = await settings()
    const values = [...(view?.querySelectorAll('wa-radio') ?? [])].map((radio) =>
      radio.getAttribute('value'),
    )
    expect(values).toEqual(['auto', 'en', 'de'])
  })

  it('names each language in its own language', async () => {
    // A user who has landed in a language they cannot read must still find their own.
    const { view } = await settings()
    const labels = [...(view?.querySelectorAll('wa-radio') ?? [])].map((radio) =>
      radio.textContent?.trim(),
    )
    expect(labels).toContain('English')
    expect(labels).toContain('Deutsch')

    await activateLocale('de')
    await view?.updateComplete
    const afterSwitch = [...(view?.querySelectorAll('wa-radio') ?? [])].map((radio) =>
      radio.textContent?.trim(),
    )
    expect(afterSwitch).toContain('English')
    expect(afterSwitch).toContain('Deutsch')
  })

  it('shows the stored preference as the current value', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'de')
    const { view } = await settings()
    expect(view?.querySelector('wa-radio-group')?.getAttribute('value')).toBe('de')
  })

  it('switches language, persists the choice, and does not navigate', async () => {
    const { element, view } = await settings()
    const hashBefore = window.location.hash

    const group = view?.querySelector('wa-radio-group') as (HTMLElement & { value?: string }) | null
    if (group === null || group === undefined) throw new Error('no radio group rendered')
    group.value = 'de'
    group.dispatchEvent(new Event('change', { bubbles: true }))

    // The handler awaits a dynamically imported catalogue chunk, which is a real network
    // round trip in the dev server. Waiting a fixed number of turns of the event loop would be
    // a flake waiting to happen; waiting for the condition itself is both faster and stable.
    await waitUntil(() => getLocale() === 'de', 'the German catalogue never activated')
    await (element as HTMLElement & Updatable).updateComplete
    await view?.updateComplete

    expect(getLocale()).toBe('de')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('de')
    expect(view?.textContent).toContain('Einstellungen')
    expect(window.location.hash).toBe(hashBefore)
  })

  it('ignores a change event carrying a value it does not recognise', async () => {
    const { view } = await settings()
    const group = view?.querySelector('wa-radio-group') as (HTMLElement & { value?: string }) | null
    if (group === null || group === undefined) throw new Error('no radio group rendered')

    group.value = 'klingon'
    group.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The storage assertion is the load-bearing one and it is not timing-dependent: the
    // handler writes before its first `await`, so had the guard let this through, the value
    // would already be there by the time the event dispatch returned.
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull()
    expect(getLocale()).toBe(SOURCE_LOCALE)
  })
})
