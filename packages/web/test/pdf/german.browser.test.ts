import '@awesome.me/webawesome-pro/dist/components/qr-code/qr-code.js'
import { browseDevices, type DeviceDocument, type RoomDocument } from '@matter-manager/core'
import { describe, expect, it } from 'vitest'
import { buildInventoryPdf, type InventoryLabels } from '../../src/pdf/inventory.js'
import { extractText } from './text-extraction.js'

/** The two strings the issue names, plus every other character German needs. */
const ROOM = 'Erdgeschoss/Küche'
const DEVICE = 'Außenbeleuchtung'
const ALL_OF_GERMAN = 'ÄÖÜ äöü ß — Größe, Weiß, Straße'

const LABELS: InventoryLabels = {
  title: 'Bestandsliste',
  pageNumber: (page, total) => `Seite ${page} von ${total}`,
  continued: (path) => `${path} (Fortsetzung)`,
  installed: 'Eingebaut am',
  pairingCode: 'Kopplungscode',
  noQrCode: 'Über Kopplungscode erfasst',
  withoutRoom: 'Ohne Raum',
  nothingToExport: 'Es gibt keine Geräte zum Exportieren.',
}

const device = (name: string, extra: Partial<DeviceDocument> = {}): DeviceDocument => ({
  _id: `device:${name}`,
  _rev: '1-a',
  updatedAt: '2026-08-19T08:00:00.000Z',
  type: 'device',
  name,
  roomId: 'room:kueche',
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

const ROOMS: readonly RoomDocument[] = [
  {
    _id: 'room:kueche',
    _rev: '1-a',
    updatedAt: '2026-08-19T08:00:00.000Z',
    type: 'room',
    path: ROOM,
  },
]

/** Builds the document and reads every string back out of it. */
async function drawn(devices: readonly DeviceDocument[]): Promise<string[]> {
  const bytes = await buildInventoryPdf(browseDevices(devices, ROOMS), { labels: LABELS })
  return extractText(bytes)
}

describe('the extractor itself', () => {
  it('finds the text that was drawn', async () => {
    // The positive control, and it is not optional. Every assertion below is of the form
    // "the extracted text contains X" — so an extractor that found nothing at all would make
    // every one of them fail loudly, but an extractor that found only ASCII would make the
    // German ones fail while looking like a real defect. This case fails first and says so.
    const text = await drawn([device('Kitchen ceiling light')])

    expect(text).toContain('Kitchen ceiling light')
  })
})

describe('German in a generated PDF', () => {
  it('renders a device name with an eszett', async () => {
    // The scenario as written. `Außenbeleuchtung` reaches the page as itself, not as
    // `Au?enbeleuchtung` and not as a blank.
    expect(await drawn([device(DEVICE)])).toContain(DEVICE)
  })

  it('renders a room path with an umlaut', async () => {
    expect(await drawn([device(DEVICE)])).toContain(ROOM)
  })

  it('renders every character German uses', async () => {
    // Beyond the issue's two examples: capital umlauts, the em dash a German sentence uses,
    // and eszett in three different words. Any one of them silently becoming a box is the
    // failure this issue exists for.
    expect(await drawn([device(ALL_OF_GERMAN)])).toContain(ALL_OF_GERMAN)
  })

  it('renders the labels the interface supplies', async () => {
    // The strings from `msg()` land in the document too — a page footer reading
    // `Seite 1 von 1` is as much a place for an encoding failure as a device name.
    const text = await drawn([device(DEVICE)])

    expect(text).toContain('Kopplungscode: 34970112332')
    expect(text).toContain('Seite 1 von 1')
  })

  it('renders German on a device with no QR code', async () => {
    const { payload: _payload, ...rest } = device(DEVICE, { payload: 'MT:Y.K9042C00KA0648G00' })
    const text = await drawn([rest as DeviceDocument])

    expect(text).toContain(DEVICE)
    // Joined, because this message is drawn with a `maxWidth` and `pdf-lib` wraps rather than
    // clipping — so it reaches the page as several strings. That is the intended rendering;
    // asserting one string would be asserting that it did *not* wrap.
    expect(text.join('')).toContain('Über')
    expect(text.join(' ').replace(/\s+/g, ' ')).toContain('Kopplungscode erfasst')
  })

  it('round-trips the strings byte for byte, not merely recognisably', async () => {
    // `toContain` on the array is an exact string comparison per entry, which is the point:
    // a normalisation that turned `ü` into `ü` would still *look* right in a rendering
    // and would not be the string the user typed.
    const text = await drawn([device(DEVICE)])
    const found = text.find((entry) => entry.includes('beleuchtung'))

    expect(found).toBe(DEVICE)
    expect(found?.normalize('NFC')).toBe(found)
  })
})

describe('a character the standard fonts cannot encode', () => {
  // German is the launch language and Helvetica covers it. The application is not
  // German-only, though: rooms and devices are named by whoever owns the house, and a
  // "Łazienka" or a "Café à côté" is one keystroke away. The standard-14 fonts are
  // WinAnsi-encoded, which covers Western Europe and stops there.
  it.each([
    ['Polish', 'Łazienka'],
    ['Czech', 'Koupelna — světlo'],
    ['Cyrillic', 'Кухня'],
    ['Greek', 'Κουζίνα'],
    ['an emoji', 'Kitchen 💡'],
  ])('does not lose the whole document to %s', async (_language, name) => {
    // The requirement is *not* that these render — that needs an embedded Unicode font, which
    // is a megabyte of payload for a feature nobody has asked for yet. The requirement is that
    // one unrepresentable character does not throw away an export of two hundred devices,
    // which is what an unhandled encoding error does.
    const bytes = await buildInventoryPdf(browseDevices([device(name)], ROOMS), {
      labels: LABELS,
    })

    expect(new TextDecoder('latin1').decode(bytes).startsWith('%PDF-')).toBe(true)
  })

  it('still prints the pairing code, which is what the entry is for', async () => {
    // The one thing on the page that must survive whatever happened to the name: digits are
    // ASCII, and the code is what re-commissions the device.
    const text = await drawn([device('Кухня')])

    expect(text.join(' ')).toContain('34970112332')
  })
})
