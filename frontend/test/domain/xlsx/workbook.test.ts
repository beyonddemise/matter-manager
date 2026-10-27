import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  readZip,
  type ZipCodecs,
  ZipError,
  type ZipLimits,
} from '../../../src/domain/archive/zip.js'
import { writeXlsx, xlsxEntries } from '../../../src/domain/xlsx/workbook.js'

/**
 * The xlsx container, read back the way `project-archive`'s zip is tested: with Node's zlib as
 * a second, independent inflate, so the file is checked against something other than the code
 * that wrote it. What a spreadsheet application would read is asserted on the XML itself.
 */

const codecs: ZipCodecs = {
  deflate: async (data) => new Uint8Array(deflateRawSync(data)),
  inflate: async (data, limit) => {
    const out = new Uint8Array(inflateRawSync(data))
    if (out.length > limit) throw new ZipError('tooLarge', 'inflated past the limit')
    return out
  },
}

const LIMITS: ZipLimits = { maxBytes: 10_000_000, maxInflatedBytes: 10_000_000, maxEntries: 100 }
const MODIFIED = new Date('2026-10-19T14:59:00Z')
const decode = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array())

const SHEET = {
  name: 'Devices',
  rows: [
    ['Room', 'Name'],
    ['Kitchen', 'Hue bulb'],
    ['Attic', ''],
  ],
} as const

async function unzipped(sheet: Parameters<typeof writeXlsx>[0]) {
  const bytes = await writeXlsx(sheet, codecs, MODIFIED)
  const entries = await readZip(bytes, codecs, LIMITS)
  return new Map(entries.map((entry) => [entry.name, decode(entry.data)]))
}

describe('the workbook container', () => {
  it('holds exactly the five parts of a minimal xlsx', async () => {
    const parts = await unzipped(SHEET)

    expect([...parts.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ])
  })

  it('declares both parts in [Content_Types].xml', async () => {
    const types = (await unzipped(SHEET)).get('[Content_Types].xml') ?? ''

    expect(types).toContain('Extension="rels"')
    expect(types).toContain(
      'PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"',
    )
    expect(types).toContain(
      'PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"',
    )
  })

  it('relates the package to the workbook and the workbook to the sheet', async () => {
    const parts = await unzipped(SHEET)

    expect(parts.get('_rels/.rels')).toContain('Target="xl/workbook.xml"')
    expect(parts.get('_rels/.rels')).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"',
    )
    const workbook = parts.get('xl/workbook.xml') ?? ''
    expect(workbook).toContain('<sheet name="Devices" sheetId="1" r:id="rId1"/>')
    expect(parts.get('xl/_rels/workbook.xml.rels')).toContain('Target="worksheets/sheet1.xml"')
  })

  it('writes every cell as an inline string at its reference', async () => {
    const sheet = (await unzipped(SHEET)).get('xl/worksheets/sheet1.xml') ?? ''

    expect(sheet).toContain('<row r="1"><c r="A1" t="inlineStr"><is><t>Room</t></is></c>')
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t>Name</t></is></c>')
    expect(sheet).toContain('<row r="2"><c r="A2" t="inlineStr"><is><t>Kitchen</t></is></c>')
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t>Hue bulb</t></is></c>')
  })

  it('omits the cell, rather than writing an empty one, where there is no value', async () => {
    const sheet = (await unzipped(SHEET)).get('xl/worksheets/sheet1.xml') ?? ''

    expect(sheet).toContain('<row r="3"><c r="A3" t="inlineStr"><is><t>Attic</t></is></c></row>')
    expect(sheet).not.toContain('B3')
  })

  it('escapes XML metacharacters in cell text', async () => {
    const sheet = (await unzipped({ name: 'Devices', rows: [['<Lamp & "Birne"> \'97']] })).get(
      'xl/worksheets/sheet1.xml',
    )

    expect(sheet).toContain('&lt;Lamp &amp; &quot;Birne&quot;&gt; &apos;97')
  })

  it('escapes the sheet name where it lands in an attribute', async () => {
    const workbook = (await unzipped({ name: 'A & "B"', rows: [['x']] })).get('xl/workbook.xml')

    expect(workbook).toContain('name="A &amp; &quot;B&quot;"')
  })

  it('drops control characters XML 1.0 cannot carry at all', async () => {
    // Escaping cannot save these: `&#0;` is as ill-formed as a raw NUL, and one such byte
    // would make a spreadsheet application refuse the whole file.
    // \u0000 and \u001F pin both ends of the forbidden range (a narrowed range survives a
    // mid-range probe alone); \u000B sits in the gap between the tab and CR/LF exemptions.
    const sheet = (await unzipped({ name: 'Devices', rows: [['a\u0000b\u001Fc\u000B\td']] })).get(
      'xl/worksheets/sheet1.xml',
    )

    expect(sheet).toContain('<t xml:space="preserve">abc\td</t>')
  })

  it('drops U+FFFE and U+FFFF, which XML 1.0 also excludes', async () => {
    // The other two non-characters escaping cannot save: outside the C0 range, so a control
    // character class alone does not catch them, and one would have a reader refuse the file.
    const sheet = (await unzipped({ name: 'Devices', rows: [['a\uFFFEb\uFFFFc']] })).get(
      'xl/worksheets/sheet1.xml',
    )

    expect(sheet).toContain('<t>abc</t>')
  })

  it('preserves leading and trailing whitespace in a cell', async () => {
    const sheet = (await unzipped({ name: 'Devices', rows: [[' spaced ']] })).get(
      'xl/worksheets/sheet1.xml',
    )

    expect(sheet).toContain('<t xml:space="preserve"> spaced </t>')
  })

  it('columns past Z carry two-letter references', () => {
    const row = Array.from({ length: 28 }, (_, i) => `v${i}`)
    const sheet = decode(
      xlsxEntries({ name: 'Wide', rows: [row] }).find(
        (entry) => entry.name === 'xl/worksheets/sheet1.xml',
      )?.data,
    )

    expect(sheet).toContain('<c r="Z1"')
    expect(sheet).toContain('<c r="AA1"')
    expect(sheet).toContain('<c r="AB1"')
  })

  it('makes the sheet name legal for the format', () => {
    // []:*?/\ are refused by Excel; 31 characters is the hard cap. Sanitised rather than
    // refused, because the name arrives from a translation, not from the user.
    const workbook = decode(
      xlsxEntries({ name: `A/B:C?D*E[F]G\\${'x'.repeat(40)}`, rows: [] }).find(
        (entry) => entry.name === 'xl/workbook.xml',
      )?.data,
    )

    const name = /<sheet name="([^"]*)"/.exec(workbook)?.[1] ?? ''
    expect(name).not.toMatch(/[[\]:*?/\\]/)
    expect(name.length).toBeLessThanOrEqual(31)
    expect(name.length).toBeGreaterThan(0)
  })

  it('still names the sheet when sanitising leaves nothing', () => {
    const workbook = decode(
      xlsxEntries({ name: '///', rows: [] }).find((entry) => entry.name === 'xl/workbook.xml')
        ?.data,
    )

    expect(workbook).toContain('<sheet name="Sheet1"')
  })

  it('is deterministic: the same sheet and timestamp give the same bytes', async () => {
    const first = await writeXlsx(SHEET, codecs, MODIFIED)
    const second = await writeXlsx(SHEET, codecs, MODIFIED)

    expect(first).toEqual(second)
  })
})
