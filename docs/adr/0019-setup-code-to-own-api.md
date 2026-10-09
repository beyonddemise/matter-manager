# 19. A setup code may travel to our own API for the catalogue lookup

Date: 2026-10-07

## Status

Accepted. **Amends [ADR 0005](0005-plaintext-payload-storage.md)**: its decision stands, and
this adds a path the payload may travel and the controls on it. It replaces the contributor rule
in `SECURITY-MODEL.md` that read "Never send a payload to a third party. The DCL lookup sends
vendor and product ids only", which assumed the lookup would never see a payload.

## Context

Nothing fills in a device's manufacturer and product names, although the device page, the
inventory PDF and search all read them. The CSA's Distributed Compliance Ledger (DCL) holds
them, keyed by vendor and product ID, and both IDs are inside every setup code.

The old rule covered the browser calling the DCL with the two IDs. It did not consider the
browser handing the code itself to our API, and the approved design does exactly that. The
options were:

1. **The browser calls the DCL directly.** It is unauthenticated and CORS-open. Rejected:
   every browser would tell a third party which products are in which home, tied to its IP
   address. Nothing could cache or serve a stale answer, and the DCL documents neither rate
   limits nor terms of use.
2. **The browser decodes the code and sends our API the two IDs.** This keeps the old rule as
   it was. It is the option nearly taken.
3. **The browser sends our API the code, and the API decodes it.** This is the approved design
   (spec 2026-10-05, "Decisions taken before the design"). One request shape serves QR payloads
   and manual codes alike. The API validates the code itself (Base-38, the reserved bits, the
   Verhoeff check digit) before anything is cached under its IDs. Backfill sends what the
   device document already stores.

## Decision

A setup code, either a QR payload or a manual pairing code, may be sent to **this service's
own API**, `POST /catalog/lookup`, under these conditions, all of them enforced:

- **Only in a POST body over TLS**, never in a URL, so it appears in no access log.
- **Decoded in memory** to the vendor and product IDs. It is never stored and never logged, and
  no error response echoes it. `code` is a redacted log field, and a route test captures the
  service's log output and finds neither `MT:` nor the manual code's digits in it.
- **Only the two IDs reach the DCL.** The DCL is still a third party, and the old rule still
  holds for it. Test vendors (0xFFF1–0xFFF4) never leave the process.
- **Signed-in callers only**, limited per subject (`Limits.catalog`), so one account cannot use
  the endpoint as a free DCL proxy.
- The cache, `matter_catalog`, holds public DCL records only, and is admin-only.

## Consequences

**Gains.**
- Names are filled in for every device, including ones added offline, through backfill.
- The DCL learns only which IDs this service asked about, never who asked.

**Costs, accepted knowingly.**
- **For a free-plan user, whose projects never sync, this is the first time a payload leaves
  the device.** Until now it stayed in IndexedDB. The lookup is open to every plan, so the
  exposure is new for exactly the users who were never exposed. It covers both legs: the
  browser reaches the API through the Cloudflare Pages Functions proxy (`/api`), where
  Cloudflare terminates TLS, so the body passes through Cloudflare in transit. Synced payloads
  already do the same through `/db`, and the proxy logs no bodies. The mitigation is everything
  above: the code is in our process for the length of one request, and in no file afterwards.
- A debug log added later around this route is now a place a passcode could be written. The
  redaction list and the log-capture test are what stand in the way. Do not weaken either.

Revisit this ADR if the lookup ever needs to persist anything derived from the code beyond the
two IDs, or if anything between the browser and this API starts logging request bodies, such
as a proxy, a WAF or an analytics layer.
