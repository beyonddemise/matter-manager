import '@awesome.me/webawesome-pro/dist/components/radio/radio.js'
import '@awesome.me/webawesome-pro/dist/components/radio-group/radio-group.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, describe, expect, it } from 'vitest'
import { activateLocale } from '../../src/i18n/localization.js'
import type { StorageManagerLike } from '../../src/storage.js'
import type { SettingsView } from '../../src/views/settings.js'
import '../../src/views/settings.js'

/**
 * #112 asked for `persisted()` to be surfaced "somewhere the user can see", because the answer
 * differs per browser and per device and nothing else reveals it.
 *
 * Every case is driven through a stubbed storage manager. A browser refuses when it decides to,
 * and no test can make that decision go a particular way — yet refusal is what most users on most
 * engines will see, so the state that matters most is the one only a stub can produce on demand.
 */

const stub = (answers: {
  persisted: boolean
  estimate?: { usage?: number; quota?: number }
}): (() => StorageManagerLike) => {
  const manager = {
    persisted: async () => answers.persisted,
    persist: async () => answers.persisted,
    estimate: async () => answers.estimate ?? {},
  }
  return () => manager
}

/** The settings view, with the storage standing it should report. */
async function settings(
  storageManager: (() => StorageManagerLike | undefined) | undefined,
): Promise<SettingsView> {
  const element = (await fixture(
    html`<settings-view .storageManager=${storageManager}></settings-view>`,
  )) as SettingsView
  await waitUntil(() => element.querySelector('[data-storage]') !== null, 'no storage section')
  await element.updateComplete
  return element
}

afterEach(async () => {
  await activateLocale('en')
})

describe('what the user is told about storage on this device', () => {
  it('says the browser agreed, when it did', async () => {
    const element = await settings(stub({ persisted: true }))
    const said = element.querySelector('[data-storage-persistence]')?.textContent ?? ''
    expect(said).toContain('agreed to keep')
  })

  it('does not present the ordinary case as a fault', async () => {
    // Most users on most browsers are here. It has to read as a statement of fact rather than
    // as an error, and it must not be dressed as a warning the user cannot act on.
    const element = await settings(stub({ persisted: false }))
    const section = element.querySelector('[data-storage]')
    const said = element.querySelector('[data-storage-persistence]')?.textContent ?? ''
    expect(said).toContain('has not promised')
    expect(section?.querySelector('wa-callout[variant="danger"]')).toBeNull()
  })

  it('names the one thing the user can actually do about it', async () => {
    // A status with no remedy is just an anxiety. Installing is what every engine weighs.
    const element = await settings(stub({ persisted: false }))
    const said = element.querySelector('[data-storage-persistence]')?.textContent ?? ''
    expect(said).toMatch(/install/i)
  })

  it('says the browser never answered, where there is no Storage API', async () => {
    const element = await settings(() => undefined)
    const said = element.querySelector('[data-storage-persistence]')?.textContent ?? ''
    expect(said).toContain('does not say')
  })

  it('shows what is stored when the browser will estimate', async () => {
    const element = await settings(
      stub({ persisted: true, estimate: { usage: 2_000_000, quota: 8_000_000 } }),
    )
    const used = element.querySelector('[data-storage-usage]')?.textContent ?? ''
    expect(used).toContain('2')
    expect(used).toContain('8')
  })

  it('shows no figures when the browser withheld them', async () => {
    // Rendering "0 MB" for "the browser did not say" would be inventing a measurement.
    const element = await settings(stub({ persisted: true, estimate: {} }))
    expect(element.querySelector('[data-storage-usage]')).toBeNull()
  })

  it('reads the standing without ever asking for it', async () => {
    // A status display that could raise a permission dialogue would be a surprise in the one
    // place somebody went to avoid one.
    let asked = false
    const manager: StorageManagerLike = {
      persisted: async () => false,
      persist: async () => {
        asked = true
        return true
      },
      estimate: async () => ({}),
    }
    await settings(() => manager)
    expect(asked).toBe(false)
  })

  it('says it in German when the interface is German', async () => {
    await activateLocale('de')
    const element = await settings(stub({ persisted: false }))
    const said = element.querySelector('[data-storage-persistence]')?.textContent ?? ''
    expect(said).toContain('Browser')
    expect(said).not.toContain('has not promised')
  })
})
