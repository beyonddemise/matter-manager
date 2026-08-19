# Architecture Decision Records

Short documents recording decisions that were expensive to make and would be expensive to
reverse, in the [Nygard format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

An ADR captures **why**, at a moment when the alternatives were still live. Code shows what
was decided; it never shows what was rejected, or what would have to change for the
decision to be wrong. That is the part people need eighteen months later.

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-offline-first-pouchdb-couchdb.md) | Offline-first with PouchDB and CouchDB | Accepted |
| [0003](0003-database-per-project.md) | One CouchDB database per project | Accepted (verified) |
| [0004](0004-typescript-backend-openapi-contract.md) | TypeScript backend behind an OpenAPI contract | Accepted |
| [0005](0005-plaintext-payload-storage.md) | Store Matter payloads unencrypted | Accepted |
| [0006](0006-materialised-path-rooms.md) | Rooms as materialised paths | Accepted |
| [0007](0007-client-side-pdf.md) | Generate PDFs in the browser | Accepted |
| [0008](0008-lit-and-web-awesome.md) | Lit and Web Awesome, no SPA framework | Accepted |
| [0009](0009-entitlement-seam-billing-deferred.md) | Entitlement seam now, billing later | Accepted |
| [0010](0010-embedded-remarks-conflict-merge.md) | Embedded remarks with deterministic merge | Accepted |
| [0011](0011-user-owned-org-ready-tenancy.md) | User-owned projects, org-ready schema | Accepted |

## Writing one

Copy the shape of 0001. Keep it to a page. Record what was actually true when you decided,
including the option you nearly took and why you did not. If a decision is later reversed,
do not edit the old record — supersede it, so the reasoning trail stays intact.
