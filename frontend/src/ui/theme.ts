/**
 * The theme and palette preferences.
 *
 * M2-2 fixed the look at `wa-theme-glossy wa-palette-anodized` and made only the light/dark
 * scheme the user's. This makes the other two axes theirs as well (#70).
 *
 * The whole look is two class names on `<html>`, beside the scheme class `scheme.ts` sets:
 *
 * ```html
 * <html class="wa-theme-glossy wa-palette-anodized wa-light">
 * ```
 *
 * Every Web Awesome component reads the same `--wa-*` tokens, so switching is a class swap plus
 * that theme's stylesheet. Nothing in this application needs to know which theme is active —
 * provided M2-2's rule holds and no component ever hardcodes a colour, radius or font size.
 *
 * @module
 */

import { readStoredPreference, writeStoredPreference } from './preferences.js'

/**
 * The themes offered, and the three that are not.
 *
 * Contrast is measured rather than assumed: `test/theme/contrast.browser.test.ts` resolves ten
 * token pairs under every theme, palette and scheme — 2200 checks — and asserts each offered
 * theme meets WCAG AA (4.5:1) throughout.
 *
 * Three do not, and are therefore not offered:
 *
 * | Theme | Where | Ratio |
 * | --- | --- | --- |
 * | `tailspin` | the quiet brand, danger, warning and success fills, in light | 2.98 – 2.99 |
 * | `shoelace` | the same four | 4.09 – 4.15 |
 * | `brutalist` | the normal neutral fill, in light | 4.29 |
 *
 * **The palette makes no difference to any of them**, which is what decides the shape of this
 * list. These are theme-level neutrals and quiet surfaces rather than brand hues, so a failure
 * is a property of the theme, not of a theme-and-palette pairing — there is no subset of
 * palettes that rescues one. And each fails in light only, while the scheme is a separate
 * control the user sets independently, so "offer it in dark alone" is not a thing the interface
 * can express. Excluding the theme is the only form the exclusion can take.
 *
 * Worth recording: #70 named `premium` and `matter` as the suspects, from a comparison made at
 * M2-2. Both now pass every pair in both schemes. The measurement disagreed with the issue, and
 * the measurement is what is acted on.
 */
export const THEMES = [
  'active',
  'awesome',
  'default',
  'glossy',
  'matter',
  'mellow',
  'playful',
  'premium',
] as const

/** Themes withheld for contrast, with the token that fails. See {@link THEMES}. */
export const EXCLUDED_THEMES: Readonly<Record<string, string>> = {
  brutalist: 'neutralNormal',
  shoelace: 'brandQuiet',
  tailspin: 'brandQuiet',
}

/** Every palette Web Awesome ships. None of them fails on its own. */
export const PALETTES = [
  'anodized',
  'base',
  'bright',
  'default',
  'elegant',
  'mild',
  'natural',
  'rudimentary',
  'shoelace',
  'vogue',
] as const

export type Theme = (typeof THEMES)[number]
export type Palette = (typeof PALETTES)[number]

/**
 * What `index.html` ships in its `class` attribute, and what an unrecognised preference falls
 * back to. Changing either means changing that attribute in the same commit, or the first paint
 * is one look and the second is another.
 */
export const DEFAULT_THEME: Theme = 'glossy'
export const DEFAULT_PALETTE: Palette = 'anodized'

export const THEME_STORAGE_KEY = 'matter-manager.theme'
export const PALETTE_STORAGE_KEY = 'matter-manager.palette'

const THEME_NAMES: ReadonlySet<string> = new Set(THEMES)
const PALETTE_NAMES: ReadonlySet<string> = new Set(PALETTES)

/**
 * The loader for a stylesheet that is **already in the entry bundle**.
 *
 * `main.ts` imports `themes/glossy.css` and `color/palettes/anodized.css` statically, because
 * `index.html` ships `class="wa-theme-glossy wa-palette-anodized"` and the first paint has to be
 * right — a theme arriving over a second round trip is a visible flash of the wrong one. So for
 * those two there is nothing to fetch, and the `import()` that used to stand here claimed
 * otherwise.
 *
 * Rolldown said so on every build, twice:
 *
 * ```
 * [INEFFECTIVE_DYNAMIC_IMPORT] …/themes/glossy.css is dynamically imported by src/ui/theme.ts
 * but also statically imported by src/ui/main.ts, dynamic import will not move module into
 * another chunk.
 * ```
 *
 * Both imports were right. The static one has to stay or the first paint flashes; the dynamic
 * one was a promise the bundler could not keep, and keeping it meant two true warnings on every
 * build that nobody could act on without reading all of this.
 *
 * Exported so `test/ui/theme/preference.test.ts` can assert that **exactly** the default theme
 * and the default palette use it. That assertion is load-bearing: "what the first paint is" is
 * stated in three places — `index.html`'s class attribute, `main.ts`'s static imports, and these
 * two tables — and changing {@link DEFAULT_THEME} without moving the static import would leave
 * the new default arriving late and the old one, still marked bundled here, never arriving at
 * all. A theme that silently stops loading is a worse outcome than a build warning.
 */
export const BUNDLED: () => Promise<void> = () => Promise.resolve()

/**
 * One loader per theme, written out rather than built from a template string.
 *
 * A dynamic import with an interpolated path is not statically analysable, so a bundler has to
 * guess which files it might reach — the same reasoning as `LOADERS` in `i18n/localization.ts`.
 * Listing them means the graph is exact and each theme becomes its own chunk, so a reader who
 * never leaves the default never downloads the other ten.
 *
 * Exported for the drift assertion described on {@link BUNDLED}; `loadLook` is still the way to
 * use it.
 */
export const THEME_LOADERS: Readonly<Record<Theme, () => Promise<unknown>>> = {
  active: () => import('@awesome.me/webawesome-pro/dist/styles/themes/active.css'),
  awesome: () => import('@awesome.me/webawesome-pro/dist/styles/themes/awesome.css'),
  default: () => import('@awesome.me/webawesome-pro/dist/styles/themes/default.css'),
  glossy: BUNDLED,
  matter: () => import('@awesome.me/webawesome-pro/dist/styles/themes/matter.css'),
  mellow: () => import('@awesome.me/webawesome-pro/dist/styles/themes/mellow.css'),
  playful: () => import('@awesome.me/webawesome-pro/dist/styles/themes/playful.css'),
  premium: () => import('@awesome.me/webawesome-pro/dist/styles/themes/premium.css'),
}

/** One loader per palette. Same reasoning as {@link THEME_LOADERS}. */
export const PALETTE_LOADERS: Readonly<Record<Palette, () => Promise<unknown>>> = {
  anodized: BUNDLED,
  base: () => import('@awesome.me/webawesome-pro/dist/styles/color/palettes/base.css'),
  bright: () => import('@awesome.me/webawesome-pro/dist/styles/color/palettes/bright.css'),
  default: () => import('@awesome.me/webawesome-pro/dist/styles/color/palettes/default.css'),
  elegant: () => import('@awesome.me/webawesome-pro/dist/styles/color/palettes/elegant.css'),
  mild: () => import('@awesome.me/webawesome-pro/dist/styles/color/palettes/mild.css'),
  natural: () => import('@awesome.me/webawesome-pro/dist/styles/color/palettes/natural.css'),
  rudimentary: () =>
    import('@awesome.me/webawesome-pro/dist/styles/color/palettes/rudimentary.css'),
  shoelace: () => import('@awesome.me/webawesome-pro/dist/styles/color/palettes/shoelace.css'),
  vogue: () => import('@awesome.me/webawesome-pro/dist/styles/color/palettes/vogue.css'),
}

/** Reads the stored theme, falling back to the default for anything unrecognised. */
export function readThemePreference(getStorage: () => Pick<Storage, 'getItem'>): Theme {
  return readStoredPreference(getStorage, THEME_STORAGE_KEY, THEME_NAMES, DEFAULT_THEME)
}

/** Reads the stored palette, falling back to the default. */
export function readPalettePreference(getStorage: () => Pick<Storage, 'getItem'>): Palette {
  return readStoredPreference(getStorage, PALETTE_STORAGE_KEY, PALETTE_NAMES, DEFAULT_PALETTE)
}

/** Stores the theme. A refused write is not worth breaking the page over. */
export function writeThemePreference(
  getStorage: () => Pick<Storage, 'setItem'>,
  theme: Theme,
): void {
  writeStoredPreference(getStorage, THEME_STORAGE_KEY, theme)
}

/** Stores the palette. */
export function writePalettePreference(
  getStorage: () => Pick<Storage, 'setItem'>,
  palette: Palette,
): void {
  writeStoredPreference(getStorage, PALETTE_STORAGE_KEY, palette)
}

/**
 * Loads a theme's and a palette's stylesheets, if they are not already in the document.
 *
 * Resolved once per stylesheet: the browser caches the module, and a second `import()` of the
 * same specifier returns the same promise rather than fetching again.
 */
export async function loadLook(theme: Theme, palette: Palette): Promise<void> {
  await Promise.all([THEME_LOADERS[theme](), PALETTE_LOADERS[palette]()])
}

/**
 * Counts look changes across the whole application, so a slow load cannot undo a later choice.
 *
 * Module-scoped rather than held by a caller, because there is one document and its look is one
 * thing. The first version of this guard lived in `SettingsView` and counted only the changes
 * that view started, which left `main.ts` outside it entirely: the stored look is applied at
 * startup through its own load, and that load is slow enough that somebody can reach Settings
 * and choose differently while it is still in flight. The startup load would then resolve last
 * and put the old classes back, leaving the controls and storage showing one look and the
 * document another. A guard held by one of two callers was always going to be half a guard.
 */
let lookRequest = 0

/**
 * Loads and applies a look unless a newer request started while its stylesheets were loading.
 *
 * @param loader how the stylesheets are fetched; injected by tests, because the case this
 *   guards needs two loads in flight with the older resolving second, and nothing about a real
 *   `import()` lets a test arrange that
 */
export async function loadAndApplyLook(
  root: Element,
  theme: Theme,
  palette: Palette,
  loader: (theme: Theme, palette: Palette) => Promise<unknown> = loadLook,
): Promise<void> {
  const token = ++lookRequest
  await loader(theme, palette)
  if (token === lookRequest) applyLook(root, theme, palette)
}

/**
 * Puts the theme and palette classes on the document element, removing whichever were there.
 *
 * Every `wa-theme-*` and `wa-palette-*` class is cleared rather than just the previous pair,
 * because the previous pair is not something this function is told and reading it back from the
 * element would make the result depend on what somebody else wrote. The scheme classes
 * (`wa-light`, `wa-dark`) belong to `scheme.ts` and are left alone.
 */
export function applyLook(root: Element, theme: Theme, palette: Palette): void {
  for (const existing of [...root.classList]) {
    if (existing.startsWith('wa-theme-') || existing.startsWith('wa-palette-')) {
      root.classList.remove(existing)
    }
  }
  root.classList.add(`wa-theme-${theme}`, `wa-palette-${palette}`)
}
