import { describe, expect, it } from 'vitest'
import { cameraProblem } from '../../src/scan/problem.js'

/**
 * A rejection shaped like the platform's.
 *
 * `DOMException` exists in Node, so these are the real thing rather than a duck-typed stand-in
 * — which matters, because the mapping reads `.name`, and a plain object with a `name` field
 * would let a mapping that accidentally depended on the class still pass.
 */
const rejection = (name: string) => new DOMException('the platform said so', name)

describe('what a camera refusal means', () => {
  it.each([
    // The spec's Permission Failure.
    ['NotAllowedError', 'denied'],
    // Not in the current specification at all — it has no occurrences in the published REC —
    // but MDN still documents it and engines have thrown it for media support disabled on the
    // document. Kept as a legacy path, because the cost of handling a name no browser sends is
    // nothing, and the cost of missing one is a real refusal reported as "unknown".
    ['SecurityError', 'denied'],
  ])('reads %s as a refusal the user can reverse', (name, expected) => {
    expect(cameraProblem(rejection(name))).toBe(expected)
  })

  it.each([
    ['NotFoundError', 'no-camera'],
    // A separate interface in the IDL, but one that extends DOMException, and its `name` is
    // this string. Constraints that cannot be satisfied means no camera this application can
    // use, which is what the user needs told.
    ['OverconstrainedError', 'no-camera'],
  ])('reads %s as there being no camera to use', (name, expected) => {
    expect(cameraProblem(rejection(name))).toBe(expected)
  })

  it('reads NotReadableError as a camera that exists but will not open', () => {
    // The spec's wording is specific: "a hardware error such as an OS/program/webpage lock".
    // That is the video-call-already-running case, and it is the one failure the user fixes
    // somewhere other than in this application.
    expect(cameraProblem(rejection('NotReadableError'))).toBe('in-use')
  })

  it('does not read AbortError as the camera being busy', () => {
    // Tempting, and wrong. The spec defines AbortError as the catch-all: "if device access
    // fails for any reason other than those listed above". Telling someone to close their
    // video call because of it would be a guess presented as a diagnosis.
    expect(cameraProblem(rejection('AbortError'))).toBe('unknown')
  })

  it('keeps the four reasons distinct', () => {
    // The point of the whole module. One catch-all message for four different situations is
    // what makes a correctly-behaving application look broken: "camera unavailable" tells
    // someone who denied permission nothing about the permission they can grant.
    const reasons = new Set([
      cameraProblem(rejection('NotAllowedError')),
      cameraProblem(rejection('NotFoundError')),
      cameraProblem(rejection('NotReadableError')),
      cameraProblem(new Error('something else entirely')),
    ])
    expect(reasons.size).toBe(4)
  })

  it('falls back rather than guessing at a name it does not know', () => {
    expect(cameraProblem(rejection('SomeErrorInventedIn2029'))).toBe('unknown')
  })

  it.each([
    ['a plain error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['an object pretending to be one', { name: 'NotAllowedError' }],
  ])('does not mistake %s for a platform rejection', (_case, thrown) => {
    // The last row is the interesting one: something with the right `name` that is not a
    // DOMException did not come from getUserMedia, and treating it as a permission refusal
    // would send the user to a browser setting that is not the problem.
    expect(cameraProblem(thrown)).toBe('unknown')
  })
})
