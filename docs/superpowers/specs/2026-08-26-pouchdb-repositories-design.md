# Device and room repositories — design

Date: 2026-08-26
Issue: [#21 M2-4](https://github.com/beyonddemise/matter-manager/issues/21)
Status: proposed

## What this establishes

`packages/data` has been an empty package with a README since M0. This is the first code in
it, and it decides how every later story reads and writes: M2-5 adds a device, M2-6 lists
them, M2-8 moves one, M2-9 appends a remark, M5 replicates the lot.

Out of scope, deliberately: replication (M5-2), conflict resolution (M5-6 — `core` already
owns the strategies), attachments (M6), and the `mm-local` cache (M4-5b). Also out of scope
is wiring a real browser database into the application: nothing in `packages/web` persists
anything until M2-5, and adding the dependency before there is a caller would be scaffolding
to work around rather than scaffolding to use.

## A spike changed the shape of this

`pouchdb-browser` is the allowlisted runtime dependency (ADR 0013), so the obvious plan was
for `packages/data` to import it and for tests to swap in `pouchdb-adapter-memory`. That does
not work, and the reason is not subtle:

```
node -e "import('pouchdb-browser')"
ReferenceError: self is not defined
    at pouchdb-browser/lib/index.js:878
```

It references `self` at module scope. The package cannot be imported in Node at all, so any
test importing it would have to run in a browser — for code whose entire job is to be a thin
layer over a database, and which the issue explicitly says to test with the memory adapter.

**So `packages/data` depends on no PouchDB implementation whatsoever.** A repository is
constructed around a database instance handed to it:

```ts
export function repository<T extends Revision>(
  database: PouchDB.Database,
  type: DocumentType,
  now: () => string,
): Repository<T>

export function projectRepositories(
  database: PouchDB.Database,
  now?: () => string,
): { devices: Repository<DeviceDocument>; rooms: Repository<RoomDocument> }
```

- `packages/web` will construct that instance from `pouchdb-browser` when M2-5 needs one.
- The tests construct it from `pouchdb-core` plus `pouchdb-adapter-memory`, both of which load
  in Node cleanly. Verified: a ranged `_all_docs` over `device:` returns exactly the devices.

The only PouchDB thing `packages/data/src` refers to is the **type** `PouchDB.Database`, from
`@types/pouchdb-core`, which is erased at compile time.

This is dependency inversion arrived at by force rather than by taste, which is the good way
to arrive at it. It also makes the package's tests run in milliseconds in plain Node, like
`core`'s.

`packages/data` joins `packages/web` in the dependency checker's `BUNDLED_PACKAGES`, because
its code does reach the browser and so a devDependency its source imported would ship too. A
test asserts that `src` imports no `pouchdb-*` package at all, which is what makes the
`allowedDev` claim — "provably absent from the built output" — an actual proof.

## Typed documents live in `core`

The issue asks for "typed documents from `core`", and that is right for a reason beyond tidiness:
`packages/api` will read and write the same documents in M4, and a second definition of the
device shape is a schema that can drift silently against itself.

```
packages/core/src/documents/
  types.ts   DeviceDocument, RoomDocument, Unsaved<T>
  ids.ts     prefixes, id construction, the _all_docs range, type-of-id
```

Only the two types this story stores. `meta:project` and `audit:*` exist in the data model but
carry no id prefix and have no reader yet; a type declared before anything writes it is a guess
recorded as a fact.

`DeviceDocument` extends `RemarkBearing` from `sync/merge.ts` rather than redeclaring
`_id`/`_rev`/`updatedAt`/`remarks`. That is not just DRY — it means `mergeDevice` accepts a
real `DeviceDocument` without a cast, so the conflict strategies written in M1-6 and the
documents written here are the same thing rather than two shapes that happen to look alike.

### `Unsaved<T>`, and who owns `updatedAt`

```ts
export type Unsaved<T extends Revision> = Omit<T, '_rev' | 'updatedAt'> & { readonly _rev?: string }
```

One type covers both create and update: a first write has no `_rev`, an update carries the one
it read. The repository stamps `updatedAt` on every write and the caller cannot supply it.

That is a deliberate constraint rather than a convenience. `updatedAt` is half of the total
order the conflict merge depends on (ADR 0010, and `compareForWinner` in `merge.ts`). A caller
that forgot to stamp it would not fail; it would produce a document that loses every future
conflict against a correctly stamped one, silently. Making it unsuppliable removes the
possibility.

The clock is injected — `now: () => string` — so tests are deterministic and the package stays
free of ambient time.

## Keying by prefix, and the ranged query

Ids are `device:<uuid>` and `room:<uuid>`, so a type is a contiguous key range and listing one
needs no view:

```ts
{ startkey: 'device:', endkey: 'device:￰', include_docs: true }
```

`￰` rather than `￿` is the documented CouchDB convention: it is above every character
an id here can contain, and it avoids the surrogate-range edge that `￿` sits next to.

This matters more than it looks. A view has to be defined, indexed, and replicated, and it
goes stale; `_all_docs` is maintained by the database itself and is available from the first
write. The cost is that the *only* free query is by id prefix — which is why ids carry the
type, and why `roomId` on a device is a full document id rather than a bare uuid.

A ranged `_all_docs` omits deleted documents entirely — checked against the adapter, not
inferred — so `list` never sees a tombstone. It still narrows away a row with no `doc`, because
the row type declares it optional; that is a type-level guard rather than a behavioural one,
and the code says so.

## The repository

```ts
interface Repository<T extends Revision> {
  get(id: string): Promise<T | undefined>
  list(): Promise<T[]>
  save(document: Unsaved<T>): Promise<T>
  remove(document: T): Promise<void>
}
```

Four decisions worth stating:

- **`get` returns `undefined` for a missing document** rather than propagating PouchDB's
  404-shaped throw. "Not there" is an ordinary answer to an ordinary question. A genuine
  failure — a corrupt database, a closed connection — still throws.
- **`save` returns the stored document**, with its new `_rev` and the `updatedAt` that was
  actually written. Returning nothing would make the caller re-read to update anything twice.
- **No read validation.** The repository types its results and does not check them at runtime.
  Every document in the database was written by this application, and the second writer —
  replication from another client — arrives in M5, which is also when there is somewhere
  sensible to report a rejected document. A guard added now would either drop data silently or
  need an error channel nobody consumes.
- **`remove` takes the document, not the id**, because PouchDB needs the `_rev` and reading it
  for the caller would turn a delete into a read-then-delete with a race in between.

Id generation stays out of `core`: `documentId('device', uuid)` is a pure formatter, and the
uuid comes from `crypto.randomUUID()` at the impure boundary. `core` promising "no I/O, no
ambient anything" is worth more than saving a caller one line.

## Testing

`pouchdb-core` plus `pouchdb-adapter-memory`, a fresh database per test, never a live CouchDB.

| Unit | What it proves |
|---|---|
| id helpers | prefix, range bounds, type-of-id, round trip | 
| device round trip | every field survives, remarks included — the issue's first scenario |
| ranged list | `_all_docs` returns devices and no rooms, with no view — the second scenario |
| `save` | stamps `updatedAt`, returns the new `_rev`, second save does not conflict |
| `get` | `undefined` for missing, the document for present |
| `remove` | gone from `get` and from `list` |
| purity | `packages/data/src` imports no `pouchdb-*` package |

## What could go wrong

**A defensive branch turns out to be unreachable.** `list` filters rows whose `doc` is absent.
A ranged `_all_docs` omits deleted documents entirely — checked against the adapter rather than
inferred — so that branch never runs, and the comment justifying it originally claimed the
opposite. It stays as a type-level narrowing, with the comment corrected to say what it is.

**The range bound is wrong and quietly includes the next type.** `device:` and `room:` are far
apart alphabetically, so an off-by-one bound would still pass a two-type test. The list test
therefore also writes a document whose id sorts immediately after the range
(`device;` — `;` is the character after `:`), which is the only thing a bad `endkey` actually
catches.

**`updatedAt` is stamped from the caller's clock and clocks disagree.** That is inherent and
already accounted for: the merge orders by `(updatedAt, _rev)` precisely because `updatedAt`
alone is not a total order.

**`pouchdb-browser` carries a `uuid@8` advisory.** It is not installed by this story, and
`npm audit --omit=dev` is clean. It returns with M2-5, and the assessment belongs there with
the dependency: PouchDB calls `uuid.v4()` with no buffer argument, and the advisory is about a
missing bounds check when one is supplied.
