# Upgrade dialog: plan comparison and a free waitlist (design)

Date: 2026-10-09
Status: approved 2026-10-09
Issue: #224. The decisions are recorded in the issue's comments.

## What this is for

**Upgrade** currently opens a dialog that says "It's just alpha — coming soon". This design replaces it with
two things:

- a **comparison of the three plans** with the user's current plan highlighted;
- a **free waitlist**: "Under heavy development, join the waitlist for free." Joining records on the server
  which plan the user would like, so an operator can see the demand.

Nothing is sold and no entitlement changes. `planRequested` is a request, not a plan. An operator still sets
`plan` through the existing operator routes. Billing stays undecided (ADR 0009).

## Decisions taken before the design

| Question | Decision |
| --- | --- |
| Field name | `planRequested` (not `levelRequested`), plus `requestedAt` |
| Signed-out users | Must sign in first. The dialog shows the comparison and "Sign in to join the waitlist" |
| Joining again or changing the plan | Overwrites `planRequested` and `requestedAt`. "Leave the waitlist" clears both |
| Comparison rows | Projects; sync and sharing; client name; transfer; price |
| Prices | "Free" for Free; "To be announced" for Member and Pro while ADR 0009 is open |
| Operators | A CouchDB view `by_plan_requested` on `matter_manager`, read in Fauxton or with curl. No admin UI (#230) |
| Offline | The comparison is shown. Joining is disabled with "Needs a connection" |
| API shape | A resource of its own, `PUT`/`DELETE /waitlist`, not fields on `PATCH /profile` |

## API

### `PUT /waitlist`

Joins the waitlist, or changes the plan already requested.

**Request**
- **Authentication:** a bearer access token is required. Without one the response is 401 `Not signed in`
  (the same `callerClaims` as `/profile`).
- **Body:** `{ "plan": "member" | "pro" }`.

**Errors**

| Status | Title | When |
| --- | --- | --- |
| 400 | `Not a plan to wait for` | `free`, or an unknown value |
| 409 | `Already on this plan` | The caller already has the requested plan or a higher one, judged by plan order through the domain helpers, not by plan literals |

**Effect**
- The record is created if it does not exist yet, through the existing `ensureRecord`: joining is server
  interaction that needs a record.
- The store then writes exactly `planRequested` and `requestedAt` (an ISO 8601 string), named-field and
  retried on a 409 like every other record write.

**Response:** 200 with the updated `Profile` and `cache-control: private, no-store`.

**Log:** one line, `waitlist: joined <plan>`, with the subject only and never the email (like the sign-in log
line).

### `DELETE /waitlist`

Leaves the waitlist.

- **Authentication:** the same as `PUT /waitlist`.
- **Effect:** removes both fields from the record. It is idempotent: if no record exists, or the caller is not
  waiting, it does nothing. It never creates a record.
- **Response:** 200 with the `Profile`. This is `GET /profile`'s answer when no record exists.

### The profile

`Profile`, the response of `GET`/`PATCH /profile` and of both waitlist operations, gains optional
`planRequested` and `requestedAt`. Both are absent unless the user is waiting. The frontend cache
(`cache:profile`) stores them as well.

### Contract

- `openapi.yaml` gains the `/waitlist` path with `put` and `delete`, the `WaitlistRequest` schema, the two
  problems, and the optional `Profile` fields.
- The generated types and the drift test cover them.

## Server

- **Record.** `UserRecord` gains `planRequested?: Plan` and `requestedAt?: string`.
- **Store.** `UserRecords` gains `requestPlan(email, plan, at)` and `clearRequest(email)`. Both are named-field
  mutations through the existing retrying `mutate`. `profileOf` passes the two fields through.
- **View.** `backend/src/users/database.ts` installs a second design document, `_design/by_plan_requested`, in
  the same `once()` setup as `by_sub`. It emits `[planRequested, requestedAt]` with the email as the value, for
  records where `planRequested` is set.
- **Operator query.** Operators read it with:

  ```
  curl -u admin … '<couch>/matter_manager/_design/by_plan_requested/_view/by_plan_requested?startkey=["pro"]&endkey=["pro",{}]'
  ```

  The exact command goes into the backend README.
- **Routes.** `backend/src/profile/waitlist.ts` exports `registerWaitlistRoutes(app, deps)`, wired in
  `server.ts` next to the profile routes, with the same dependencies.

## Plan comparison data

`frontend/src/domain/plan.ts` gains `PLAN_FEATURES: Record<Plan, { clientName: boolean; transfer: boolean;
price: 'free' | 'tba' }>`. Its values are Free: none and `free`; Member: none and `tba`; Pro: both and `tba`.

- **Other rows** are derived, not repeated:
  - Projects: from `PROJECT_LIMITS` (1 local, 5, unlimited).
  - Sync and sharing: from `SYNCED_PLANS`.
- **No plan literals.** The view never compares `plan === '…'` (ADR 0009). It iterates `PLANS`, adding the list
  if it does not exist yet, in upgrade order.

## The dialog

It replaces the body of `renderUpgrade` (`frontend/src/ui/shell-header.ts`). The shell passes the plan, the
session, `online`, the cached profile's `planRequested`, and the callbacks (join, leave, sign in, close).

- **Comparison.**
  - A table with the plans as columns and the rows above.
  - The current plan's column is highlighted with a `wa-tag` "Your plan" and the brand surface tokens. This
    follows DESIGN.md's One Status Vocabulary rule.
  - At 360 px it becomes one stacked `wa-card` per plan. It must not scroll horizontally.
  - Check marks and dashes are `wa-icon` with labels, so the table reads correctly to a screen reader.
- **Statement:** "Under heavy development. Join the waitlist for free."
- **Actions:**

  | State | Actions |
  | --- | --- |
  | Signed out | One button, "Sign in to join the waitlist", which runs the existing sign-in |
  | Signed in, not waiting | "Join the waitlist for Member" and "Join the waitlist for Pro", only for plans above the current one |
  | Waiting | "You are on the waitlist for Pro (since …)" with "Change to Member"/"Change to Pro" where it applies, plus "Leave the waitlist". Leaving asks for no confirmation: it is not destructive and can be redone at once |
  | Offline | Every action that needs the server is disabled, with "Needs a connection" |

- **Errors** show inline in a `wa-callout`, in DESIGN.md's error style. A 409 says "You already have this plan".
- **Copy:** English and German (formal *Sie*), all through `msg()`. The voice is dry and plain (PRODUCT.md).

## Docs

- **DATA-MODEL.md:** the two fields in the record example, and the new view.
- **SECURITY-MODEL.md:** the record now also holds `planRequested` and `requestedAt`. It stays admin-only.
- **Backend README:** the operator query.
- **This spec:** an "as built" section.

## Testing

**Backend**
- Store: request, overwrite, clear, and a conflict retry.
- Routes:
  - 401 without a token.
  - 400 for `free` or an unknown plan.
  - 409 for the plan the caller already has, or a lower one.
  - A record is created on join.
  - `DELETE` creates no record and is idempotent.
  - The response is the profile.
  - The log has no email.
- View: the design document is installed, and the map emits only for waiting records.
- Drift test and contract.

**Frontend**
- Domain: `PLAN_FEATURES` and `PLANS` order. The public-API test.
- Client: `waitlistApi` join and leave, never throws on network or 401 (it reports the outcome).
- Dialog (browser tests):
  - each state (signed out, not waiting, waiting, offline);
  - the current plan is highlighted;
  - plans at or below the current one have no join button;
  - join and leave update the shown state and the cached profile;
  - the German strings.
- Visual check at 360 px and 1280 px, light and dark.

## Out of scope

Payment, billing and real prices; an admin UI; email notification of joins; changing `plan` from the waitlist.

## As built

Implemented in one PR on `feat/waitlist-224`, following
`docs/superpowers/plans/2026-10-09-upgrade-waitlist.md`. Where the build settled something this
design left open:

- **Plan order on the server** is `backend/src/domain/waitlist.ts`: `hasAtLeast` and
  `isWaitlistPlan`, both tables keyed by `Plan`. The frontend order is `PLANS` and `plansAbove`
  in `frontend/src/domain/plan.ts`, with its own `isWaitlistPlan` derived from `PLANS` (R9): the
  profile cache and the profile parser both use it, so a cached `free` request is refused by the
  same rule as on the server.
- **The 409** carries `reason: already-on-plan` (`AlreadyOnPlan` in `openapi.yaml`). The 400 uses
  the shared `BadRequest`. The client branches on the status, never the title.
- **Both or neither.** `profileOf` reports `planRequested` and `requestedAt` only together, and
  only for `member` or `pro`, so a hand edit in Fauxton cannot put an out-of-contract value in a
  response.
- **The log line** is Fastify's request log, `{ sub }` with the message `waitlist: joined <plan>`.
  The address is not in it. An unknown stored plan is reported without the address too.
- **The view** `by_plan_requested` emits `[planRequested, requestedAt]` valued by address for any
  record with a `planRequested`. It is installed with `by_sub`; the API never reads it.
- **The dialog** is `frontend/src/ui/upgrade-dialog.ts`. On desktop it is a table, at phone width
  (`<wa-page>`'s 768 px breakpoint) it is stacked cards. Offline also disables "Sign in to join
  the waitlist", because signing in needs the server too.
- **German plan names** are Kostenlos, Mitglied and Pro. "Free" is one string, used both as a
  plan name and as a price, so it has one translation.
- **The shell** caches the profile `PUT`/`DELETE` answers with and re-reads its facts, so the
  dialog and an offline reload agree with the server.

### Rulings made during execution

- **R3, Upgrade stays reachable.** The Upgrade button shows when the plan has something above it
  or a request is pending. A raised account (for example Pro with a stale request) can still open
  the dialog and leave the waitlist. Cost: such an account sees Upgrade until it leaves.
- **R4, one filled brand button.** In the dialog the join for the next plan up is the only
  filled (`accent`) brand button; further joins, "Change to" and "Leave the waitlist" are
  outlined, following DESIGN.md's Commissioning Blue Rule.
- **R8, commit trailer.** Every #224 commit carries the single trailer the plan's implementer
  rules prescribe, `Co-Authored-By: Claude Opus 5.5`, whichever model implemented it.
- **R9, `isWaitlistPlan`.** The frontend check that a cached request is a plan one can wait for
  was folded into W5's fix as one domain function, replacing a separate "accepts free" patch.
- **R10, W6 follow-ups.** Three W6 minors were fixed in W7 because they touch the same file and
  test: the desktop cards-hidden assertion, a why-comment on `msg('Free')`, and the `dt` label
  class.
- **R11, `index.html` meta.** `frontend/index.html` gained `mobile-web-app-capable` (commit
  `16a698c`), fixing a console warning found during the browser checks.
- **R12, the cache write can fail.** A join the server accepted but the device could not store
  shows the inline notice "Saved, but this device could not store it. Reload to see it." rather
  than failing silently.
- **R13, return focus.** The dialog gives focus back when it closes by any route (Close, Esc, or
  the Upgrade button going away after "Leave the waitlist"), WCAG 2.4.3.
- **R14, the fallback target.** When Upgrade is gone the target is the scheme toggle, the next
  control in header focus order. A button announces one label and does not talk over the live
  announcement as `<main tabindex="-1">` would.

### Deferred minors

None affects correctness or the contract.

- A record without `sub` that holds an unknown plan is warned about with no identifier, the cost
  of keeping the address out of the log.
- `hasAtLeast(free, free)` is not in the matrix test, and the profile test helper uses `as never`.
- No view test covers `planRequested` of `''` or a missing `requestedAt` (it emits `[plan, null]`).
- The plan check runs outside `requestPlan`'s mutate, so an operator raising the plan mid-request
  leaves a moot request. It is harmless: `DELETE` clears it and R3 keeps it reachable.
- The 409 test asserts the absent field, not zero `putDoc` calls.
- A `PUT` happy path makes three reads.
- `plansAbove(unknown)` returns every plan; the type rules the input out.
- The current plan's `th` accessible name includes "Your plan", which is accurate but repeated
  per cell.
- Sign-in shows while the session is still `undefined` (mandated by the brief, low impact), and
  Sign in and Close stay enabled while a change is busy.
- At 360 px the German signed-out header wraps to two rows (pre-existing, no overflow), and plan
  card icons wrap below long German labels (cosmetic).
- A focused waiting line inside `role="status"` may be read twice, and a repeated identical
  "left the waitlist" announcement is not re-announced.
