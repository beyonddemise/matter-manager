/**
 * Folding text so that two spellings a person would read as the same compare as the same.
 *
 * Extracted from `roomPathKey`, which had this logic inline and is now one caller of it. The
 * other is device search: "does this device match what was typed" and "is this the room that
 * already exists" are the same question about text, and answering them two different ways
 * would mean a search that fails to find the room the duplicate check just refused to create.
 *
 * @module
 */

/**
 * The key under which two pieces of text count as the same to a human reading them.
 *
 * Runs of whitespace collapsed, case folded, Unicode composed — in that order, because case
 * folding can decompose.
 *
 * The Unicode step matters more than it looks. `ü` has two spellings — one code point, or `u`
 * followed by a combining diaeresis — which render identically. In a German-speaking house,
 * typing one and pasting the other would otherwise produce two rooms nobody can tell apart on
 * screen, and a search for one that never finds the other.
 *
 * Case is *folded*, not merely lowered. `toLowerCase` implements Unicode case **conversion**,
 * which preserves linguistic distinctions on purpose; folding erases them so two spellings of
 * one word compare equal. The difference is not academic here: `Straße`.toLowerCase() is
 * `straße` and `STRASSE`.toLowerCase() is `strasse`, so the same German room would fail to be
 * recognised as a duplicate of itself. Upper-casing collapses `ß` to `SS`, the Greek final
 * sigma to the medial form, and ligatures to their letters.
 *
 * Upper rather than lower, and nothing after it: lowering the result again was measured to
 * change no comparison, so it was removed. The key is never displayed — it exists only to be
 * equal or not.
 *
 * **This is case conversion used as a fold, not Unicode `Case_Folding`.** The measured
 * difference is the Turkish dotless `ı`, which upper-cases to `I` and so matches `i` here,
 * where true folding keeps them apart. Accepted, for three reasons: the consequences are one
 * extra duplicate-room warning and one extra search hit, rather than a merge or any data loss;
 * JavaScript exposes no `toCaseFold`, so real folding means shipping the `CaseFolding.txt`
 * table against ADR 0013; and the obvious substitute is worse where it counts —
 * `Intl.Collator` at `sensitivity: 'accent'` reports `Straße` and `STRASSE` as *different*,
 * failing the German case this fold exists for.
 *
 * Revisit if Turkish is ever a supported locale, where `ı` and `i` are separate letters. The
 * test pinning that pair will fail and force the decision rather than letting it drift.
 */
export function foldForComparison(text: string): string {
  return text.replace(/\s+/g, ' ').toUpperCase().normalize('NFC')
}
