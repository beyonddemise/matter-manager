/**
 * Measuring the contrast a theme and palette actually produce.
 *
 * Through the **tokens** rather than a rendered component. Every Web Awesome component reads
 * `--wa-color-*`, so the tokens are where a contrast problem lives; reaching into a button's
 * shadow DOM would measure one component's interpretation of them and couple the test to its
 * internals. A probe element carrying `color: var(...)` and `background-color: var(...)` gets
 * both halves resolved to `rgb()` by the browser — `color-mix()`, relative colours and all.
 */

// Every theme and palette Web Awesome Pro ships, imported by name because this file measures
// all of them. Written out rather than globbed: a glob rooted at `/node_modules` resolves
// against the web package, where the hoisted dependency is not - and the first version of this
// file did exactly that, matched nothing, and reported every combination as failing because no
// token resolved to anything. The application loads one theme and one palette on demand; see
// `src/theme.ts`.
import '@awesome.me/webawesome-pro/dist/styles/themes/active.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/awesome.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/brutalist.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/default.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/glossy.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/matter.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/mellow.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/playful.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/premium.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/shoelace.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/tailspin.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/anodized.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/base.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/bright.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/default.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/elegant.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/mild.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/natural.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/rudimentary.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/shoelace.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/vogue.css'

export const WA_THEMES = [
  'active',
  'awesome',
  'brutalist',
  'default',
  'glossy',
  'matter',
  'mellow',
  'playful',
  'premium',
  'shoelace',
  'tailspin',
] as const

export const WA_PALETTES = [
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

/**
 * The token pairs worth checking, and what each one is.
 *
 * The `normal` and `quiet` fills are here because of what #70 actually reported: a brand button
 * with a **pale fill** and a low-contrast label. `loud` is the saturated fill, so a pale one is
 * either of the other two — checking only `loud` would have measured the wrong thing and
 * reported all clear.
 */
export const PAIRS = {
  /** Body text. The one that affects every screen. */
  text: ['--wa-color-text-normal', '--wa-color-surface-default'],
  /** Secondary text: hints, timestamps, empty states. Quiet by design, and easily too quiet. */
  textQuiet: ['--wa-color-text-quiet', '--wa-color-surface-default'],
  /** The primary button. */
  brandLoud: ['--wa-color-brand-on-loud', '--wa-color-brand-fill-loud'],
  /** A secondary brand control — the pale fill #70 describes. */
  brandNormal: ['--wa-color-brand-on-normal', '--wa-color-brand-fill-normal'],
  /** The palest brand surface, used for callouts and selected rows. */
  brandQuiet: ['--wa-color-brand-on-quiet', '--wa-color-brand-fill-quiet'],
  /** The delete confirmation, where a misread is expensive. */
  dangerLoud: ['--wa-color-danger-on-loud', '--wa-color-danger-fill-loud'],
  /** The danger callout, which carries the sentence explaining what is about to be lost. */
  dangerQuiet: ['--wa-color-danger-on-quiet', '--wa-color-danger-fill-quiet'],
  /** The offline and sync notices. */
  warningQuiet: ['--wa-color-warning-on-quiet', '--wa-color-warning-fill-quiet'],
  /** Confirmation of a save. */
  successQuiet: ['--wa-color-success-on-quiet', '--wa-color-success-fill-quiet'],
  /** Neutral chrome: disabled rows, secondary buttons. */
  neutralNormal: ['--wa-color-neutral-on-normal', '--wa-color-neutral-fill-normal'],
} as const

export type Pair = keyof typeof PAIRS

/** Resolves both halves of a pair under one theme, palette and scheme. */
export function resolvePair(
  theme: string,
  palette: string,
  scheme: 'wa-light' | 'wa-dark',
  pair: Pair,
): { foreground: string; background: string } {
  const [fg, bg] = PAIRS[pair]
  const host = document.createElement('div')
  host.className = `wa-theme-${theme} wa-palette-${palette} ${scheme}`
  const probe = document.createElement('span')
  probe.style.color = `var(${fg})`
  probe.style.backgroundColor = `var(${bg})`
  probe.textContent = 'Ag'
  host.append(probe)
  document.body.append(host)
  const computed = getComputedStyle(probe)
  const result = { foreground: computed.color, background: computed.backgroundColor }
  host.remove()
  return result
}

/** `rgb(…)` / `rgba(…)` to channel values 0-255. */
function channels(colour: string): [number, number, number] {
  const parts = colour.match(/[\d.]+/g)?.map(Number) ?? []
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/** WCAG relative luminance. */
function luminance(colour: string): number {
  const [r, g, b] = channels(colour).map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
