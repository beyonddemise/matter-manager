# 11. User-owned projects with an org-ready schema

Date: 2026-08-19

## Status

Accepted

## Context

Projects need an owner. Two user groups pull in different directions.

A **homeowner** owns one or two projects and shares them with a partner. A single-user owner
is exactly right.

A professional **installer** commissions houses for customers, may employ several people
sharing a portfolio, and hands finished projects over to homeowners. That points to
organisations owning projects, with roles granted at organisation level.

Building organisations now means org CRUD, invitations, role inheritance, and billing
attached to organisations rather than users — a substantial subsystem, for a user group that
is currently hypothetical. Building user ownership now and organisations later means a data
migration touching every project and every authorisation call site.

## Decision

Projects are owned by a single user, and ownership is transferable. Installer hand-over is
"create, commission, transfer, optionally retain read access" — which covers the workflow
without an organisation concept.

But the owner field is polymorphic from the first commit:

```ts
{ ownerType: 'user' | 'org', ownerId: string }
```

Only `user` is ever produced today. The rule that makes this worth anything: **no code
anywhere compares against a bare user id.** Every authorisation decision goes through one
`isOwner(principal, project)` helper.

## Consequences

- Homeowners get the simple model that suits them, immediately.
- Installers get a workable hand-over flow without waiting for organisations.
- Adding organisations later is a new `ownerType` value plus an org CRUD surface. No data
  migration, no rewrite of authorisation call sites.
- The cost is a slightly more verbose owner reference, and the discipline to route every
  check through the helper. That discipline is the entire value — a single `project.ownerId
  === user.sub` comparison anywhere reintroduces the migration this ADR exists to avoid, and
  it will not be noticed until organisations are attempted.
- PR review checks for direct owner-id comparisons.
- CouchDB's `_security` cannot express ownership at all; it knows only readers and writers
  (ADR 0003). Ownership and the `manage` role are enforced by the API alone.
