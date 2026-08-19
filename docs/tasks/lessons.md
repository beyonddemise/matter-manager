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

**Rule:** after implementing a decoder, parser or codec, change one constant at a time and
confirm a test fails. It takes minutes, needs no tooling, and finds the tests that are
decorative. Coverage will not tell you this — the surviving mutant was on a line with 100%
coverage, because coverage measures whether a line *ran*, never whether anything would have
noticed it being wrong.
