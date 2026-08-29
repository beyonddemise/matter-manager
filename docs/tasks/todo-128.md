# A project's name cannot be changed, and its address is discarded (#128)

- [x] `PATCH /projects/{projectId}` in the contract, and the drift check went red first
- [x] `ProjectPointer` and `ProjectSummary` gain `address`; the view emits it
- [x] `provisionProject` **stores** the address it was already validating
- [x] `updateProjectSettings` — name, address, or both; participants untouched
- [x] `canManageMembers`, 403 for a participant who may not, **404 for a stranger**
- [x] Mutation probes: 14/14 caught
- [x] `npm run verify` — 1960 tests, 96 files

---

## The bug underneath the feature

M5-9 asks for "rename, address, and the room list". Writing the issue turned up something the
story does not mention: `POST /projects` has accepted an `address` since M5-1, the route reads
it, and `provisionProject` **checked its length and returned only the name**.

```ts
if ((request.address ?? '').length > MAX_ADDRESS) {
  throw new ProvisioningError(...)
}
return name          // the address went no further
```

So a 201 said everything worked, and the address of the building was gone. The length check is
the part that makes it a bug rather than an unimplemented field: it is the only evidence anyone
ever meant to keep the value, and it is also the only code that ever looked at it.

That is why this shipped as a story rather than folded into the room work — it is a data loss
that predates the feature request.

## Three states, not two

`address` in a `PATCH` body means three different things, and collapsing any two of them breaks
something:

| Sent | Means |
|---|---|
| absent | leave the address alone |
| `null` | remove it |
| a string | set it |

If absent and `null` were the same, a client sending `{ name: 'x' }` would erase an address
nobody asked it to touch. The same convention already exists in `PUT /projects/:id/members`,
where `role: null` revokes — "spelled as a value rather than as a missing field, so that a body
which forgot `role` is a mistake rather than an accidental revocation".

Empty and whitespace-only become **absence**, not an empty string. An empty string is a value
every reader has to special-case, and it exports as a blank line rather than as nothing.

## The pointer is one document, and that is the hazard

The registry pointer holds the project's name *and* its participant list. A rename written as a
fresh document from its arguments would silently drop every member — the same failure
`applyTransfer` was written against in M5-5.

So the update is a read, an amendment of the fields being changed, and a write of the whole
thing back, and there is a test asserting the participants are **exactly** as they were. The
probe for it fails that test alone, which is the point: nothing else about the response would
look wrong.

## Who may, and what a refusal admits

`canManageMembers`, not `isOwner`. Naming is a settings change, and whoever may decide who has
access may certainly correct a name; requiring ownership would make an installer's manager
useless for the thing they are most likely to fix.

A stranger gets **404, not 403**, the rule the rest of `routes.ts` follows. A 403 confirms that a
project with this id exists, which is a fact about somebody else's home — and the id is a uuid,
so the only way to hold one is to have been given it.

## The contract went first, and the drift check said so

`openapi-drift.test.ts` has reported an empty "described but not implemented" list since M5-5.
Adding the operation to the specification turned it red — `PATCH /projects/:projectId` — and the
route turned it green again. That is the order the check exists to enforce.

## A probe that survived for a reason worth keeping

Replacing the conditional spread in `GET /projects` with a plain `address: row.address` survived
every test. It is not a false alarm and it is not a real bug either: `JSON.stringify` **omits
keys whose value is `undefined`**, so with an undefined address the response is byte-identical
either way.

What the guard actually defends against is `null` — which is what CouchDB emits, because the map
function names `doc.address` whatever the pointer holds, and a missing field renders as null
rather than being left out. The test now seeds `address: null`, which is the value that really
arrives, and the mutant is caught.

**Seeding `undefined` there would have proved nothing at all.**

## Not done

The settings interface. `area:web`, and #120 stands in front of it — which is now the only thing
between M5 and a working application.
