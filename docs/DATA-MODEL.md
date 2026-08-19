# Data model

Two kinds of database: one per user, and one per project.

## `user_<sub>` — one per user

Replicated to that user's browsers. `<sub>` is the internal user id, which is also the
CouchDB username carried in the JWT's `sub` claim.

### `profile`

```jsonc
{
  "_id": "profile",
  "type": "profile",
  "displayName": "Stephan",
  "email": "someone@example.com",
  "locale": "auto",          // "auto" | "en" | "de" — "auto" follows the browser
  "theme": "auto",
  "createdAt": "2026-08-19T08:00:00.000Z"
}
```

### `project:<uuid>` — membership pointers

```jsonc
{
  "_id": "project:8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60",
  "type": "projectPointer",
  "projectId": "8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60",
  "dbName": "project_8f14e45f_ceea_467a_9c0e_1b2c3d4e5f60",
  "role": "owner",           // owner | manage | write | read
  "projectName": "Musterstraße 12",
  "addedAt": "2026-08-19T08:00:00.000Z"
}
```

**This is how a client discovers what to replicate.** `_all_dbs` is blocked, so there is no
enumeration path — a user sees exactly the projects the server has told them about.

Pointers are written by the API on grant and revoke, and a `validate_doc_update` in this
database makes them read-only to the user. Otherwise a user could grant themselves
membership by writing a pointer, and CouchDB would happily let them try to replicate it.
(The project database's own `_security` would still refuse, but a client showing projects it
cannot open is a bug worth preventing at the source.)

## `project_<uuid>` — one per project

The unit of sharing. See [ADR 0003](adr/0003-database-per-project.md).

### `meta:project`

```jsonc
{
  "_id": "meta:project",
  "type": "projectMeta",
  "name": "Musterstraße 12",
  "address": "12 Musterstraße, 12345 Musterstadt",
  "ownerType": "user",       // "user" | "org" — polymorphic from day one (ADR 0011)
  "ownerId": "auth0|abc123",
  "createdAt": "2026-08-19T08:00:00.000Z",
  "schemaVersion": 1
}
```

`ownerType`/`ownerId` are never compared directly. Every check goes through
`isOwner(principal, project)` in `core`, which is what makes organisations a later addition
rather than a later migration.

### `room:<uuid>`

```jsonc
{
  "_id": "room:3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "type": "room",
  "path": "Ground Floor/Kitchen",   // materialised path, "/" separated (ADR 0006)
  "sortKey": 100,
  "updatedAt": "2026-08-19T08:00:00.000Z"
}
```

Hierarchy is derived by splitting `path`. There is no `parentId`, which is precisely why
there are no reparenting conflicts to resolve under offline sync.

### `device:<uuid>`

```jsonc
{
  "_id": "device:6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "type": "device",
  "name": "Kitchen ceiling light",
  "roomId": "room:3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "spot": "ceiling, north end",     // free text the room name cannot capture

  // --- from the QR code ---
  "payload": "MT:Y.K9042C00KA0648G00",
  "manualCode": "34970112332",
  "vendorId": 65521,                // 0xFFF1
  "productId": 32768,               // 0x8000
  "discriminator": 3840,
  "vendorName": "Example GmbH",     // from the DCL lookup, may be absent
  "productName": "Smart Bulb A60",
  "deviceTypeId": 266,

  // --- user metadata ---
  "serial": "SN-000123",
  "installedAt": "2026-08-19",      // defaults to the scan date
  "addedAt": "2026-08-19T08:00:00.000Z",
  "updatedAt": "2026-08-19T08:00:00.000Z",
  "disabled": false,
  "disabledAt": null,

  "remarks": [
    {
      "id": "9f8e7d6c-1234-4567-89ab-cdef01234567",
      "text": "Replaced batteries",
      "authorSub": "auth0|abc123",
      "authorName": "Stephan",
      "createdAt": "2026-08-19T09:30:00.000Z"
    }
  ]
}
```

`_attachments` carries device photos, downscaled client-side before saving — attachments
replicate in full and are by far the largest driver of sync bandwidth.

**`payload` is a secret.** It contains the setup passcode. Never log it, never send it to a
third party (the DCL lookup sends vendor and product ids only), and never include it in a
bug report. See [SECURITY.md](../SECURITY.md).

**Remark ids are client-generated UUIDs**, not indices or counts. The conflict merge unions
by id, and positional identity would make "the same remark twice" indistinguishable from
"two different remarks".

### `audit:<iso>-<uuid>`

```jsonc
{
  "_id": "audit:2026-08-19T09:30:00.000Z-9f8e7d6c",
  "type": "audit",
  "actor": "auth0|abc123",
  "action": "device.disabled",
  "targetId": "device:6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "before": { "disabled": false },
  "after": { "disabled": true },
  "at": "2026-08-19T09:30:00.000Z"
}
```

Append-only and immutable, enforced by `validate_doc_update`. Because nothing ever rewrites
them, **audit entries cannot conflict** — a property worth preserving deliberately.

## Conflicts

CouchDB detects conflicts and picks a deterministic winner. It does not merge. Without an
explicit strategy, a remark added offline on one device silently disappears when another
device's revision wins — the worst kind of bug, because nobody notices and so nobody reports
it.

`core` owns the strategies; `data` applies them on every change event.

| Shape | Strategy |
|---|---|
| `remarks` | Union by `id`, sorted by `createdAt`. Nothing is discarded. |
| Scalars (`name`, `roomId`, `disabled`, `spot`) | Last write wins by `updatedAt`. |
| `room.path` | Last write wins. A deleted room still referenced by a live device is resurrected as `Unassigned/<old path>`. |
| `audit:*` | Cannot conflict — append-only. |

Losing revisions are deleted after a successful merge, or `_conflicts` grows without bound
and every read pays for it.

See [ADR 0010](adr/0010-embedded-remarks-conflict-merge.md).

## Identifiers

- Documents use a `type:` prefix (`device:`, `room:`, `audit:`) so ranged `_all_docs` queries
  can select a kind without a view.
- Database names replace UUID hyphens with underscores: CouchDB database names are
  restricted to `[a-z][a-z0-9_$()+/-]*`, and underscores avoid ambiguity in URLs.
- `schemaVersion` on `meta:project` drives migrations. Migrations must be able to run against
  a replica that has been offline for months, so they must be idempotent and must never
  assume they run exactly once.
