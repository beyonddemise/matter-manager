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

## Update 2026-10-03: `project.sync` is the second real policy

`project.create` was the first policy to refuse; `project.sync` is the second. It asks whether a
plan may own server projects at all (`SYNCED_PLANS`: free no, member and pro yes) and is asked
before `project.create` on every route that makes a project active: `POST /projects`, unarchiving
via `PATCH /projects/:id` (the owner's plan) and accepting a transfer (the recipient's plan). Both
actions' call sites were already there, which is the seam doing what this record says it would:
making each policy a table change rather than an audit. Archived projects no longer count toward
the limit. The CouchDB validator additionally refuses writes from an owner whose plan cannot
sync; see `docs/SECURITY-MODEL.md`, *Operator accounts and plans*.

## Update 2026-11-24: the provider is Stripe

The product owner settled the provider question on 2026-10-28 (#263): **Stripe**. The integration
defaults, shared by both repositories:

- **Stripe-hosted pages only.** Subscribing is a Stripe-hosted Checkout; changing plan, cancelling
  and updating the payment method is the Stripe Customer Portal. The API answers a session URL and
  the browser is sent there by a top-level navigation, so card data never reaches our code, there is
  no Stripe.js, and the Content-Security-Policy names no Stripe origin (a navigation is neither a
  `connect-src` fetch nor a `form-action` submit).
- **Stripe is the source of truth for the plan.** A signed webhook maps the subscription's price to a
  plan and sets it through the same path an operator's `PUT /customer` takes, so a downgrade starts
  the read-only grace of #211/#284 exactly as an operator's does. Neither the redirect back from
  Checkout nor anything in the browser grants a plan; the page rereads the profile and shows what the
  webhook set.
- **The next billing date and the cancellation state** come from the subscription and are exposed as
  `billing` on the profile; the account page shows them.
- **Unconfigured means absent.** Every `/billing` route answers 404 on a deployment without Stripe,
  and the app then behaves as it did before billing: the waitlist dialog behind Upgrade, no purchase
  on the account page.
- **VAT.** As the consequences above noted, Stripe, unlike a merchant of record, leaves VAT
  registration and filing with the operator. Stripe Tax is a configuration switch
  (`STRIPE_AUTOMATIC_TAX` on the backend), not a code decision.

What this record set out to protect held: the provider arrived as a new route group and one page,
with the entitlement call sites untouched. Amounts are not in the app: the published plan matrix
(ADR 0020) and Checkout state them, so a price change needs no release. The contract is the
`billing` tag in `openapi.yaml`; the backend half is matter-manager-backend#60.
