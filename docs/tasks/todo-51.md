# M5-4 Invite someone who has no account yet (#51)

- [x] An unknown address becomes an invitation instead of a refusal
- [x] Redeemed by signing in with that address — **no token anywhere**
- [x] `Identity.emailVerified`, and redemption that refuses without it
- [x] Invitations expire, and an expired one cannot be redeemed
- [x] The CouchDB fake now enforces `_rev`, as CouchDB does
- [x] Mutation probes: 7/7 caught, plus 28 core cases
- [x] `npm run verify` — 1709 tests, 88 files

---

## There is no invitation token, and that is the design

An invitation is redeemed by **signing in with the address it was sent to**. What grants access
is therefore control of that mailbox as the identity provider verifies it — not possession of a
link.

A link that granted access could be forwarded, quoted in a support ticket, or read out of a
shared inbox, and any of those would hand somebody else a role in a stranger's house. An address
cannot be any of those things. It also means the email itself carries nothing sensitive: a
project name, who invited you, and a link to the application.

That shifts the entire weight of the feature onto one claim.

## `email_verified` is the whole security model here

`Identity` gained `emailVerified`, read **strictly** as `claims.email_verified === true`:

- Google issues tokens with `email_verified: false` for an address a user has merely typed into
  their account. Redemption by address without this check would turn "invite
  `ada@example.test`" into "let anybody who says they are Ada in".
- A **missing** claim is not a yes. A provider that does not say has not said so.
- The string `"true"` is not a yes either — a truthy check would accept it, and would equally
  accept `"false"`, which is also a non-empty string. There is a test for each.

`redeemable()` reports `unverified` **before** `wrong-address`, deliberately: the address not
matching is something a user can see and act on, while not being verified is a fact about their
account. Somebody whose address is both wrong and unverified is told the thing they can fix.

## Where an invitation lives

The **registry**, beside the project pointers, and there is nowhere else it could go:

- Not the project database — that replicates to every member, and an invitation carries the
  address of somebody who is not one yet.
- Not `_users` — there is no account.

The registry is admin-only and never replicated (ADR 0012), which is exactly the property this
needs.

One document per address per project, so a second invitation **replaces** the first: two
invitations for one person would be two roles to apply in an order nobody chose. The most recent
decision is the decision.

## What is refused, and why each one is not merely tidiness

| Refused | Because |
|---|---|
| `role: owner` | Ownership is transferred, not granted (M5-5). An invitation that could make a stranger an owner on sign-in is a way to give a project away to somebody who has not appeared yet. |
| Inviting yourself | The inviter already has a role, and redeeming **overwrites** it — an owner inviting themselves as a reader would demote themselves on their next sign-in. |
| A caller who may not share | Checked before anything is stored. An invitation that outlived the inviter's permission would be a grant nobody is entitled to make, applied at a later sign-in when nobody is watching. |
| Anything that is not an address | It is stored as a key and matched against a verified claim. |
| Revoking access from a stranger | There is nothing to revoke, and nothing to invite them to. |

## The order at sign-in is load-bearing

`acceptInvitationsOnSignIn` wraps `rememberUser`: **remember first, then redeem.** Redemption
resolves the invitee's address to a subject through `_users`, and until `rememberUser` has
written that account there is nobody to resolve. Reversing the two produces an invitation that is
silently never applied on the one sign-in it was waiting for.

Both halves sit inside the window M4-3 established — after the identity is verified, before the
session is issued — so a failure means **no session**. A failed sign-in can simply be repeated;
somebody signed in without the access they were invited to has no way to notice.

Each invitation is applied independently, and one that cannot be applied is **kept**: the project
may have been deleted or the inviter may have lost the right to grant it, neither of which is the
invitee's doing, and a discarded invitation cannot be applied on a later sign-in when the
situation has changed.

## No sender, no invitations

`InvitationSender` has **no default**. A sender that quietly did nothing would mean invitations
that are recorded, never delivered, and indistinguishable from delivered ones — the share would
look like it had worked.

A deployment with no sender configured answers exactly what it answered before M5-4: *"Nobody
with that address has an account yet."* True, and actionable.

**What the deployment needs:** an `InvitationSender` implementation and whatever credential it
requires. None is included, because choosing an email provider is a decision with a cost and a
data-processing agreement attached, and the interface is four fields wide.

## The fake now enforces `_rev`

The probe reported "a re-invitation is stored alongside the first" as SURVIVED, and the code was
right — the *fake* was wrong. It accepted any write, so dropping `_rev` changed nothing, when
real CouchDB would answer 409.

`putDoc` in `test/support/couch.ts` now conflicts exactly as CouchDB does. **No existing test
broke**, which is the useful part: it means every caller was already carrying `_rev` correctly,
and from now on one that forgets will be caught here rather than on the second write against a
real server.

## Deliberately not here

- **Pending invitations in `GET /members`.** The contract's `Member` requires a `sub`, and a
  pending invitee has none; giving them an empty one would put a name nobody has into a members
  list, which is precisely what `grantRole` refuses. A member list showing pending invitations
  belongs with M5-9's project settings, where the interface for it exists.
- **Wiring into a running deployment.** The auth routes are still not composed in
  `composition.ts` — they need Google credentials — so `acceptInvitationsOnSignIn` is built,
  tested and ready rather than switched on.

## Mutation probes

| Module | Result |
|---|---|
| `core/src/projects/invitation.ts` | 28 test cases, exhaustive over folding, expiry and verification |
| `api/src/projects/invitations.ts` | 7/7 caught |

The one survivor was the fake, described above.
