/**
 * Making text safe for the PDF standard-14 fonts.
 *
 * German is a launch language and Helvetica covers it: ä ö ü Ä Ö Ü ß are all in WinAnsi, and
 * M3-4's test extracts them back out of a generated document to prove it. But the application
 * is not German-only, and rooms and devices are named by whoever owns the house. A `Łazienka`
 * or a `Кухня` is one keystroke away.
 *
 * Without this, such a name does not render badly — **it throws, and the entire export fails.**
 * `pdf-lib` raises `WinAnsi cannot encode "Ł" (0x0141)`, so one character in one device's name
 * loses an inventory of two hundred devices. That is a far worse outcome than the boxes and
 * blanks the issue warns about, and it is what this module exists to prevent.
 *
 * **This is a stopgap, and the shape of the real fix is known.** Embedding a Unicode font
 * (`@pdf-lib/fontkit` plus a font file) makes all of this unnecessary and costs about a
 * megabyte of payload in an application that is deliberately small and works offline. That is
 * a decision with a real trade-off and belongs with the branding work in M8, not smuggled in
 * here. Until then: the accent is dropped where a letter survives without it, and anything
 * with no Latin form becomes a visible `?` rather than a silent nothing.
 *
 * The pairing code is unaffected in every case — digits are ASCII — and that is what makes a
 * degraded entry still a usable one.
 *
 * @module
 */

/**
 * The characters WinAnsi can represent.
 *
 * Latin-1's printable range, plus the 27 typographic characters WinAnsi puts in 0x80–0x9F
 * where Latin-1 has control codes. Built once as a set rather than checked with a range test,
 * because the 0x80–0x9F block is exactly where a range test would be wrong.
 */
const ENCODABLE: ReadonlySet<string> = new Set([
  // 0x20–0x7E and 0xA0–0xFF, the two printable Latin-1 runs.
  ...Array.from({ length: 0x7f - 0x20 }, (_, index) => String.fromCharCode(0x20 + index)),
  ...Array.from({ length: 0x100 - 0xa0 }, (_, index) => String.fromCharCode(0xa0 + index)),
  // WinAnsi's own 0x80–0x9F.
  ...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ',
])

/**
 * Latin letters that carry no decomposable accent, so stripping marks does not reach them.
 *
 * Short and deliberately not a transliteration table: this is "the same letter without its
 * decoration", not "how this language is written in Latin script". Romanising Cyrillic or
 * Greek is a linguistic decision with several defensible answers, and guessing at one would
 * produce a document that looks authoritative and is wrong.
 */
const PLAIN_FORM: Readonly<Record<string, string>> = {
  Ł: 'L',
  ł: 'l',
  Đ: 'D',
  đ: 'd',
  Ħ: 'H',
  ħ: 'h',
  Ŧ: 'T',
  ŧ: 't',
  Ŋ: 'N',
  ŋ: 'n',
  ı: 'i',
  ĸ: 'k',
  ſ: 's',
  Ə: 'E',
  ə: 'e',
}

/** What replaces a character with no Latin form at all. Visible, deliberately. */
export const UNREPRESENTABLE = '?'

/**
 * Rewrites text so the standard-14 fonts can draw it.
 *
 * Returns the input unchanged when it is already representable, which is the case for every
 * English and German string in the application — so the common path costs one scan and no
 * allocation beyond it.
 */
export function winAnsiSafe(text: string): string {
  if ([...text].every((character) => ENCODABLE.has(character))) return text

  let out = ''
  for (const character of text) {
    if (ENCODABLE.has(character)) {
      out += character
      continue
    }

    const plain = PLAIN_FORM[character]
    if (plain !== undefined) {
      out += plain
      continue
    }

    // Decomposed, with the combining marks removed: `ě` is `e` plus a caron, and `e` is a
    // letter the reader can still use. This is what makes a Czech or Polish room name
    // readable rather than a row of question marks.
    const stripped = character.normalize('NFD').replace(/\p{M}/gu, '')
    out +=
      stripped !== '' && [...stripped].every((part) => ENCODABLE.has(part))
        ? stripped
        : UNREPRESENTABLE
  }
  return out
}

/** Whether the standard fonts can draw this text as written. For telling the user it cannot. */
export function isWinAnsiSafe(text: string): boolean {
  return [...text].every((character) => ENCODABLE.has(character))
}
