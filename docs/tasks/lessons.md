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
