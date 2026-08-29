import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { beforeAll, describe, expect, it } from 'vitest'
import { BUNDLED_ICONS, useBundledIcons } from '../../src/icons/library.js'

/**
 * #106: every `<wa-icon>` fetched its SVG from `ka-f.fontawesome.com` the first time it
 * rendered, so an offline application had no icons at all.
 *
 * The static check (`scripts/check-offline-assets.mjs`) cannot make the whole claim on its own.
 * Web Awesome's bundle contains Font Awesome's CDN template whether or not the library is
 * overridden, so that origin has to sit in the check's allowlist — and an allowlist entry is a
 * promise. This file is the proof behind it.
 */

beforeAll(() => {
  useBundledIcons()
})

/**
 * Icon names chosen at run time, which no scan of the templates can find.
 *
 * Each is a value in a lookup rather than a literal in markup: the colour-scheme toggle in
 * `app-shell.ts`, the navigation entries in `router/routes.ts`, and the enable/disable button in
 * `views/device.ts`. They are the ones most likely to be missed when icons are bundled, because
 * grepping for `name="` finds every other icon in the application and none of these.
 */
const RUNTIME_CHOSEN = [
  'sun',
  'moon',
  'circle-half-stroke',
  'lightbulb',
  'gear',
  'play',
  'pause',
] as const

/** Every source file, as text, so the templates can be searched for icon names. */
const SOURCES = import.meta.glob('../../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Readonly<Record<string, string>>

/** Icon names written as literals in a template, with the file each came from. */
const literalIcons = (): ReadonlyArray<readonly [string, string]> => {
  const found: Array<readonly [string, string]> = []
  for (const [path, source] of Object.entries(SOURCES)) {
    for (const match of source.matchAll(/<wa-icon[^>]*?\sname="([a-z0-9-]+)"/g)) {
      const name = match[1]
      // Unreachable: the group is not optional. Written out rather than asserted away, because
      // `noUncheckedIndexedAccess` is on for a reason and a `!` here would be the one place it
      // is switched off.
      if (name === undefined) continue
      found.push([name, path.replace('../../', '')])
    }
  }
  return found
}

describe('every icon the application can draw is bundled', () => {
  it('finds icon names in the templates at all', () => {
    // A positive control. Without it, a regex that stopped matching would make every
    // assertion below vacuously true, which is the way this kind of test usually rots.
    expect(literalIcons().length).toBeGreaterThan(10)
  })

  it.each(literalIcons())('bundles %s, used in %s', (name) => {
    expect(BUNDLED_ICONS.has(name)).toBe(true)
  })

  it.each(RUNTIME_CHOSEN)('bundles %s, which is chosen at run time', (name) => {
    expect(BUNDLED_ICONS.has(name)).toBe(true)
  })
})

describe('no icon is fetched from another origin', () => {
  it('resolves every bundled icon to this origin or to the page itself', async () => {
    const icon = (await fixture(html`<wa-icon name="bars"></wa-icon>`)) as HTMLElement & {
      library: string
    }
    // Reaching through the element rather than calling the resolver directly: what matters is
    // the library `<wa-icon>` actually consults, and registering under an existing name is the
    // part that could silently fail.
    const { getIconLibrary } = await import(
      '@awesome.me/webawesome-pro/dist/components/icon/library.js'
    )
    const resolver = getIconLibrary('default')?.resolver
    expect(resolver).toBeDefined()

    for (const name of BUNDLED_ICONS) {
      const url = String(await resolver?.(name, 'classic', 'solid', false))
      // Vite inlines an asset below its size limit, so most of these are `data:` URLs and the
      // rest are same-origin paths. Both are requests that never leave the page; an
      // `https://` anywhere here is the bug this test exists for.
      expect(
        url.startsWith('data:') || url.startsWith('/') || url.startsWith(location.origin),
        name,
      ).toBe(true)
    }
    expect(icon).toBeDefined()
  })

  it('draws an icon rather than silently resolving to nothing', async () => {
    const icon = (await fixture(html`<wa-icon name="bars"></wa-icon>`)) as HTMLElement
    // Absence would also be what a broken resolver produced, which is how #132's two missing
    // icons went unnoticed for as long as they did.
    await waitUntil(() => icon.shadowRoot?.querySelector('svg') != null, 'no svg was drawn')
    expect(icon.shadowRoot?.querySelector('svg')).not.toBeNull()
  })
})
