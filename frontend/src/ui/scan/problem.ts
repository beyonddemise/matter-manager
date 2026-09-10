/**
 * What went wrong when the camera would not open.
 *
 * Four situations, four messages. One catch-all "camera unavailable" is what makes a
 * correctly-behaving application look broken: it tells someone who denied permission nothing
 * about the permission they can grant, and tells someone with a video call running to go
 * looking for a browser setting instead.
 *
 * Pure, and tested in Node: a `DOMException` is a plain value here, and the decision of what a
 * rejection *means* has nothing to do with a camera. The camera itself lives in `source.ts`.
 *
 * Names taken from the Media Capture and Streams specification rather than from recall, which
 * matters more than it looks — a mapping keyed on a name no browser sends reports every real
 * failure as "unknown", and nothing anywhere goes red.
 * https://www.w3.org/TR/mediacapture-streams/
 *
 * @module
 */

/** Why scanning cannot start. */
export type CameraProblem = 'denied' | 'no-camera' | 'in-use' | 'unknown'

/**
 * The rejection names this application can say something useful about.
 *
 * `AbortError` is deliberately absent. It is tempting to read as "the camera is busy", and the
 * specification says the opposite: it is the catch-all for "device access fails for any reason
 * other than those listed above". Telling someone to close their video call because of it
 * would be a guess presented as a diagnosis.
 */
const MEANING: Readonly<Record<string, CameraProblem>> = {
  // Permission Failure. Also, by design, what a *missing* camera looks like before permission
  // has ever been granted: the specification downgrades NotFoundError to this so that a page
  // cannot enumerate hardware it was never allowed to see. So the message for `denied` has to
  // stay true for someone who has no camera at all, which is why it talks about what to do
  // rather than asserting that a camera is there.
  NotAllowedError: 'denied',
  // Not in the current specification — it does not appear in the published REC at all — but
  // MDN still documents it and engines have thrown it when media support is disabled on the
  // document. Handling a name no browser sends costs nothing; missing one reports a real
  // refusal as "unknown".
  SecurityError: 'denied',
  NotFoundError: 'no-camera',
  // A distinct interface in the IDL, but one extending DOMException, and this is its `name`.
  // Constraints that cannot be satisfied means no camera this application can use.
  OverconstrainedError: 'no-camera',
  // "A hardware error such as an OS/program/webpage lock prevents access" — the video call
  // already running, and the one failure the user fixes somewhere other than here.
  NotReadableError: 'in-use',
}

/**
 * Reads a `getUserMedia` rejection.
 *
 * Anything that is not a `DOMException` is `unknown`, including an object carrying the right
 * `name`. Such a thing did not come from `getUserMedia`, and treating it as a permission
 * refusal would send the user to a browser setting that is not the problem.
 *
 * Note that an insecure context does not arrive here at all: `navigator.mediaDevices` is
 * `[SecureContext]`, so on plain HTTP the property is `undefined` and the failure is a
 * `TypeError` at the call site. `source.ts` feature-detects rather than catching it.
 */
export function cameraProblem(error: unknown): CameraProblem {
  // `instanceof` rather than reading `.name` off anything, and that is deliberate — do not
  // "fix" it. What it buys is that an object merely *carrying* the right name cannot be read as
  // a permission refusal. The cost is theoretical: `OverconstrainedError` was not a DOMException
  // in some old Firefox builds, and `source.ts` passes `facingMode` as a plain value rather than
  // `{ exact: … }` precisely so this application can never provoke one.
  if (!(error instanceof DOMException)) return 'unknown'
  return MEANING[error.name] ?? 'unknown'
}
