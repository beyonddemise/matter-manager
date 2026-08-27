#!/usr/bin/env node

/**
 * Generates the installed-application icons into `packages/web/public/`.
 *
 * A generator rather than four hand-drawn files, because the icons are one design at four
 * sizes and two safe-zone rules. Kept as a script rather than run at build time: the PNGs are
 * committed, so a fresh clone builds with no code-generation step — the same reasoning the
 * translation catalogue follows.
 *
 * The mark is a QR code's three finder patterns. Not a decoration: it is the thing this
 * application is *for*, it reads at 48 pixels on a home screen where a lightbulb or a house
 * would not, and it cannot be mistaken for a hub or a controller app.
 *
 * No image library. A PNG of flat rectangles is a pixel buffer, a zlib stream and three
 * chunks — about sixty lines — and `pdf-lib` aside, this project does not add a runtime or
 * build dependency it can do without (ADR 0013).
 *
 * Usage:  node scripts/make-icons.mjs
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'packages/web/public')

/** Ink and ground. Fixed hex, because a PNG cannot resolve a CSS custom property. */
const INK = [0x11, 0x14, 0x18, 0xff]
const PAPER = [0xff, 0xff, 0xff, 0xff]

/** CRC-32, as PNG defines it. Table built once. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, data, CRC. */
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** An RGBA pixel buffer to a PNG. Filter byte 0 on every scanline: these are flat colours. */
function png(pixels, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * The mark, on a 21×21 grid — the module count of a version-1 QR code.
 *
 * `1` is ink. Three finder patterns and a scatter of modules between them: enough to read as a
 * QR code at a glance, and deliberately not a valid one. A working code on an app icon is an
 * invitation to scan it, and what it would decode to is nothing.
 */
const GRID = [
  '111111100000001111111',
  '100000101010101000001',
  '101110100000101011101',
  '101110101101001011101',
  '101110100010101011101',
  '100000101100101000001',
  '111111101010101111111',
  '000000000000000000000',
  '001011101101010110100',
  '110100010010101001011',
  '001110101011010110010',
  '110001010100101001101',
  '001011101011010110100',
  '000000001100101000000',
  '111111100010101101010',
  '100000101101010010101',
  '101110101010101101010',
  '101110100101010010101',
  '101110101010101101010',
  '100000100101011010101',
  '111111101010100101010',
]

/**
 * Draws the mark at `size`, leaving `inset` of the width clear on every edge.
 *
 * `inset` is what separates the two icon kinds. A maskable icon is cropped to whatever shape
 * the platform prefers — Android will cut a circle out of it — and anything outside the middle
 * 80% of the diameter can be shaved off. An icon drawn edge to edge loses its corners.
 */
function draw(size, inset) {
  const pixels = Buffer.alloc(size * size * 4)
  const fill = (x, y, colour) => {
    const at = (y * size + x) * 4
    pixels[at] = colour[0]
    pixels[at + 1] = colour[1]
    pixels[at + 2] = colour[2]
    pixels[at + 3] = colour[3]
  }

  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) fill(x, y, PAPER)

  const margin = Math.round(size * inset)
  const span = size - margin * 2
  const module = span / GRID.length

  for (let row = 0; row < GRID.length; row += 1) {
    for (let column = 0; column < GRID.length; column += 1) {
      if (GRID[row][column] !== '1') continue
      const left = Math.round(margin + column * module)
      const top = Math.round(margin + row * module)
      const right = Math.round(margin + (column + 1) * module)
      const bottom = Math.round(margin + (row + 1) * module)
      for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) fill(x, y, INK)
    }
  }

  return png(pixels, size)
}

const icons = [
  // The two sizes a manifest is expected to offer, drawn close to the edge.
  ['icon-192.png', 192, 0.08],
  ['icon-512.png', 512, 0.08],
  // Maskable: the mark inside the middle 60%, so a circular or squircle crop cannot reach it.
  ['icon-maskable-512.png', 512, 0.2],
  // iOS does not read the manifest for its home-screen icon, and does not round-trip
  // transparency the way it rounds corners — hence a separate opaque one at Apple's size.
  ['apple-touch-icon.png', 180, 0.08],
]

for (const [name, size, inset] of icons) {
  writeFileSync(join(out, name), draw(size, inset))
  console.log(`icons: wrote ${name} (${size}px, ${Math.round(inset * 100)}% inset)`)
}
