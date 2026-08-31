# todo-55 — Switch and manage projects

Closes #55 in three parts. **This is part one.**

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
