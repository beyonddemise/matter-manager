import { describe, expect, it } from 'vitest'
import type { DeviceGroup } from '../../src/documents/browse.js'
import type { DeviceDocument } from '../../src/documents/types.js'
import { A4, type Block, entriesOf, layoutInventory, type Page } from '../../src/pdf/layout.js'

const device = (name: string): DeviceDocument => ({
  _id: `device:${name}`,
  _rev: '1-a',
  updatedAt: '2026-08-19T08:00:00.000Z',
  type: 'device',
  name,
  roomId: 'room:kitchen',
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
})

const group = (path: string, ...names: string[]): DeviceGroup => ({
  roomId: `room:${path}`,
  path,
  devices: names.map(device),
})

/** Every device, in the order the pages present them. */
const printed = (pages: readonly Page[]): string[] =>
  pages.flatMap((page) => entriesOf(page).map((entry) => entry.device.name))

/** How many entries fit on a page under a heading, for the geometry in use. */
const usable = A4.height - A4.margin * 2 - A4.footerHeight

describe('laying out an inventory', () => {
  it('puts one room and its devices on one page', () => {
    const pages = layoutInventory([group('Kitchen', 'Lamp', 'Sensor')])

    expect(pages).toHaveLength(1)
    expect(printed(pages)).toEqual(['Lamp', 'Sensor'])
  })

  it('heads each room with its path', () => {
    const [page] = layoutInventory([group('Ground Floor/Kitchen', 'Lamp')])
    const heading = page?.blocks[0]

    expect(heading).toEqual({
      kind: 'heading',
      path: 'Ground Floor/Kitchen',
      top: 0,
      continued: false,
    })
  })

  it('prints every device exactly once, whatever the pagination', () => {
    // The invariant the whole feature rests on. A device printed twice is confusing; a device
    // printed nowhere is the failure this application exists to prevent, and neither is
    // visible from looking at one page.
    const many = Array.from({ length: 40 }, (_, index) => `Device ${index}`)
    const pages = layoutInventory([
      group('Kitchen', ...many.slice(0, 20)),
      group('Hall', ...many.slice(20)),
    ])

    expect(printed(pages)).toEqual(many)
  })

  it('never leaves a room heading alone at the foot of a page', () => {
    // A room name at the bottom of a page with its devices overleaf reads as a room
    // containing nothing. Enough devices here to force a break at several points.
    for (let count = 1; count <= 24; count += 1) {
      const names = Array.from({ length: count }, (_, index) => `Device ${index}`)
      const pages = layoutInventory([group('Kitchen', ...names), group('Hall', 'Other')])

      for (const page of pages) {
        expect(page.blocks.at(-1)?.kind, `with ${count} devices`).not.toBe('heading')
      }
    }
  })

  it('repeats the heading when a room continues onto the next page, and says so', () => {
    const names = Array.from({ length: 20 }, (_, index) => `Device ${index}`)
    const pages = layoutInventory([group('Kitchen', ...names)])

    expect(pages.length).toBeGreaterThan(1)
    const second = pages[1]?.blocks[0] as Block
    expect(second).toMatchObject({ kind: 'heading', path: 'Kitchen', continued: true })
  })

  it('does not mark a room that starts on a page as continued', () => {
    const pages = layoutInventory([group('Kitchen', 'Lamp'), group('Hall', 'Sensor')])
    const headings = pages
      .flatMap((page) => page.blocks)
      .filter((block) => block.kind === 'heading')

    expect(headings.every((heading) => heading.continued === false)).toBe(true)
  })

  it('never places a block past the bottom of the printable area', () => {
    // Anything below this is clipped by the printer, silently, on paper only.
    const names = Array.from({ length: 50 }, (_, index) => `Device ${index}`)
    const pages = layoutInventory([group('Kitchen', ...names)])

    for (const page of pages) {
      for (const block of page.blocks) {
        const height = block.kind === 'heading' ? A4.headingHeight : A4.entryHeight
        expect(block.top + height).toBeLessThanOrEqual(usable)
      }
    }
  })

  it('numbers pages from one, in order', () => {
    const names = Array.from({ length: 30 }, (_, index) => `Device ${index}`)
    const pages = layoutInventory([group('Kitchen', ...names)])

    expect(pages.map((page) => page.number)).toEqual(pages.map((_, index) => index + 1))
  })

  it('keeps rooms in the order it was given them', () => {
    const pages = layoutInventory([group('Zebra room', 'Z'), group('Attic', 'A')])
    expect(printed(pages)).toEqual(['Z', 'A'])
  })

  it('produces a page even when there is nothing to print', () => {
    // A zero-page PDF is a file that will not open, which is a worse answer to "an empty
    // project" than a page saying there is nothing in it.
    const pages = layoutInventory([])

    expect(pages).toHaveLength(1)
    expect(pages[0]?.blocks).toEqual([])
  })

  it('starts a room that will not fit in the space left on a fresh page', () => {
    // Rather than squeezing the heading in and pushing the first device over.
    const names = Array.from({ length: 5 }, (_, index) => `Device ${index}`)
    const pages = layoutInventory([group('Kitchen', ...names), group('Hall', 'Sensor')])

    const withHall = pages.find((page) =>
      page.blocks.some((block) => block.kind === 'heading' && block.path === 'Hall'),
    )
    const hallIndex = withHall?.blocks.findIndex(
      (block) => block.kind === 'heading' && block.path === 'Hall',
    )
    expect(withHall?.blocks[(hallIndex ?? 0) + 1]?.kind).toBe('entry')
  })

  it('never orphans a heading when every room holds one device', () => {
    // Many rooms of one device puts a heading near a page break constantly, which is the case
    // that catches a heading measured *apart* from the device it introduces: on its own it
    // fits, and then the entry after it does not.
    const groups = Array.from({ length: 30 }, (_, index) =>
      group(`Room ${index}`, `Device ${index}`),
    )
    const pages = layoutInventory(groups)

    for (const page of pages) {
      expect(page.blocks.at(-1)?.kind).not.toBe('heading')
      for (const block of page.blocks) {
        const height = block.kind === 'heading' ? A4.headingHeight : A4.entryHeight
        expect(block.top + height).toBeLessThanOrEqual(usable)
      }
    }
    expect(printed(pages)).toHaveLength(30)
  })

  it('does not squeeze in a heading whose device will then not fit', () => {
    // The window where measuring the heading separately actually differs: the space left over
    // takes the entry but not the heading above it. A4's round numbers never land in it, so
    // this geometry is chosen to. Get it wrong and the heading fits, the device beneath it
    // runs off the bottom, and a printer silently cuts it in half.
    const geometry = {
      ...A4,
      height: 255,
      margin: 10,
      entryHeight: 100,
      headingHeight: 20,
      footerHeight: 0,
    }
    const bound = geometry.height - geometry.margin * 2

    const pages = layoutInventory(
      Array.from({ length: 4 }, (_, index) => group(`Room ${index}`, `Device ${index}`)),
      geometry,
    )

    for (const page of pages) {
      for (const block of page.blocks) {
        const height = block.kind === 'heading' ? geometry.headingHeight : geometry.entryHeight
        expect(block.top + height).toBeLessThanOrEqual(bound)
      }
    }
  })

  it('keeps the footer space clear', () => {
    // A4's entry height is coarse enough that losing 24 points of footer happens to change
    // nothing, so a test using it cannot see this rule at all. These numbers can: without the
    // reservation exactly one more entry fits per page, and it lands in the footer.
    const geometry = {
      ...A4,
      height: 400,
      margin: 20,
      entryHeight: 20,
      headingHeight: 20,
      footerHeight: 40,
    }
    const bound = geometry.height - geometry.margin * 2 - geometry.footerHeight
    const names = Array.from({ length: 40 }, (_, index) => `Device ${index}`)

    const pages = layoutInventory([group('Kitchen', ...names)], geometry)

    for (const page of pages) {
      for (const block of page.blocks) {
        const height = block.kind === 'heading' ? geometry.headingHeight : geometry.entryHeight
        expect(block.top + height).toBeLessThanOrEqual(bound)
      }
    }
  })

  it('produces no blank page for an entry too tall to fit anywhere', () => {
    // A geometry that cannot hold one device is a bug elsewhere, but the answer to it must not
    // be a document of alternating blank pages: the entry goes on the page it is on, and the
    // reader gets something rather than nothing.
    const geometry = {
      ...A4,
      height: 120,
      margin: 10,
      entryHeight: 200,
      headingHeight: 20,
      footerHeight: 0,
    }
    const pages = layoutInventory([group('Kitchen', 'A', 'B')], geometry)

    for (const page of pages) expect(page.blocks.length).toBeGreaterThan(0)
    expect(printed(pages)).toEqual(['A', 'B'])
  })

  it('honours a geometry other than A4', () => {
    // The geometry is a parameter rather than a constant so that M3-3's label sheets are a
    // different call rather than a different module.
    const tiny = { ...A4, height: 300, entryHeight: 100, headingHeight: 20, footerHeight: 0 }
    const pages = layoutInventory([group('Kitchen', 'A', 'B', 'C')], tiny)

    expect(pages.length).toBeGreaterThan(1)
    expect(printed(pages)).toEqual(['A', 'B', 'C'])
  })
})
