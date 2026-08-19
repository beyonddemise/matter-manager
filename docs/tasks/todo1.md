# Todo 1 — Project setup (M0 Foundations)

Session date: 2026-08-19
Branch: `m0-foundations`

## Goal

Stand up the repository, document the design, produce a reviewable backlog, and prove the
test-first loop works end to end before any feature depends on it.

## Plan

### Repository and tooling
- [x] npm workspaces, TypeScript project references, root scripts
- [x] Biome 2.5.9 (replaces ESLint + Prettier)
- [x] Vitest 4.1.11 with `projects`, coverage gates
- [x] `.gitignore` replaced (was the GitHub Java template)
- [x] `.editorconfig`, `.nvmrc`, `.env.example`
- [x] README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG

### Development environment
- [x] Devcontainer with a CouchDB service matching production
- [x] CouchDB config baked into a derived image rather than bind-mounted
- [x] Host port moved to 5985 to avoid colliding with an existing local CouchDB
- [x] `require_valid_user_except_for_up` so the healthcheck can work unauthenticated

### GitHub
- [x] Issue templates: story, bug, chore
- [x] PR template with a test-first confirmation
- [x] CI: Biome, typecheck, tests with coverage, CouchDB contract check
- [x] Label taxonomy, dependabot

### Documentation
- [x] Design specification
- [x] ARCHITECTURE, DATA-MODEL, SECURITY-MODEL, GLOSSARY
- [x] 11 ADRs
- [x] Backlog for M0–M5, 51 issues with Given/When/Then criteria

### Code
- [x] `packages/core` with the Base38 codec, test-first
- [x] `data`, `web`, `api`, `e2e` as documented placeholders
- [x] OpenAPI contract skeleton

### Verification
- [x] Test observed **failing** (23 red) before implementation
- [x] Green: 29/29, 100% coverage on `core`
- [x] `npm run verify` exits 0
- [x] CouchDB healthy, config applied, existing instance untouched
- [x] CouchDB access model verified: 8/8

## Review

### What was delivered

A repository where `npm run verify` is clean, the red-green-refactor loop has been
demonstrated end to end, and every architectural decision is recorded with its rejected
alternatives.

### The two things that mattered most

**1. The access model was verified, not assumed.** The entire sharing design rests on
CouchDB preserving unknown `_security` keys and passing them to `validate_doc_update`.
Neither is prominently documented. Twenty minutes of curl at M0 confirmed all eight
assertions against CouchDB 3.5.2 — and had it failed, it would otherwise have surfaced in M5
with the whole sharing UI already built on top. It is now
`infra/couchdb/verify-access-model.sh`, running in CI, because a future CouchDB upgrade
breaking it would silently turn read-only access into read-write.

**2. The test vector was wrong, and checking caught it.** The plan gave the reference
payload's Product ID as `0x8001`. Decoding the payload and checking against two independent
anchors — the documented SDK test device field values, and the manual pairing code
`34970112332` derived through an unrelated algorithm — showed the true value is `0x8000`.
Writing the assumed value into a test would have locked a permanent error behind a passing
test, and the implementation would have been bent to match it.

### Deviations from the plan

- **11 ADRs, not 10.** Tenancy earned its own record rather than being folded into the
  backend-language ADR.
- **The access model moved from M5 to M0.** It was the top risk; retiring it early was worth
  more than the plan's sequencing.
- **CouchDB runs on 5985**, not 5984, because an existing local instance owns the default.
- **CouchDB config is baked into an image**, not bind-mounted — forced by a real failure,
  documented in `lessons.md`.
- **Toolchain versions are newer than assumed**: Vitest 4, TypeScript 7, Biome 2.5.9.

### Follow-up in the same session

**M0-6 fixed.** `.env.example` now points at port 5985.

**M0-7 fixed, and the gate had been broken.** Coverage reported 100% while being unable to
see untested code: `coverage.include` was `src/**/*.ts`, which resolves against the
repository root rather than each project, so it matched nothing — and a glob matching nothing
is not an error. Coverage fell back to measuring only the files tests had imported, which are
by definition the covered ones.

Proved by adding an unimported module with real statements: before the fix it was invisible
and coverage stayed at 100%; after the fix coverage dropped to 93.61% and the thresholds
correctly failed. Probe removed, back to 100% (44/44) passing. The empty per-file table
turned out to be the same bug rather than a separate cosmetic issue.

Recorded as lesson L8: **a gate that has never been observed failing has not been shown to be
a gate.**

### Known gaps

- No issues created in GitHub — awaiting review of `docs/backlog/`
- `packages/data`, `web`, `api` are documented placeholders with no `tsconfig.json`, by
  design; each gets one in the milestone that fills it

### Next

1. Review `docs/backlog/` and adjust
2. Bootstrap labels, milestones and issues (M0-8)
3. Begin M1 with M1-1, payload decoding
