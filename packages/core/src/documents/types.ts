/**
 * The shapes stored in a `project_<uuid>` database.
 *
 * They live in `core` rather than in `data` because `packages/api` reads and writes the same
 * documents from M4 onwards. A second definition of the device shape would be a schema that
 * can drift silently against itself, with nothing failing until two halves of the application
 * disagree about a field neither one wrote.
 *
 * See [docs/DATA-MODEL.md](../../../../docs/DATA-MODEL.md) for the documents in context.
 *
 * @module
 */

import type { Remark, RemarkBearing, Revision } from '../sync/merge.js'

/**
 * A document that has not been written yet, or is about to be written again.
 *
 * One type covers both: a first write has no `_rev`, an update carries the one it read.
 *
 * `updatedAt` is removed rather than made optional, so a caller **cannot** supply it. That is a
 * constraint, not a convenience. `updatedAt` is half of the total order the conflict merge
 * depends on (ADR 0010), and a document written without one does not fail — it quietly loses
 * every future conflict against a correctly stamped one. The repository owns the stamp, so
 * there is no way to forget it.
 */
export type Unsaved<T extends Revision> = Omit<T, '_rev' | 'updatedAt'> & {
  readonly _rev?: string
}

/**
 * A device: the QR code, plus everything that makes it findable again years later.
 *
 * Extends `RemarkBearing` rather than redeclaring `_id`, `_rev`, `updatedAt` and `remarks`, so
 * that `mergeDevice` accepts one of these directly. The conflict strategies and the documents
 * they merge are then the same type rather than two shapes that happen to look alike.
 */
export interface DeviceDocument extends RemarkBearing {
  readonly type: 'device'
  readonly name: string
  /** A full `room:<uuid>` document id, so it can be passed straight to `get`. */
  readonly roomId: string
  /** Free text the room name cannot carry: "ceiling, north end". */
  readonly spot?: string

  /**
   * The `MT:` onboarding payload.
   *
   * **A secret.** It contains the setup passcode. Never log it, never send it to a third party
   * (the DCL lookup sends vendor and product ids only), never put it in a bug report.
   */
  readonly payload: string
  readonly manualCode: string
  readonly vendorId: number
  readonly productId: number
  readonly discriminator: number

  readonly vendorName?: string
  readonly productName?: string
  readonly deviceTypeId?: number

  readonly serial?: string
  /** A calendar date, `YYYY-MM-DD`. Defaults to the scan date. */
  readonly installedAt: string
  readonly addedAt: string
  readonly disabled: boolean
  readonly disabledAt?: string

  /**
   * Always present, possibly empty - narrowed from `RemarkBearing`, where it is optional
   * because the merge must also accept a room. A device with no remarks has `[]`, so no caller
   * has to decide what a missing array means.
   */
  readonly remarks: readonly Remark[]
}

/**
 * A room, identified by a materialised path (ADR 0006).
 *
 * There is no `parentId`. Hierarchy is derived by splitting `path`, which is precisely why
 * there are no reparenting conflicts to resolve under offline sync.
 */
export interface RoomDocument extends Revision {
  readonly type: 'room'
  /** `"Ground Floor/Kitchen"`, separator-delimited per ADR 0006. */
  readonly path: string
  readonly sortKey?: number
}
