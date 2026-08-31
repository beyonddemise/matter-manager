# todo-55 — Switch and manage projects

Closes #55 in three parts. **All three are done.**

## Why three parts

The issue is `size:M` and its three scenarios turned out to want three different things:

1. **This one — archiving, on the server.** There was no archive support anywhere: not in the
   API, not in the OpenAPI contract, not in `core`, not in the local cache. The maintainer chose
   account-wide rather than per-device, which makes it a contract change.
2. **Switching and roles** in the interface, on the plumbing #120 landed.
3. **Moving the local catalogue into a project**, so `project_local` can be emptied deliberately
   rather than stranded.

## Archived is a state, not an event

A project that could be archived and not unarchived would be deleted with extra steps, and the
scenario says explicitly that it is *not* deleted. So `PATCH /projects/{projectId}` takes
`archived: true` or `false`, alongside the name and address it already took from #128 — the same
route, because this is a setting rather than a new kind of operation.

Authority is the same as the other settings: `owner` or `manage`. Hiding a project from everyone
who shares it is not something a contributor does.

## No migration, deliberately

The stored field is optional and the view emits `doc.archived === true`, so every pointer written
before this change reads as `false` without being rewritten. The alternative was touching every
document in the registry to record a fact that is false for all of them — and L31 is about
exactly what goes wrong when registry documents are rewritten.

The **contract** field is required, so a client never has to read an absence as a `false`. The
absence is the storage layer's business and stops there.

## Archived projects are still listed

`GET /projects` returns them, with the flag. Filtering them out on the server would leave a
client no way to show what it had put away and therefore no way to bring it back — which would
make archiving a deletion after all. Hiding is the client's job, and it needs the flag to do it.

## Tasks

- [x] `archived` on the registry pointer, optional, no migration
- [x] `archived` on `ProjectSummary`, required
- [x] `PATCH /projects/{projectId}` accepts it, validated as a boolean at both the route and the
      operation
- [x] The registry view emits it as a real boolean
- [x] `GET /projects` reports it and filters nothing
- [x] The OpenAPI contract says all of this, and the generated types are regenerated
- [x] Tests: archived, unarchived, alongside a rename, refused for `write`, refused for a
      stranger, and a pointer written before the field existed

## Review

**Part one done.** `npm run verify` clean, 2173 tests pass, 618 of them in the API.

Three existing tests failed on the change, all asserting the exact response shape with
`toEqual`. That is the correct outcome and the reason to write them that way: a contract that
grew a required field should break the assertions that describe it, rather than passing because
they only checked the fields they knew about.

---

# Part two — switching, and what a read-only project offers

## The switcher is in the header, not in Settings

Moving between buildings is context you change while working, not a preference you set once.
Putting it a page away would make it a navigation task. It appears only when there is more than
one project, because a control offering one choice is not a choice.

## "On this device" is a real entry

`project_local` predates accounts and holds everything anybody recorded before signing in.
Leaving it out of the switcher would make those devices vanish the moment somebody signed in —
for an application whose promise is not losing a code, the worst possible first impression of
having an account.

It is always first, always writable, and its contents are never uploaded. Moving them into a
project deliberately is part three.

## Signing out now asks a question

This is the part worth reviewing hardest, because it changes existing behaviour.

Sign-out used to destroy `project_local`, which was right when it was the only catalogue and
belonged to whoever used the browser. Once it is a catalogue you keep and switch to, that becomes:
record devices while signed out, sign in, sign out, and they are gone — destroyed by leaving an
account that never owned them.

So the sign-out control asks, **unticked by default**. Everything the account put here goes
either way.

## Sign-out also removes the replicated project databases

A gap #120 opened and nothing closed: replication gives this browser a database per project the
account can see, and `removeLocalDatabases` only ever knew two fixed names. Signing out left
every device of the previous user on a shared machine — precisely what signing out exists to
prevent.

The names come from the local cache rather than from `indexedDB.databases()`, which Firefox did
not have before 126 and this application supports.

## Absent, not disabled

A disabled control says "this is possible and you are doing it wrong". On a project somebody may
only read, neither half is true. So the add button, the edit, disable and delete actions, and the
remark composer are **removed** on a read-only project — while the remarks themselves, the
labels and the PDF export stay, because reading is what read access is for.

There is a positive control for this: a view that rendered no add button at all would satisfy the
absence assertion while being broken for everybody.

## Views hear about a switch

Each view resolves its repositories once and holds them — re-resolving per render would open a
second handle on the same database and fire every change feed twice. So `useProjectDatabase`
raises an event and the three views that read a database listen for it.

---

# Part three — moving the local catalogue into a project

## The hard part is the rooms

Copying documents is arithmetic. Both catalogues name rooms by **path**, and ADR 0006 settled
long ago that `Ground Floor/Kitchen` and `ground floor / kitchen` are the same room — so a move
that copied rooms by id would put a second Kitchen into a project that has one. That is the
duplicate M1-5 and M2-5 exist to prevent, walking back in through the door nobody was watching.

`planMigration` lives in `core`, is pure, and reuses `roomPathKey` rather than answering the
question a second time.

## Written first, removed second, never the other way round

PouchDB has no transactions, so a failure between the two has to leave *something*. Of the two
possible half-finished states — the devices in both catalogues, or in neither — only one loses
nothing. Duplicates are a tidying problem; a gap is the failure this application exists to
prevent.

## A retry does not duplicate, and the test proved I was wrong about why

Each device keeps its id, so a move interrupted and retried writes the same document rather than
a second one. The first version claimed that made a retry safe. It did not: the second write
carries no `_rev`, and PouchDB answers **409**. The test written to demonstrate the property
failed on it.

Devices already in the target are now skipped rather than rewritten — which is also the right
behaviour for a different reason. Carrying the target's `_rev` and overwriting would replace
whatever has happened to the device *in the project* since (a remark added, a room corrected)
with a stale copy from the catalogue it came from.

## The offer appears only when it means something

An empty local catalogue has nothing to move; an account with no writable, unarchived project has
nowhere to put it. Neither is an error, so neither is reported — the section is simply absent.

Every assertion about that is an absence, and all of them would pass against a section that never
rendered at all, so there is a positive control alongside them.
