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

- [ ] Red: a core test asserting `PayloadError.problem` for each throw site
- [ ] `PayloadProblem` union; every `new PayloadError` in `payload.ts`, `manual-code.ts` and
      `credential.ts` names its code
- [ ] Red: a core test asserting `DraftError.problem`, including a credential failure
      forwarding the `PayloadProblem`
- [ ] `DraftProblem` union; every `new DraftError` names its code
- [ ] Export both from `packages/core/src/index.ts`; extend `public-api.test.ts`
- [ ] Red: a web test that a German locale renders a German sentence for an unusable setup code
- [ ] `i18n/problems.ts`; `device-form.ts` and `scan-dialog.ts` translate the code
- [ ] `scan-dialog` holds the **code**, not the sentence, so a locale switch re-renders it
- [ ] `npm run i18n`, write the German for every new unit
- [ ] Check whether `<wa-combobox allow-create>`'s `Create "…"` label can be localised; fix or
      file an issue

## Review
