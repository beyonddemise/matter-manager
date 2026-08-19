# M5 — Projects and synchronisation

**Goal:** Release 1.0. Multiple projects, shared with other people, synchronised across
devices, correct when two people work offline at once.

This is the milestone where the offline-first decisions are actually tested.

---

## M5-1 · Provision a project database

`type:story` `area:api` `security` `size:L`

**Story:** as a user, I want to create a project for a house, so its devices are separate
from every other house.

```gherkin
Scenario: a project is created
  When I create a project
  Then a project_<uuid> database exists
  And its _security lists me as a member and a writer
  And _design/access is installed
  And a document appears in the central projects registry listing me as owner
  And GET /projects returns it to me and to nobody else

Scenario: creation requires connectivity
  Given no connectivity
  When I try to create a project
  Then I am told clearly that this one operation needs a connection
  And nothing is queued that would half-create it later

Scenario: provisioning is atomic
  Given database creation succeeds but writing _security fails
  Then the database is removed
  And no pointer is written
```

**That third scenario is the one to get right.** A database without `_security` is readable
by anyone with an account. A half-created project is a security hole, not an inconvenience.

---

## M5-2 · Replicate projects

`type:story` `area:sync` `size:L`

```gherkin
Scenario: projects sync automatically
  Given I am a member of two projects
  When I sign in on a second device
  Then both replicate and their devices appear

Scenario: offline changes sync on reconnect
  Given I added devices offline
  When connectivity returns
  Then they appear on my other devices without any action from me

Scenario: replication survives interruption
  When the connection drops mid-replication
  Then it resumes from where it stopped rather than restarting
```

---

## M5-3 · Share a project

`type:story` `area:auth` `size:M`

```gherkin
Scenario: read access is granted
  When I grant someone read access
  Then they see the project and its devices
  And any attempt by them to write is refused by CouchDB, not merely hidden in the UI

Scenario: write access is granted
  Then they can add and edit devices

Scenario: access is revoked
  When I revoke access
  Then they cannot replicate further changes
  And they are told plainly that data already on their device remains there
```

**The read-access scenario must be tested at the database level, not the UI level.** A UI
that hides the edit button while CouchDB would accept the write is not read-only access —
it is a read-only *appearance*, and the difference is the entire point of
[ADR 0003](../adr/0003-database-per-project.md).

---

## M5-4 · Invite someone who has no account yet

`type:story` `area:auth` `size:M`

```gherkin
Scenario: an invitation is accepted
  When I invite an email address that has no account
  Then they receive an invitation
  And on signing in with Google using that address, they gain the granted role
  And the project's document in the projects registry gains them as a participant

Scenario: an invitation expires
  Then an expired invitation cannot be redeemed
```

---

## M5-5 · Transfer ownership

`type:story` `area:auth` `size:M`

**Story:** as an installer, I want to hand a finished project to the homeowner, so they own
their own data.

```gherkin
Scenario: ownership is transferred
  When I transfer a project and choose to retain read access
  Then the recipient becomes owner
  And I hold read access only
  And I can no longer manage members

Scenario: transfer requires acceptance
  Then the recipient must accept before ownership changes
```

**Why acceptance is required:** an unaccepted transfer would let anyone push responsibility
for data — and eventually a bill — onto someone who never agreed to it.

---

## M5-6 · Resolve conflicts

`type:story` `area:sync` `size:L`

**Story:** as a user who worked offline, I want nothing silently lost.

```gherkin
Scenario: concurrent remarks all survive
  Given two people, both offline, each add a remark to the same device
  When both reconnect
  Then both remarks are present, attributed and in chronological order

Scenario: concurrent field edits resolve deterministically
  Given two people rename the same device offline
  When both reconnect
  Then the later edit wins, on both devices
  And both devices show the same result

Scenario: conflict revisions do not accumulate
  After a merge
  Then the losing revisions are removed
  And _conflicts is empty for that document
```

**Test plan:** two Playwright browser contexts, both `setOffline(true)`, both edit, both
reconnect. This is the single most important e2e test in the product — the failure it guards
against is silent, so users would never report it.

---

## M5-7 · Offline user experience

`type:story` `area:web` `size:M`

```gherkin
Scenario: sync state is visible
  Then the app shows whether changes are synced, syncing, or waiting for connectivity

Scenario: only genuinely server-bound actions are blocked
  When offline
  Then only project creation and member management are unavailable
  And each explains why rather than merely being greyed out

Scenario: the project list survives going offline
  Given the project list was fetched while online
  When I go offline and reload
  Then my projects are still listed from mm-local
  And each shows whether it is available offline on this device

Scenario: what I may access and what I have are tracked separately
  Given a project I have access to but have never opened on this device
  Then it is listed with localState "not-downloaded"
  And a project whose replica is present shows "downloaded"

Scenario: revoked access is reported, not hidden
  Given my access to a project was revoked while I was offline
  When I reconnect and replication returns 403
  Then the project is shown as "access removed"
  And the app does not appear broken
```

**Extends `mm-local` (M4-5b)** from caching the profile to caching the project list.

**Why `localState` is not redundant with the server list:** the server says what you *may*
access; `localState` says what you *actually have here*. They diverge constantly — a project
granted on your phone is not downloaded on your laptop — and only the second answers "what can
I open right now". It also gives an honest indicator: *3 of 5 available offline*.

---

## M5-8 · Switch and manage projects

`type:story` `area:web` `size:M`

```gherkin
Scenario: projects are switched
  Then I can move between projects, and the current one is remembered

Scenario: my role is visible
  Then read-only projects are marked, and editing controls are absent rather than disabled

Scenario: a project is archived
  When I archive a project
  Then it stops syncing and is hidden, but is not deleted
```

---

## M5-9 · Project settings

`type:story` `area:web` `size:S`

Rename, address, and the room list: create, rename, reorder, delete with reassignment of
affected devices.

```gherkin
Scenario: a room with devices cannot be silently deleted
  When I delete a room containing devices
  Then I must choose a destination room or confirm moving them to "Unassigned"
```

---

## M5-10 · Release 1.0 readiness

`type:chore` `area:infra` `size:M`

**Done when:** end-to-end suite green including offline and conflict scenarios; the CouchDB
access model check green; German and English both complete with no missing translations;
tested on iOS Safari, Android Chrome and desktop; the operator controls in
[SECURITY.md](../../SECURITY.md) verified on the live instance; and a **backup restored into
a clean environment**.

**A backup that has never been restored is not a backup.** Do it once, deliberately, before
anyone else's data is in there.
