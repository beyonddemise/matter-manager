# todo-75 — Domain error messages are English in a German UI

Closes #75.

## The defect

Every user-visible failure from `packages/core` carries an **English sentence**, and the web
layer renders it verbatim. With the interface in German, an unusable setup code shows an
English paragraph in the callout and the field hint, surrounded by German labels.

`core` deliberately holds no `msg()` and no locale — it is imported by `packages/api` too,
where a translation runtime does not belong. So the sentence cannot be translated where it
is produced.

## The shape

The project already has the pattern: `RoomPathProblem`, `PasscodeProblem` and
`InvitationProblem` are **codes**. `PayloadError` and `DraftError` predate it and carry prose.

1. **`PayloadProblem`** — a closed union in `matter/payload.ts`, covering the payload, manual
   pairing code and credential failures. `PayloadError` gains `readonly problem`.
2. **`DraftProblem`** — a closed union in `documents/draft.ts` for the form's own failures,
   `| PayloadProblem` so a credential failure forwards its code rather than being flattened.
   `DraftError` gains `readonly problem`.
3. **The English sentence stays**, as `Error.message`, for a caller with no interface: the API,
   a log, a test. Nothing is removed.
4. **`packages/web/src/i18n/problems.ts`** maps a code to a `msg()` string, with an exhaustive
   switch so a new code is a type error rather than a silent English fallback.

## Constraint that must survive

**No message may echo the input** — it encodes the setup passcode.
`packages/core/test/matter/secrets.test.ts` enforces this and must keep passing. The new
translated strings are static, so they cannot echo anything; the check still matters for the
English fallbacks, which are unchanged.

## Tasks

- [x] Red: a core test asserting `PayloadError.problem` for each throw site
- [x] `PayloadProblem` union; every `new PayloadError` in `payload.ts`, `manual-code.ts` and
      `credential.ts` names its code
- [x] Red: a core test asserting `DraftError.problem`, including a credential failure
      forwarding the `PayloadProblem`
- [x] `DraftProblem` union; every `new DraftError` names its code
- [x] Export both from `packages/core/src/index.ts`; extend `public-api.test.ts`
- [x] Red: a web test that a German locale renders a German sentence for an unusable setup code
- [x] `i18n/problems.ts`; `device-form.ts` and `scan-dialog.ts` translate the code
- [x] `scan-dialog` holds the **code**, not the sentence, so a locale switch re-renders it
- [x] `npm run i18n`, write the German for every new unit
- [x] Check whether `<wa-combobox allow-create>`'s `Create "…"` label can be localised; fix or
      file an issue

## Review

**Done.** `npm run verify` clean, 2018 tests pass, coverage 93.35% statements.

### What the shape turned out to be

`PAYLOAD_PROBLEMS` and `DRAFT_PROBLEMS` are exported as **arrays** with the type derived from
them (`(typeof PAYLOAD_PROBLEMS)[number]`) rather than as bare type unions. That was not the
first design, and it is worth saying why it became one: a runtime list is what lets a test walk
the union, and the test that matters most here is the one asserting **every code is reachable
from some input**. A code nothing can produce is a sentence nobody will ever read, and it looks
exactly like a working one from every direction — which is L32 again.

That test found nothing wrong today. It exists so that the next code added without a producer
fails instead of passing.

### Three things worth knowing

- **`device.ts` was already correct.** It maps a caught `DraftError` to its own local
  `'blank' | 'storage'` codes and translates those. The pattern was already in the codebase;
  it had just not been applied to the two views the issue named.
- **`scan-dialog` now holds the code, not the sentence.** It previously stored
  `error.message`, which would have frozen the text into whichever language was active when
  the frame was decoded. Holding the code means a locale switch mid-scan re-renders it.
- **The combobox needed no workaround.** Web Awesome ships a German catalogue containing
  `createOption`, and resolves the language from `lang`, which `activateLocale` already sets.
  The only missing step was registering the catalogue. It is imported inside the German loader,
  so a reader who never switches language never downloads it.

### Not done, deliberately

Three payload codes — `fieldOutOfRange`, `unknownCommissioningFlow`, `inconsistentDiscovery` —
describe failures only *encoding* can reach, so no user input produces them. They are
translated anyway, because `DraftProblem` forwards whatever it is given, and the test says
plainly that they are in the union for that reason rather than because a draft can produce
them.

**Web Awesome's own German string is slightly wrong**: `createOption` renders
`„${value}" erstellen` — an opening German quote closed with an ASCII one. That is their
string, not ours, and it is cosmetic. Filed as a note rather than worked around.
