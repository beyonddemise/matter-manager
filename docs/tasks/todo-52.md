# M5-5 Transfer ownership (#52)

- [x] `POST /projects/:projectId/transfer` — an **offer**, not a transfer
- [x] `GET /transfers`, `POST /transfers/:projectId`, `DELETE /transfers/:projectId`
- [x] Ownership moves only when the recipient accepts
- [x] The outgoing owner's retained access is real in CouchDB
- [x] Mutation probes: 18/18 caught
- [x] **The contract-drift check's unimplemented list is now empty**
- [x] `npm run verify` — 1766 tests, 90 files

---

## Ownership is offered, never pushed

> An unaccepted transfer would let anyone push responsibility for data — and eventually a bill —
> onto someone who never agreed to it.

So a transfer is **two acts by two people**, and the state in between is a thing this code has to
represent. `POST /projects/:id/transfer` records an offer and changes nothing: the participants
are untouched and `_security` is not written at all. There is a test asserting exactly that,
because "the offer went through" and "the project moved" are easy to conflate in an
implementation that has only one step.

The acceptance half needed operations the contract did not have, so it gained three — `GET
/transfers`, `POST /transfers/{projectId}`, `DELETE /transfers/{projectId}` — along with a
`TransferOffer` schema and a reusable `NotFound` response. Deliberate contract growth, the same
way `POST /auth/signout` arrived in M4-7.

## No token, again

The recipient is identified by an address the provider has **verified** — never by possession of
a link. The reasoning is M5-4's and it applies harder here: an invitation grants a role, a
transfer hands over everything. A forwarded message grants nothing.

`acceptable()` therefore refuses on `emailVerified !== true`, and the mutation probe found that
the tests only ever passed `true` and `false`. A check written as `=== false` accepts every
provider that simply does not send the claim, and nothing would have failed. The absent case now
has its own test, with the reason written next to it.

## The case invitations do not have

Between offer and acceptance the project **may have moved**. An offer made by somebody who is no
longer the owner must not still work — ownership can only be given away by whoever holds it at
the moment it moves — so `acceptable()` re-reads the participants and reports `no-longer-owner`.
Without that check, an owner could offer the project, transfer it elsewhere, and have the first
recipient accept afterwards.

## One offer per project

Not one per recipient. An owner who changes their mind about *who* to hand the house to has
changed their mind; two live offers would be a race between two people to accept the same
project. A second offer replaces the first.

## Both halves at once

`applyTransfer` is a pure function over the whole participant list rather than a demotion
followed by a promotion. Done in two steps there is a moment with two owners or none — and
`grantRole` refuses to demote the last owner precisely so that no such moment can be reached by
accident, which would make the two-step version fail in the middle.

The invariant is asserted directly: **exactly one owner afterwards**, everybody else untouched,
and a recipient who was already a participant promoted rather than listed twice.

`_security` is written **before** the registry, because a transfer always narrows somebody's
access — the outgoing owner loses write, and often loses everything. Same rule as `members.ts`,
same reason.

The probe caught that test being loose: it asserted `putSecurity` came before the *last*
`putDoc`, and accepting also deletes the offer — which is another `putDoc`, so the assertion held
whichever way round the two writes went. It now compares against the pointer write specifically.

## "I can no longer manage members" follows from the role

The first scenario asks for three things: the recipient becomes owner, the installer holds read
access only, and the installer can no longer manage members. The third needs no code —
`canManageMembers('read')` is already false — but the second has to be **true in CouchDB**, not
merely in a list, or the installer can still edit a house they no longer own. There is a test on
`writers.names`.

`retainAccess` is `read` or nothing, and the contract's enum is deliberately not a reference to
`Role`: a departing owner who could keep `manage` could remove the new owner afterwards, which
is not a transfer. The route rejects anything else with a 400.

## 404 wherever a 403 would confirm something

- Offering a project you do not own → 404, because you may not be a participant at all.
- Accepting an offer made to somebody else → 404, even though the caller has an account.
- Declining somebody else's offer → 404. Withdrawing an offer is the owner's act, not a
  bystander's.

The probe found the first version of the stranger test could not reach that branch: the stranger
had no account, so it stopped at an earlier refusal. It now uses the installer — a real account,
a real participant, the wrong address.

## The drift check's list is empty

`openapi-drift.test.ts` has reported "described but not implemented" since M4-2. It listed eleven
operations at #48, three at #50, one at #51, and **none** now. From here it goes red when the
contract grows an operation rather than when somebody forgets to update a list.

## Mutation probes

| Module | Result |
|---|---|
| `core/src/projects/transfer.ts` | 11/11 caught |
| `api/src/projects/transfers.ts` | 7/7 caught |

Three survivors along the way, all loose or unreachable tests rather than wrong code: the absent
`email_verified` claim, the stranger who stopped at the wrong refusal, and the write-order
assertion that could not distinguish the two orders.
