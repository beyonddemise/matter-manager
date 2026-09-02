import { describe, expect, it } from 'vitest'

/**
 * In the browser project rather than beside the rest of the connectivity tests, because the
 * whole question is what a *browser's* `navigator` carries. Node has a `navigator` and it has no
 * `onLine`, so asserting this in Node would fail for the environment rather than the code.
 */

describe('the browser as a source', () => {
  it('answers with a boolean rather than nothing at all', async () => {
    // The exact shape of the bug. `online` and `offline` fire on `window`; `onLine` is a
    // property of `navigator`. Passing `window` alone made `source.onLine` `undefined`, and
    // `undefined !== false` is `true` — so the offline indicator reported a network however
    // offline the browser was.
    //
    // Asserted as a *type* rather than against `navigator.onLine`, which would compare the
    // helper to itself. `undefined` is what was wrong, and `undefined` is what this refuses.
    // Found by the end-to-end suite (#57): every unit test here injected a source that had the
    // property, so none of them could have caught the one that did not.
    const { browserConnectivity } = await import('../src/connectivity.js')
    expect(typeof browserConnectivity().onLine).toBe('boolean')
  })

  it('reads it afresh each time rather than capturing it', async () => {
    // The object is built once at startup. A captured value would answer the same thing
    // forever, which is the same bug wearing a different hat.
    const { browserConnectivity } = await import('../src/connectivity.js')
    const source = browserConnectivity()
    const descriptor = Object.getOwnPropertyDescriptor(source, 'onLine')
    expect(descriptor?.get).toBeTypeOf('function')
  })
})
