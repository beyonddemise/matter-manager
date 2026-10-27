/**
 * Writing a workbook (`.xlsx`) with one sheet of text cells.
 *
 * **Written by hand rather than through an xlsx library, and that is a decision this module
 * records (#295).** ADR 0013 allows a runtime dependency only where the platform is genuinely
 * insufficient, and here it is not: an xlsx file is a zip of small XML parts, the repository
 * already owns the zip container (`archive/zip.ts`, itself written instead of a library), and
 * the subset this export needs — inline strings in one sheet — is the hundred lines below. The
 * allowlist in ADR 0013 therefore stays unchanged; ADR 0018 (our own QR encoder) is the
 * precedent for owning a small, fully-specified format outright.
 *
 * The parts are the minimal set a consumer requires (ECMA-376; verified against LibreOffice
 * and Excel's reader): `[Content_Types].xml`, the package relationships, the workbook, its
 * relationships, and the one worksheet. Every cell is an **inline string** (`t="inlineStr"`),
 * so no shared-strings table exists to keep consistent, and no styles part is needed because
 * nothing is styled.
 *
 * Dates are written as ISO text, not as serial-date cells — `xlsx/sheet.ts` says why.
 *
 * Like the zip it rides in, this reaches for nothing ambient: the deflate arrives as
 * {@link ZipCodecs}, so the web layer supplies `CompressionStream` and the tests Node's zlib.
 *
 * @module
 */

import { writeZip, type ZipCodecs, type ZipEntry } from '../archive/zip.js'
import { encodeUtf8 } from '../text/utf8.js'

/** One sheet: its tab name, and its rows of text cells. An empty cell is omitted from the file. */
export interface Worksheet {
  readonly name: string
  readonly rows: readonly (readonly string[])[]
}

/**
 * Characters XML 1.0 cannot carry at all, raw or as references: C0 controls bar tab, LF, CR.
 *
 * Escaping cannot save these — `&#0;` is as ill-formed as a raw NUL — and one such character
 * would make a spreadsheet application refuse the whole file, so they are dropped.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is this line's job
const UNREPRESENTABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/** Text made safe for XML content and attribute values alike. */
function escaped(value: string): string {
  return value
    .replace(UNREPRESENTABLE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * A column's letters, 0-based: 0 → `A`, 25 → `Z`, 26 → `AA`.
 *
 * Bijective base 26 — there is no zero digit, which is why the plain radix conversion that
 * looks obviously right here is wrong from column 26 on.
 */
function columnOf(index: number): string {
  let letters = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(0x41 + ((n - 1) % 26)) + letters
  }
  return letters
}

/**
 * One cell as an inline string, or nothing for an empty value: a cell that says nothing is
 * absent in the format's own idiom, and what a reader sees either way is an empty cell.
 *
 * `xml:space="preserve"` wherever default attribute handling could eat whitespace — leading,
 * trailing, or a tab — so a spot like ` ceiling ` survives the round trip as typed.
 */
function cell(reference: string, value: string): string {
  if (value === '') return ''
  const text = escaped(value)
  const fragile = text !== text.trim() || /[\t\n\r]/.test(text)
  const space = fragile ? ' xml:space="preserve"' : ''
  return `<c r="${reference}" t="inlineStr"><is><t${space}>${text}</t></is></c>`
}

/**
 * The tab's name, made legal: the format refuses `[ ] : * ? / \` and anything over 31
 * characters. Sanitised rather than refused, because the name arrives from a translation.
 */
function sheetName(name: string): string {
  const legal = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31)
    .trim()
  return legal === '' ? 'Sheet1' : legal
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006'
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006'
const SPREADSHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml'

/**
 * The five parts of the workbook, as entries for {@link writeZip}.
 *
 * Exposed apart from {@link writeXlsx} so a test can read a part without inflating a zip; the
 * application calls {@link writeXlsx}.
 */
export function xlsxEntries(sheet: Worksheet): readonly ZipEntry[] {
  const contentTypes =
    `${XML_DECLARATION}\n<Types xmlns="${PACKAGE}/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="${SPREADSHEET}.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${SPREADSHEET}.worksheet+xml"/>` +
    `</Types>`

  const packageRels =
    `${XML_DECLARATION}\n<Relationships xmlns="${PACKAGE}/relationships">` +
    `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT}/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`

  const workbook =
    `${XML_DECLARATION}\n<workbook xmlns="${MAIN}" xmlns:r="${OFFICE_DOCUMENT}/relationships">` +
    `<sheets><sheet name="${escaped(sheetName(sheet.name))}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`

  const workbookRels =
    `${XML_DECLARATION}\n<Relationships xmlns="${PACKAGE}/relationships">` +
    `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT}/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`

  const body = sheet.rows
    .map((row, rowIndex) => {
      const cells = row.map((value, column) => cell(`${columnOf(column)}${rowIndex + 1}`, value))
      return `<row r="${rowIndex + 1}">${cells.join('')}</row>`
    })
    .join('')
  const worksheet = `${XML_DECLARATION}\n<worksheet xmlns="${MAIN}"><sheetData>${body}</sheetData></worksheet>`

  return [
    { name: '[Content_Types].xml', data: encodeUtf8(contentTypes) },
    { name: '_rels/.rels', data: encodeUtf8(packageRels) },
    { name: 'xl/workbook.xml', data: encodeUtf8(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: encodeUtf8(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: encodeUtf8(worksheet) },
  ]
}

/**
 * The finished `.xlsx` bytes.
 *
 * @param sheet the one sheet
 * @param codecs deflate, injected as everywhere in `archive/`
 * @param modified the timestamp every zip entry carries, so two exports of the same data at
 *   the same moment are byte-identical
 */
export async function writeXlsx(
  sheet: Worksheet,
  codecs: Pick<ZipCodecs, 'deflate'>,
  modified: Date,
): Promise<Uint8Array> {
  return writeZip(xlsxEntries(sheet), codecs, modified)
}
