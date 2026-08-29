/**
 * The sentence for a domain problem code, in the language the interface is showing.
 *
 * `packages/core` reports **codes** rather than sentences, because it is imported by
 * `packages/api` as well and a translation runtime belongs in neither a pure domain layer nor
 * a server. It still carries an English sentence on every error, which is the right thing for
 * a log or an API response and the wrong thing to put on a German screen (#75).
 *
 * This module is where a code becomes a sentence. It is the only place that knows both.
 *
 * **A switch, not a lookup table.** The table would have to be built at module scope, and
 * `msg()` resolves against whichever locale is active *when it is called* — so a table would
 * freeze every sentence into whatever language happened to be loaded at import time, and a
 * locale switch would leave these strings behind while the rest of the page changed. Calling
 * `msg()` inside the function is what makes them follow.
 *
 * @module
 */

import { msg } from '@lit/localize'
import type { DraftProblem } from '@matter-manager/core'

/**
 * The fallback for a code this build does not know.
 *
 * Unreachable while the switch below is exhaustive, which the compiler enforces: adding a
 * member to `DraftProblem` without adding a case here makes `problem` something other than
 * `never` and this call stops type-checking.
 *
 * It returns rather than throws on purpose. This runs inside a render, and the situation it
 * would be reached in — a stale bundle meeting a newer code — is one where a vague sentence is
 * a far better outcome for the user than a blank screen.
 */
function unknownProblem(_problem: never): string {
  return msg('This could not be read. Check it against what is printed on the device.')
}

/** What a problem code means to the person looking at the form. */
export function problemMessage(problem: DraftProblem): string {
  switch (problem) {
    // The form's own fields.
    case 'nameEmpty':
      return msg('A device needs a name; that is what makes it findable later.')
    case 'roomPathEmpty':
      return msg('A device needs a room. Type a name to create one, or pick an existing room.')
    case 'roomPathEmptySegment':
      return msg(
        'A room path is one or more names separated by "/", so "Ground Floor/Kitchen" works but a doubled or trailing "/" does not.',
      )
    case 'installedAtNotACalendarDate':
      return msg('The installation date must be a real calendar date.')
    case 'remarkEmpty':
      return msg('A remark needs some text; there is nothing to record yet.')

    // The setup code, in the two forms it comes in. These are kept apart rather than collapsed
    // into "the code is wrong" because they call for different things from the reader: count
    // the digits, check a character, or look for a different sticker altogether.
    case 'emptySetupCode':
      return msg('Enter the setup code printed on the device or its packaging.')
    case 'notASetupCode':
      return msg(
        'A setup code is either a Matter code beginning with "MT:" or a manual pairing code of 11 or 21 digits. This is neither.',
      )
    case 'missingPrefix':
      return msg('A Matter code begins with "MT:". This one does not.')
    case 'emptyPayload':
      return msg('Nothing follows "MT:", so there is no code here to read.')
    case 'notBase38':
      return msg(
        'This looks like a Matter code but contains characters one cannot contain. Compare it with the label.',
      )
    case 'payloadTooShort':
      return msg('This Matter code is too short to be complete; part of it is missing.')
    case 'reservedPaddingSet':
      return msg('This is not a Matter setup code that this version can read.')
    case 'manualCodeLength':
      return msg(
        'A manual pairing code has 11 or 21 digits. Spaces and dashes do not count, so only the digits matter.',
      )
    case 'manualCodeNotDigits':
      return msg('A manual pairing code contains only digits, apart from spaces and dashes.')
    case 'manualCodeCheckDigit':
      return msg(
        'This manual pairing code does not check out, so a digit was probably misread. Compare it with the label.',
      )
    case 'manualCodeUnknownFormat':
      return msg('This manual pairing code uses a format that this version does not know.')
    case 'manualCodeLengthContradictsFlag':
      return msg(
        'This manual pairing code says it carries a manufacturer and product, but is not long enough to. A digit is probably missing.',
      )
    case 'manualCodeGroupOutOfRange':
      return msg(
        'This manual pairing code is malformed; one of its groups holds an impossible value.',
      )

    // Reachable only from code that *builds* a payload rather than reads one, so a user does
    // not normally meet them. Translated anyway: the union forwards them, and an English
    // sentence appearing on a German screen once is exactly the defect #75 is about.
    case 'fieldOutOfRange':
      return msg('One of the values in this code is outside the range the format allows.')
    case 'unknownCommissioningFlow':
      return msg('This code names a commissioning method that the format does not define.')
    case 'inconsistentDiscovery':
      return msg('This code contradicts itself about how the device can be found.')
    case 'vendorProductNotPaired':
      return msg('A manufacturer and a product must be given together, or neither given at all.')

    default:
      return unknownProblem(problem)
  }
}
