import { join } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'

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
 * release that renames or moves that import breaks the build and says so.
 *
 * **The transform runs in development too, and only the assertion is build-only.** It was
 * `apply: 'build'` at first, which meant `npm run dev` still fetched fonts from Bunny while a
 * build did not - dev and production disagreeing about typography. That was tolerable while one
 * theme was involved; #70 makes eight selectable, seven of which fall back to the platform stack
 * in production, so a developer would have been looking at fonts no user ever sees. What
 * `apply: 'build'` was really protecting is the assertion below: a unit test that imports one
 * component never reads a theme, and failing there would be a false alarm.
 */
function stripThirdPartyFontImports(): Plugin {
  let stripped = 0
  let building = false

  return {
    name: 'strip-third-party-font-imports',
    enforce: 'pre',

    configResolved(config) {
      building = config.command === 'build'
    },

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
      if (building && error === undefined && stripped === 0) {
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

export default defineConfig(({ mode }) => {
  // From the repository root, where `.env` lives beside `.env.example` - the same file the API
  // and the compose stack read, so there is one place to say where things are.
  const env = loadEnv(mode, join(import.meta.dirname, '../..'), '')

  return {
    // import.meta.dirname (not __dirname): this package is "type": "module", and under
    // NodeNext module resolution __dirname does not exist in real ESM. import.meta.dirname
    // is the direct equivalent, available since Node 20.11 and always present given this
    // repo's node >=22 engine requirement.
    root: import.meta.dirname,
    plugins: [stripThirdPartyFontImports()],
    build: { outDir: 'dist', emptyOutDir: true },

    server: {
      proxy: devProxy(env),
    },
  }
})

/**
 * Where `/api` and `/db` go in development.
 *
 * Exported so a test can supply its own environment. Reading `loadEnv` inside the test instead
 * would make the assertions depend on whichever `.env` the machine happens to have, which is
 * exactly the sort of test that passes for its author and fails for everybody else.
 */
export function devProxy(env: Record<string, string>) {
  return {
    /**
     * `/api` and `/db` are proxied so that development and production agree.
     *
     * In production the application keeps its Cloudflare Pages deployment and Pages Functions
     * forward these two paths to the API and to CouchDB, so the browser only ever addresses its
     * own origin - which is why `_headers` needs no third-party entry in `connect-src` and why
     * nothing in `packages/web` has to know a hostname.
     *
     * Development has to match, or the relative URLs the application uses would work in exactly
     * one of the two places, and the one they failed in would be the one nobody runs before
     * deploying.
     *
     * The prefix is stripped, because the API serves `/projects` and `/auth/*` at its root and
     * CouchDB serves databases at its own. Keeping it would push knowledge of the proxy into
     * every route on both sides.
     */
    '/api': {
      target: env.DEV_API_TARGET || 'http://localhost:3000',
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ''),
    },
    '/db': {
      target: env.DEV_COUCHDB_TARGET || 'http://localhost:5985',
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/db/, ''),
    },
  }
}
