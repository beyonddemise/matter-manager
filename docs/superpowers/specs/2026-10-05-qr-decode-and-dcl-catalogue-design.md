# Full QR capture and a DCL-backed vendor and product catalogue: design

Date: 2026-10-05
Status: proposed

Related:
- [`docs/qr-rules.md`](../../qr-rules.md), the QR format rules.
- [ADR 0018](../../adr/0018-own-qr-encoder.md), our own encoder.
- The M6 "Enrichment: DCL lookup" milestone in `2026-08-19-matter-manager-design.md`, which this
  delivers.

## What this is for

A Matter QR code carries more than the passcode: a payload version, vendor and product IDs, a
commissioning flow, discovery capabilities and a discriminator. The app already decodes all of
these (`decodePayload` in `frontend/src/domain/matter/payload.ts`), but `readCredential` drops
version, flow and discovery. Nothing ever fills in `vendorName` and `productName`, although
the device page, the inventory PDF and search all read them. PRODUCT.md claims those names are
filled in automatically. That claim is not true yet.

This design does two things:
1. **Capture** every decoded field worth keeping on the device document.
2. **Look up** the manufacturer and product in the CSA's Distributed Compliance Ledger (DCL),
   through our backend, which caches the results in CouchDB.

In a relational database, the vendor ID would be a foreign key and the display would join.
Here the catalogue values are **copied onto the device document** when the device is created,
or later by backfill. A device record then stays complete offline, in a PDF and after it has
been handed over.

## Decisions taken before the design

| Question | Decision |
| --- | --- |
| What the app sends to the backend | **The full code** (`MT:` QR string or 21-digit manual code). The backend decodes it. This changes the documented rule "the DCL lookup sends vendor and product ids only"; see [Security](#security) |
| Decoded fields captured on the device | Payload version, commissioning flow, discovery capabilities (vendor ID, product ID, discriminator and the payload were already stored) |
| Raw TLV extension | Not captured separately: it is already inside the stored payload string |
| Device added offline | **Backfill** once online: the app looks the device up and writes the names into the document as an ordinary, synced edit |
| Catalogue fields copied onto the device | Vendor name, **vendor preferred name**, product name, device type, part number, product, support and manual URLs, commissioning instructions and custom-flow URL, factory-reset instructions |
| Cache staleness | A found entry is refreshed after **90 days**; a miss is retried after **1 day**; a stale entry is served if the DCL is unreachable |
| Refreshing on demand | An admin UI with "refresh" and "refresh all": **future**, its own issue, not planned here |
| Who may call the lookup | **Signed-in users only**, rate-limited per user |
| Test vendors 0xFFF1–0xFFF4 | Never sent to the DCL (verified absent from MainNet and TestNet); answered locally as "Test vendor" |
| Copied fields in the edit form | Read-only |

## The DCL

Verified by calling the live API on 2026-10-05.

**Endpoints.**
- MainNet REST base: `https://on.dcl.csa-iot.org/dcl`. TestNet: `https://on.test-net.dcl.csa-iot.org/dcl`.
- Unauthenticated, with `Access-Control-Allow-Origin: *`. No rate limits or terms of use are
  documented.
- Vendor: `GET /vendorinfo/vendors/{vid}` returns `{ "vendorInfo": { vendorID, vendorName,
  companyLegalName, companyPreferredName, vendorLandingPageURL, creator, schemaVersion } }`.
- Model: `GET /model/models/{vid}/{pid}` returns `{ "model": { vid, pid, deviceTypeId,
  productName, productLabel, partNumber, commissioningCustomFlow, commissioningCustomFlowUrl,
  commissioningModeInitialStepsHint, commissioningModeInitialStepsInstruction, userManualUrl,
  supportUrl, productUrl, factoryResetStepsInstruction, … } }`.
- IDs go in the path in **decimal**.

**Conventions.**
- Not found is HTTP 404 with `{"code":5,"message":"not found","details":[]}`.
- An empty string or 0 means "not set". The mapping turns both into `null`.

## Architecture

```
add-device form / backfill ──POST /api/catalog/lookup {code}──▶ backend
                                                     decode → (vid, pid)
                                                     matter_catalog (CouchDB) ── fresh? ─▶ answer
                                                              └─ stale/absent ─▶ DCL (ids only) ─▶ store ─▶ answer
browser ◀── catalogue result ── copies fields into the device document (PouchDB, synced as usual)
```

### Backend

**`POST /catalog/lookup`** (the public path `/api/catalog/lookup`, through the existing
proxy).

**Request and access.**
- Bearer access token required. Without one: 401 `Not signed in`.
- Body: `{ "code": string }`, either a QR string (`MT:…`) or a 21-digit manual pairing code.
- A POST, so the passcode-bearing string never appears in a URL or an access log.
- Rate limit: a new `catalog` entry in `Limits` (ADR 0016), **keyed by token subject** rather
  than IP. Default: 120 requests per 300 s. Over the limit: 429 with `retry-after`.

**Response 200:**

```jsonc
{
  "vendorId": 4447,
  "productId": 8194,
  "source": "dcl",                    // "dcl" | "test-vendor" | "missing"
  "vendor": {                         // null when missing
    "name": "Aqara",
    "preferredName": null,            // companyPreferredName, "" → null
    "legalName": "Lumi United Technology Co., Ltd.",
    "landingPageUrl": "https://www.aqara.com/"
  },
  "product": {                        // null when the model is missing (vendor may still be found)
    "name": "Aqara Door and Window Sensor P2",
    "label": "Aqara Door and Window Sensor P2",
    "partNumber": "AS056",
    "deviceTypeId": 21,
    "productUrl": "https://www.aqara.com/en/products.html",
    "supportUrl": null,
    "userManualUrl": null,
    "commissioningCustomFlow": 0,
    "commissioningCustomFlowUrl": null,
    "commissioningInstructions": "1. Please make sure …",
    "factoryResetInstructions": null
  },
  "fetchedAt": "2026-10-05T16:20:00Z",
  "stale": false                       // true when served past 90 days because the DCL was unreachable
}
```

**Errors.** Every error is an RFC 7807 problem response, and none echoes the code.

| Status | When |
| --- | --- |
| 400 | Not a decodable code |
| 422 | A valid code that carries no vendor or product ID (the 11-digit manual code) |
| 401 | Not signed in |
| 429 | Rate limited |
| 503 | The DCL is unreachable or timed out (5 s) **and** nothing is cached |

`source: "missing"` with status 200 is a normal outcome, not an error.

**Modules.** All new modules live under `backend/src/catalog/`.

| Module | Responsibility |
| --- | --- |
| `decode.ts` | The backend's own decoder: Base-38 and the bit unpacking up to vendor and product ID, plus the 21-digit manual code. ADR 0017 keeps the two halves free of shared code, so it is tested against the same reference vectors as the frontend's `decodePayload` |
| `dcl.ts` | `dclClient(baseUrl, fetchImpl)`: `vendor(vid)`, `model(vid, pid)`. Each returns the record, `missing` for a 404, or throws for anything else. Native `fetch` (ADR 0013), with a timeout through `AbortSignal.timeout(5000)` |
| `store.ts` | `matter_catalog` access through the existing `CouchClient`. `ensureCatalogDatabase` is lazy and runs once, like `ensureUsersDatabase`. `_security` is admin-only |
| `policy.ts` | Pure: `isFresh(entry, now)` (found: 90 days; missing: 1 day) and the mapping from DCL JSON to the response shape |
| `routes.ts` | `registerCatalogRoutes(app, deps)`, wired in `composition.ts` when the CouchDB and DCL dependencies exist |

**Configuration.** `DCL_BASE_URL`, defaulting to MainNet. Tests inject a fake `fetch`.

**Contract.** The operation and schemas go into `openapi.yaml`, with generated types and the
existing drift test (ADR 0015/0017).

### Database: `matter_catalog`

Admin-only, created on first lookup. Document IDs use **decimal** numbers. Each document keeps
the DCL record **raw** (minus `creator`), so a field we start using later needs no re-fetch.

```jsonc
// a found vendor
{ "_id": "vendor:4447", "type": "vendor", "vid": 4447, "status": "found",
  "fetchedAt": "2026-10-05T16:20:00Z", "network": "mainnet",
  "dcl": { "vendorID": 4447, "vendorName": "Aqara", "companyLegalName": "…", "companyPreferredName": "",
           "vendorLandingPageURL": "https://www.aqara.com/", "schemaVersion": 0 } }

// a found model
{ "_id": "model:4447:8194", "type": "model", "vid": 4447, "pid": 8194, "status": "found",
  "fetchedAt": "2026-10-05T16:20:00Z", "network": "mainnet",
  "dcl": { "deviceTypeId": 21, "productName": "Aqara Door and Window Sensor P2", "partNumber": "AS056", "…": "…" } }

// a miss, retried after one day
{ "_id": "model:4447:9999", "type": "model", "vid": 4447, "pid": 9999, "status": "missing",
  "fetchedAt": "2026-10-05T16:20:00Z", "network": "mainnet" }
```

**The view.** `_design/catalog`, view `by_fetched`: emit `fetchedAt`. It exists for the future
"refresh all" and costs nothing now.

**The lookup algorithm.**
1. Decode the code to `(vid, pid)`. If the vendor ID is a test vendor (0xFFF1–0xFFF4), return
   `source: "test-vendor"` with vendor name "Test vendor" and product `null`, touching neither
   CouchDB nor the DCL.
2. Read `vendor:{vid}` and `model:{vid}:{pid}`. Anything absent or not fresh is re-fetched from
   the DCL. The vendor and model fetches are independent and run in parallel.
3. A successful fetch is written back: found, or missing on a 404. A write conflict (another
   request stored it first) is ignored; the response uses what was fetched.
4. If a fetch fails and a cached entry exists, return the entry with `stale: true`. If nothing is
   cached, return 503.
5. Map to the response. A missing vendor and a missing model both give `source: "missing"`; a
   found vendor with a missing model gives the vendor and `product: null`.

### Device document

These fields are added to `DeviceDocument` (`frontend/src/domain/documents/types.ts`), all
optional. Optional fields keep existing devices valid, so no migration is needed. The existing
`vendorName`, `productName` and `deviceTypeId` are reused unchanged.

```ts
// decoded locally from the payload, at create time, offline
payloadVersion?: number
commissioningFlow?: 'standard' | 'userActionRequired' | 'custom' | 'reserved'
discovery?: { softAp: boolean; ble: boolean; onNetwork: boolean }

// copied from the catalogue (create or backfill)
vendorPreferredName?: string
partNumber?: string
productUrl?: string
supportUrl?: string
userManualUrl?: string
commissioningFlowUrl?: string
commissioningInstructions?: string
factoryResetInstructions?: string
/** When the catalogue was last consulted for this device, found or not. */
catalogCheckedAt?: string
/** Whether that consultation found the product: 'found' | 'missing' | 'test-vendor'. */
catalogSource?: 'found' | 'missing' | 'test-vendor'
```

**Copy semantics.** The catalogue block (`vendorName` through `catalogSource`) is written as a
unit. `catalogSource` maps the API's `source`: `dcl` becomes `found`; `missing` and
`test-vendor` stay as they are. A field the DCL leaves empty is **removed** from the document, not written as an empty
string.

**Merging (`mergeDevice`).** The block from the side with the newer `catalogCheckedAt` wins
whole. The decoded fields never change after creation, so they merge trivially.

**Editing.** The edit form shows the copied fields read-only and does not write them.

## Flows

### Adding a device (`frontend/src/ui/views/add-device.ts`)

1. **Decode.** A scan, an upload or a valid typed code goes through `readCredential`, which now
   also returns `version`, `customFlow` and `discovery`. This step needs no network.
2. **Look up.** If a session exists and the browser is not known to be offline,
   `catalogApi.lookup(code)` runs in the background:
   - debounced 300 ms;
   - aborted when the code changes or the form closes;
   - never awaited by submit.
3. **Show progress.** A quiet hint, "Looking up manufacturer…", appears while the request runs.
   A result shows read-only "Manufacturer" (the preferred name, otherwise the vendor name) and
   "Product" lines.
4. **Save.** Submit calls
   `planNewDevice(draft, rooms, clock, catalog?)`.
   - It copies the decoded fields, and the catalogue block if a result arrived in time.
   - `planNewDevice` stays pure: the result is an argument.
5. **Fail quietly.** Any failure (offline, signed out, timeout, 5xx, 429) saves the device without
   names and shows nothing alarming. Backfill catches up later.

### Backfill (`frontend/src/ui/catalog-backfill.ts`)

**When it starts.** The app shell starts it, like sync:
- while signed in;
- on connectivity becoming online;
- on switching project;
- once after sign-in.

**Which devices it picks.** Devices in the open project that meet all of these:
- the project is editable (`projectIsEditable`);
- the device has a payload or a 21-digit manual code;
- `catalogCheckedAt` is absent, or `catalogSource` is `missing` and the check is older than 1 day.

**How it runs.**
- One request at a time, with 1 s between requests.
- Stops at the first network or 401 failure, and waits until the next trigger.
- On 429, waits for `retry-after`.

**Writing.** It writes through the normal device repository (`devices.save`), so the edit syncs
and merges like any other. It writes only the catalogue block, which the existing timestamps
already cover; it never touches user-entered fields.

**Payload handling.** Backfill sends stored payloads to our API, which is the decision recorded
above. It sends each one only while the device has no `catalogCheckedAt`, so once per device, plus
retries for misses.

### Display

**Device page.**
- **Manufacturer:** the preferred name, then the vendor name, then the hex ID (as today).
- **Product:** the product name, then the hex ID.
- **Links:** product, support and manual URLs, when present, opening in a new tab with
  `rel="noopener noreferrer"`.
- **Two `<wa-details>` sections, shown only when their text exists:**
  - "How to put it in pairing mode": commissioning instructions, plus the custom-flow link;
  - "Factory reset": factory-reset instructions.
- **Tags:** discovery (`BLE`, `Wi-Fi`, `On network`) and a non-standard commissioning flow
  ("Needs the manufacturer's app") as `<wa-tag>`s.
- **DCL text** is shown as plain text, never as HTML.

**Inventory PDF.** The manufacturer (preferred name) and the part number.

**Search.** The part number and the preferred name join the search text in `browse.ts`.

**Localisation.** All new strings go through `msg()`, with German translations (formal *Sie*).
**PRODUCT.md** §Positioning becomes true. Its wording is checked, and the claim is reworded if
anything still differs.

## Security

**What changes.** SECURITY-MODEL.md ("Never send a payload to a third party. The DCL lookup sends
vendor and product ids only"), DATA-MODEL.md and ADR 0005 are amended. The new rule:
- The payload may be sent to **our own API**, `POST /catalog/lookup`, over TLS, in the request
  body.
- The backend decodes it in memory and **never stores or logs it**.
- **Only vendor and product IDs reach the DCL.** The DCL is still a third party, and the old rule
  still holds for it.

**Enforcement.**
- `backend/src/logging.ts` adds `code` to its redacted keys.
- A route test asserts that captured log output contains no `MT:` and no digit string of the
  manual code.
- Error responses never include the code.
- Rate limiting is keyed by subject, so one account cannot use the endpoint as a free DCL proxy.

**DCL content is untrusted text.** URLs are rendered only if they are `https:`, and text is
rendered as text.

## Testing

**Backend.**
- `decode.ts`: the frontend's reference vectors, including the reference QR and the long manual
  code; malformed input; error texts free of the code.
- `dcl.ts`: an injected `fetch` with recorded real responses (Aqara vendor 4447, model
  4447/8194), the real 404 body, the timeout, and a non-JSON 5xx.
- `policy.ts`: fresh, stale at 90 days and one second, a miss at 1 day, the empty-to-`null`
  mapping.
- `routes.ts`:
  - 401 without a token, 429 past the limit;
  - a test vendor never calling the DCL;
  - a cache hit never calling the DCL;
  - stale served on a DCL failure, 503 with nothing cached;
  - the log-redaction assertion;
  - the OpenAPI drift test.

**Frontend domain.**
- `readCredential` keeps version, flow and discovery.
- `planNewDevice` copies the catalogue block and drops empty fields.
- `mergeDevice` keeps the newer catalogue block whole.

**Frontend UI (browser).** The tests mock `catalogApi`.
- The form shows the hint and then the names.
- Saving offline saves without names.
- Saving with a result copies it.
- Backfill writes once and then skips; it skips read-only projects and stops on a network error.
- The device page shows links, instructions and tags only when present.

**No real DCL calls in CI.** An opt-in `npm run dcl:smoke` (backend) checks the live response
shape by hand.

## Delivery

GitHub issues: one epic and these sub-issues, shipped as stacked PRs.

| # | Issue | Depends on |
| --- | --- | --- |
| 1 | Capture decoded fields: `readCredential`, `DeviceDocument`, `planNewDevice`, `mergeDevice` | none |
| 2 | Backend catalogue: decoder, DCL client, `matter_catalog`, `POST /catalog/lookup`, OpenAPI, rate limit, security-doc and ADR 0005 amendments | none |
| 3 | Look up when adding a device, and copy on create | 1, 2 |
| 4 | Backfill when online | 3 |
| 5 | Display: device page, inventory PDF, search, PRODUCT.md wording | 1 (finishes after 3) |
| 6 | Future: admin UI to refresh one entry or all (`by_fetched`) | 2, not planned |

The API needs deploying by hand after issue 2 merges; Cloudflare Pages only deploys the frontend.

## Out of scope

- Parsing the TLV extension.
- Multi-device codes (Matter 1.4.1).
- Software versions and OTA data from the DCL.
- Replicating the catalogue to browsers for offline lookups.
- Editing catalogue fields by hand.
- The admin UI (issue 6).
