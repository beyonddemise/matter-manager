# 1. Record architecture decisions

Date: 2026-08-19

## Status

Accepted

## Context

This project makes several decisions early that are cheap now and very expensive later:
database-per-project authorisation, storing commissioning secrets unencrypted, generating
PDFs client-side, deferring billing behind a seam.

Each was chosen against real alternatives for reasons that will not be visible in the code.
Someone reading `packages/api` in a year will see that projects get their own database.
They will not see that filtered replication was considered and rejected because the filter
runs after the read and therefore is not a security boundary. Without that, the natural
assumption is that the current design is arbitrary, and the natural next step is to "simplify"
it into a vulnerability.

## Decision

Record architecturally significant decisions as ADRs in `docs/adr/`, in Nygard format.

Significant means: it constrains future work, it was contested, or reversing it would touch
many files. Library choices that could be swapped in an afternoon do not qualify.

Records are immutable. A reversed decision gets a new ADR that supersedes the old one; the
old one stays, marked superseded.

## Consequences

Decisions carry their reasoning, including the rejected alternatives and the conditions
that would make them right after all. Onboarding gets faster and re-litigation gets rarer.

The cost is discipline: an ADR written after the fact reconstructs a rationale rather than
recording one, and tends to justify what was done rather than explain why. Write it while
the alternatives are still live.
