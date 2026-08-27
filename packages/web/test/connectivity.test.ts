import { describe, expect, it } from 'vitest'
import { type ConnectivitySource, watchConnectivity } from '../src/connectivity.js'

/** A `window` with a network state a test can change. */
function fakeSource(onLine = true) {
  const listeners = new Map<string, Set<() => void>>()
  return {
    onLine,
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener)
    },
    /** Loses or regains the network, as the browser reports it. */
    go(online: boolean) {
      this.onLine = online
      for (const listener of listeners.get(online ? 'online' : 'offline') ?? []) listener()
    },
    listening: () => (listeners.get('online')?.size ?? 0) + (listeners.get('offline')?.size ?? 0),
  }
}

const watch = (source: ReturnType<typeof fakeSource>, onChange: (online: boolean) => void) =>
  watchConnectivity(source as unknown as ConnectivitySource, onChange)

describe('watching for a network', () => {
  it('reports the state it starts in, before anything has changed', () => {
    // A page loaded while already offline fires no event at all. An indicator that appeared
    // only on a transition would be missing precisely when it is most true.
    const seen: boolean[] = []
    watch(fakeSource(false), (online) => seen.push(online))

    expect(seen).toEqual([false])
  })

  it('reports losing the network', () => {
    const source = fakeSource(true)
    const seen: boolean[] = []
    watch(source, (online) => seen.push(online))

    source.go(false)

    expect(seen).toEqual([true, false])
  })

  it('reports getting it back', () => {
    const source = fakeSource(false)
    const seen: boolean[] = []
    watch(source, (online) => seen.push(online))

    source.go(true)

    expect(seen).toEqual([false, true])
  })

  it('treats a source that cannot say as online', () => {
    // Assuming a network exists is the assumption that blocks nothing, and nothing here is
    // blocked on connectivity anyway.
    const seen: boolean[] = []
    const source = fakeSource()
    const withoutOnLine = { ...source, onLine: undefined } as unknown as ConnectivitySource

    watchConnectivity(withoutOnLine, (online) => seen.push(online))

    expect(seen).toEqual([true])
  })

  it('stops watching when asked', () => {
    const source = fakeSource(true)
    const seen: boolean[] = []
    const stop = watch(source, (online) => seen.push(online))

    stop()
    source.go(false)

    expect(seen).toEqual([true])
    expect(source.listening()).toBe(0)
  })
})
