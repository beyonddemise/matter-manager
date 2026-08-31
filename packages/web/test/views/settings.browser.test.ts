import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import '@awesome.me/webawesome-pro/dist/components/radio/radio.js'
import '@awesome.me/webawesome-pro/dist/components/radio-group/radio-group.js'
import '@awesome.me/webawesome-pro/dist/components/select/select.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, describe, expect, it } from 'vitest'
import { localCatalogue } from '../../src/db/project-database.js'
import { activateLocale } from '../../src/i18n/localization.js'
import type { StorageManagerLike } from '../../src/storage.js'
import {
  DEFAULT_PALETTE,
  DEFAULT_THEME,
  EXCLUDED_THEMES,
  PALETTES,
  THEME_STORAGE_KEY,
  THEMES,
} from '../../src/theme.js'
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

/** What `index.html` ships, so a test that changes the look puts it back. */
const ORIGINAL_LOOK = document.documentElement.className

afterEach(async () => {
  await activateLocale('en')
  // The look is applied to the real document element, not to the fixture, because that is where
  // it belongs in the application. Leaving it changed would make the next test's starting state
  // depend on which tests ran before it.
  document.documentElement.className = ORIGINAL_LOOK
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

describe('choosing a theme and a palette', () => {
  it('offers every theme that passes the contrast measurement', async () => {
    const element = await settings(stub({ persisted: true }))
    const offered = [...element.querySelectorAll('[data-field="theme"] wa-option')].map((option) =>
      option.getAttribute('value'),
    )
    expect(offered).toEqual([...THEMES])
  })

  it('offers none of the themes withheld for contrast', async () => {
    const element = await settings(stub({ persisted: true }))
    const offered = [...element.querySelectorAll('[data-field="theme"] wa-option')].map((option) =>
      option.getAttribute('value'),
    )
    for (const withheld of Object.keys(EXCLUDED_THEMES)) {
      expect(offered, withheld).not.toContain(withheld)
    }
  })

  it('offers every palette', async () => {
    const element = await settings(stub({ persisted: true }))
    const offered = [...element.querySelectorAll('[data-field="palette"] wa-option')].map(
      (option) => option.getAttribute('value'),
    )
    expect(offered).toEqual([...PALETTES])
  })

  it('shows the look currently in force', async () => {
    localStorage.removeItem(THEME_STORAGE_KEY)
    const element = await settings(stub({ persisted: true }))
    const theme = element.querySelector('[data-field="theme"]') as { value?: string }
    const palette = element.querySelector('[data-field="palette"]') as { value?: string }
    expect(theme.value).toBe(DEFAULT_THEME)
    expect(palette.value).toBe(DEFAULT_PALETTE)
  })
})

describe('two look changes in quick succession', () => {
  it('leaves the one the user asked for last, not the one that arrived last', async () => {
    // The stale-load race. Two changes are two loads in flight, and the first asked for is not
    // necessarily the first to arrive - a cached stylesheet resolves in a microtask while one
    // being fetched does not. Arranged deterministically here by holding the first load open
    // until after the second has finished.
    const pending: Array<() => void> = []
    const element = (await fixture(
      html`<settings-view
        .storageManager=${stub({ persisted: true })}
        .lookLoader=${() => new Promise<void>((resolve) => pending.push(resolve))}
      ></settings-view>`,
    )) as SettingsView
    await element.updateComplete

    const select = element.querySelector('[data-field="theme"]') as HTMLElement & { value: string }
    select.value = 'mellow'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    select.value = 'premium'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    // The second load lands first, then the first - the order the guard exists for.
    pending[1]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    pending[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await element.updateComplete

    expect(element.theme).toBe('premium')
    expect(document.documentElement.classList.contains('wa-theme-premium')).toBe(true)
    expect(document.documentElement.classList.contains('wa-theme-mellow')).toBe(false)
  })
})

describe('moving the catalogue on this device into a project', () => {
  /** Settings, with the project list and the move itself injected. */
  const withMove = async (over: Record<string, unknown>) => {
    const element = (await fixture(html`
      <settings-view
        .storageManager=${stub({ persisted: true })}
        .listProjects=${over.listProjects ?? (async () => [])}
        .moveLocal=${over.moveLocal ?? (async () => ({ devicesMoved: 0, localCleared: true }))}
      ></settings-view>
    `)) as SettingsView
    await element.updateComplete
    await new Promise((resolve) => setTimeout(resolve, 40))
    await element.updateComplete
    return element
  }

  const serverProject = (over: Record<string, unknown> = {}) => ({
    projectId: 'p1',
    dbName: 'project_p1',
    name: 'Musterstraße 12',
    role: 'owner',
    archived: false,
    ...over,
  })

  /** Puts one device in the catalogue on this device, and takes it out again afterwards. */
  const withALocalDevice = async (body: () => Promise<void>) => {
    const local = localCatalogue()
    await local.devices.save({
      _id: 'device:local-one',
      type: 'device',
      name: 'Hall light',
      roomId: 'room:hall',
      manualCode: '34970112332',
      installedAt: '2026-08-31',
      addedAt: '2026-08-31T09:00:00.000Z',
      disabled: false,
      remarks: [],
    })
    try {
      await body()
    } finally {
      for (const device of await local.devices.list()) await local.devices.remove(device)
    }
  }

  it('offers the move when there is something to move and somewhere to put it', async () => {
    // The positive control. Every assertion below is an absence, and all of them would pass
    // against a section that never rendered at all.
    await withALocalDevice(async () => {
      const element = await withMove({ listProjects: async () => [serverProject()] })
      expect(element.querySelector('[data-move-local]')).not.toBeNull()
    })
  })

  it('moves them into the project that was chosen', async () => {
    await withALocalDevice(async () => {
      let movedInto: string | undefined
      const element = await withMove({
        listProjects: async () => [serverProject()],
        moveLocal: async (dbName: string) => {
          movedInto = dbName
          return { devicesMoved: 1, localCleared: true }
        },
      })
      ;(element.querySelector('[data-move]') as HTMLElement).click()
      await waitUntil(() => element.querySelector('[data-move-done]') !== null, 'no result')

      expect(movedInto).toBe('project_p1')
    })
  })

  it('says plainly when nothing moved', async () => {
    // A failed move leaves the local catalogue untouched, so the honest report is that nothing
    // happened - not an error the reader is expected to do something about.
    await withALocalDevice(async () => {
      const element = await withMove({
        listProjects: async () => [serverProject()],
        moveLocal: async () => {
          throw new Error('storage refused')
        },
      })
      ;(element.querySelector('[data-move]') as HTMLElement).click()
      await waitUntil(() => element.querySelector('[data-move-done]') !== null, 'no result')

      expect(element.querySelector('[data-move-done]')?.textContent).toContain(
        'still on this device',
      )
    })
  })

  it('says nothing when the local catalogue is empty', async () => {
    // Not an error, so not reported. There is simply nothing to offer.
    const element = await withMove({ listProjects: async () => [serverProject()] })
    expect(element.querySelector('[data-move-local]')).toBeNull()
  })

  it('says nothing when there is nowhere to move it to', async () => {
    // An account with no writable project has nowhere to put it, which is also not an error.
    const element = await withMove({ listProjects: async () => [] })
    expect(element.querySelector('[data-move-local]')).toBeNull()
  })

  it('does not offer a project the reader may only read', async () => {
    // Moving devices into a project you cannot write to would fail at the first save, after
    // telling the reader it was possible.
    const element = await withMove({ listProjects: async () => [serverProject({ role: 'read' })] })
    expect(element.querySelector('[data-move-local]')).toBeNull()
  })

  it('does not offer an archived project', async () => {
    const element = await withMove({
      listProjects: async () => [serverProject({ archived: true })],
    })
    expect(element.querySelector('[data-move-local]')).toBeNull()
  })
})
