/**
 * Filling in manufacturer and product for devices added offline (#228).
 *
 * A device added in a basement has no names: the lookup never ran. This asks the catalogue for
 * each such device once a session and a network exist, and writes the answer into the device as
 * a new revision, so it syncs and merges like any other (`mergeDevice` keeps the newer block).
 *
 * **Polite by construction.** One request at a time, a second between requests, stop at the
 * first sign the API cannot help (offline, signed out), and on 429 wait as long as asked. The
 * next trigger (sign-in, network back, project switch) starts again from the top; the device
 * documents themselves record what is done, so there is no queue to persist.
 *
 * **Writes only the catalogue block**, on a fresh read, through `devices.saveKeepingUpdatedAt`:
 * the device's `updatedAt` stays as it was, so the write never outranks a user's edit in the
 * merge; the block has its own clock, `catalogCheckedAt`. A save refused because somebody
 * edited the device in the meantime is left alone: their edit stands, and the next run fills
 * the block on top of it.
 *
 * Nothing is logged: every document here carries a setup code.
 *
 * @module
 */

import { isConflict, type Repository } from '../data/index.js'
import {
  type CatalogFields,
  catalogFields,
  type DeviceDocument,
  needsCatalogLookup,
  withCatalogBlock,
} from '../domain/index.js'
import type { CatalogApi } from './catalog.js'
import { catalog } from './composition.js'
import { projectDatabase, projectIsEditable } from './db/project-database.js'

/** The pause between two requests. */
export const BACKFILL_GAP_MS = 1000

/** What backfill needs; every impure thing is injected so the tests control time and network. */
export interface BackfillDependencies {
  readonly lookup: CatalogApi['lookup']
  /** The open project's devices, read at the start of each run. */
  readonly devices: () => Repository<DeviceDocument>
  /** Whether the open project may be written; a read-only shared project is never backfilled. */
  readonly editable: () => boolean
  readonly now: () => Date
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
}

/** A running backfill, as the shell holds it. */
export interface CatalogBackfill {
  /** Starts a run, or asks for one more after the current run. Never runs two at once. */
  trigger(): void
  /** Aborts the current run and forgets any pending one. Nothing is written after this. */
  stop(): void
  /** Settles when no run is in progress. For tests. */
  idle(): Promise<void>
}

/** A `setTimeout` that ends early, and quietly, when the signal aborts. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** The block for a code the API refuses: when it was tried, and that it cannot be read. */
const unusableBlock = (checkedAt: string): Partial<CatalogFields> => ({
  catalogCheckedAt: checkedAt,
  catalogSource: 'unusable',
})

/** What to send: the payload if there is one, else the digits of the manual code. */
const codeOf = (device: DeviceDocument): string => device.payload ?? device.manualCode

/**
 * Writes one catalogue block into one device, on a fresh read.
 *
 * Re-read rather than written over the listed copy: the list may be seconds old, and saving it
 * would quietly revert whatever was edited since. Checked again with `needsCatalogLookup`, so a
 * block written meanwhile by another tab or replica is not replaced by this answer.
 *
 * @param block the catalogue fields to write, built from the time it is given
 * @throws whatever `devices.saveKeepingUpdatedAt` throws, except a 409; the caller ends the pass on it
 */
async function fill(
  devices: Repository<DeviceDocument>,
  id: string,
  block: (checkedAt: string) => Partial<CatalogFields>,
  deps: BackfillDependencies,
  signal: AbortSignal,
): Promise<void> {
  const fresh = await devices.get(id)
  if (signal.aborted || fresh === undefined) return
  const at = deps.now()
  if (!needsCatalogLookup(fresh, at)) return
  try {
    // Keeps `updatedAt`: filling the block is not an edit, and a restamp would let this write,
    // made on a stale copy, outrank a newer rename or move in `mergeDevice` (ruling R26).
    await devices.saveKeepingUpdatedAt(withCatalogBlock(fresh, block(at.toISOString())))
  } catch (error) {
    // A 409: the device changed between the read and the write. The edit stands; the next run
    // fills the block on top of it. Anything else (quota, a broken database) is not this
    // device's problem alone, so it ends the pass. Not logged: the document holds the setup code.
    if (!isConflict(error)) throw error
  }
}

/** One pass over the open project. Returns early at the first reason to stop. */
async function runOnce(deps: BackfillDependencies, signal: AbortSignal): Promise<void> {
  if (!deps.editable()) return
  const devices = deps.devices()
  const listed = await devices.list()
  const now = deps.now()
  const candidates = listed.filter((device) => needsCatalogLookup(device, now))

  let first = true
  for (const candidate of candidates) {
    for (;;) {
      if (!first) await deps.wait(BACKFILL_GAP_MS, signal)
      first = false
      if (signal.aborted) return

      const outcome = await deps.lookup(codeOf(candidate), signal)
      if (signal.aborted) return

      if (outcome.kind === 'rate-limited') {
        // The budget is shared with the add form (see `catalog.ts`), so a 429 here may be the
        // user's own lookups, not this pass; waiting as asked is right either way.
        await deps.wait(outcome.retryAfterSeconds * 1000, signal)
        // The retry-after already was the pause; the same device is asked again at once.
        first = true
        continue
      }
      // Offline, a 5xx, or no session: nothing later in this pass would fare better.
      if (outcome.kind === 'unavailable' || outcome.kind === 'signed-out') return
      if (outcome.kind === 'found') {
        const { lookup } = outcome
        await fill(devices, candidate._id, (at) => catalogFields(lookup, at), deps, signal)
      } else {
        // `unusable` (400/422): the API will never read this stored code. It is marked so that
        // `needsCatalogLookup` skips it from now on, instead of sending it on every trigger.
        await fill(devices, candidate._id, unusableBlock, deps, signal)
      }
      break
    }
  }
}

/**
 * The backfill runner.
 *
 * Coalesces triggers: one arriving mid-run asks for exactly one more run afterwards, which is
 * what a project switch during a run needs (stop, then a run over the new project).
 */
export function catalogBackfill(deps: BackfillDependencies): CatalogBackfill {
  let controller: AbortController | undefined
  let running: Promise<void> | undefined
  let again = false

  const loop = async (): Promise<void> => {
    do {
      again = false
      controller = new AbortController()
      try {
        await runOnce(deps, controller.signal)
      } catch {
        // An unreadable database, or a save refused for a reason other than a conflict: the
        // pass ends here. The next trigger tries again; nothing is logged (secrets).
      }
    } while (again)
    running = undefined
  }

  return {
    trigger(): void {
      if (running !== undefined) {
        again = true
        return
      }
      running = loop()
    },
    stop(): void {
      again = false
      controller?.abort()
    },
    idle: () => running ?? Promise.resolve(),
  }
}

/** The application's backfill: the real API, the open project, the system clock. */
export function defaultCatalogBackfill(): CatalogBackfill {
  const api = catalog()
  return catalogBackfill({
    lookup: (code, signal) => api.lookup(code, signal),
    devices: () => projectDatabase().devices,
    editable: projectIsEditable,
    now: () => new Date(),
    wait: abortableDelay,
  })
}
