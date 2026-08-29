#!/usr/bin/env node
/**
 * Downloads the fonts and icons the application needs, so that it can render without a network.
 *
 * Run by hand, not by the build. The output is committed: a build that reaches the internet to
 * succeed is a build that fails when the internet is unavailable or the CDN has moved on, and
 * these files change roughly never. Re-run it to pick up a new Web Awesome theme's fonts or a
 * newly used icon, and commit what changes.
 *
 * **The fonts are taken from Bunny's own stylesheet rather than hand-written.** That stylesheet
 * carries the `unicode-range` for each subset, which is what stops a browser downloading
 * `latin-ext` for a page that has no such character in it. Writing those ranges out by hand
 * would be copying forty lines of hex from a source we can just read.
 *
 * Usage:  node scripts/fetch-offline-assets.mjs
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fontsDir = join(root, 'packages/web/src/fonts')
const iconsDir = join(root, 'packages/web/src/icons/svg')

/**
 * The families and weights the active theme actually resolves to.
 *
 * `glossy.css` names 350, 400, 600 and 800. CSS font matching sends a request for 350 to the
 * 300 file, because for a target below 400 it looks downwards first — so 300 is what a browser
 * fetches for `--wa-font-weight-light`, and 350 is not a file that exists anywhere.
 *
 * The theme's own `@import` asks for all nine weights and both styles of all three families.
 * That is 108 combinations, of which a running browser has ever been observed to fetch three.
 */
const FONTS = 'figtree:300,400,600,800|chivo-mono:400|fraunces:300'

/**
 * Where the icons come from.
 *
 * The **Free** package, from `node_modules`, rather than the CDN Web Awesome resolves to. Two
 * reasons, and either alone would decide it:
 *
 * - **Licence.** That CDN hands back files stamped `Font Awesome Pro ... (Commercial License)`
 *   without asking for a credential. This repository is public, so committing them would be
 *   redistributing Pro assets. Font Awesome Free is CC BY 4.0 and may be redistributed with
 *   attribution, which `LICENCE.md` beside the icons gives.
 * - **Reproducibility.** A script that needs the internet to produce a committed artefact is a
 *   script that stops working when the CDN moves. The version is pinned in `package.json` and
 *   `package-lock.json` like everything else.
 *
 * The fonts still come over the network, because there is no package for them and Bunny's
 * stylesheet is the source of the `unicode-range` values.
 */
const FA_FREE = join(root, 'node_modules/@fortawesome/fontawesome-free/svgs/solid')

/**
 * Every icon the application can ask for.
 *
 * Written out rather than derived from the source, because seven of them are chosen at run time
 * — the scheme toggle, the two navigation entries, and the enable/disable button — so no grep
 * over the templates can find them. `packages/web/test/views/icons.browser.test.ts` asserts this
 * list and the directory agree, which is what keeps the list honest.
 */
const ICONS = [
  // Named directly in a template.
  'arrows-rotate',
  'bars',
  'camera',
  'circle-exclamation',
  'circle-info',
  'comment-medical',
  'expand',
  'file-pdf',
  'pen',
  'plus',
  'tags',
  'trash',
  'triangle-exclamation',
  // #132: `camera-slash` and `cloud-slash` are Pro-only and 403 on the endpoint Web Awesome
  // uses, so neither has ever rendered. These are their free replacements.
  'video-slash',
  'plug-circle-xmark',
  // Chosen at run time: the colour-scheme toggle in `app-shell.ts`.
  'sun',
  'moon',
  'circle-half-stroke',
  // Chosen at run time: `NAV_ROUTES` in `router/routes.ts`.
  'lightbulb',
  'gear',
  // Chosen at run time: the enable/disable button in `views/device.ts`.
  'play',
  'pause',
]

/** A modern browser, so Bunny serves the woff2 stylesheet rather than a legacy one. */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const get = async (url, as = 'text') => {
  const response = await fetch(url, { headers: { 'user-agent': UA } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return as === 'text' ? response.text() : Buffer.from(await response.arrayBuffer())
}

/**
 * Removes what a previous run generated, so a dropped icon or weight actually disappears.
 *
 * Selective rather than a recursive delete of the directory. The first version wiped the whole
 * thing, which also took `fonts/LICENCE.md` with it — the file recording that these are OFL
 * fonts and where they came from. The OFL asks for the licence to travel with the files, so a
 * routine regeneration would have quietly removed the one thing that must not be removed. The
 * icons directory survived the same treatment only by accident, its licence happening to sit one
 * level up.
 *
 * Naming the extensions this script writes means anything else in the directory is somebody's
 * deliberate addition, and stays.
 */
const clearGenerated = (directory, extensions) => {
  mkdirSync(directory, { recursive: true })
  for (const entry of readdirSync(directory)) {
    if (extensions.some((extension) => entry.endsWith(extension))) {
      rmSync(join(directory, entry), { force: true })
    }
  }
}

console.log(`Fonts: ${FONTS}`)
const css = await get(`https://fonts.bunny.net/css?family=${FONTS}&display=swap`)

clearGenerated(fontsDir, ['.woff2', '.css'])
const blocks = []
let downloaded = 0

// Each @font-face block, with the comment naming its subset kept for the reader.
for (const [, subset, block] of css.matchAll(/\/\* ([\w-]+) \*\/\s*(@font-face \{[^}]*\})/g)) {
  const woff2 = /url\((https:\/\/[^)]+\.woff2)\)/.exec(block)?.[1]
  if (woff2 === undefined) continue
  const file = woff2.slice(woff2.lastIndexOf('/') + 1)
  writeFileSync(join(fontsDir, file), await get(woff2, 'buffer'))
  downloaded += 1
  // The woff fallback is dropped: every browser this application supports takes woff2, and
  // shipping both doubles the directory to serve engines that cannot run the rest of it.
  blocks.push(
    `/* ${subset} */\n${block
      .replace(/\s*src:[^;]+;/, `\n  src: url('./${file}') format('woff2');`)
      .replace(/\n\s*\n/g, '\n')}`,
  )
}

writeFileSync(
  join(fontsDir, 'fonts.css'),
  `/*
 * Self-hosted webfonts. **Generated — do not edit.**
 *   node scripts/fetch-offline-assets.mjs
 *
 * The Web Awesome theme @imports these from fonts.bunny.net, which makes every visit a
 * third-party request and leaves an offline application with no typography at all (#106). The
 * import is stripped at build time by the plugin in vite.config.ts; this file replaces it.
 *
 * Figtree, Chivo Mono and Fraunces are all under the SIL Open Font License 1.1 — see LICENSE
 * beside this file. The @font-face blocks and their unicode-range values come from Bunny's own
 * stylesheet, so a browser still downloads only the subsets a page actually needs.
 */

${blocks.join('\n\n')}\n`,
)
console.log(`  ${downloaded} woff2 files + fonts.css`)

const faVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/@fortawesome/fontawesome-free/package.json'), 'utf8'),
).version

console.log(`Icons: ${ICONS.length}, Font Awesome Free v${faVersion}`)
clearGenerated(iconsDir, ['.svg'])
for (const name of ICONS) {
  const source = join(FA_FREE, `${name}.svg`)
  if (!existsSync(source)) {
    throw new Error(
      `${name} is not in Font Awesome Free v${faVersion}. It is a Pro icon, and this ` +
        'repository is public - choose a free icon instead. See #132.',
    )
  }
  copyFileSync(source, join(iconsDir, `${name}.svg`))
}
console.log(`  ${readdirSync(iconsDir).length} svg files from Font Awesome Free v${faVersion}`)
