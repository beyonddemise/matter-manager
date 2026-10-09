/**
 * The manufacturer's name as the interface shows it.
 *
 * Every manufacturer name comes from the catalogue except one: `TEST_VENDOR_NAME`, which the
 * application writes itself for the test vendors (0xFFF1–0xFFF4) the DCL never lists. It is
 * stored in English, because it is data: it syncs, it is searched, and a document must not
 * change when the person who wrote it changes language. It is translated here, when it is
 * shown, which is the one place that knows both the stored value and the interface language.
 *
 * Takes the translation rather than calling `msg()`, so the PDF writer, which receives every
 * word it prints from its caller, can use it too.
 *
 * @module
 */

import { TEST_VENDOR_NAME } from '../../domain/index.js'

/**
 * `name`, with the stored test-vendor name replaced by `testVendor`.
 *
 * @param name the manufacturer as stored, or `undefined` when none is known
 * @param testVendor "Test vendor" in the interface language, e.g. `msg('Test vendor')`
 * @returns the name to show; `undefined` stays `undefined`, so the caller keeps its fallback
 */
export function shownManufacturer(
  name: string | undefined,
  testVendor: string,
): string | undefined {
  return name === TEST_VENDOR_NAME ? testVendor : name
}
