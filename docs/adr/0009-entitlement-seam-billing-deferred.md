# 9. Entitlement seam now, billing later

Date: 2026-08-19

## Status

Accepted

## Context

The product needs a subscription eventually. It does not need one before it has users, and
choosing a pricing model now would mean guessing at what people value.

But "add billing later" usually goes badly, for a specific and avoidable reason. The
integration is not the hard part — payment providers are well documented and a webhook
handler is a day's work. The hard part is that entitlement checks must appear at every
gated action, scattered across the UI and API, and retrofitting them means auditing the
whole application for places a limit should have applied. Some get missed. The ones that get
missed are, by definition, the ones nobody tested.

## Decision

Build the seam now, defer the provider.

A single service answers `can(principal, action, project)`. Today it returns `true` for
everything. Every gated action calls it from the start: creating a project, inviting a
member, exporting a PDF, attaching a photo.

Accounts carry a `plan` field from the first migration, so there is somewhere to put the
answer when there is one.

## Consequences

- Choosing a model later changes one file and its tests. The call sites already exist and
  are already exercised by the test suite, so a missing one shows up immediately rather
  than as a revenue leak.
- No `if (user.plan === 'free')` scattered through components. Ever. That pattern is the
  precise failure this ADR exists to prevent.
- A small amount of work now for something that earns nothing yet. That is the point.
- The seam must be genuinely called, not merely present. A gated action that skips it is
  invisible until the day it matters, so PR review checks it.
- Provider choice is open. For an EU-based single operator, a merchant-of-record provider
  (Paddle, Lemon Squeezy) removes VAT registration and filing obligations that Stripe would
  leave with the operator — likely to dominate the decision, but it is an M8 decision made
  with real usage data, not a guess made now.
