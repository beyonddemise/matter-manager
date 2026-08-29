import { defineConfig, type Plugin } from 'vite'

/**
 * The third-party font stylesheet every Web Awesome theme pulls in.
 *
 * `themes/glossy.css` line 3 is an `@import` of `fonts.bunny.net`. Vite cannot bundle an
 * external `@import` — there is nothing it could resolve it to — so it survives into the built
 * CSS verbatim, and every visitor's browser fetches it before anything renders.
 */
const THIRD_PARTY_FONTS = /@import\s+url\(\s*['"]https:\/\/fonts\.bunny\.net\/[^'")]*['"]\s*\);?/g

/**
 * Removes the theme's webfont `@import`, which `src/fonts/fonts.css` replaces.
 *
 * Editing a file in `node_modules` is not an option and vendoring the whole theme would mean
 * re-vendoring it on every Web Awesome upgrade, so the import is stripped as the stylesheet is
 * read. `enforce: 'pre'` puts this ahead of Vite's own CSS handling, while the text is still
 * the file on disk.
 *
 * **It fails when it finds nothing.** A stripper that silently does nothing is worse than no
 * stripper: the fonts would quietly go back to being fetched from Bunny and everything would
 * still build, still pass, and still look right to anybody with a network. So a Web Awesome
 * release that renames or moves that import breaks the build and says so. `apply: 'build'`
 * because only a build loads the whole application - a unit test that imports one component
 * never reads the theme, and failing there would be a false alarm.
 */
function stripThirdPartyFontImports(): Plugin {
  let stripped = 0

  return {
    name: 'strip-third-party-font-imports',
    enforce: 'pre',
    apply: 'build',

    transform(code, id) {
      if (!id.endsWith('.css')) return null
      THIRD_PARTY_FONTS.lastIndex = 0
      if (!THIRD_PARTY_FONTS.test(code)) return null

      stripped += 1
      THIRD_PARTY_FONTS.lastIndex = 0
      return { code: code.replace(THIRD_PARTY_FONTS, ''), map: null }
    },

    buildEnd(error) {
      // Only when the build itself succeeded: reporting this on top of a real failure would
      // bury the cause under a consequence.
      if (error === undefined && stripped === 0) {
        this.error(
          'No fonts.bunny.net @import was found in any stylesheet, so this plugin removed ' +
            'nothing.\nEither Web Awesome changed where its themes get webfonts - in which ' +
            'case update THIRD_PARTY_FONTS here and re-run scripts/fetch-offline-assets.mjs - ' +
            'or the theme import was dropped from main.ts.\nSee #106: without this the built ' +
            'site fetches its typography from a third party on every visit.',
        )
      }
    },
  }
}

export default defineConfig({
  // import.meta.dirname (not __dirname): this package is "type": "module", and under
  // NodeNext module resolution __dirname does not exist in real ESM. import.meta.dirname
  // is the direct equivalent, available since Node 20.11 and always present given this
  // repo's node >=22 engine requirement.
  root: import.meta.dirname,
  plugins: [stripThirdPartyFontImports()],
  build: { outDir: 'dist', emptyOutDir: true },
})
