/**
 * Resolves `<wa-icon>` from bundled files instead of Font Awesome's CDN.
 *
 * Web Awesome's default library fetches every icon from
 * `ka-f.fontawesome.com` the first time it renders. For an offline-first application (ADR 0002)
 * that means the interface loses its icons in exactly the situation the product exists for —
 * and it tells a third party the visitor's address on every visit besides (#106).
 *
 * The SVGs are committed under `svg/`, copied from `@fortawesome/fontawesome-free` by
 * `scripts/fetch-offline-assets.mjs`. Font Awesome **Free**, not Pro: the CDN hands back Pro
 * files without asking for a credential, and this repository is public, so committing those
 * would be redistributing them. See `LICENCE.md` beside the SVGs.
 *
 * @module
 */

import { registerIconLibrary } from '@awesome.me/webawesome-pro/dist/webawesome.js'

/**
 * Every bundled icon, by name.
 *
 * `eager` rather than lazy: an icon is wanted at the moment it renders, and a dynamic import
 * per icon would put a network round trip back in the path this module exists to remove — the
 * shape of the bug, if not its destination. Vite emits each SVG as a fingerprinted asset and
 * this map holds the URLs, so the bundle carries 22 short strings rather than the files.
 */
const BUNDLED = import.meta.glob('./svg/*.svg', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Readonly<Record<string, string>>

/** The names this build can draw. Exported so a test can hold it against what the views ask for. */
export const BUNDLED_ICONS: ReadonlySet<string> = new Set(
  Object.keys(BUNDLED).map((path) => path.slice('./svg/'.length, -'.svg'.length)),
)

/**
 * Drawn when a name is not bundled: nothing, in the space an icon would have taken.
 *
 * Inert and same-origin, so a missing icon cannot become a network request by accident — which
 * is the failure this module exists to prevent, and the one it would be embarrassing to
 * reintroduce in the branch that handles a mistake.
 */
const NOTHING = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E'

/**
 * Points every `<wa-icon>` at the bundled files.
 *
 * Registering under `default` **replaces** Web Awesome's own registration of that name, which is
 * what takes the CDN out of the picture. Called from `main.ts` before any component renders.
 */
export function useBundledIcons(): void {
  registerIconLibrary('default', {
    resolver: (name) => {
      const url = BUNDLED[`./svg/${name}.svg`]
      if (url === undefined) {
        // Loud, because the alternative is a gap on screen that looks like a layout choice.
        // Unreachable while `icons.browser.test.ts` passes; it asserts that every name the
        // views can ask for is bundled.
        console.error(
          `No bundled icon named "${name}". Add it to ICONS in scripts/fetch-offline-assets.mjs and re-run it.`,
        )
        return NOTHING
      }
      return url
    },
  })
}
