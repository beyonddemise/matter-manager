# M0 — Foundations

**Goal:** a repository where the test-first loop demonstrably works, before any feature
exists to distract from whether it does.

Most of this was completed in the initial setup session. Issues are listed so the work is
tracked and so the remaining items are visible.

---

## M0-1 · Monorepo scaffolding ✅

`type:chore` `area:infra` `size:M`

**What:** npm workspaces, TypeScript project references, Biome, Vitest, root scripts.

**Done when:**
- `npm run verify` runs Biome, typecheck and tests, and exits 0
- `packages/core` builds via project references
- `data`, `web`, `api` and `e2e` exist as workspaces with READMEs stating what lands there
  and in which milestone

**Note:** those packages deliberately have no `tsconfig.json` yet. An empty composite
project makes `tsc --build` fail, and scaffolding that must be worked around is worse than
scaffolding that does not yet exist.

---

## M0-2 · Devcontainer with CouchDB ✅

`type:chore` `area:infra` `size:M`

**What:** a devcontainer whose CouchDB matches production exactly.

**Done when:**
- `docker compose -f .devcontainer/docker-compose.yml up -d couchdb` reports healthy
- `curl http://localhost:5985/_up` succeeds unauthenticated
- The dev stack does not collide with any CouchDB already running on the machine

**Two findings worth keeping:**
- Host port is **5985**, not 5984, so a CouchDB already running locally is untouched.
- CouchDB config is **baked into a derived image, never bind-mounted**. The upstream
  entrypoint chowns `/opt/couchdb` as root under `set -e`; a bind-mounted file cannot be
  chowned, so it exits 1 with *no log output at all*. Documented in both Dockerfiles.
- The healthcheck is unauthenticated, which requires `require_valid_user_except_for_up`.
  Without it every probe 401s, the container never reports healthy, and dependents hang.

---

## M0-3 · CI pipeline ✅

`type:chore` `area:infra` `size:S`

**Done when:** push and PR run Biome, typecheck, tests with coverage gates, and the CouchDB
contract check; all green on `main`.

---

## M0-4 · Verify the CouchDB access model ✅

`type:spike` `area:infra` `security` `size:M`

**Why:** the entire sharing design rests on CouchDB preserving unknown `_security` keys and
passing them to `validate_doc_update`. Neither is prominently documented. If either is
false, read-only access silently becomes read-write and no application test would notice.

**Done when:** a repeatable script asserts all of the following against the pinned CouchDB
version, and runs in CI.

```gherkin
Scenario: a custom writers key survives
  Given a project database
  When _security is written with a non-standard "writers" key
  Then reading _security back returns that key intact

Scenario: a reader can read but not write
  Given alice is in writers and bob is not, and both are members
  When bob attempts to create a document
  Then the write is forbidden
  And bob can still read existing documents
  And bob cannot delete a document

Scenario: audit entries are immutable
  Given an audit document exists
  When anyone attempts to write a second revision of it
  Then the write is forbidden

Scenario: a non-member is refused entirely
  When mallory, who is not a member, reads any document
  Then access is denied
```

**Result: 8/8 pass against CouchDB 3.5.2.** Preserved as
`infra/couchdb/verify-access-model.sh`. Run it against any new CouchDB version before
adopting it.

---

## M0-5 · Base38 codec, test-first ✅

`type:story` `area:core` `size:M`

**Story:** as a developer, I want the innermost layer of the Matter codec implemented
test-first, so the red-green-refactor loop is proven before feature work depends on it.

**Done when:** `decodeBase38` and `encodeBase38` pass 29 tests including a verified
reference vector, invalid characters, illegal chunk lengths, chunk overflow, and lossless
round-trips. 100% coverage.

**Critical detail:** the reference vector was **verified against two independent anchors**
before use — the documented field values of the standard SDK test device, and the manual
pairing code derived through an unrelated algorithm. This corrected an assumption: the
payload's Product ID is `0x8000`, not `0x8001`. See the comment block in
`packages/core/test/matter/base38.test.ts` and do not change an expected value without
re-deriving it externally.

---

## M0-6 · Fix the .env.example CouchDB port ✅

`type:chore` `area:infra` `size:S`

`COUCHDB_URL` read `http://localhost:5984`; the dev stack moved to `5985`.

**Done:** `.env.example` reads `COUCHDB_URL=http://localhost:5985` with a comment explaining
that the container-internal port is still 5984.

---

## M0-7 · Confirm coverage counts untested files ✅

`type:chore` `area:infra` `size:S`

**The gate was broken, and it was broken in the way that produces false confidence.**

```gherkin
Scenario: an untested module counts against the gate
  Given a module in packages/core/src that no test imports
  When coverage runs
  Then that module appears in the report at 0%
  And the overall percentage drops accordingly
  And the thresholds fail
```

**What was wrong:** `coverage.include` was `src/**/*.ts`, which reads as project-relative but
is resolved against the **repository root**. It therefore matched nothing — and matching
nothing does not raise an error. Coverage silently fell back to measuring only the files the
tests happened to load, and reported a confident **100%**.

**Verified by proof, not inspection.** An unimported module with real statements and branches
was added:

| | Before fix | After fix |
|---|---|---|
| Probe visible in report | no | yes, at 0%, lines 4–7 |
| Statements | 100% (44/44) | 93.61% (44/47) |
| Thresholds | passed | **failed**, as they should |

Probe removed; back to 100% (44/44) and passing. Fixed to `packages/*/src/**/*.ts`.

The empty per-file table noted earlier was the same bug, not a separate cosmetic issue — it
populates correctly now.

---

## M0-8 · Bootstrap script for labels, milestones and issues

`type:chore` `area:infra` `size:M`

**Done when:** a script reads `.github/labels.yml` and `docs/backlog/*.md` and creates the
labels, milestones and issues via `gh`; is idempotent; and prints what it would do with
`--dry-run`.

**Out of scope:** syncing changes back from GitHub into the markdown. One direction only —
once issues exist, GitHub is the source of truth and these files become historical.
