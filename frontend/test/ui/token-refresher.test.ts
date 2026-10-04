import { describe, expect, it } from 'vitest'
import type { TokenOutcome } from '../../src/ui/composition.js'
import {
  BACKOFF_CAP_MS,
  backoffDelay,
  MIN_REFRESH_DELAY_MS,
  refreshDelay,
  startRefresher,
} from '../../src/ui/token-refresher.js'

/** A clock-free scheduler: tasks run only when the test says so. */
function harness(outcomes: (TokenOutcome | Error)[]) {
  let clock = 0
  const visibleHandlers: (() => void)[] = []
  const signals: AbortSignal[] = []
  const timers: { run: () => void; ms: number }[] = []
  const onlineHandlers: (() => void)[] = []
  const seen: TokenOutcome[] = []
  const refresher = startRefresher({
    request: async (signal) => {
      signals.push(signal)
      const next = outcomes.shift() ?? { kind: 'refreshed', expiresIn: 300 }
      if (next instanceof Error) throw next
      return next
    },
    onOutcome: (o) => seen.push(o),
    schedule: (run, ms) => {
      const t = { run, ms }
      timers.push(t)
      return () => timers.splice(timers.indexOf(t), 1)
    },
    onOnline: (run) => {
      onlineHandlers.push(run)
      return () => onlineHandlers.splice(onlineHandlers.indexOf(run), 1)
    },
    onVisible: (run) => {
      visibleHandlers.push(run)
      return () => visibleHandlers.splice(visibleHandlers.indexOf(run), 1)
    },
    now: () => clock,
    random: () => 1,
  })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const advance = (ms: number) => {
    clock += ms
  }
  return { timers, onlineHandlers, visibleHandlers, signals, advance, seen, refresher, flush }
}

describe('backoffDelay', () => {
  it('doubles from one second and stops at sixty', () => {
    expect([0, 1, 2, 3, 10].map((a) => backoffDelay(a, () => 1))).toEqual([
      1000,
      2000,
      4000,
      8000,
      BACKOFF_CAP_MS,
    ])
  })

  it('jitters downward by at most half', () => {
    expect(backoffDelay(2, () => 0)).toBe(2000)
  })
})

describe('refreshDelay', () => {
  it('refreshes two margins before expiry, so the token is never withheld before its successor', () => {
    expect(refreshDelay(300)).toBe(240_000)
  })

  it('never schedules sooner than the floor', () => {
    expect(refreshDelay(31)).toBe(MIN_REFRESH_DELAY_MS)
  })
})

describe('startRefresher', () => {
  it('schedules the next refresh before the token expires', async () => {
    const h = harness([{ kind: 'refreshed', expiresIn: 300 }])
    await h.flush()
    expect(h.timers.at(-1)?.ms).toBe((300 - 60) * 1000)
  })

  it('retries silently with backoff while unreachable, never reporting it as ended', async () => {
    const h = harness([{ kind: 'unreachable' }, { kind: 'unreachable' }])
    await h.flush()
    expect(h.timers.at(-1)?.ms).toBe(1000)
    h.timers.at(-1)?.run()
    await h.flush()
    expect(h.timers.at(-1)?.ms).toBe(2000)
    expect(h.seen.some((o) => o.kind === 'ended')).toBe(false)
  })

  it('retries at once when the browser comes back online, and resets the backoff', async () => {
    const h = harness([{ kind: 'unreachable' }, { kind: 'unreachable' }, { kind: 'unreachable' }])
    await h.flush()
    h.timers.at(-1)?.run()
    await h.flush()
    for (const run of h.onlineHandlers) run()
    await h.flush()
    expect(h.timers.at(-1)?.ms).toBe(1000)
  })

  it('stops after an authentication failure and reports it once', async () => {
    const h = harness([{ kind: 'ended' }])
    await h.flush()
    expect(h.seen).toEqual([{ kind: 'ended' }])
    expect(h.timers).toHaveLength(0)
  })

  it('stops after signed-out without scheduling anything', async () => {
    const h = harness([{ kind: 'signed-out' }])
    await h.flush()
    expect(h.timers).toHaveLength(0)
  })

  it('treats a request that throws as unreachable, never as an unhandled rejection', async () => {
    // `request` can fail after it changed state, e.g. the token store rejecting a write.
    const h = harness([new Error('store.write rejected')])
    await h.flush()
    expect(h.seen).toEqual([{ kind: 'unreachable' }])
    expect(h.timers.at(-1)?.ms).toBe(1000)
  })

  it('cancels the pending refresh and the online subscription when stopped', async () => {
    const h = harness([{ kind: 'refreshed', expiresIn: 300 }])
    await h.flush()
    h.refresher.stop()
    expect(h.timers).toHaveLength(0)
    expect(h.onlineHandlers).toHaveLength(0)
  })

  it('reports nothing from a request that was still in flight when stopped', async () => {
    const h = harness([{ kind: 'refreshed', expiresIn: 300 }])
    h.refresher.stop()
    await h.flush()
    expect(h.seen).toEqual([])
    expect(h.timers).toHaveLength(0)
  })

  it('aborts the signal handed to a request in flight when stopped', async () => {
    const h = harness([{ kind: 'refreshed', expiresIn: 300 }])
    expect(h.signals[0]?.aborted).toBe(false)
    h.refresher.stop()
    expect(h.signals[0]?.aborted).toBe(true)
  })

  it('refreshes at once on becoming visible when the refresh is overdue', async () => {
    const h = harness([
      { kind: 'refreshed', expiresIn: 300 },
      { kind: 'refreshed', expiresIn: 300 },
    ])
    await h.flush()
    h.advance(240_000)
    for (const run of h.visibleHandlers) run()
    await h.flush()
    expect(h.seen).toHaveLength(2)
  })

  it('leaves a refresh that is not yet due alone when the page becomes visible', async () => {
    const h = harness([{ kind: 'refreshed', expiresIn: 300 }])
    await h.flush()
    h.advance(1000)
    for (const run of h.visibleHandlers) run()
    await h.flush()
    expect(h.seen).toHaveLength(1)
  })
})
