# Lessons

Patterns worth not repeating, and the rules that prevent them. Added to after any
correction. Reviewed at the start of a session.

---

## L1 · Verify a test vector against an independent anchor before trusting it

**What happened:** the setup plan specified a reference Matter payload with Product ID
`0x8001`. Decoding the payload showed `0x8000`.

**Why it matters more than an ordinary mistake:** a wrong test vector is worse than no test.
The assertion goes green only once the implementation is bent to match the error, and the
error is then permanently protected by a passing test. Every future developer treats it as
verified truth.

**Rule:** a test vector must be corroborated by something outside the code that consumes it.
Here: the documented field values of the standard SDK test device, and the manual pairing
code `34970112332` derived through an unrelated algorithm. Two independent derivations
agreeing is evidence; recall is not.

**Applies to:** protocol constants, checksums, cryptographic vectors, fixture data,
"well-known" example values, and anything quoted from memory.

---

## L2 · Retire architectural assumptions at M0, not at the milestone that depends on them

**What happened:** the plan deferred verifying CouchDB's `_security` behaviour to M5. It was
checked at M0 in about twenty minutes. All eight assertions passed.

**Why:** had it failed at M5, the sharing UI, permission model and API would already have
been built on it. Cost of checking early: twenty minutes. Cost of checking late: a rewrite.

**Rule:** if a design rests on undocumented or lightly-documented third-party behaviour, test
it before writing code that depends on it. Then keep the test — this one is in CI, because a
future CouchDB upgrade that broke it would silently convert read-only access into
read-write, and no application-level test would notice.

---

## L3 · Verify the test harness before trusting a negative result

**What happened:** a bisect of CouchDB config files reported that *every* variant failed,
including a trivial two-line one. The real cause was that macOS has no `timeout` command, so
every probe exited 127 at the shell and matched nothing. The conclusion "all configs fail"
was an artefact of a broken harness.

**Why it matters:** a uniformly negative result is much more often a broken harness than a
uniformly broken subject. Acting on it means debugging the wrong thing, confidently.

**Rule:** when every case in an experiment fails identically, test the harness against a case
known to pass before drawing any conclusion. Prefer a positive control in the experiment
itself.

**Corollary:** do not assume GNU coreutils on macOS. No `timeout`, and `sed -i` needs an
explicit argument.

---

**Recurrence (M1-3, twice in one session).** Mutation probes reported `SURVIVED` twice when
the mutation had not taken effect. Once the replacement text landed in the wrong branch of a
ternary, so the guarded path was never altered. Once a `&&` written inside a double-quoted
bash string reached the file as `\&\&`, which does not compile — the run died before any test
executed, and the script's "no failures matched" check read that as a survivor.

A surviving mutant and a mutant that never ran produce the same silence. Before believing a
survivor, confirm the mutation is present in the file and that the suite actually ran: a probe
that reports `SURVIVED` for every input is indistinguishable from a thorough one.

**Fix, after the third occurrence (M1-5).** The probe moved out of the shell into a script
that applies the mutation in-process, asserts the pattern was actually found, and reports
three outcomes rather than two:

```text
caught        — N tests failed
SURVIVED      — the suite ran, M passed, nothing noticed
INCONCLUSIVE  — no test counts in the output, so the mutant likely did not compile
```

Separating the third case from the second is the whole point. Shell escaping had twice turned
a broken mutation into a silent "survivor", and each time the instinct was to go and weaken a
test that was in fact fine.

## L4 · zsh does not word-split unquoted variables

**What happened:** `A="-u admin:pw"; curl $A "$URL"` returned "Name or password is
incorrect". In bash, `$A` splits into two arguments. In zsh it stays one, and curl silently
misinterprets it. The error message pointed at credentials, not at the shell.

**Rule:** never pack multiple command-line arguments into one variable. Pass them literally,
or use an array. The failure mode is a plausible-looking error message from the wrong layer,
which is expensive to chase.

---

## L5 · Never bind-mount configuration into `/opt/couchdb`

**What happened:** mounting `couchdb-local.ini` into `/opt/couchdb/etc/local.d/` made the
container exit 1 with **zero log output**, which looked exactly like a config parse error and
sent the investigation towards the file's contents.

**Root cause:** the entrypoint runs, as root under `set -e`:

```bash
find /opt/couchdb \! \( -user couchdb -group couchdb \) -exec chown -f couchdb:couchdb '{}' +
```

A bind-mounted host file cannot be chowned. `-f` suppresses the *message* but not the
non-zero exit; `find` propagates it, `set -e` kills the script. Silent failure by design.

**Rule:** bake CouchDB configuration into a derived image with `COPY --chown`. Documented in
both Dockerfiles so the next person does not rediscover it.

**Generalisation:** when a container exits non-zero with no output at all, read the
entrypoint before theorising about the application. `set -e` plus a suppressed error message
is a common and invisible combination.

---

## L6 · Check for port conflicts before concluding a service is broken

**What happened:** `curl localhost:5984` returned a healthy CouchDB welcome while
`docker compose ps` reported the service was not running. An unrelated pre-existing container
owned the port, so the new container failed to bind and the health probes were reaching
someone else's database.

**Rule:** when a service appears to be simultaneously working and not running, check what
actually owns the port. Choose a non-default host port for a development stack so it can
never collide with an instance the user already depends on — and never stop or reconfigure
theirs to make room.

---

## L7 · An unauthenticated healthcheck needs an unauthenticated endpoint

**What happened:** CouchDB with `require_valid_user = true` returns 401 for `/_up`, so the
compose healthcheck could never pass. Anything with `depends_on: service_healthy` would have
hung forever with no useful error.

**Rule:** `require_valid_user_except_for_up = true` when `require_valid_user` is set.
Generally: check that a healthcheck's endpoint is reachable under the security configuration
it will actually run with, not the default one.

---

## L8 · Prove a quality gate can fail before trusting it

**What happened:** the coverage gate reported a confident **100%** while being entirely
incapable of noticing untested code. `coverage.include` was set to `src/**/*.ts`, which reads
as project-relative but resolves against the repository root. It matched nothing.

**Why it was invisible:** a glob that matches nothing is not an error. Coverage silently fell
back to measuring only the files the tests happened to import — which are, by definition,
the tested ones. Every file it measured was well covered, so it reported 100% and the
thresholds passed. A module with zero tests would not have appeared at all.

**How it was found:** by adding a module with real statements and branches that no test
imports, and checking the number moved. It did not. After the fix, coverage dropped to
93.61% and the thresholds failed — which is the gate working.

**Rule:** a gate that has never been observed failing has not been shown to be a gate. Prove
it by making it fail on purpose:

| Gate | Prove it by |
|---|---|
| Coverage threshold | Add an unimported module; confirm the total drops and thresholds fail |
| Lint in CI | Push a deliberate violation; confirm CI goes red |
| Type checking | Introduce a type error; confirm the build fails |
| A contract test | Break the contract; confirm the test catches it |
| A security check | Remove the control it protects; confirm it objects |

**This is the same principle as L1 and as watching a test go red first.** In each case the
failure mode is agreement-with-itself: a wrong vector, an unverified assumption, and a gate
that measures only what already passes are all internally consistent and quietly wrong. The
only defence is to force the negative case and watch it behave.

**Corollary:** treat "100%" and "0 problems found" as claims requiring evidence, not as
reassurance. They are equally consistent with a tool that is not running.

---

## L9 · A local green is conditioned on your machine's accumulated state

**What happened:** `npm run verify` passed locally and was reported as clean. CI then failed
immediately on `npm ci`: `Missing: @matter-manager/{api,data,web,e2e} from lock file`. Those
workspaces had been created *after* the last `npm install`, so the lockfile never learned
about them.

**Why local passed:** `node_modules` was already populated, so nothing forced npm to
re-resolve the dependency graph. The lockfile was stale and it did not matter — locally.
`npm ci` installs from the lockfile alone, which is exactly why CI uses it.

**Rule:** before claiming a clean build, run the command CI runs, not the one that happens to
be convenient. `npm ci`, not `npm install`. If the change touched `package.json`, workspaces
or dependencies, that is not optional.

**The wider pattern.** Each of these strips away a layer of state your machine is silently
contributing:

| Local convenience | What CI does | What it exposes |
|---|---|---|
| `npm install` | `npm ci` | stale lockfile, phantom dependencies |
| existing `node_modules` | clean checkout | anything uncommitted or untracked |
| warm build cache | cold build | missing generated files, stale artefacts |
| your `.env` | configured secrets | undocumented required configuration |
| your installed tools | container image | undeclared system dependencies |

"Works on my machine" persists as a phrase because the machine is genuinely doing part of the
build — invisibly, and for free.

**Relationship to L8:** L8 was about proving a gate *can* fail. This is about proving it is
being run under the conditions that matter. A gate that passes only because your environment
is doing half the work is not measuring what you think it is.

---

## L10 · Do not use `\s` in a shell `grep` that must run on both macOS and Linux

**What happened:** a CI guard meant to stop a literal npm token being committed to a public
repository was written as `grep -nE '_authToken\s*=' .npmrc | grep -qv '\${'`. Tested against
a deliberately planted literal token, it **passed** — reporting the file clean.

**Root cause:** `\s` is a GNU extension. BSD `grep` on macOS does not support it, so the first
grep matched nothing, the pipeline was empty, and the check reported success. It would have
worked on Linux CI and never on a developer's Mac — a guard that appears to work everywhere
while protecting only half the places it runs.

**Portable form** — as far as portability goes:

```sh
grep '_authToken' .npmrc | grep -v '[$]{' | grep -q .
```

`[[:space:]]` is the portable character class if whitespace matching is genuinely needed.

**But do not copy that line — it was later shown to be bypassable**, and the fix now lives in
`scripts/check-npmrc.mjs`. It accepts any line *containing* `${` anywhere, so a literal
token followed by a comment mentioning the variable passes cleanly:

```text
//npm.webawesome.com/:_authToken=REALSECRET # normally ${WEBAWESOME_NPM_TOKEN}
```

That is a second, separate lesson layered on the first: making the check *portable* did
nothing about making it *correct*, and fixing the platform bug felt like fixing the check.
A guard must match the whole value and reject everything it does not positively recognise —
fail closed, not "looks like it mentions a variable".

**Rule:** shell in CI runs on Linux; shell in a developer's terminal often does not. Stick to
POSIX constructs in anything committed, and test on the platform you actually use.

**Why this is L8 again, and worth noticing.** The guard was written *because* leaking a token
to a public repository is serious — and it was still shipped untested. Proving it by planting
a literal token took one command and found it immediately. **The checks written to protect
against the worst outcomes are the ones most worth making fail on purpose**, and the ones
most often trusted on sight because writing them felt like the diligent act.

---

## L11 · A negative test must actually change the input

**What happened:** verifying that CouchDB rejects tampered JWTs, the test replaced the final
character of the signature. CouchDB returned **200 and served the document**. For a moment
that looked like a signature-verification vulnerability.

**It was the test.** An ES256 signature is 64 bytes encoded in 86 base64url characters.
86 × 6 = 516 bits for 512 bits of data, so the final character carries 4 significant bits and
2 that are discarded. Changing `Q` to `X` decoded to **byte-identical** input:

```text
orig bytes: 64  tampered bytes: 64  identical: true
```

Editing a middle character, or the payload, produced `Bad signature` correctly.

**Rule:** for any negative test, assert that the input actually differs before asserting the
system rejects it. With encodings that have padding or normalisation — base64/base64url,
Unicode, JSON key order, trailing whitespace — "I changed a character" and "I changed the
value" are different claims.

**Why this one is worth remembering:** the bogus result pointed at a *catastrophic* finding
in someone else's code. That is the most dangerous direction for a test bug to fail, because
the conclusion is alarming enough to feel urgent and to get reported before it is checked.
The cost of confirming was one command comparing the decoded bytes.

**Companion to L3.** There, a uniformly negative result came from a broken harness; here, a
falsely positive one did. Both were resolved by testing the test rather than the subject.

---

## L12 · Change one variable, or you will blame the wrong one

**What happened:** while testing CouchDB JWT authentication, three settings were applied in a
single step — `authentication_handlers`, `jwt_keys`, and `jwt_auth.required_claims` — and
nothing authenticated. After a restart it worked. The conclusion drawn was *"`jwt_keys` is
read only at startup"*, and it was written into three documents and a verification script.

**It was wrong.** `jwt_keys` is applied **live**. The startup-only setting is
`authentication_handlers`. The restart had fixed the handler, not the key.

**How it surfaced:** the verification script was run a second time and failed its own first
assertion. Idempotency caught what a single run could not — the second run began with the
handler already loaded, which isolated the variable by accident.

**Rule:** when several settings are changed together and the outcome changes, no individual
setting has been tested. Isolate before concluding — set one, observe, revert, set the next.
The corrected finding matters operationally: keys being live is the difference between
zero-downtime key rotation and rotation that drops every replication.

**Why this was easy to believe.** A plausible mechanism was already available — a trusted
reference implementation calls `/_restart` after updating keys — so the wrong conclusion
arrived pre-justified. Corroboration is not confirmation: that project may restart for its
own reasons, or for an older version. It explained the observation without ever being tested
against it.

**Run a verification twice before trusting it.** A script that passes once may be reading
state its own previous steps created.

---

## L13 · Test every path to a property, not one path

**What happened:** `access.js` guaranteed that audit entries are immutable. The verification
suite asserted it, passed, and shipped. A reviewer pointed out that audit entries could be
**deleted**. They could:

```text
=== edit an audit entry (expect forbidden) ===
{"error":"forbidden","reason":"Audit entries are immutable."}
=== DELETE an audit entry ===
{"ok":true,"id":"audit:1","rev":"2-7754f99..."}
```

**Root cause.** A CouchDB deletion is `{_id, _rev, _deleted: true}` and carries *no other
fields*. The validation function returned early on `_deleted`, then checked `newDoc.type ===
'audit'` — which is never true for a deletion, because a deletion has no `type`. The type had
to come from `oldDoc`.

**Two separate failures, and the second is the instructive one.**

*The guard tested one mutation path.* "Immutable" has at least two: edit and delete. Asserting
one and calling the property verified is the same error as a negative test that does not
change the input (L11) — the assertion is true, and it is not the claim.

*The verifier contained a copy of the code under test.* The validation function was hand-copied
into the verification script as a string, and the copy had the identical bug. So the suite
compared the implementation against a duplicate of its own mistake and agreed with itself. It
now reads `access.js` directly, and that coupling was proved by deleting the guard from the
source and watching the suite fail.

**Rules.**

1. For a property, enumerate the ways it can be violated and assert each. Immutable means no
   edit *and* no delete. Read-only means no write, no delete, no attachment change.
2. A verifier must exercise the artefact that ships. If it embeds a copy, it validates the
   copy. Prove the coupling by breaking the source and watching the check fail.

**A reviewer found this, not the tests.** Worth sitting with: the suite was written carefully,
with the failure mode explicitly in mind, and still checked only half of it.

---

## L14 · Mutation-probe a new decoder before believing its tests

**What happened:** M1-1's payload decoder had 43 passing tests written directly from the
acceptance criteria, including one asserting every field of the reference device at once. It
looked thorough. Then each field width was narrowed by one bit in turn to see which tests
noticed:

```text
passcode 27 -> 26        SURVIVED - no test failed
discriminator 12 -> 11   3 failed
vendorId 16 -> 15        7 failed
```

**Why the passcode survived.** The reference device's passcode is 20202021, which needs 25
bits. Bits 26 and 27 are zero in that value, so reading 26 bits instead of 27 returns exactly
the same number. The test asserted the right value and proved nothing about the width.

**The general trap: a single real-world vector does not pin field widths.** It pins them only
where the value happens to exercise the top bit. Every field whose reference value is smaller
than its width is silently untested, and off-by-one in a packed bit stream is precisely the
error that class of test should catch.

**Fix:** add vectors that set every bit of the widest fields — `0x7FFFFFF` for a 27-bit
passcode, `0xFFF` for a 12-bit discriminator — plus one isolating the top bit alone. Re-run
the probe until every mutation is caught. All seven widths and the BLE bit are now
load-bearing.

**Recurrence (M1-3).** Four more survivors, all the same root cause. Masking the passcode at
13 bits instead of 14 changed nothing, because the anchor's low group is 549. Two zero-padding
widths were never exercised, because the anchor's digit groups are already full width. And a
range check on a digit group could be deleted outright, because reaching it needs a code that
is out of range *and* carries a correct check digit — which no natural vector does.

That is three consecutive stories where a verified real-world anchor left an off-by-one
invisible. The anchor proves the layout; it does not probe the edges, and it never will. Treat
"we have a verified vector" as the start of the width tests, not the end of them.

**Recurrence (M1-2).** The same trap reappeared in a check that only asserts *non-zero*. A
test rejecting reserved padding bits set to `0b1010` did not pin the 4-bit width: narrowing it
to 3 bits still sees a set bit and still throws. A "must be zero" assertion pins a width only
when a case isolates the **top bit alone** — `0b1000` — so the narrowed read returns zero and
sails through. Non-zero is not a boundary; the highest bit is.

**Rule:** after implementing a decoder, parser or codec, change one constant at a time and
confirm a test fails. It takes minutes, needs no tooling, and finds the tests that are
decorative. Coverage will not tell you this — the surviving mutant was on a line with 100%
coverage, because coverage measures whether a line *ran*, never whether anything would have
noticed it being wrong.

---

## L15 · Verify a reviewer's premises, not just its conclusion

**What happened:** CodeRabbit found a real bug in `scripts/bootstrap-github.mjs` — a failed
issue-close was suppressed and could never be repaired on a later run — and prescribed the
fix, including this detail:

> Store each issue's number and state in a `Map`, close matching issues whose state is
> lowercase `open` [...]

The conclusion was correct. The premise was not:

```console
$ gh issue list --state all --limit 1 --json number,title,state
[{"number":57,"state":"OPEN","title":"M5-10 Release 1.0 readiness"}]
```

`gh` returns `OPEN` and `CLOSED`. Implementing the suggestion verbatim would have produced a
fix that reads correctly, reviews cleanly, and **does nothing**: every closed issue compares
as open, so the repair branch either never fires or fires on all fifty-six issues forever.

**Why this is worth a rule.** A reviewer that is right about the defect earns trust that
carries, unearned, to every factual claim in the same comment. The bug report and the API
detail arrive in one paragraph and feel like one assertion. They are not: the first came from
reading the code in front of it, the second from a general belief about a tool.

**Rule:** separate a review's *finding* from its *facts*. Accept the finding on its argument;
check every factual claim — API shapes, return values, casing, defaults — against the actual
system before writing code that depends on it. One command usually settles it. When the
reviewer is a language model, this is not optional.

**It applies to your own premises as well.** Two caveats were written into the M1-3 pull
request — that a helper had to be duplicated, and that a lesson could not be numbered — both
resting on the belief that PR #61 was still open. It had already merged, and the branch was cut
from a main that contained it. One `git log` would have settled it; neither caveat was
necessary, and both were published as fact. A remembered repository state is a claim, not
knowledge.

**Related:** [[L1]] (verify a vector against an independent anchor) is the same discipline
applied to test data instead of review comments.

---

## L16 · A round trip is not evidence that either direction is right

**What happened:** M1-2 added an encoder to sit opposite M1-1's decoder, and put the field
widths in one shared table so the two could not drift apart:

```ts
const WIDTH = { version: 3, vendorId: 16, /* ... */ passcode: 27, padding: 4 } as const
```

That is the right design, and it quietly disarms the most obvious test. `encode(decode(x)) === x`
now passes *for every possible mutation of that table*, because the error is applied twice in
opposite directions and cancels itself out. Narrow the passcode to 26 bits and the round trip
is still exact — of a payload that is no longer the Matter format.

**What saved it:** the test file keeps `pack`, a second, independently written bit-packer, and
asserts against that rather than against the encoder. Every one of the eight width mutations
was caught. Had the width vectors been rebuilt with `encodePayload` — which looked like an
obvious simplification, since the encoder now existed and the helper appeared redundant — all
eight would have survived.

**The trap in general:** symmetric functions (encode/decode, serialise/parse, compress/inflate,
encrypt/decrypt) invite round-trip tests because they are cheap and read as thorough. They test
*consistency*, not *correctness*. A round trip cannot distinguish an implementation that matches
the specification from one that is internally coherent and wrong.

**Rule:** every symmetric pair needs at least one assertion against an external anchor — a
published vector, a hand-computed byte string, or a second implementation written independently.
Keep that anchor even when it starts to look like duplication. **Deleting a test helper because
the production code can now do the same job removes the only independent witness.**

**Related:** [[L14]] — the mutation probe is how you find out whether the anchor is load-bearing.

---

## L17 · Derive the anchor before writing the code, not after

**What happened:** M1-3's acceptance criteria supply `34970112332` as a verified manual pairing
code for discriminator 3840 and passcode 20202021. Before writing any implementation, it was
re-derived from first principles — field layout by hand, then the Verhoeff check digit. The
derivation disagreed:

```text
body                : 3497011233     <- matches the anchor's first ten digits
check digit         : 5             <- the anchor says 2
```

The fault was the placeholder zero: appended to the body it permutes each digit by the position
it will really occupy, prepended it does not. Corrected, the derivation reproduced the anchor
exactly.

**Why the timing is the lesson.** The bug would have been found either way. What changed is the
cost of finding it. Derived first, there was exactly one suspect — no implementation existed —
and the ten matching digits localised the fault to the check digit alone in a single step.

Written first, the same failure surfaces as *"my code and the anchor disagree"*: two suspects,
and the more tempting one to doubt is the anchor, because it is a bare constant in an issue
while the code is something you just reasoned through. The issue even says the anchor is
verified — and that is precisely the sentence that gets rationalised away at 6pm.

**Rule:** when a story hands you a magic constant, reproduce it independently **before** the
implementation exists. Partial agreement is the prize: matching ten of eleven digits is a
bisection you get for free, and you only get it while there is nothing else to blame.

**Related:** [[L1]] is the same instinct applied to trusting a vector at all; [[L16]] is why the
anchor cannot be replaced by a round trip.

---

## L18 · A test table derived from the code under test can assert nothing — or vanish

**What happened:** M1-4 checks setup passcodes against ten values the specification forbids.
The obvious way to test that is to iterate the list:

```ts
it.each([...FORBIDDEN_PASSCODES].map((p) => [p]))('rejects %i', (value) => {
  expect(passcodeProblem(value)).toBe('forbidden')
})
```

Two things are wrong with it, and the second is worse than the first.

**It asserts a tautology.** The claim being tested is *"these ten specific values are
forbidden"*. What this actually checks is *"every value in the forbidden list is forbidden"*,
which is true by construction and stays true if someone deletes half the list.

**It can disappear without a sound.** Against the stub, where the set was empty, `it.each`
received an empty array and generated **zero test cases**. Not a failure, not a skip — the
block simply produced nothing, and the run reported only passes. A test that silently ceases
to exist is worse than one that was never written, because the file still looks like coverage.

**Fix:** write the table out as a literal, independent of the production constant, and assert
its own size:

```ts
const FORBIDDEN = [11111111, /* ... */ 87654321] as const

it('checked all ten of them', () => {
  expect(FORBIDDEN).toHaveLength(10)
  expect(new Set(FORBIDDEN).size).toBe(10)
})
```

The separate equality test between the literal and the exported set then makes any edit to
either one a deliberate act with a failing test behind it.

**Rule:** test data must not come from the subject. When a parameterised table is computed
rather than written, assert its length as well as its contents — an empty table is silence,
not success.

**Related:** [[L16]] is the same principle for symmetric functions; [[L14]] is why the values
in the table have to reach the boundaries.

---

## L19 · A surviving mutant means redundant code *or* a missing test — find out which

**What happened:** the entitlement gate accumulated four guards while a review hardened it: an
own-property check, a callable check, a strict `=== true`, and a try/catch. Twice, adding one
made an earlier one survive mutation — the probe reported that deleting it broke nothing. The
two cases looked identical and needed opposite fixes.

**The callable check was genuinely redundant.** Once a `try/catch` existed, calling a
non-function threw and was caught, so the explicit check produced the same refusal by a
different route. No input could distinguish them. Deleted.

**The own-property check was not.** Its mutant survived because the strict `=== true` already
refused every *inherited* name — `constructor` returns an object, `valueOf` throws. What the
tests never covered was the case it actually defends:

```js
Object.prototype['data.export'] = () => true    // classic prototype pollution
withoutHasOwn(POLICIES, 'data.export')  // true  <- bypass
withHasOwn(POLICIES, 'data.export')     // false
```

A polluted prototype supplies a policy returning *exactly* `true`, so every downstream guard is
satisfied: callable, does not throw, returns the one permitting value. Only refusing to walk
the prototype chain stops it. The mutant survived because a test was missing, not because the
code was.

**Deleting it would have removed a security control while pointing at a green suite as
justification** — and the mutation probe, used carelessly, would have been the thing that
recommended it.

**Rule:** when a mutant survives, do not reach for the delete key. Ask what input would
distinguish the two versions, and go looking for it. If a genuine search finds nothing, the
code is redundant and should go. If it finds something, you have just discovered the test you
were missing. Both outcomes are useful; only the first is a deletion.

**Related:** [[L3]] and [[L14]] are about trusting the probe's verdict; this is about
interpreting a verdict that is entirely correct.


---

## L20 · A navigation to the same URL is not a reload, and a check that never re-ran is not a check

**What happened:** verifying the i18n boot path, I cleared the stored preference, overrode
`navigator.languages` to `['fr-FR', 'fr']`, navigated to `http://localhost:5173/#/`, and read
back `lang="de"` with a German interface. Two conclusions were available:

1. negotiation is broken — a French browser is getting German, and scenario 2 of the story fails
2. the page never reloaded

It was the second. The browser was **already** at `http://localhost:5173/#/`, so the navigation
was same-document: no new document, no module re-execution, no boot. The German on screen was
left over from a *previous* test where I had clicked "Deutsch". The override survived for the
same reason — same document.

The dangerous part is that the run *before* it looked like a pass for exactly the same reason.
I had recorded "with no stored preference and a `de` browser language, the app boots in German"
as verified. It had booted in German, but from a stored preference set by hand two steps
earlier, and the boot in question had happened minutes before the languages were overridden.
**A false pass and a false fail from one bug, and only the false fail was loud enough to
notice.**

`page.goto()` to the current URL is skipped by Playwright, and `addInitScript` accumulates
across calls rather than replacing, so retrying harder made it worse. What finally worked was
not forcing a reload but removing the shared state: a fresh `browser.newContext({ locale })`
per case, which sets `navigator.languages` natively and starts with empty storage.

**Rule:** when a manual browser check depends on start-up behaviour, assert that start-up
*happened* rather than assuming a navigation caused one. Read back the input the code under
test actually saw — here, `navigator.languages` — in the same breath as the output. If it does
not match what was set up, the result is about the previous run. Where a run has start-up
state at all, prefer a fresh context per case over resetting one; resetting is a list of things
to remember, and the one forgotten is what produces a plausible wrong answer.

**Related:** [[L16]] — a round trip proves neither direction. Same shape: agreement between two
things that were never independent is not evidence.

---

## L21 · An uncovered defensive branch is a question about your model, not a number to chase

**What happened:** the repository's `list` maps `_all_docs` rows and filters out any row with no
`doc`, with a comment explaining why:

> A deleted document still has a row in `_all_docs`, with no `doc` attached.

The test beside it — *"drops removed documents rather than returning holes"* — passed. Coverage
then reported the filter's false branch as never taken.

The comment was simply wrong. A **ranged** `_all_docs` omits deleted documents entirely; no
tombstone row is returned, so the filter never fires and the test was passing for a completely
different reason than the one written next to it. Both the code comment and the test comment
asserted a behaviour of CouchDB that I had inferred from the shape of the API rather than
checked. Six lines to check it:

```
db.remove('device:a', rev)
db.allDocs({ startkey: 'device:', endkey: 'device:￰', include_docs: true })
→ rows: [ { id: 'device:b', hasDoc: true } ]      // no tombstone at all
```

The filter still earns its place — the row type declares `doc` optional and narrowing beats
casting — but as a **type-level** guard, which is a different claim with a different comment.

The general shape: an uncovered branch is usually read as "write a test for this". Sometimes
the right reading is "you believe something about this system that is not true, and the belief
is written down three inches away". The coverage number was the only thing in the room
disagreeing with a comment, a test name and a test body that all agreed with each other.

**Rule:** when coverage says a defensive branch never runs, do not reach for a test that forces
it. First find out whether it *can* run, by probing the real dependency. If it cannot, the
comment justifying it is a hypothesis that just failed, and the test that appeared to cover it
is passing for a reason nobody has written down.

**Related:** [[L19]] — a surviving mutant means redundant code *or* a missing test. This is its
coverage-shaped twin, with a third answer: neither, and a false belief instead.

---

## L22 · A test that fakes an interaction the widget forbids is testing a state no user can reach

**What happened:** six browser tests for the add-device form failed against an application that
was correct. The helper filled every control the same way:

```ts
const control = element.querySelector(`[data-field="${field}"]`)
control.value = value        // fine for <wa-input>
```

For `<wa-combobox>` it is not fine. Setting `value` to a string matching no `<wa-option>` does
not select anything — the component rejects it and leaves `value` as `null`. What a user does
when they type a new room is change `inputValue`; what they do when they pick one is change
`value`. The helper produced a third state, reachable only from a test, in which both are
empty. The form then reported "A device needs a room", which was the right answer to the
question it was actually asked.

The diagnosis took one throwaway test that dumped `value`, `inputValue`, the date field and the
recorded error together. Reading `errorField: 'room'` next to `comboValue: null` ended it
immediately; guessing from the timeout alone had already sent me to the date field first.

**Rule:** before concluding that a component is broken, ask what the user's hands actually do
to it and whether the test does that. For a custom element, a settable property is not
automatically a settable-by-a-user property — read its documented API and find out which one
the interaction writes. When a test fails, dump the inputs the code under test saw *alongside*
its output; a timeout on its own names the symptom and not one of the six things that cause it.

**Related:** [[L20]] — assert that the thing you set up actually reached the code, rather than
that a step ran. Same failure wearing different clothes: here the test set a property the
component threw away.

---

## L23 · A passing test can be blind to the failure by construction, not by oversight

**What happened:** the device page renders a QR from the stored payload. The test decodes the
rendered `<canvas>` with zxing and asserts it comes back as identical field values — a genuinely
end-to-end check, and the one the whole milestone rests on. It passed.

Then I opened the page at 360px wide. The enlarged QR was **clipped**, missing its right-hand
columns. A QR missing columns does not scan. The feature was broken on every phone, and the
test could not have caught it: `decodeFromCanvas` reads the canvas *bitmap*, and CSS clipping
never touches a bitmap. The test was not weak. It was measuring a different thing than the one
that was broken, and no amount of strengthening it would have helped.

The first fix made it worse. I reasoned from the component's stylesheet — `canvas { width:
100%; height: 100% }` inside a host with `aspect-ratio: 1` — and concluded that constraining
the host would scale the code down. It did not, and at 360px the code was then clipped on
*both* sides. Reading the component's `render()` explained why in one line:

```js
style=${styleMap({ maxWidth: `${this.size}px`, minWidth: `${this.size}px`, ... })}
```

An inline `min-width` on an element inside the shadow root. No `max-width` I can write from
outside beats it, so the code cannot shrink — it can only overflow. The size has to be correct
at the moment it is set, which meant computing it in TypeScript from the viewport.

Two rules out of one bug:

**Rule (tests):** when a test asserts on data extracted from a rendering — a canvas, a
serialised DOM, an accessibility tree — write down what layer it *cannot* see, next to the
test. Then check that layer by hand at least once, at the sizes that matter. "The test passes"
answers only the question the test asks.

**Rule (shadow DOM):** before writing CSS to reshape a custom element from outside, read its
`render()` for inline styles. A component that writes `min-width` inline has made a decision
you cannot override from the light DOM, and the fix belongs wherever that value is chosen.
Reasoning from its stylesheet alone tells you half the story and the half that is missing is
the half that wins.

**Related:** [[L21]] — a coverage hole was a false belief, not a missing test. Same family: the
number that looked like the answer was answering a different question. [[L22]] — check what the
component actually does before concluding what it must be doing.

---

## L24 · Extracting shared code exposes assumptions that were only true for the first caller

**Context:** M2-8. The add form and the edit form differ in one field, so the shared half moved
to a `DeviceFormView` base class. One of the methods that moved was this:

```ts
return selected === '' ? typed : selected   // combobox: value vs inputValue
```

Correct in the add form, and provably so — its tests had been green for two milestones. Wrong
the moment the edit form called it, because it encodes an assumption the add form happened to
satisfy: *there is never a prior selection*. On the edit form the room is preselected from the
stored device, so `value` is always set, and typing a different room leaves `value` on the old
one. The result was a **move that did not move** — save, navigate back, and the device is still
in the room the user had just changed away from, with nothing on screen saying so.

The tests I had written for the move caught it, but only because they typed rather than
selected. It would have been just as easy to write them the other way and ship the bug.

**Rule:** when a method moves into a shared base, do not carry its tests' green status with it.
For each branch in the moved code, ask what the *original* caller made true that the new caller
does not — a state that was unreachable, a field that was always empty, an order that was
guaranteed. That list is the new caller's test plan. "It worked before" is a statement about
one call site, and extraction is precisely the act of adding another.

**Corollary, and it is [[L22]] again:** the fix rested on what `<wa-combobox>` does to
`inputValue` when `value` is set programmatically. I did not reason about it — I wrote a
throwaway test that dumped both properties before and after, learned that selecting *syncs*
`inputValue` to the option's label while typing leaves `value` stale, and only then chose the
condition. That one fact is what makes `typed !== '' && typed !== selected` safe rather than a
different guess. Three minutes of probe, and the alternative was a second silent bug where the
first one had been.

---

## L25 · `git add -A` commits the working tree, not your change

**Context:** PR #82. CodeRabbit filed a finding against `scripts/derv-up.sh` — a tmux helper
that hard-codes one developer's `$HOME/Code` layout. It was a fair finding about a file that
had no business being in the diff: the script is my human partner's local helper, it was
sitting untracked in the working tree, and `git add -A` swept it into a commit about editing
devices. Nothing in `npm run verify` notices an extra file, and nothing in my own review did
either — I read the diff of what I had *written*, not the diff of what I had *staged*.

The damage here was small. The same reflex commits a `.env` someone left lying around, a
scratch script with a token in it, or a half-finished file from another branch — and a public
repository's history does not forget.

**Rule:** never `git add -A` (or `git add .`) on a repository you did not start from empty.
Stage the paths the change actually touches, and when a change is broad enough that listing
paths is impractical, run `git status --short` first and account for **every** line: `M` you
expected, `??` you can name. An untracked file you did not create is not yours to commit —
leave it untracked and say so, because whether it belongs in the repository is its owner's
decision and not part of your story.

**Corollary:** `git diff --cached --stat` immediately before committing takes two seconds and
answers "what am I actually about to put in history?" — a different question from "is my code
right?", and the one no test suite asks.

---

## L26 · A wrong clock is invisible to a test that reads through the same clock

**Context:** `#46`, `packages/web/src/tokens.ts`. The token holder stores the *instant* a token
expires, computed with an injected clock that defaults to `Math.floor(Date.now() / 1000)` —
seconds, because that is the scale the contract and the JWT both use. Every behavioural test
injected its own clock, so nothing exercised the default at all, and coverage said so: 75% of
functions.

The obvious fix was a test that remembers a token with the default clock and reads it back with
the default clock. It passed. It also passed when the default was mutated to `Date.now()`
(milliseconds) and when it was mutated to a constant `0`. Both mutations SURVIVED, because a
clock that is consistently wrong is consistently wrong on both sides of the comparison: write
`now + 3600`, read `now'`, and `now' < now + 3570` holds whatever unit `now` is in.

Had it shipped, `expiresIn: 3600` would have placed the expiry roughly forty thousand years
out. Sign-in would work, nothing would visibly break, and the safety margin — the entire reason
the module knows about expiry — would have been dead code.

**Rule:** to test a clock, unit, or any other scale, the assertion has to cross the boundary:
write through the value under test and read through a *known* one, or the reverse. A test that
uses the same source on both sides asserts self-consistency, which every wrong answer also has.

**Corollary:** a function that coverage reports as never called is not merely untested — it is
usually the one whose only observable behaviour is a unit, a default, or an ambient dependency,
which is exactly the class this lesson is about.

---

## L27 · A constructor that succeeds is not a working feature

**Context:** `#87`/`#88`, `packages/web/src/scan/detector.ts`. `nativeDetector()` decided that a
browser could read QR codes if `'BarcodeDetector' in globalThis` and `new BarcodeDetector(…)`
did not throw. Both are true on **Android without Play Services** — Huawei devices, de-Googled
builds, Fire OS, or Play Services older than 19.7.42 — where there is no barcode service behind
the API at all. Blink exposes the interface on Android unconditionally, and its constructor
validates nothing: it drops unrecognised format strings, keeps the rest as a *hint*, and hands
them to a service that may not exist.

The result was the worst shape a failure can take: the scan control renders, the camera opens,
the loop runs, and nothing is ever read. Every `detect()` rejects with `NotSupportedError`, and
`readFrame()`'s catch — correctly written for "most frames have no code in them" — swallowed it
on every frame forever. Silent, unreportable, and indistinguishable from a bad camera, on the
one platform where people are most likely to be scanning.

Nothing in the test suite could have caught it: CI is Linux Chromium, which has no
`BarcodeDetector` at all, so the native path was never taken there.

**Rule:** feature detection has to detect the *feature*, not the *interface*. When an API is a
shim over a platform service — barcode detection, speech, NFC, payments — the object's existence
is a fact about the browser build, not about the device it is running on. Find the call that
asks whether the service is actually there (`getSupportedFormats()` returning `[]`, here) and
ask it once, at the point where the answer changes what is offered to the user.

**Corollary:** a catch that is right about the common case can be wrong about a rare one in a way
that hides it completely. "Most frames have no code in them" is true and "this browser will never
read a code" is also true, and the second arrives through the same channel. Discriminate at the
layer where the difference is knowable — here, before the control is offered — rather than adding
a second guard inside the loop.

---

## L28 · The care taken over writes did not reach the reads

**Context:** `packages/web/src/views/`. `device-form.ts`'s write path has a careful comment:

> A rejected write is reported rather than thrown. Left to propagate out of a submit handler it
> becomes an unhandled rejection: the button un-busies, nothing appears on screen, and the user
> cannot tell whether their device was saved — which for a form whose whole purpose is not
> losing a code is the worst possible way to fail.

That reasoning is exactly right, and it was applied to writes only. Every **read** in the
application — `device-list.ts`'s `load()`, `device.ts`'s `load()`, `device-form.ts`'s
`loadRooms()` — awaited a repository with no `catch`. A rejection left `loaded === false`
forever, produced an unhandled rejection, and rendered a page with a header, a search box and
nothing else.

The `loaded` flag itself carries a comment identifying the right distinction — "one is *you have
no devices*, the other is *we have not looked yet*" — and there was no third state for *we
looked and could not*. Two states where three were needed, so the third failure quietly rendered
as one of the other two.

This was not exotic. PouchDB flattens every IndexedDB failure into one rejection, its task queue
makes an open failure sticky so *every* later operation rejects, and the reachable causes include
a quota exceeded by embedded photos and a database evicted between sessions. An offline-first
catalogue rendering a blank page to somebody standing in a basement in front of the device they
came to look up is the exact scenario ADR 0002 exists for.

**Rule:** when a piece of reasoning about failure is written down for one direction of I/O, go
and apply it to the other direction the same day. The reads in a read-mostly application are the
paths a user meets most often, and they are the ones most likely to have been written first —
before the failure handling was thought about at all.

**Corollary:** a two-state flag (`loading` / `loaded`) is a design that cannot express failure.
If the code has a boolean for "have we got the data", the failure case is already being rendered
as one of the two states — and which one it lands in is an accident.

**How to find the next one, cheaply:** grep for comments that explain how a failure should be
*reported*, and for each one ask which side of the I/O boundary it was written for. This lesson
was already written down in this repository — carefully, with the right reasoning — on the path
it did not need to cover most. A codebase that has thought hard about one direction is a
codebase where the other direction is worth reading immediately.

## L30 — Documentation is not wiring, and it reads exactly like it

`GOOGLE_CLIENT_ID` was in `.env.example`, in `infra/compose.prod.yml` and in a configuration
table in the API README. Three files, agreeing with each other, all correct about what the
variable is for. **No source file read it.** `serverOptions` never populated
`ServerOptions.auth`, so `buildServer` registered no `/auth` routes, and a deployment with a
Google client fully configured answered `GET /auth/google` with 404.

Every individual artefact was honest. `googleProvider()` was written, tested and correct. The
README's table described the variables the *code* wanted. The compose file passed them in. The
one thing nobody wrote was the six lines that read them — and the absence of those six lines is
invisible from every direction except the one nobody looked from.

The test suite agreed with the documentation rather than with the code:
`describe('a fully configured deployment')` asserted only that the *project* routes were served.
It had been true when written, and stayed passing while the definition of "fully configured"
grew past it.

**Rule:** an environment variable is wired when something *reads* it. Documenting a variable and
plumbing it through a deployment file are not steps towards that — they are steps that make its
absence harder to notice, because they are exactly what a wired variable also looks like.

**Corollary — the cheap check.** For each variable named in `.env.example`, in a compose file or
in a README table, grep the source for its name. A variable with no reader is either dead or a
feature that does not work. There is no third case, and the grep takes a minute.

**Corollary — the same drift in reverse.** The same three files described an *RS256* keypair and
a `JWT_PRIVATE_KEY_PATH` long after the code moved to inline ES256 and started refusing non-EC
keys at startup. Configuration files do not fail to compile, so nothing ever tells you they have
stopped being true. They need reading at the same moments code gets reviewed, not at the moment
somebody follows them.
## L29 · A `textContent` assertion tests the whole subtree, including the thing it is about

**Context:** PR #84, review comment from CodeRabbit. The device list has three empty states, and
the third — every device disabled, filter on — has to *name the control* so the remedy is
findable. The test asserted:

```ts
expect(element.textContent).toContain('Show disabled devices')
```

The view renders `<wa-checkbox data-include-disabled>Show disabled devices</wa-checkbox>` a few
lines above the empty message. So `element.textContent` contains that string **whatever the
message says**, including when it says nothing useful. The mutation probe confirmed it: replacing
the entire message with "Nothing to show." left all thirteen tests passing.

The reviewer was right and the finding was worth acting on even though the PR had already merged.

**Rule:** assert against the smallest element that can carry the claim. `element.textContent` on
a component root is a search of everything the component renders — labels, hints, other empty
states, sibling controls — so a `toContain` against it says only "this string appears somewhere
on screen", which is rarely what the test is named for.

**Corollary:** the negative form is fine and often better. `expect(element.textContent).not
.toContain('Nothing matches')` is a *stronger* claim when unscoped, because absence from the
whole subtree implies absence from the part. Scope the positives; leave the negatives broad.

**How this got past review the first time:** the assertion is true, the test passes, and the
string in it is the string the message is supposed to contain. Nothing about it reads as wrong.
Only asking "what else on this page says that?" — or running the probe — distinguishes it from a
test that works.

---

## L30 · A resource list is not a map of what the resources are *for*

**Context:** asked to point the deploy workflow at a new Cloudflare Pages project,
`matter-manager-app`. `cf pages projects list` returned exactly one existing project,
`matter-manager-web`, holding the custom domain `matter-manager.io`. From that single fact I
inferred a story — "the app's project, about to be superseded" — and proposed moving the domain
onto the new project.

Wrong. `matter-manager-web` is the **public website**; `matter-manager-app` is the
**application**. Two projects, distinct purposes, and the domain belongs where it already was.
Acting on the inference would have taken the website's domain off the website.

**Rule:** an inventory tells you what exists, never what it is for. When the purpose of an
existing resource decides whether an action is safe — moving a domain, retargeting a deploy,
deleting anything — the purpose is a question for the owner, not a gap to fill by inference from
a name. A name that shares a prefix with the thing being built is the weakest evidence there is.

**Corollary:** the shape of the ask carries information. "Deploy to a **new** project" says the
old one keeps doing whatever it was doing. Had I read the word "new" as load-bearing rather than
incidental, the two-projects reading was available without asking anything.

**What was right about it:** the suggestion was surfaced as a question rather than executed. The
edits shipped were all scoped to the new project and needed no revert. Flagging beats acting when
the inference is this thin — but noticing it *was* an inference, and asking, beats both.
## L31 — Every test starts with an empty database. A deployment is empty once.

Four helpers wrote a CouchDB design document with `putDoc` and no `_rev`. CouchDB accepts that as
a *create* and refuses it as a *replace*, so each worked on the first process against a given
database and threw `409 conflict` on every process after — permanently, because each set its
"already done" flag only after a successful write. Creating a project, redeeming an invitation,
accepting a transfer and finding anybody by address were all broken after any restart.

The test suite could not have caught it. `fakeCouch()` enforces `_rev` **exactly as CouchDB
does** — that was a deliberate choice, made for exactly this class of bug, and it still missed
this one, because every test constructed a fresh empty fake. The write under test was always a
create. The replace path had no test because no test had a *before*.

The fix was to make the process boundary expressible: `forget*()` already existed for tests, and
calling it between two `ensure` calls against the *same* fake is what a restart is.

**Rule:** for any code that runs once per process against durable state, write the test that runs
it twice. Not twice in one process — the flag makes that free — but twice with the state kept and
the memory discarded. If there is no way to express "the same database, a fresh process", that
absence is the finding.

**Corollary — a skip can hide the thing it optimises.** The fix both carried the `_rev` and
skipped the write when the stored map was unchanged. Skipping made the `_rev` carry *unreachable*
in every test, so removing it again changed nothing and the mutant survived. An early return that
makes a fix untestable is worth noticing: the case the fix exists for is the case the early return
excludes. Here it was a map function that had **changed**, which is the entire reason those
helpers run on every process.

**Corollary — a flag set after an await is a race.** `if (established) return` … `await write()`
… `established = true` lets two callers through. Memoise the in-flight promise instead, and forget
it on failure so a transient error is retried rather than remembered. This one was reachable from
two people sharing a project at the same moment, because `findUser` awaits it.
