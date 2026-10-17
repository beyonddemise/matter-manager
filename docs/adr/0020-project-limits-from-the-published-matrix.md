# 20. Project limits come from the published matrix; accounts keep theirs

Date: 2026-10-18

## Status

Accepted (amends 0009)

## Context

Under ADR 0009, every gated action asks one seam, and that seam answered from tables in code. Two of
those tables held the same project limits: `PlanPolicy` in the backend and `PROJECT_LIMITS` in the page
(free 1, member 5, pro unlimited). Separately, the operator maintains the published plan matrix (the
`plans` document behind `GET /plans`) as marketing copy, and it said Home includes **3**.

Nothing compared the two, so they drifted. A Home account read "Projects your plan includes: 5" on the
projects page while the plan comparison beside it said 3. The bug was not in the page: it showed exactly
what the API reported. The bug was that one fact had two homes.

Management sets the limits, may change them at any time, and may introduce new plan levels. A limit
written into code changes only with a release, and it can disagree with what the account was told.

## Decision

**The matrix decides.** The matrix row stored with `"key": "projectLimit"` is enforced as well as shown,
whether or not it is `active`. Its cells are parsed strictly: a whole number from 0, or `Unlimited` (any
case, with an optional footnote `*`). A cell that is neither leaves that plan's limit unknown. Nothing is
guessed, because this cell is display copy that is also enforced, and a wrong guess either refuses
paying accounts or removes the limit for everyone. The member tier is read from a `member` column, else
from its marketing name `home`.

**Each account keeps what it was given.** The user record holds `entitlement: {plan, projectLimit}`.
Every access check that needs the limit (create, unarchive, transfer accept, every profile answer)
brings the record up to date:

- the matrix raises the plan's limit: the account is raised, and the higher limit is recorded;
- the matrix lowers it: the account keeps its higher limit (a *legacy plan*), and new accounts get the
  lower one;
- the account switches plan, through an operator or a hand edit: the new plan's limit applies, even when
  it is lower. The plan recorded beside the number is how a switch is told from a matrix change.

**Both numbers are reported.** `GET /profile` answers `projectLimit` (the account's, which is what the
gate enforces) and `planProjectLimit` (the plan's today). The page derives "legacy plan" from the two:
*"Projects your plan includes: 3. Yours: 5 (legacy plan)."* Neither repository keeps a limit table any
more. A device that never heard a limit assumes one project, the least any plan grants.

**Without an answer, refuse.** When the matrix has no readable limit for the account's plan and the
account holds none recorded for it, the answer is `503 entitlements-unavailable`. It is not a built-in
default. A free account is still told `plan-no-sync` without the matrix being read, because the gate asks
for the limit lazily and only after sync.

## Consequences

- An operator's edit to the matrix applies at the next access check, without a deploy. The matrix is
  read on every check rather than cached: the checks are rare, and a cache would make an edit take
  effect at an unpredictable time.
- Lowering a limit never takes projects from anyone. A plan switch can leave an account over its new
  limit. Making those surplus projects read-only, and what happens to them afterwards, is #284. Until
  then such an account keeps everything usable and cannot create more, as before.
- The matrix's `projectLimit` key must be in place before a backend that reads it is deployed. Without
  it, every account without a recorded limit gets 503 on `GET /profile`.
- New plan *levels* still need a release. The tier is a Java enum carried into JWT roles, the CouchDB
  validator and the waitlist ranking. Making tiers data is a separate decision (phase 2). This one makes
  every *limit* data.
- We considered keeping the code table as a fallback when the matrix is unreadable. We rejected it: the
  fallback is exactly the second copy that caused the bug, and it would silently come back into force
  whenever an operator mistyped a cell.
