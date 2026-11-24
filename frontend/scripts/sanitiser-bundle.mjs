/**
 * Bundles `src/ui/layouts/sanitise.ts` into one classic script that defines `PlanSanitiser`.
 *
 * Shared by `probe-svg-rendering.mjs`, which loads it into a page to measure the sanitiser that
 * ships, and `check-lazy-svg.mjs`, which uses it as its positive control: the markers that check
 * looks for must be present in the sanitiser itself, or "in no chunk" would pass vacuously.
 *
 * Built with the application's own bundler and its pinned DOMPurify, never reimplemented, so
 * both measure the code that ships.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** @returns {Promise<string>} the sanitiser as an IIFE assigning `window.PlanSanitiser` */
export async function buildSanitiserBundle() {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: join(root, 'src/ui/layouts/sanitise.ts'),
        formats: ['iife'],
        name: 'PlanSanitiser',
      },
    },
  })
  const output = (Array.isArray(result) ? result[0] : result).output
  const chunk = output.find((file) => file.type === 'chunk')
  if (chunk === undefined) throw new Error('Building the sanitiser produced no script')
  return chunk.code
}
