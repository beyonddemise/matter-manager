/**
 * What an export reports while it runs, and how it says it was stopped.
 *
 * Both of these lived in `inventory.ts`, beside the code that raises them. They are here instead
 * for one reason: **`inventory.ts` imports `pdf-lib`, and this module must not.**
 *
 * `device-list.ts` loads the two PDF builders on demand — `pdf-lib`, its standard-font tables,
 * `@pdf-lib/upng` and `pako` come to 408 kB, which is 40% of the bundle every visitor downloads,
 * for a feature reached by pressing Export. But the view still needs `ExportCancelled` at the
 * top level, because it appears in a `catch` that has to run whether or not the dynamic import
 * resolved, and `instanceof` needs the real class rather than a type. Importing it from
 * `inventory.ts` would pull `pdf-lib` back into the entry chunk through the type-only door and
 * undo the split in silence — a bigger first load with nothing anywhere turning red.
 *
 * So: one tiny module, no dependencies, statically imported by both sides. There is exactly one
 * `ExportCancelled` class, which is what `instanceof` across a chunk boundary requires.
 *
 * `scripts/check-lazy-pdf.mjs` fails the build if `pdf-lib` reaches the entry bundle again.
 *
 * @module
 */

/** Progress, so a long export can say what it is doing. */
export interface InventoryProgress {
  readonly done: number
  readonly total: number
}

/** Thrown when an export's `cancelled` callback asked for a stop. */
export class ExportCancelled extends Error {
  override readonly name = 'ExportCancelled'
}
