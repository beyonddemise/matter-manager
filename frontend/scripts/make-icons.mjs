#!/usr/bin/env node

/**
 * Generates the installed-application icons into `public/` from the application icon,
 * `src/ui/brand/icon.svg`.
 *
 * A generator rather than four hand-exported files, because the icons are one design at four
 * sizes and two safe-zone rules. Kept as a script rather than run at build time: the PNGs are
 * committed, so a fresh clone builds with no code-generation step — the same reasoning the
 * translation catalogue follows.
 *
 * The icon is a traced vector image, so it is rasterised by a browser rather than drawn by hand.
 * The browser is Chromium through Playwright, which the test suite already depends on. Nothing
 * is added for this, and nothing here ships (ADR 0013).
 *
 * Usage:  node scripts/make-icons.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public')
const svg = readFileSync(join(root, 'src/ui/brand/icon.svg'), 'utf8')

/**
 * The icon's own ground: the fill of its first path, a rectangle covering the whole canvas.
 * Read from the file rather than repeated here, so a redrawn icon brings its colour with it.
 */
const ground = /<path fill="(#[0-9a-fA-F]{3,6})" d="M0 0h(\d+)v\2H0z"\/>/.exec(svg)?.[1]
if (ground === undefined) {
  throw new Error(
    'icon.svg no longer starts with a full-canvas ground rectangle; update this script.',
  )
}

const icons = [
  // The two sizes a manifest is expected to offer. The icon already keeps its artwork off the
  // edge, so it is drawn at full size.
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  // Maskable: the platform crops to its own shape — Android cuts a circle — and only the middle
  // 80% of the diameter is safe. The house goes in the middle 64%, on its own ground colour.
  ['icon-maskable-512.png', 512, 0.64],
  // iOS does not read the manifest for its home-screen icon, and does not round-trip
  // transparency the way it rounds corners — hence a separate opaque one at Apple's size.
  ['apple-touch-icon.png', 180, 1],
]

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  for (const [name, size, scale] of icons) {
    const dataUrl = await page.evaluate(
      async ({ source, size, scale, ground }) => {
        const image = new Image()
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const context = canvas.getContext('2d')
        context.fillStyle = ground
        context.fillRect(0, 0, size, size)
        const drawn = size * scale
        const offset = (size - drawn) / 2
        context.drawImage(image, offset, offset, drawn, drawn)
        return canvas.toDataURL('image/png')
      },
      { source: svg, size, scale, ground },
    )
    writeFileSync(join(out, name), Buffer.from(dataUrl.split(',')[1], 'base64'))
    console.log(`icons: wrote ${name} (${size}px, artwork at ${Math.round(scale * 100)}%)`)
  }
} finally {
  await browser.close()
}
