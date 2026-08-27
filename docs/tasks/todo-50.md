# M5-3 Share a project (#50)

- [x] `PUT /projects/:projectId/members` — grant, change, revoke
- [x] `GET /projects/:projectId/members`
- [x] Read access is real: `_security` says who reads, `writers` says who writes
- [x] The two writes go in the order that makes the moment between them safe
- [x] The entitlement seam's second gated route, driven and watched
- [x] Mutation probes: 30/30 caught
- [x] `npm run verify` — 1638 tests, 86 files

---

## Read-only has to be real, and CouchDB is what makes it real

> A UI that hides the edit button while CouchDB would accept the write is not read-only access —
> it is a read-only *appearance*.

`securityFor()` in `core` is the whole mapping, and it is a pure function so it can be tested
exhaustively:

| Role | `members.names` | `writers.names` |
|---|---|---|
| `read` | ✓ | |
| `write` | ✓ | ✓ |
| `manage` | ✓ | ✓ |
| `owner` | ✓ | ✓ |

`manage` and `owner` land in `writers` because **CouchDB cannot express "may change who else has
access"** — from the database's point of view a manager is simply somebody who may write, and
the distinction lives in the API alone. That is `docs/SECURITY-MODEL.md`, and the CI job
`verify-access-model.sh` already proves against a real CouchDB 3.5.2 that a name in `members` but
not `writers` is refused with `{"forbidden": "You have read-only access to this project."}` by
`validate_doc_update`. This issue's job was to produce that shape, not to re-prove it.

Three details in `securityFor` that are each one word away from a hole:

- **`members.roles` is empty and stays empty.** A role there grants access to everybody holding
  it; access here is per person, and a `roles` entry is the one way to share every project with
  every account at once.
- **No `admins` key.** A project admin can rewrite `_security` itself, which would let them grant
  themselves anything.
- **An empty project gets `{members: {names: []}}`, not `{}`.** To CouchDB an *absent* `members`
  means any authenticated user may read — which is the default a fresh database has, and exactly
  what M5-1's provisioning is racing to overwrite.

## Which write goes first, and why it is a function

The registry pointer and the project's `_security` are two databases, so there is no transaction
— only a choice about which half-applied state is safe to be caught in. `narrowsAccess()` decides
it:

- **Taking access away → `_security` first.** The moment between the writes is then one where
  somebody has already lost access rather than one where they still have it. With replication
  running (#49), "still has it" means "is still pulling changes".
- **Giving access → the registry first.** The worst that can happen in between is a project
  listed before it can be opened, which is a refresh away from correct.

A **demotion from writer to reader counts as narrowing** even though `members.names` does not
change — until CouchDB is told, they can still write. That case has its own test, and a mutation
that ignores the writers half survives without it.

## 404 rather than 403 for a stranger

A 403 confirms that a project with that id exists, which is a fact about somebody else's home.
The id is a uuid, so the only way to have one is to have been told it — and telling somebody
holding a guessed id that they guessed right is the only thing this endpoint could leak.

A participant who is merely not allowed *does* get 403: they already know the project exists.

## Roles, and who may hand them out

Only an owner or a manager. **A writer may not**: writing devices and deciding who else may see
the house are different things, and a writer who can add themselves as a co-owner has taken the
project.

A **project must keep an owner**. `grantRole` and `revokeAccess` both refuse to remove the last
one, because there is no way back through the API from an ownerless project — it cannot be
transferred, shared or deleted by anybody. Refused up front rather than repaired later.

**Revocation is spelled `role: null`**, as a value. A body that forgot `role` is a mistake, and
treating a missing field as "remove this person" would make the most destructive operation the
one that happens by accident.

## Two changes at once

All participants live in one document, so two membership changes to the same project conflict —
`docs/DATA-MODEL.md` says so and says the API is the only writer, which makes this a re-read and
retry rather than a merge. Bounded at three attempts: a conflict that keeps happening is
something the caller should hear about rather than wait through.

The probe caught the test for this being too loose. It asserted only that the retry eventually
gave up with a 409, which is also true of a bound of ten thousand — and a caller holding a
request open through ten thousand retries cannot tell that apart from a hang. It now counts.

## Finding somebody by address

`_users` is keyed by subject, so an invitation arriving as an email needs an index — the
alternative is reading every account in the deployment to answer one share.

**The view folds the address, not just the query.** A folded query against an unfolded index
matches nothing, which is the same failure as not folding at all. And the fold matters: the local
part of an address is case-sensitive by the letter of RFC 5321 and case-insensitive at every
provider anybody uses. Somebody typing `Ada@Example.test` to share their house means the person
they know as `ada@example.test`, and telling them that person has no account would be wrong in
the only way that matters.

The view is executed in the tests rather than string-matched, for the reason #48 established:
asserting that the source *contains* `toLowerCase` passes for a view that folds the wrong field.

An address nobody has is **not an error** — it is the one refusal the caller can act on, and
M5-4 turns it into an invitation rather than a dead end.

## The gate fired again, as designed

`gate.test.ts` has kept a `DRIVERS` map since #48 with a loud throw for any gated route it cannot
drive. Implementing `PUT /projects/:projectId/members` meant landing in that file, adding a
driver, and watching the gate be called with `project.invite` — which is exactly what the M4-6
comment said should happen. Both gated routes are now implemented, driven and watched.

The contract-drift check's "described but not implemented" list is down to
`POST /projects/:projectId/transfer`, which is M5-5's.

## What is deliberately not here

- **"They are told plainly that data already on their device remains there."** That sentence
  belongs to an interface, and there is none yet; the API cannot recall what has replicated and
  `openapi/matter-manager.yaml` already says so in the endpoint's own description.
- **Inviting somebody with no account** — M5-4, and the refusal is shaped to become that.
- **Transfer** — M5-5, and `revokeAccess`'s last-owner rule is what it will need.

## Mutation probes

| Module | Result |
|---|---|
| `core/src/projects/membership.ts` | 13/13 caught |
| `api/src/projects/members.ts` | 11/11 caught |
| `api/src/projects/users.ts` | 6/6 caught |

Two survivors in `members.ts`, both my tests rather than the code: the retry bound described
above, and a last-owner test that asserted only the message. `MembershipError` and
`MembershipRefused` carry the same words, so it passed even when the refusal escaped as an
unhandled 500 — which tells the user something went wrong rather than what they need to do first.
