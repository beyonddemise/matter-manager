import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/combobox/combobox.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import { DRAFT_PROBLEMS } from '@matter-manager/core'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activateLocale } from '../../src/i18n/localization.js'
import { problemMessage } from '../../src/i18n/problems.js'
import type { AddDeviceView } from '../../src/views/add-device.js'
import '../../src/views/add-device.js'
import '../../src/views/scan-dialog.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'

/**
 * #75: with the interface in German, an unusable setup code showed an English paragraph in the
 * callout and in the field hint, surrounded by German labels. The sentence came from
 * `packages/core`, which holds no `msg()` and no locale by design.
 *
 * These tests are about the *sentence the user reads*, so they go through the rendered form
 * rather than through `problemMessage` alone — a mapping that is never called translates
 * nothing.
 */

/** The English `core` sentence for a setup code that is neither form. Must not reach a screen. */
const ENGLISH = 'A setup code is either a Matter payload'

let database: TestDatabase

beforeEach(async () => {
  database = browserDatabase()
  await activateLocale('de')
})

afterEach(async () => {
  await activateLocale('en')
  await database.destroy()
})

/** The form, wired to a database of its own. */
async function form(): Promise<AddDeviceView> {
  const element = (await fixture(
    html`<add-device-view .repositories=${database.repositories}></add-device-view>`,
  )) as AddDeviceView
  await element.updateComplete
  return element
}

/** Types a setup code and submits, then waits for the callout. */
async function submitCredential(element: AddDeviceView, credential: string): Promise<void> {
  const set = (selector: string, value: string): void => {
    const control = element.querySelector(selector) as { value?: string } | null
    if (control) control.value = value
  }
  set('[data-field="credential"]', credential)
  set('[data-field="name"]', 'Deckenlampe')
  set('[data-field="room"]', 'Erdgeschoss/Küche')
  set('[data-field="installed-at"]', '2026-08-30')
  element.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))
  await waitUntil(() => element.querySelector('[data-error]') !== null)
  await element.updateComplete
}

describe('a rejected setup code speaks the interface language', () => {
  it('does not put the English sentence in the callout', async () => {
    const element = await form()
    await submitCredential(element, 'Küchenlampe')
    const callout = element.querySelector('[data-error]') as HTMLElement
    expect(callout.textContent).not.toContain(ENGLISH)
  })

  it('says in German that this is neither a payload nor a pairing code', async () => {
    const element = await form()
    await submitCredential(element, 'Küchenlampe')
    const callout = element.querySelector('[data-error]') as HTMLElement
    expect(callout.textContent).toContain('Kopplungscode')
  })

  it('puts the same German sentence beside the control that caused it', async () => {
    const element = await form()
    await submitCredential(element, 'Küchenlampe')
    const field = element.querySelector('[data-field="credential"]') as { hint?: string }
    // Scoped to the control's own hint, not the whole subtree: the callout above carries the
    // same words, so a `textContent` search would pass whatever the hint said (L29).
    expect(field.hint).toContain('Kopplungscode')
  })

  it('tells an empty field apart from an unreadable one', async () => {
    const element = await form()
    await submitCredential(element, '   ')
    const callout = element.querySelector('[data-error]') as HTMLElement
    expect(callout.textContent).not.toContain(ENGLISH)
    expect(callout.textContent?.trim()).not.toBe('')
  })
})

describe('every problem code has something to say', () => {
  it('maps each code to a non-empty sentence', () => {
    for (const problem of DRAFT_PROBLEMS) {
      expect(problemMessage(problem), problem).not.toBe('')
    }
  })

  it('never echoes anything that could carry a passcode', () => {
    // The sentences are static by construction, which is what makes this true — but it is the
    // constraint #75 must not break, so it is asserted rather than assumed.
    for (const problem of DRAFT_PROBLEMS) {
      expect(problemMessage(problem)).not.toMatch(/\d{6,}/)
    }
  })
})

describe('the combobox names its own control in German too', () => {
  /**
   * The "Related, smaller" half of #75. `<wa-combobox allow-create>` renders its own
   * `Create "…"` label, which is Web Awesome's string rather than one of ours — so `msg()`
   * cannot reach it and `check:i18n` cannot see it.
   *
   * Web Awesome ships a German catalogue containing `createOption`, and resolves the language
   * from `lang`, which `activateLocale` already sets. The only thing missing was registering
   * the catalogue, which nothing did.
   */
  it('offers to create a room in German', async () => {
    const element = await form()
    const combobox = element.querySelector('[data-field="room"]') as HTMLElement & {
      inputValue: string
      updateComplete: Promise<unknown>
    }
    // Typed through the component's own input rather than by assigning `inputValue`: the
    // synthetic "create" option is built while filtering, which only runs on real input.
    const input = combobox.shadowRoot?.querySelector('input') as HTMLInputElement
    input.value = 'Küche'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }))
    await combobox.updateComplete
    const create = combobox.querySelector('[data-create-option]')
    expect(create?.textContent).toContain('erstellen')
  })
})
