# Full QR capture and DCL catalogue: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every decoded QR field on the device, look the manufacturer and product up in the CSA Distributed Compliance Ledger through our own API (cached in CouchDB `matter_catalog`) when a device is added or later by backfill, and show the result on the device page, in the inventory PDF and in search.

**Architecture:**
- **Frontend domain:** a pure layer (`frontend/src/domain/catalog/`) owns the device catalogue block: copying, merging and deciding which devices need a lookup.
- **Backend:** `POST /catalog/lookup` decodes the code in memory and answers from the `matter_catalog` cache. It asks the DCL, by IDs only, for anything absent or stale.
- **Frontend UI:** a client that never throws, a debounced background lookup in the add form, and a sequential backfill the shell runs like sync. Display reads only the device document, so it works offline.

**Tech Stack:**
- **Frontend:** TypeScript 7 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Lit 3, Web Awesome Pro 3.12, `@lit/localize`, PouchDB 9, Vitest 4, Biome 2.5.
- **Backend:** Fastify, CouchDB 3.5, native `fetch`, `openapi.yaml` with generated types.

**Spec:** `docs/superpowers/specs/2026-10-05-qr-decode-and-dcl-catalogue-design.md` (approved 2026-10-07). Epic #231; sub-issues #225–#229 (#230 is future and not in this plan).

## Global Constraints

- Every new device field is **optional**; existing devices stay valid and no migration is written.
- A field the DCL leaves empty is **omitted**, never written as `''` or `null` (`exactOptionalPropertyTypes`: omit the key, never assign `undefined`).
- URLs are kept and rendered only when they are `https:`; DCL text is rendered as text, never HTML.
- `catalogSource`: `dcl` → `found`; `missing` and `test-vendor` stay. Test vendors get `vendorName: 'Test vendor'`.
- A `missing` result is retried after **1 day** (24 h); a found one is never re-asked by the client.
- The lookup is debounced **300 ms**, aborted when the code changes or the form closes, and **never awaited by submit**.
- Backfill: one request at a time, **1 s** between requests, stops on network failure or 401, waits `retry-after` on 429, writes only the catalogue block through `devices.save`.
- Never log, print or put into an error message a payload or manual code.
- `src/domain` may not use the DOM (`tsconfig.domain.json`: `lib: ["ES2023"]`, `types: []`, so no `URL`, no `fetch`).
- Coverage gates: `src/domain/**` and `src/data/**` 90%, `src/ui/**` 70%, all four metrics.
- Zero warnings: Biome, `tsc`, Vitest console output, `check:i18n`.
- All UI strings through `msg()`, German in formal *Sie*; run `npm run i18n` and write every new `<target>`.
- UI work: load the `webawesome-design` and `webawesome` skills first; Web Awesome components, `wa-stack`/`wa-cluster`/`wa-grid`, `--wa-*` tokens only; no raw hex/px/rem in app CSS.
- Commits: conventional messages, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Local verification before each PR: `npm run verify` at the repo root (lint, typecheck, i18n check, tests with coverage gates, build).


**Backend additions:**
- `POST /catalog/lookup` needs a bearer token and works on every plan.
- Rate limit: 120 per 300 s per **token subject**, enforced inside the handler after authentication.
- 429 is a problem response with `retry-after`.
- Only a DCL 404 with body `code: 5` counts as a miss.
- CouchDB failures degrade to a DCL answer; they never fail the lookup.
- `DCL_BASE_URL` must be `https:` and defaults to `https://on.dcl.csa-iot.org/dcl`.
- The code is never stored, logged or echoed, and only vendor and product IDs reach the DCL.
- No new runtime dependencies (ADR 0013).

## Review Focus

1. **A lookup answer arriving after Save, or after the code was edited.** Expected: the saved device carries no names from a stale or foreign answer, and nothing is written a second time. Pinned in Task C3 (two tests) and Task A3 (`planNewDevice` ignores a lookup whose vendor/product ids differ from the code's).
2. **Backfill racing a user edit (409, or a conflict replicated later).** Expected: the user's edit survives, the block is filled on a later run, and a merge keeps the block from the side that looked it up. Pinned in Task D1 (conflict test) and Task A4 (`mergeDevice` with a newer user edit lacking the block).
3. **A DCL URL with a `javascript:` / `http:` scheme, or one injected by another client via sync.** Expected: no link at all. Pinned in Task A2 (`catalogFields` drops it) and Task E1 (device page seeded with a `javascript:` URL renders no `<a>`).
4. **Project switch or sign-out mid-backfill, and a read-only shared project.** Expected: nothing written into either project after the switch; nothing written to a read-only project. Pinned in Task D1 (stop mid-run, read-only) and Task D2 (shell stops on `PROJECT_CHANGED`, `ended`, sign-out).
5. **Very long DCL instruction text at 360 px.** Expected: wraps, no horizontal page scroll. Pinned in Task E1 (layout test at 360 px).

Also pinned: a device from a 21-digit manual code without payload is looked up with its digits (Tasks A2, C3, D1); an 11-digit code never triggers a request (Task C3).


**Backend review focus**, each pinned in Part B:
- Typed input: lower-case `mt:`, whitespace, separators.
- Two first lookups racing on database setup and on the same entry.
- A DCL answer that isn't what we expect (wrong 404, 5xx, timeout, oversized body).
- Vendor found but model 404.
- A hostile 10,000-character code.
- CouchDB down during a lookup.
- Requests without a token spending a user's rate-limit budget.

## Branching, PR stack and order

Each part is one PR, branched off the previous part's branch and based on it. The base is `feat/qr-decode-dcl-catalogue`, which is stacked on PR #223.

| Order | Part | Branch | Issue |
| --- | --- | --- | --- |
| 1 | A: capture decoded fields | `feat/catalog-capture-225` | #225 |
| 2 | B: backend catalogue | `feat/catalog-api-226` | #226 |
| 3 | C: look up when adding | `feat/catalog-lookup-227` | #227 |
| 4 | D: backfill | `feat/catalog-backfill-228` | #228 |
| 5 | E: display | `feat/catalog-display-229` | #229 |

**Why B comes before C:**
- B's documentation (ADR 0019, SECURITY-MODEL, DATA-MODEL, PRODUCT.md) is the one place the security wording changes, and it must land before any code sends a setup code.
- C's tests mock the API, so C is green without the backend. In production, it needs the API from B deployed, which is Task B9.

**Doc ownership:** every change to wording about where a setup code may travel is in Task B1. Parts A and E only document the new fields and the auto-fill claim.

Frontend commands run from `frontend/` and backend commands from the repo root, unless a step says otherwise.

---

## Part A — Capture decoded fields (#225)

| File | Change | Responsibility |
| --- | --- | --- |
| `frontend/src/domain/matter/credential.ts` | Modify | `DeviceCredential` keeps `version`, `customFlow`, `discovery` |
| `frontend/src/domain/documents/types.ts` | Modify | `DeviceDocument` gains decoded fields and the catalogue block; `CatalogSource`, `DeviceDiscovery` |
| `frontend/src/domain/catalog/types.ts` | Create | `CatalogLookup` (hand-written API shape) |
| `frontend/src/domain/catalog/copy.ts` | Create | `catalogFields`, `CATALOG_FIELD_KEYS`, `needsCatalogLookup`, `withCatalogBlock`, `isHttpsUrl`, `manufacturerName` |
| `frontend/src/domain/documents/new-device.ts` | Modify | `planNewDevice(draft, rooms, clock, catalog?)` |
| `frontend/src/domain/sync/merge.ts` | Modify | `mergeDevice`: newer `catalogCheckedAt` block wins whole |
| `frontend/src/domain/index.ts` | Modify | Export the catalogue API |
| `frontend/test/domain/matter/credential.test.ts` | Modify | New fields |
| `frontend/test/domain/catalog/copy.test.ts` | Create | Copy, URL filter, retry rule, block replacement |
| `frontend/test/domain/documents/new-device.test.ts` | Modify | Decoded fields, catalogue copy |
| `frontend/test/domain/sync/merge.test.ts` | Modify | Catalogue merge rule |
| `frontend/test/domain/public-api.test.ts` | Modify | New exports |
| `docs/DATA-MODEL.md` | Modify | Device section and conflicts table (the payload security sentence belongs to Task B1) |

### Task A1: `readCredential` keeps version, flow and discovery

**Files:**
- Modify: `frontend/src/domain/matter/credential.ts:33-50` (interface), `:84-98` (payload branch)
- Test: `frontend/test/domain/matter/credential.test.ts:14-23,40-58`

**Interfaces:**
- Consumes: `CustomFlow`, `DiscoveryCapabilities` from `matter/payload.ts`.
- Produces: `DeviceCredential` gains `readonly version?: number`, `readonly customFlow?: CustomFlow`, `readonly discovery?: DiscoveryCapabilities` (present for an `MT:` payload only).

- [ ] **Step 1: Write the failing test.** Replace the first test in `describe('a Matter payload')` and add one to `describe('a manual pairing code')`:

```ts
  it('keeps the payload, derives the manual code and keeps the decoded flags', () => {
    expect(readCredential(PAYLOAD)).toEqual({
      payload: PAYLOAD,
      manualCode: LONG_CODE,
      vendorId: 0xfff1,
      productId: 0x8000,
      discriminator: 3840,
      // Verified in `payload.test.ts`: version 0, the standard flow, BLE only (raw 0b010).
      version: 0,
      customFlow: 'standard',
      discovery: { softAp: false, ble: true, onNetwork: false, raw: 0b010 },
    })
  })
```

```ts
  it('carries no version, flow or discovery, because a manual code has none', () => {
    // The same asymmetry as the discriminator: inventing "standard" or "BLE" for a typed code
    // would state a fact about the device that nobody read off it.
    for (const code of [LONG_CODE, SHORT_CODE]) {
      const credential = readCredential(code)
      expect(credential).not.toHaveProperty('version')
      expect(credential).not.toHaveProperty('customFlow')
      expect(credential).not.toHaveProperty('discovery')
    }
  })
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `npx vitest run --project domain test/domain/matter/credential.test.ts`
Expected: FAIL in "keeps the payload, derives the manual code and keeps the decoded flags" (`version`, `customFlow`, `discovery` missing from the received object). The manual-code test passes already.

- [ ] **Step 3: Implement.** In `credential.ts` change the import and the interface, then the payload branch:

```ts
import { deriveManualCode, parseManualCode } from './manual-code.js'
import {
  type CustomFlow,
  type DiscoveryCapabilities,
  decodePayload,
  PAYLOAD_PREFIX,
  PayloadError,
} from './payload.js'
```

Add after `discriminator?` in `DeviceCredential`:

```ts
  /** The payload format version. Absent for a manual code. */
  readonly version?: number
  /**
   * How commissioning begins. Absent for a manual code, which does not carry it: assuming
   * "standard" would tell a reader the device pairs normally when nobody knows that.
   */
  readonly customFlow?: CustomFlow
  /** Which transports the device can be found on. Absent for a manual code. */
  readonly discovery?: DiscoveryCapabilities
```

In the `PAYLOAD_SCHEME` branch, extend the returned object after `discriminator: payload.discriminator,`:

```ts
      version: payload.version,
      customFlow: payload.customFlow,
      discovery: payload.discovery,
```

Update the module note's table row `| discovery, flow, TLV | yes | no | no |` to `| version, flow, discovery, TLV | yes | no | no |`.

- [ ] **Step 4: Run the tests to verify they pass.**
Run: `npx vitest run --project domain test/domain/matter`
Expected: PASS (all files in `test/domain/matter`).

- [ ] **Step 5: Commit.**

```bash
git add src/domain/matter/credential.ts test/domain/matter/credential.test.ts
git commit -m "feat(qr): readCredential keeps version, flow and discovery (#225)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A2: The device fields and the catalogue copy rules

**Files:**
- Modify: `frontend/src/domain/documents/types.ts:14,62-80` (import; fields after `deviceTypeId`; `manualCode` doc comment)
- Create: `frontend/src/domain/catalog/types.ts`
- Create: `frontend/src/domain/catalog/copy.ts`
- Create: `frontend/test/domain/catalog/copy.test.ts`

**Interfaces:**
- Consumes: `CustomFlow` from `matter/payload.ts`.
- Produces (exact):
  - `types.ts`: `export type CatalogSource = 'found' | 'missing' | 'test-vendor'`; `export interface DeviceDiscovery { readonly softAp: boolean; readonly ble: boolean; readonly onNetwork: boolean }`; on `DeviceDocument`: `payloadVersion?: number`, `commissioningFlow?: CustomFlow`, `discovery?: DeviceDiscovery`, `vendorPreferredName?`, `partNumber?`, `productUrl?`, `supportUrl?`, `userManualUrl?`, `commissioningFlowUrl?`, `commissioningInstructions?`, `factoryResetInstructions?` (all `string`), `catalogCheckedAt?: string`, `catalogSource?: CatalogSource` (all `readonly`).
  - `catalog/types.ts`: `export interface CatalogLookup` (contract shape).
  - `catalog/copy.ts`: `export type CatalogFields`; `export const CATALOG_FIELD_KEYS: readonly (keyof CatalogFields)[]`; `export const TEST_VENDOR_NAME = 'Test vendor'`; `export const CATALOG_MISS_RETRY_MS = 86_400_000`; `export function catalogFields(lookup: CatalogLookup, checkedAt: string): CatalogFields`; `export function needsCatalogLookup(device: Pick<DeviceDocument, 'payload' | 'manualCode' | 'catalogCheckedAt' | 'catalogSource'>, now: Date): boolean`; `export function withCatalogBlock<T extends object>(document: T, source: object): T`; `export function isHttpsUrl(value: string | null | undefined): value is string`; `export function manufacturerName(fields: Pick<CatalogFields, 'vendorPreferredName' | 'vendorName'>): string | undefined`.

- [ ] **Step 1: Write the failing tests.** Create `frontend/test/domain/catalog/copy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  CATALOG_FIELD_KEYS,
  CATALOG_MISS_RETRY_MS,
  catalogFields,
  isHttpsUrl,
  manufacturerName,
  needsCatalogLookup,
  withCatalogBlock,
} from '../../../src/domain/catalog/copy.js'
import type { CatalogLookup } from '../../../src/domain/catalog/types.js'

const CHECKED = '2026-10-05T16:20:00.000Z'

/** The recorded Aqara answer the backend plan also uses: vendor 4447, model 4447/8194. */
const AQARA: CatalogLookup = {
  vendorId: 4447,
  productId: 8194,
  source: 'dcl',
  vendor: {
    name: 'Aqara',
    preferredName: 'Aqara Home',
    legalName: 'Lumi United Technology Co., Ltd.',
    landingPageUrl: 'https://www.aqara.com/',
  },
  product: {
    name: 'Aqara Door and Window Sensor P2',
    label: 'Aqara Door and Window Sensor P2',
    partNumber: 'AS056',
    deviceTypeId: 21,
    productUrl: 'https://www.aqara.com/en/products.html',
    supportUrl: 'https://www.aqara.com/support',
    userManualUrl: 'https://www.aqara.com/manual.pdf',
    commissioningCustomFlow: 0,
    commissioningCustomFlowUrl: 'https://www.aqara.com/pairing',
    commissioningInstructions: '1. Please make sure the sensor is powered.',
    factoryResetInstructions: 'Hold the button for 10 seconds.',
  },
  fetchedAt: CHECKED,
  stale: false,
}

describe('catalogFields', () => {
  it('copies every catalogue field and maps dcl to found', () => {
    expect(catalogFields(AQARA, CHECKED)).toEqual({
      vendorName: 'Aqara',
      vendorPreferredName: 'Aqara Home',
      productName: 'Aqara Door and Window Sensor P2',
      deviceTypeId: 21,
      partNumber: 'AS056',
      productUrl: 'https://www.aqara.com/en/products.html',
      supportUrl: 'https://www.aqara.com/support',
      userManualUrl: 'https://www.aqara.com/manual.pdf',
      commissioningFlowUrl: 'https://www.aqara.com/pairing',
      commissioningInstructions: '1. Please make sure the sensor is powered.',
      factoryResetInstructions: 'Hold the button for 10 seconds.',
      catalogCheckedAt: CHECKED,
      catalogSource: 'found',
    })
  })

  it('omits null and blank values rather than storing them', () => {
    // An empty string is a value somebody wrote; an absent field is "the DCL does not say".
    const sparse: CatalogLookup = {
      ...AQARA,
      vendor: { name: 'Aqara', preferredName: null, legalName: null, landingPageUrl: null },
      product: {
        name: 'P2',
        label: null,
        partNumber: '   ',
        deviceTypeId: null,
        productUrl: null,
        supportUrl: '',
        userManualUrl: null,
        commissioningCustomFlow: 0,
        commissioningCustomFlowUrl: null,
        commissioningInstructions: '',
        factoryResetInstructions: null,
      },
    }
    expect(catalogFields(sparse, CHECKED)).toEqual({
      vendorName: 'Aqara',
      productName: 'P2',
      catalogCheckedAt: CHECKED,
      catalogSource: 'found',
    })
  })

  it('trims what it keeps', () => {
    const padded: CatalogLookup = {
      ...AQARA,
      vendor: { name: '  Aqara ', preferredName: null, legalName: null, landingPageUrl: null },
    }
    expect(catalogFields(padded, CHECKED).vendorName).toBe('Aqara')
  })

  it('keeps a URL only when it is https', () => {
    // DCL content is untrusted. A `javascript:` URL rendered as a link runs script on click.
    const hostile: CatalogLookup = {
      ...AQARA,
      product: {
        ...(AQARA.product as NonNullable<CatalogLookup['product']>),
        productUrl: 'javascript:alert(1)',
        supportUrl: 'http://www.aqara.com/support',
        userManualUrl: 'https:/missing-slash',
        commissioningCustomFlowUrl: 'HTTPS://WWW.AQARA.COM/PAIRING',
      },
    }
    const fields = catalogFields(hostile, CHECKED)
    expect(fields).not.toHaveProperty('productUrl')
    expect(fields).not.toHaveProperty('supportUrl')
    expect(fields).not.toHaveProperty('userManualUrl')
    expect(fields.commissioningFlowUrl).toBe('HTTPS://WWW.AQARA.COM/PAIRING')
  })

  it('keeps a found vendor whose model is missing', () => {
    const vendorOnly: CatalogLookup = { ...AQARA, product: null }
    expect(catalogFields(vendorOnly, CHECKED)).toEqual({
      vendorName: 'Aqara',
      vendorPreferredName: 'Aqara Home',
      catalogCheckedAt: CHECKED,
      catalogSource: 'found',
    })
  })

  it('records a miss with no names', () => {
    const missing: CatalogLookup = { ...AQARA, source: 'missing', vendor: null, product: null }
    expect(catalogFields(missing, CHECKED)).toEqual({
      catalogCheckedAt: CHECKED,
      catalogSource: 'missing',
    })
  })

  it('names a test vendor "Test vendor", whatever the answer says', () => {
    const test: CatalogLookup = {
      ...AQARA,
      vendorId: 0xfff1,
      source: 'test-vendor',
      vendor: null,
      product: null,
    }
    expect(catalogFields(test, CHECKED)).toEqual({
      vendorName: 'Test vendor',
      catalogCheckedAt: CHECKED,
      catalogSource: 'test-vendor',
    })
  })

  it('drops a device type of zero, which the DCL uses for "not set"', () => {
    const zero: CatalogLookup = {
      ...AQARA,
      product: { ...(AQARA.product as NonNullable<CatalogLookup['product']>), deviceTypeId: 0 },
    }
    expect(catalogFields(zero, CHECKED)).not.toHaveProperty('deviceTypeId')
  })

  it('produces only keys listed in CATALOG_FIELD_KEYS', () => {
    // The list is how merge and backfill replace the block whole; a key missing from it would
    // survive a replacement and outlive the answer it came from.
    for (const key of Object.keys(catalogFields(AQARA, CHECKED))) {
      expect(CATALOG_FIELD_KEYS).toContain(key)
    }
  })
})

describe('isHttpsUrl', () => {
  it.each([
    ['https://example.com', true],
    ['https://example.com/a b', false],
    ['https://', false],
    ['http://example.com', false],
    ['javascript:alert(1)', false],
    ['https://exa\u0001mple.com', false],
    [null, false],
    [undefined, false],
  ])('%s → %s', (value, expected) => {
    expect(isHttpsUrl(value)).toBe(expected)
  })
})

describe('manufacturerName', () => {
  it('prefers the preferred name, then the vendor name', () => {
    expect(manufacturerName({ vendorPreferredName: 'Aqara Home', vendorName: 'Aqara' })).toBe(
      'Aqara Home',
    )
    expect(manufacturerName({ vendorName: 'Aqara' })).toBe('Aqara')
    expect(manufacturerName({})).toBeUndefined()
  })
})

describe('needsCatalogLookup', () => {
  const now = new Date('2026-10-07T12:00:00.000Z')
  const LONG_CODE = '749701123365521327687'
  const SHORT_CODE = '34970112332'

  it('asks for a device with a payload that was never checked', () => {
    expect(needsCatalogLookup({ payload: 'MT:Y.K9042C00KA0648G00', manualCode: LONG_CODE }, now)).toBe(
      true,
    )
  })

  it('asks for a device filed from a 21-digit code, which carries the ids', () => {
    expect(needsCatalogLookup({ manualCode: LONG_CODE }, now)).toBe(true)
  })

  it('never asks for an 11-digit code, which carries no ids', () => {
    expect(needsCatalogLookup({ manualCode: SHORT_CODE }, now)).toBe(false)
  })

  it('does not ask again once found', () => {
    expect(
      needsCatalogLookup(
        { manualCode: LONG_CODE, catalogCheckedAt: '2020-01-01T00:00:00.000Z', catalogSource: 'found' },
        now,
      ),
    ).toBe(false)
  })

  it('retries a miss after one day, and not before', () => {
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString()
    const miss = (checked: string) =>
      needsCatalogLookup(
        { manualCode: LONG_CODE, catalogCheckedAt: checked, catalogSource: 'missing' },
        now,
      )
    expect(miss(at(CATALOG_MISS_RETRY_MS + 1000))).toBe(true)
    expect(miss(at(CATALOG_MISS_RETRY_MS - 1000))).toBe(false)
  })

  it('treats an unreadable check time on a miss as due', () => {
    expect(
      needsCatalogLookup(
        { manualCode: LONG_CODE, catalogCheckedAt: 'yesterday', catalogSource: 'missing' },
        now,
      ),
    ).toBe(true)
  })

  it('does not retry a test vendor', () => {
    expect(
      needsCatalogLookup(
        { manualCode: LONG_CODE, catalogCheckedAt: '2020-01-01T00:00:00.000Z', catalogSource: 'test-vendor' },
        now,
      ),
    ).toBe(false)
  })
})

describe('withCatalogBlock', () => {
  it('replaces the whole block and leaves everything else alone', () => {
    const device = {
      name: 'Hall sensor',
      spot: 'door frame',
      vendorName: 'Old',
      supportUrl: 'https://old.example',
      catalogCheckedAt: '2026-01-01T00:00:00.000Z',
      catalogSource: 'missing' as const,
    }
    const result = withCatalogBlock(device, catalogFields(AQARA, CHECKED))
    expect(result.name).toBe('Hall sensor')
    expect(result.spot).toBe('door frame')
    expect(result.vendorName).toBe('Aqara')
    expect(result.supportUrl).toBe('https://www.aqara.com/support')
    expect(result.catalogSource).toBe('found')
  })

  it('removes a field the new block does not have', () => {
    const device = { name: 'Hall sensor', supportUrl: 'https://old.example' }
    const result = withCatalogBlock(device, { catalogCheckedAt: CHECKED, catalogSource: 'missing' })
    expect(result).not.toHaveProperty('supportUrl')
  })

  it('ignores keys of the source that are not catalogue keys', () => {
    const result = withCatalogBlock({ name: 'Mine' }, { name: 'Theirs', catalogSource: 'found' })
    expect(result.name).toBe('Mine')
  })

  it('does not mutate its inputs', () => {
    const device = { name: 'Hall sensor', vendorName: 'Old' }
    withCatalogBlock(device, catalogFields(AQARA, CHECKED))
    expect(device).toEqual({ name: 'Hall sensor', vendorName: 'Old' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `npx vitest run --project domain test/domain/catalog/copy.test.ts`
Expected: FAIL, "Failed to load url ../../../src/domain/catalog/copy.js" (module does not exist).

- [ ] **Step 3: Implement the types.** In `frontend/src/domain/documents/types.ts` change the import line and add, before `DeviceDocument`:

```ts
import type { CustomFlow } from '../matter/payload.js'
import type { Remark, RemarkBearing, Revision } from '../sync/merge.js'

/**
 * Whether the last catalogue consultation found the product.
 *
 * `found` is the API's `dcl`, renamed because the document records an outcome rather than a
 * data source; `missing` is retried after a day; `test-vendor` is answered locally and final.
 */
export type CatalogSource = 'found' | 'missing' | 'test-vendor'

/**
 * Which transports the device can be found on, from the payload.
 *
 * The three named flags only: the raw bitmask stays inside the stored `payload`, which is the
 * source of truth for anything a later version learns to read.
 */
export interface DeviceDiscovery {
  readonly softAp: boolean
  readonly ble: boolean
  readonly onNetwork: boolean
}
```

Replace the `manualCode` doc line `(the DCL lookup sends vendor and product ids only)` with `(it goes to our own catalogue lookup over TLS and is never stored there; only vendor and product ids reach the DCL)`. Then replace the three lines `readonly vendorName?` … `readonly deviceTypeId?` with:

```ts
  /** Decoded from the payload when the device was added, offline. Never changes afterwards. */
  readonly payloadVersion?: number
  /** How commissioning begins, from the payload. Absent for a manual code. */
  readonly commissioningFlow?: CustomFlow
  /** From the payload. Absent for a manual code, which does not carry it. */
  readonly discovery?: DeviceDiscovery

  // The catalogue block, copied from the DCL lookup at creation or by backfill, and replaced
  // as a unit (`withCatalogBlock`): a half-old, half-new block would pair one product's name
  // with another product's manual. Copied rather than joined so that the record stays complete
  // offline, in a PDF, and after hand-over.
  readonly vendorName?: string
  /** The DCL's `companyPreferredName`, which is what people call the company. */
  readonly vendorPreferredName?: string
  readonly productName?: string
  readonly deviceTypeId?: number
  readonly partNumber?: string
  /** `https:` only; anything else is dropped when copied. The same for every URL below. */
  readonly productUrl?: string
  readonly supportUrl?: string
  readonly userManualUrl?: string
  /** The manufacturer's page for a custom commissioning flow. */
  readonly commissioningFlowUrl?: string
  /** Untrusted DCL text: render as text, never as HTML. */
  readonly commissioningInstructions?: string
  /** Untrusted DCL text: render as text, never as HTML. */
  readonly factoryResetInstructions?: string
  /** When the catalogue was last consulted for this device, found or not. */
  readonly catalogCheckedAt?: string
  /** What that consultation found. See {@link CatalogSource}. */
  readonly catalogSource?: CatalogSource
```

Create `frontend/src/domain/catalog/types.ts`:

```ts
/**
 * What `POST /api/catalog/lookup` answers.
 *
 * Hand-written, because the frontend has no generated API types; the backend's `openapi.yaml`
 * (`CatalogLookup`) is the source and its drift test guards the other half. Kept in the domain
 * because `catalogFields` turns it into device fields, and that decision is pure.
 *
 * `null` means "the DCL does not say". It never reaches a device document: `catalogFields`
 * omits it.
 *
 * @module
 */

/** One catalogue answer, already mapped from the DCL's raw records by the backend. */
export interface CatalogLookup {
  readonly vendorId: number
  readonly productId: number
  readonly source: 'dcl' | 'test-vendor' | 'missing'
  readonly vendor: {
    readonly name: string
    readonly preferredName: string | null
    readonly legalName: string | null
    readonly landingPageUrl: string | null
  } | null
  readonly product: {
    readonly name: string
    readonly label: string | null
    readonly partNumber: string | null
    readonly deviceTypeId: number | null
    readonly productUrl: string | null
    readonly supportUrl: string | null
    readonly userManualUrl: string | null
    readonly commissioningCustomFlow: number
    readonly commissioningCustomFlowUrl: string | null
    readonly commissioningInstructions: string | null
    readonly factoryResetInstructions: string | null
  } | null
  /** ISO 8601. When the backend fetched it from the DCL, not when it answered. */
  readonly fetchedAt: string
  /** Served past its 90 days because the DCL was unreachable. */
  readonly stale: boolean
}
```

- [ ] **Step 4: Implement the copy rules.** Create `frontend/src/domain/catalog/copy.ts`:

```ts
/**
 * Turning a catalogue answer into device fields, and deciding when to ask.
 *
 * The catalogue values are **copied onto the device** rather than joined at display time, so a
 * record stays complete offline, in a PDF and after hand-over. Copying has one rule that makes
 * it safe: the block is a unit. It is written whole, replaced whole and merged whole
 * ({@link CATALOG_FIELD_KEYS}), so a document never pairs one answer's product name with an
 * older answer's manual link.
 *
 * Everything from the DCL is untrusted text: empty values are dropped, and a URL survives only
 * if it is `https:`. `URL` is not available here (`tsconfig.domain.json` has no DOM), so the
 * check is a strict pattern rather than a parse; it errs towards dropping a link.
 *
 * @module
 */

import type { CatalogSource, DeviceDocument } from '../documents/types.js'
import type { CatalogLookup } from './types.js'

/** The catalogue block of a device: everything a lookup writes, and nothing else. */
export type CatalogFields = Pick<
  DeviceDocument,
  | 'vendorName'
  | 'vendorPreferredName'
  | 'productName'
  | 'deviceTypeId'
  | 'partNumber'
  | 'productUrl'
  | 'supportUrl'
  | 'userManualUrl'
  | 'commissioningFlowUrl'
  | 'commissioningInstructions'
  | 'factoryResetInstructions'
> & {
  readonly catalogCheckedAt: string
  readonly catalogSource: CatalogSource
}

/**
 * Every key of the block, so it can be replaced whole.
 *
 * A key missing here would survive a replacement and outlive the answer it came from; the
 * copy test asserts that {@link catalogFields} produces no key outside this list.
 */
export const CATALOG_FIELD_KEYS: readonly (keyof CatalogFields)[] = [
  'vendorName',
  'vendorPreferredName',
  'productName',
  'deviceTypeId',
  'partNumber',
  'productUrl',
  'supportUrl',
  'userManualUrl',
  'commissioningFlowUrl',
  'commissioningInstructions',
  'factoryResetInstructions',
  'catalogCheckedAt',
  'catalogSource',
]

/** The name a test vendor (0xFFF1–0xFFF4) gets. The DCL never lists them. */
export const TEST_VENDOR_NAME = 'Test vendor'

/** How long a miss stands before the catalogue is asked again: one day. */
export const CATALOG_MISS_RETRY_MS = 24 * 60 * 60 * 1000

/** The API's `source`, as the document records it. */
const SOURCE: Readonly<Record<CatalogLookup['source'], CatalogSource>> = {
  dcl: 'found',
  missing: 'missing',
  'test-vendor': 'test-vendor',
}

/** `https://`, then a host with no whitespace, slash, query or fragment, then anything unbroken. */
const HTTPS_URL = /^https:\/\/[^\s/?#\\]+\S*$/i

/** Twenty-one digits: the manual code that carries vendor and product ids. */
const LONG_MANUAL_CODE = /^\d{21}$/

const CATALOG_KEYS: ReadonlySet<string> = new Set(CATALOG_FIELD_KEYS)

/**
 * Whether a value is an `https:` URL safe to render as a link.
 *
 * Control characters are refused separately: they are invisible in an address bar and a
 * pattern written to exclude them trips Biome's `noControlCharactersInRegex`.
 */
export function isHttpsUrl(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !HTTPS_URL.test(value)) return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** Trimmed text, or `undefined` for `null`, `undefined` and blank. */
function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** A trimmed `https:` URL, or `undefined`. */
function link(value: string | null | undefined): string | undefined {
  const trimmed = text(value)
  return isHttpsUrl(trimmed) ? trimmed : undefined
}

/**
 * `{ [key]: value }`, or `{}` when there is no value.
 *
 * A spread of this is how an optional field is *omitted* under `exactOptionalPropertyTypes`:
 * assigning `undefined` to it would not compile, and that is the setting doing its job.
 */
function present<K extends keyof CatalogFields, V>(
  key: K,
  value: V | undefined,
): { readonly [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { readonly [P in K]?: V })
}

/**
 * The catalogue block for one answer.
 *
 * @param lookup what the API answered
 * @param checkedAt when the catalogue was consulted, ISO 8601; becomes `catalogCheckedAt`
 * @returns the block, with every empty value and every non-`https:` URL left out
 */
export function catalogFields(lookup: CatalogLookup, checkedAt: string): CatalogFields {
  const { vendor, product } = lookup
  // Forced rather than trusted: the backend says the same today, and the name a test vendor
  // shows must not depend on a server that may say something else tomorrow.
  const vendorName = lookup.source === 'test-vendor' ? TEST_VENDOR_NAME : text(vendor?.name)
  const deviceTypeId = product?.deviceTypeId
  return {
    ...present('vendorName', vendorName),
    ...present('vendorPreferredName', text(vendor?.preferredName)),
    ...present('productName', text(product?.name)),
    // 0 is the DCL's "not set", like an empty string.
    ...present(
      'deviceTypeId',
      typeof deviceTypeId === 'number' && deviceTypeId > 0 ? deviceTypeId : undefined,
    ),
    ...present('partNumber', text(product?.partNumber)),
    ...present('productUrl', link(product?.productUrl)),
    ...present('supportUrl', link(product?.supportUrl)),
    ...present('userManualUrl', link(product?.userManualUrl)),
    ...present('commissioningFlowUrl', link(product?.commissioningCustomFlowUrl)),
    ...present('commissioningInstructions', text(product?.commissioningInstructions)),
    ...present('factoryResetInstructions', text(product?.factoryResetInstructions)),
    catalogCheckedAt: checkedAt,
    catalogSource: SOURCE[lookup.source],
  }
}

/**
 * Whether the catalogue should be asked about this device.
 *
 * Only a device whose code carries vendor and product ids (a payload, or a 21-digit manual
 * code) can be looked up. A device asked once is not asked again, except a miss, which is
 * retried a day later because the DCL gains products every week.
 */
export function needsCatalogLookup(
  device: Pick<DeviceDocument, 'payload' | 'manualCode' | 'catalogCheckedAt' | 'catalogSource'>,
  now: Date,
): boolean {
  const carriesIds = device.payload !== undefined || LONG_MANUAL_CODE.test(device.manualCode)
  if (!carriesIds) return false
  if (device.catalogCheckedAt === undefined) return true
  if (device.catalogSource !== 'missing') return false
  const checked = Date.parse(device.catalogCheckedAt)
  // An unreadable stamp is treated as due: asking once more costs one request, while trusting
  // it would leave the device unnamed for good.
  return Number.isNaN(checked) || now.getTime() - checked > CATALOG_MISS_RETRY_MS
}

/**
 * `document` with its catalogue block replaced by the one in `source`.
 *
 * Every catalogue key is removed from `document` first, so a field the new block lacks is
 * removed rather than kept from the old one. Keys of `source` that are not catalogue keys are
 * ignored, so a whole revision can be passed as the source.
 */
export function withCatalogBlock<T extends object>(document: T, source: object): T {
  const kept = Object.entries(document).filter(([key]) => !CATALOG_KEYS.has(key))
  const block = Object.entries(source).filter(([key]) => CATALOG_KEYS.has(key))
  return Object.fromEntries([...kept, ...block]) as T
}

/** The manufacturer as people say it: the preferred name, then the vendor name. */
export function manufacturerName(
  fields: Pick<CatalogFields, 'vendorPreferredName' | 'vendorName'>,
): string | undefined {
  return fields.vendorPreferredName ?? fields.vendorName
}
```

- [ ] **Step 5: Run the tests to verify they pass.**
Run: `npx vitest run --project domain test/domain/catalog/copy.test.ts && npx tsc -p tsconfig.domain.json`
Expected: PASS; `tsc` prints nothing (no `Cannot find name 'URL'`).

- [ ] **Step 6: Commit.**

```bash
git add src/domain/documents/types.ts src/domain/catalog test/domain/catalog
git commit -m "feat(domain): device catalogue block and its copy rules (#225)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A3: `planNewDevice` copies the decoded fields and the catalogue block

**Files:**
- Modify: `frontend/src/domain/documents/new-device.ts:20-33` (imports), `:46-107` (signature, body)
- Test: `frontend/test/domain/documents/new-device.test.ts:37-56` and new `describe` blocks

**Interfaces:**
- Consumes: `catalogFields(lookup, checkedAt)`, `CatalogLookup` (Task A2); `DeviceCredential.version/customFlow/discovery` (Task A1); `DraftClock.now: () => string`.
- Produces: `planNewDevice(draft: DeviceDraft, rooms: readonly RoomDocument[], clock: DraftClock, catalog?: CatalogLookup): DeviceCreation`.

- [ ] **Step 1: Write the failing tests.** Update the expected object in "stores everything the payload carried" by adding after `discriminator: 3840,`:

```ts
      payloadVersion: 0,
      commissioningFlow: 'standard',
      // The three named flags only; the raw bitmask stays inside the payload.
      discovery: { softAp: false, ble: true, onNetwork: false },
```

Append to the file (add `import type { CatalogLookup } from '../../../src/domain/catalog/types.js'` at the top):

```ts
/** A catalogue answer for the reference device (a test vendor, as the backend answers it). */
const TEST_VENDOR: CatalogLookup = {
  vendorId: 0xfff1,
  productId: 0x8000,
  source: 'test-vendor',
  vendor: { name: 'Test vendor', preferredName: null, legalName: null, landingPageUrl: null },
  product: null,
  fetchedAt: '2026-08-26T08:59:00.000Z',
  stale: false,
}

describe('a device from a manual code', () => {
  it('records no version, flow or discovery, because the code does not carry them', () => {
    const { device } = planNewDevice(draft({ credential: LONG_CODE }), [KITCHEN], clock('d'))
    expect(device).not.toHaveProperty('payloadVersion')
    expect(device).not.toHaveProperty('commissioningFlow')
    expect(device).not.toHaveProperty('discovery')
  })
})

describe('copying a catalogue answer', () => {
  it('copies the block, checked at the moment the device was added', () => {
    const { device } = planNewDevice(draft(), [KITCHEN], clock('device-uuid'), TEST_VENDOR)
    expect(device.vendorName).toBe('Test vendor')
    expect(device.catalogSource).toBe('test-vendor')
    expect(device.catalogCheckedAt).toBe('2026-08-26T09:00:00.000Z')
    expect(device.addedAt).toBe(device.catalogCheckedAt)
  })

  it('writes no catalogue field without an answer', () => {
    const { device } = planNewDevice(draft(), [KITCHEN], clock('device-uuid'))
    expect(device).not.toHaveProperty('catalogCheckedAt')
    expect(device).not.toHaveProperty('vendorName')
  })

  it('ignores an answer about a different device', () => {
    // A lookup that landed for the code the user typed before correcting it. Copying it would
    // name this device after another one, with nothing on screen to say so.
    const other: CatalogLookup = { ...TEST_VENDOR, vendorId: 4447, productId: 8194 }
    const { device } = planNewDevice(draft(), [KITCHEN], clock('device-uuid'), other)
    expect(device).not.toHaveProperty('catalogCheckedAt')
  })

  it('ignores an answer for a code that carries no ids', () => {
    const { device } = planNewDevice(
      draft({ credential: SHORT_CODE }),
      [KITCHEN],
      clock('device-uuid'),
      TEST_VENDOR,
    )
    expect(device).not.toHaveProperty('catalogCheckedAt')
  })

  it('still refuses an unreadable code when an answer is supplied', () => {
    expect(() =>
      planNewDevice(draft({ credential: 'kitchen lamp' }), [KITCHEN], clock('d'), TEST_VENDOR),
    ).toThrow(/setup code/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `npx vitest run --project domain test/domain/documents/new-device.test.ts`
Expected: FAIL in "stores everything the payload carried" (missing `payloadVersion`, …) and in "copies the block…" (`vendorName` undefined).

- [ ] **Step 3: Implement.** In `new-device.ts` add imports:

```ts
import { catalogFields } from '../catalog/copy.js'
import type { CatalogLookup } from '../catalog/types.js'
```

Change the signature and its JSDoc (add the `@param`):

```ts
 * @param catalog the catalogue's answer for this code, when one arrived before Save. Passed in
 *   rather than fetched, so this stays pure. Ignored when its ids are not the code's: an answer
 *   that landed for a code since corrected would name this device after another one.
 ...
export function planNewDevice(
  draft: DeviceDraft,
  rooms: readonly RoomDocument[],
  clock: DraftClock,
  catalog?: CatalogLookup,
): DeviceCreation {
```

After `const { roomId, room } = chooseRoom(path, rooms, clock.uuid)` add:

```ts
  // Read once: `addedAt` and `catalogCheckedAt` are the same moment, and two reads of a real
  // clock can straddle a second.
  const now = clock.now()
  const answersThisCode =
    catalog !== undefined &&
    catalog.vendorId === credential.vendorId &&
    catalog.productId === credential.productId
  const { discovery } = credential
```

In the device literal, after the `discriminator` spread add:

```ts
    ...(credential.version === undefined ? {} : { payloadVersion: credential.version }),
    ...(credential.customFlow === undefined ? {} : { commissioningFlow: credential.customFlow }),
    // The named flags only: `raw` stays in the payload, which remains the source of truth.
    ...(discovery === undefined
      ? {}
      : {
          discovery: {
            softAp: discovery.softAp,
            ble: discovery.ble,
            onNetwork: discovery.onNetwork,
          },
        }),
```

Replace `addedAt: clock.now(),` with `addedAt: now,` and after `remarks: [],` add:

```ts
    // `catalog !== undefined` repeated: a boolean held in a variable does not narrow `catalog`.
    ...(catalog !== undefined && answersThisCode ? catalogFields(catalog, now) : {}),
```

- [ ] **Step 4: Run the tests to verify they pass.**
Run: `npx vitest run --project domain test/domain/documents`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/domain/documents/new-device.ts test/domain/documents/new-device.test.ts
git commit -m "feat(domain): planNewDevice keeps decoded fields and copies the catalogue (#225)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A4: `mergeDevice` keeps the newer catalogue block whole, exports, docs

**Files:**
- Modify: `frontend/src/domain/sync/merge.ts:28-33` (import), `:131-143` (`mergeDevice`)
- Modify: `frontend/src/domain/index.ts` (exports)
- Test: `frontend/test/domain/sync/merge.test.ts` (new `describe` after `mergeDevice`), `frontend/test/domain/public-api.test.ts:20-100,165-210`
- Modify: `docs/DATA-MODEL.md:335-402`

**Interfaces:**
- Consumes: `withCatalogBlock` (Task A2).
- Produces: `export interface CatalogBearing { readonly catalogCheckedAt?: string }`; `mergeDevice<T extends RemarkBearing & CatalogBearing>(winner: T, conflicts: readonly T[]): T`; domain index exports `CATALOG_FIELD_KEYS`, `CATALOG_MISS_RETRY_MS`, `TEST_VENDOR_NAME`, `catalogFields`, `isHttpsUrl`, `manufacturerName`, `needsCatalogLookup`, `withCatalogBlock`, and types `CatalogFields`, `CatalogLookup`, `CatalogSource`, `DeviceDiscovery`, `CatalogBearing`.

- [ ] **Step 1: Write the failing tests.** In `merge.test.ts` widen the fixture type and add a `describe`:

```ts
type DeviceFixture = Revision & {
  readonly remarks: readonly Remark[]
  readonly name: string
  readonly vendorName?: string
  readonly supportUrl?: string
  readonly catalogCheckedAt?: string
  readonly catalogSource?: 'found' | 'missing' | 'test-vendor'
}
```

```ts
/**
 * The catalogue block is a unit (spec §Merging). The common case it protects: backfill on one
 * replica fills the names while somebody renames the device on another. The rename is newer and
 * wins the scalars; without this rule it would also carry its *absent* block and erase the names.
 */
describe('mergeDevice and the catalogue block', () => {
  const FOUND = {
    vendorName: 'Aqara',
    supportUrl: 'https://www.aqara.com/support',
    catalogCheckedAt: '2026-10-05T10:00:00.000Z',
    catalogSource: 'found' as const,
  }

  it('keeps the block from the revision that looked it up, under a newer edit without one', () => {
    const backfilled = device('2-a', '2026-10-05T10:00:01.000Z', [], FOUND)
    const renamed = device('2-b', '2026-10-05T11:00:00.000Z', [], { name: 'Hall sensor' })

    const merged = mergeDevice(renamed, [backfilled])

    expect(merged.name).toBe('Hall sensor')
    expect(merged.vendorName).toBe('Aqara')
    expect(merged.catalogSource).toBe('found')
  })

  it('takes the whole block from the newer check, removing fields the newer one lacks', () => {
    const older = device('2-a', '2026-10-06T00:00:00.000Z', [], FOUND)
    const newer = device('2-b', '2026-10-05T00:00:00.000Z', [], {
      catalogCheckedAt: '2026-10-05T12:00:00.000Z',
      catalogSource: 'found',
      vendorName: 'Aqara Home',
    })

    const merged = mergeDevice(older, [newer])

    // `older` wins the scalars by updatedAt; `newer` wins the block by catalogCheckedAt.
    expect(merged._rev).toBe('2-a')
    expect(merged.vendorName).toBe('Aqara Home')
    expect(merged).not.toHaveProperty('supportUrl')
  })

  it('breaks a tie in catalogCheckedAt by (updatedAt, _rev), so replicas agree', () => {
    const one = device('2-a', '2026-10-05T10:00:00.000Z', [], { ...FOUND, vendorName: 'One' })
    const two = device('2-b', '2026-10-05T10:00:00.000Z', [], { ...FOUND, vendorName: 'Two' })
    expect(mergeDevice(one, [two]).vendorName).toBe('Two')
    expect(mergeDevice(two, [one]).vendorName).toBe('Two')
  })

  it('leaves a document with no block on any side unchanged', () => {
    const one = device('1-a', '2026-08-01T00:00:00.000Z')
    const two = device('2-b', '2026-08-02T00:00:00.000Z')
    expect(mergeDevice(one, [two])).not.toHaveProperty('catalogCheckedAt')
  })

  it('stays permutation-independent with blocks involved', () => {
    const a = device('2-a', '2026-10-05T10:00:01.000Z', [], FOUND)
    const b = device('2-b', '2026-10-05T11:00:00.000Z', [], { name: 'Hall sensor' })
    const c = device('1-c', '2026-10-04T00:00:00.000Z', [], {
      catalogCheckedAt: '2026-10-04T00:00:00.000Z',
      catalogSource: 'missing',
    })
    const results = [
      mergeDevice(a, [b, c]),
      mergeDevice(b, [c, a]),
      mergeDevice(c, [a, b]),
    ]
    for (const result of results) expect(result).toEqual(results[0])
  })
})
```

In `public-api.test.ts` add to `EXPECTED` (after the `// credential` group):

```ts
  // catalogue
  ['CATALOG_FIELD_KEYS', 'object'],
  ['CATALOG_MISS_RETRY_MS', 'number'],
  ['TEST_VENDOR_NAME', 'string'],
  ['catalogFields', 'function'],
  ['isHttpsUrl', 'function'],
  ['manufacturerName', 'function'],
  ['needsCatalogLookup', 'function'],
  ['withCatalogBlock', 'function'],
```

and in "the public entry point reaches the implementations":

```ts
  it('decides when to ask the catalogue', () => {
    expect(core.needsCatalogLookup({ manualCode: '34970112332' }, new Date())).toBe(false)
  })
```

- [ ] **Step 2: Run to verify failure.**
Run: `npx vitest run --project domain test/domain/sync/merge.test.ts test/domain/public-api.test.ts`
Expected: FAIL: "keeps the block from the revision that looked it up…" (`vendorName` undefined), the tie and "newer check" tests, and the public API list (`catalogFields` undefined).

- [ ] **Step 3: Implement the merge.** In `merge.ts` add `import { withCatalogBlock } from '../catalog/copy.js'` below the rooms import (no runtime cycle: `copy.ts` imports only types from `documents/types.ts`, which imports only types from here). Add after `RoomRevision`:

```ts
/** A revision that may carry a catalogue block (`catalog/copy.ts`). */
export interface CatalogBearing {
  readonly catalogCheckedAt?: string
}

/**
 * The revision whose catalogue block wins: the newest `catalogCheckedAt`, ties broken by the
 * same `(updatedAt, _rev)` order as scalars so that every replica picks the same one.
 */
function catalogueSource<T extends Revision & CatalogBearing>(
  revisions: readonly T[],
): T | undefined {
  let best: T | undefined
  for (const revision of revisions) {
    if (revision.catalogCheckedAt === undefined) continue
    if (
      best === undefined ||
      compareText(revision.catalogCheckedAt, best.catalogCheckedAt ?? '') > 0 ||
      (revision.catalogCheckedAt === best.catalogCheckedAt && compareForWinner(revision, best) > 0)
    ) {
      best = revision
    }
  }
  return best
}
```

Replace `mergeDevice` (keep and extend its JSDoc):

```ts
/**
 * Merges conflicting revisions of a device.
 *
 * Scalars come from the latest revision; remarks are unioned across all of them; the
 * catalogue block comes, whole, from the revision that consulted the catalogue last. The block
 * has its own clock (`catalogCheckedAt`) because it is written by backfill, not by the person
 * editing: a newer rename that never saw the lookup must not erase what the lookup found.
 *
 * The result does not depend on which revision arrived as `winner`, so two replicas merging the
 * same conflict independently reach the same document.
 */
export function mergeDevice<T extends RemarkBearing & CatalogBearing>(
  winner: T,
  conflicts: readonly T[],
): T {
  const revisions = [winner, ...conflicts]
  const latest = latestRevision(revisions)
  const merged = { ...latest, remarks: mergeRemarks(revisions) }
  const source = catalogueSource(revisions)
  return source === undefined || source === latest ? merged : withCatalogBlock(merged, source)
}
```

- [ ] **Step 4: Implement the exports.** In `src/domain/index.ts` add, keeping the alphabetical-by-path order of the file:

```ts
export {
  CATALOG_FIELD_KEYS,
  CATALOG_MISS_RETRY_MS,
  type CatalogFields,
  catalogFields,
  isHttpsUrl,
  manufacturerName,
  needsCatalogLookup,
  TEST_VENDOR_NAME,
  withCatalogBlock,
} from './catalog/copy.js'
export type { CatalogLookup } from './catalog/types.js'
```

add `type CatalogSource,` and `type DeviceDiscovery,` to the existing `./documents/types.js` export, and `type CatalogBearing,` to the `./sync/merge.js` export.

- [ ] **Step 5: Run the whole domain project with coverage.**
Run: `npx vitest run --project domain --coverage --coverage.include='src/domain/**'`
Expected: PASS; the summary shows `src/domain` ≥ 90% for statements, branches, functions and lines, and `catalog/copy.ts` at 100% lines.

- [ ] **Step 6: Document.** In `docs/DATA-MODEL.md`, replace the device JSON block's lines from `// --- from the QR code ---` to `"deviceTypeId": 266,` with:

```jsonc
  // --- from the QR code, decoded locally when the device is added ---
  "payload": "MT:Y.K9042C00KA0648G00",
  "manualCode": "34970112332",
  "vendorId": 65521,                // 0xFFF1
  "productId": 32768,               // 0x8000
  "discriminator": 3840,
  "payloadVersion": 0,              // payload only
  "commissioningFlow": "standard",  // standard | userActionRequired | custom | reserved; payload only
  "discovery": { "softAp": false, "ble": true, "onNetwork": false },  // payload only

  // --- the catalogue block: copied from the DCL lookup, written and merged as a unit ---
  "vendorName": "Example GmbH",
  "vendorPreferredName": "Example",
  "productName": "Smart Bulb A60",
  "deviceTypeId": 266,
  "partNumber": "A60-E27",
  "productUrl": "https://example.com/a60",          // https: only, as are the next three
  "supportUrl": "https://example.com/support",
  "userManualUrl": "https://example.com/a60.pdf",
  "commissioningFlowUrl": "https://example.com/pair",
  "commissioningInstructions": "Switch it on and off three times.",  // plain text
  "factoryResetInstructions": "Switch it on and off six times.",     // plain text
  "catalogCheckedAt": "2026-08-19T08:00:00.000Z",
  "catalogSource": "found",         // found | missing | test-vendor
```

After the JSON block add:

```markdown
**Every field below `discriminator` is optional.** A device added before these fields existed,
or from an 11-digit code, simply lacks them; nothing migrates. The catalogue block is filled when
the device is added online, or later by backfill, and an empty DCL value is left out rather than
stored as `""`. A `missing` result is asked again after a day. The copied fields are read-only in
the edit form.
```

Leave the payload paragraph's security sentence alone: Task B1 owns it. In the Conflicts table add the row:

```markdown
| Catalogue block (`vendorName` … `catalogSource`) | Taken whole from the revision with the newest `catalogCheckedAt`, ties by `(updatedAt, _rev)`. |
```

- [ ] **Step 7: Full check and commit.**
Run: `npm run typecheck && npx biome check . && npx vitest run --project domain --project data`
Expected: no output from `tsc`; Biome "No fixes applied" with 0 errors and 0 warnings; tests PASS (the `data` suite exercises `mergeDevice` through `conflictResolver`).

```bash
git add src/domain/sync/merge.ts src/domain/index.ts test/domain/sync/merge.test.ts test/domain/public-api.test.ts ../docs/DATA-MODEL.md
git commit -m "feat(sync): the newer catalogue block wins a device merge whole (#225)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Verify the part and open the PR.** From the repo root: `npm run verify`. Expected: exits 0, no warnings, all coverage gates met. Push `feat/catalog-capture-225` and open the PR against `feat/qr-decode-dcl-catalogue` ("Catalogue 1: capture decoded QR fields", `Closes #225`).

---

---

## Part B — Backend catalogue (#226)

**Goal:** `POST /catalog/lookup` decodes a setup code to its vendor and product IDs and answers
what the CSA's DCL says about them, from an admin-only `matter_catalog` cache, without the code
ever being stored, logged or echoed.

**How it fits together:** `routes.ts` authenticates, counts the caller against a per-subject
limit, decodes with `decode.ts`, answers test vendors locally, and otherwise hands the IDs to
`lookup.ts`. `lookup.ts` reads `store.ts`, asks `dcl.ts` for anything absent or not fresh
(`policy.ts` decides), writes back, and falls back to stale entries when the DCL is down.
`policy.ts` maps the two entries to the response, which is typed from the generated OpenAPI
types, so a shape the contract does not declare will not compile.

**Every snippet below was compiled, linted and run** against a scratch copy of this branch
(`npm --prefix backend run verify`: 1190 tests, src/catalog at 97.5% statements and 92.5%
branches). `npm run dcl:smoke` was also run against live MainNet on 2026-10-07 and passed.

### Decisions this part makes (read before Task B7)

- **The rate limit runs inside the handler, after authentication.** `registerSecurity`'s
  `onRequest` hook runs before routing and has no key to verify a token with, so it could only
  count addresses. An address is shared by a household or an office, while the abuse the spec
  names is one *account* using the endpoint as a free DCL proxy. `Limits` gains a required
  `catalog` entry (default 120 per 300 s) so that every limit is still configured in one place.
  `buildServer` passes `(security.limits ?? DEFAULT_LIMITS).catalog` to the route, and the route
  builds its own `rateLimiter` keyed by `catalog:${sub}`. A side effect, which a test pins:
  unauthenticated requests cannot spend a signed-in user's budget.
- **429 is a problem response.** It has the fixed title `Too many requests` and a `retry-after`
  header, sent with `problem()`. The `/auth/*` hook's plain `{ error }` body is undeclared in the
  contract. This one is declared, and the drift check validates it. The frontend switches on the
  status and reads `retry-after`, so nothing changes for it.
- **Only the DCL's own not-found is a miss.** A miss is a 404 whose body has `code: 5`. Any
  other 404, for example from a proxy or a mistyped `DCL_BASE_URL`, is `DclUnavailable`.
  Without this rule, a misconfiguration would cache every product as missing for a day.
- **CouchDB trouble degrades the lookup instead of failing it.** A cache read that fails counts
  as "nothing cached". A write that fails, other than a 409, is logged and skipped. The cache is
  an optimisation, and the DCL can still answer.
- **The orchestration lives in a sixth module, `lookup.ts`.** It is not in the spec's module
  table. It keeps the algorithm testable without HTTP and keeps `policy.ts` pure.
- **The documentation change is a new ADR.** `docs/adr/README.md` says "do not edit the old
  record — supersede it". ADR 0019 amends ADR 0005 and replaces the contributor rule in
  SECURITY-MODEL.md. ADR 0005's *Status* line gains a pointer, in the same way ADR 0004's
  status points to 0015.

### File structure

| File | Create / modify | Responsibility |
|---|---|---|
| `docs/adr/0019-setup-code-to-own-api.md` | Create | Records why a setup code may travel to our own API, and the controls that go with it |
| `docs/adr/README.md` | Modify | Index row for 0019; marks 0005 as amended |
| `docs/adr/0005-plaintext-payload-storage.md` | Modify (Status only) | Points to 0019; the decision itself is unchanged |
| `docs/SECURITY-MODEL.md` | Modify | The contributor rule now separates our API from third parties; `matter_catalog` is admin-only |
| `docs/DATA-MODEL.md` | Modify | The payload paragraph; a new `matter_catalog` section |
| `docs/ARCHITECTURE.md` | Modify | Adds the DCL and `matter_catalog` to the diagram and to the stores table |
| `PRODUCT.md` | Modify | The secrets sentence: setup codes also go to our own catalogue lookup |
| `backend/src/catalog/decode.ts` | Create | `decodeCode` and `CodeError`: QR (`MT:` + Base-38) or manual code down to `{ vendorId, productId }` |
| `backend/src/catalog/dcl.ts` | Create | `dclClient`, `DclUnavailable`, `networkOf`, `MAINNET_URL`, `TESTNET_URL`: the two DCL reads over native `fetch` with a 5 s timeout |
| `backend/src/catalog/store.ts` | Create | The `matter_catalog` database: lazy admin-only setup, `by_fetched` view, entry types, `catalogStore` |
| `backend/src/catalog/policy.ts` | Create | Pure: `isFresh`, `isTestVendor`, the empty-to-`null` mapping, `toLookup`, `testVendorLookup`, `CatalogLookup` |
| `backend/src/catalog/lookup.ts` | Create | `lookupEntries`: cache → DCL → write back → stale fallback |
| `backend/src/catalog/routes.ts` | Create | `registerCatalogRoutes`: auth, per-subject limit, decode, answer |
| `backend/src/security/register.ts` | Modify | `Limits.catalog`, `DEFAULT_LIMITS.catalog` |
| `backend/src/server.ts` | Modify | `ServerOptions.catalog`; registers the route with the configured limit |
| `backend/src/composition.ts` | Modify | `DCL_BASE_URL` (https only, default MainNet); wires `catalog` when CouchDB and the key exist |
| `backend/src/logging.ts` | Modify (comment) | `code` is already redacted; the comment now gives its second reason |
| `backend/src/generated/openapi.ts` | Regenerate | `npm run openapi:types` |
| `openapi.yaml` | Modify | `catalog` tag, `POST /catalog/lookup`, four schemas |
| `backend/package.json` | Modify | `dcl:smoke` script |
| `backend/README.md` | Modify | The catalogue lookup and `DCL_BASE_URL` |
| `backend/test/support/dcl.ts` | Create | Recorded DCL responses (Aqara 4447 and 4447/8194, the real 404) and `fakeDcl` |
| `backend/test/catalog/*.test.ts` | Create | One test file per module |
| `backend/test/smoke/dcl-smoke.ts` | Create | The opt-in live check (`npm run dcl:smoke`); not collected by vitest |
| `backend/test/openapi-drift.test.ts` | Modify | Wires `catalog`; extra requests reach 200, 422 and 503 |
| `backend/test/composition.test.ts` | Modify | The route is served with CouchDB; `DCL_BASE_URL` validation |
| `backend/test/logging.test.ts` | Modify | Pins `code` for its catalogue meaning |
| `backend/test/security/server-security.test.ts` | Modify | Its two `limits` literals gain `catalog` (the field is required) |

### Review focus (backend)

The spec implies these inputs but never names them. Each one has a test, in the task shown.

1. **What people type or paste:** lower-case `mt:`, surrounding whitespace, and hyphenated or
   spaced digit groups. Whitespace and separators are tolerated. A lower-case prefix is refused,
   as the frontend refuses it. Tests in B2 (`decode.test.ts`) and B7 (route answers 400).
2. **Two first lookups racing:** both on `createDb`/`installDesign`, and both on `putDoc` of the
   same new entry. Setup is shared through `once()`, and the second write's 409 is ignored.
   Tests in B4 (concurrent `ensureCatalogDatabase`, a 409 on `write`) and B6 (two
   `lookupEntries` at once: four DCL requests, one stored revision).
3. **A DCL answer that is not what we expect:** a 200 that is not a vendor or model, a 404 that
   is not the DCL's, a 5xx with or without JSON, a timeout, an oversized body. Each one is
   `DclUnavailable`, so the route serves stale data or a 503 and never caches a miss. Tests in
   B3.
4. **Vendor found but model 404:** a 200 with `source: "missing"`, the vendor filled in and
   `product: null`, with the miss cached for a day. Tests in B5 (`toLookup`), B6 (a stored
   miss) and B7 (the route).
5. **Huge or hostile input:** a 10 000-character `code` is refused before decoding; a raw
   non-JSON body holding a code is refused by Fastify's parser without echoing or logging it.
   Request bodies are already capped at 64 KiB service-wide. Tests in B2 and B7, including the
   log-capture test.
6. **CouchDB unavailable during a lookup:** the lookup still answers from the DCL and logs a
   warning. Test in B6.
7. **A signed-out token** gets 401, and unauthenticated requests do not spend a user's budget.
   Tests in B7.

### Contract mismatches found against the real code, and how the tasks resolve them

- **`code` is already in `REDACTED_FIELDS`**, for the OAuth authorisation code. The contract
  asks to "add" it. B7 only adds a comment giving the second reason and a test that pins it.
- **`dclClient(baseUrl, fetchImpl = fetch)` gains two compatible extensions:** an optional
  third parameter `timeoutMs = 5000`, so the timeout test does not wait five seconds, and a
  `network: 'mainnet' | 'testnet' | 'other'` property, which every cached document records as
  the spec's `network` field.
- **`Omit<DclVendor, 'creator'>` erases every named field**, because the record types carry an
  index signature. The stored `dcl` is therefore typed `DclVendor`/`DclModel`, and
  `withoutCreator` returns `T`. The removal still happens at runtime.
- **The 429 body** is the existing limiter's response only in spirit: it is
  `application/problem+json` with the title `Too many requests`. See the decisions above.
- **The contract checker cannot read `nullable`:** a `type: string` value of `null` fails it.
  The schemas use the forms the contract already uses: `type: [string, 'null']`, and
  `oneOf: [$ref, {type: 'null'}]` for the nullable objects.
- **The drift test requires every contract operation to be implemented.** Its "pending" list
  must stay empty, so the `openapi.yaml` operation lands in the same task as the route (B7),
  not earlier.
- **`CouchClient` lacks nothing.** `getDoc` returns `undefined` on a 404, `putDoc` throws
  `CouchError` 409, `createDb` returns `false` on 412, and `putSecurity` and `installDesign`
  with `once()` cover setup.
- **The spec's reference vectors are all test vendors.** `749701123365521327687` is
  `65521/32768`, which is 0xFFF1/0x8000. B2 adds a real-vendor pair produced by the frontend's
  own `encodePayload` and `deriveManualCode` for Aqara 4447/8194: `MT:CUSJ0YJB00KA0648G00` and
  `749701123304447081941`. It also adds `MT:0W-T3ELB00KA0648G00` for 4447/9999 (model
  missing) and `MT:Y.K9042C00KA0640A30` (padding bits set).

---

### Task B1: ADR 0019 and the security-document amendments

**Files:**
- Create: `docs/adr/0019-setup-code-to-own-api.md`
- Modify: `docs/adr/README.md` (index table)
- Modify: `docs/adr/0005-plaintext-payload-storage.md` (*Status* section only)
- Modify: `docs/SECURITY-MODEL.md` (*What isolation does and does not give you*; *Rules for contributors*)
- Modify: `docs/DATA-MODEL.md` (the `payload` paragraph; a new `matter_catalog` section)
- Modify: `docs/ARCHITECTURE.md` (diagram; *The two paths*; *Three stores*)

**Interfaces:**
- Consumes: nothing.
- Produces: the decision record that `decode.ts`, `dcl.ts`, `routes.ts`, `logging.ts` and
  `openapi.yaml` cite as "ADR 0019".

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0019-setup-code-to-own-api.md`:

```markdown
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
  exposure is new for exactly the users who were never exposed. The mitigation is everything
  above: the code is in our process for the length of one request, and in no file afterwards.
- The browser reaches the API through the Cloudflare Pages Functions proxy (`/api`), where
  Cloudflare terminates TLS, so the body passes through Cloudflare in transit. Synced payloads
  already do the same through `/db`, and the proxy logs no bodies. For a free-plan user, though,
  this is new exposure.
- A debug log added later around this route is now a place a passcode could be written. The
  redaction list and the log-capture test are what stand in the way. Do not weaken either.

Revisit this ADR if the lookup ever needs to persist anything derived from the code beyond the
two IDs, or if anything between the browser and this API starts logging request bodies, such
as a proxy, a WAF or an analytics layer.
```

- [ ] **Step 2: Index it, and point ADR 0005 at it**

In `docs/adr/README.md`, change the 0005 row and add a 0019 row after 0018:

```markdown
| [0005](0005-plaintext-payload-storage.md) | Store Matter payloads unencrypted | Accepted; amended by 0019 |
```

```markdown
| [0019](0019-setup-code-to-own-api.md) | A setup code may travel to our own API for the catalogue lookup | Accepted (amends 0005) |
```

In `docs/adr/0005-plaintext-payload-storage.md`, replace the body of `## Status` (currently
`Accepted — with mandatory compensating controls`) with:

```markdown
Accepted — with mandatory compensating controls. **Amended by
[ADR 0019](0019-setup-code-to-own-api.md)**, which lets a setup code travel to this service's own
API for the catalogue lookup, and adds the controls that go with it. The decision below stands.
```

- [ ] **Step 3: Amend SECURITY-MODEL.md**

Replace:

```markdown
**Two of the three server-side databases are unreachable from a browser**, and this is
load-bearing rather than tidy:
```

with:

```markdown
**Three of the four server-side databases are unreachable from a browser.** For the first two
this is load-bearing rather than tidy:
```

After the `matter_manager` bullet that follows it, which ends `used for profiles.`, add:

```markdown
- **`matter_catalog`** caches what the DCL says about vendors and models
  ([ADR 0019](adr/0019-setup-code-to-own-api.md)). Nothing in it is secret; it is admin-only
  because no browser needs it, and a database nobody else can reach is one nobody has to
  reason about.
```

In *Rules for contributors*, replace:

```markdown
- **Never send a payload to a third party.** The DCL lookup sends vendor and product ids
  only.
```

with:

```markdown
- **Never send a payload to a third party.** The one place a setup code leaves the browser,
  other than replication, is `POST /catalog/lookup` to our own API, in a POST body over TLS
  ([ADR 0019](adr/0019-setup-code-to-own-api.md)). The API decodes it in memory, never stores or
  logs it, never echoes it in an error, and sends **only vendor and product IDs** to the DCL,
  which is still a third party.
```

- [ ] **Step 3b: Amend PRODUCT.md**

In §Capabilities and Constraints, replace `They must never be logged or transmitted outside sync.` with:

```markdown
They must never be logged. They leave the browser only through sync and through the catalogue lookup on our own API ([ADR 0019](docs/adr/0019-setup-code-to-own-api.md)), which decodes them in memory and never stores or logs them; only vendor and product IDs reach the DCL.
```

- [ ] **Step 4: Amend DATA-MODEL.md**

Replace:

```markdown
**`payload` is a secret.** It contains the setup passcode. Never log it, never send it to a
third party (the DCL lookup sends vendor and product ids only), and never include it in a
bug report. See [SECURITY.md](../SECURITY.md).
```

with:

```markdown
**`payload` is a secret.** It contains the setup passcode. Never log it, never send it to a
third party, and never include it in a bug report. See [SECURITY.md](../SECURITY.md). The one
place it travels other than replication is `POST /catalog/lookup`: to our own API, in a POST
body, decoded in memory and never stored. Only the vendor and product IDs reach the DCL
([ADR 0019](adr/0019-setup-code-to-own-api.md)).
```

Insert this section between the end of the `matter_manager` section (the `---` after "*User
records and tokens*.") and `## \`projects\` — the registry`:

````markdown
## `matter_catalog` — the DCL cache

What the CSA's Distributed Compliance Ledger said about each vendor and model, and when.
**Admin access only; never replicated.** Created by the API on the first lookup, with
`_security` written before anything else. A cache, not a source of truth: every document can
be fetched again. Document IDs use **decimal** IDs, as the DCL's own paths do.

Each document keeps the DCL record **raw**, minus `creator`, so a field the app starts using
later needs no re-fetch. `dcl` is present exactly when `status` is `found`.

```jsonc
{ "_id": "vendor:4447", "type": "vendor", "vid": 4447, "status": "found",
  "fetchedAt": "2026-10-05T16:20:00.000Z", "network": "mainnet",
  "dcl": { "vendorID": 4447, "vendorName": "Aqara", "companyLegalName": "Lumi United Technology Co., Ltd.",
           "companyPreferredName": "", "vendorLandingPageURL": "https://www.aqara.com/", "schemaVersion": 0 } }

{ "_id": "model:4447:9999", "type": "model", "vid": 4447, "pid": 9999, "status": "missing",
  "fetchedAt": "2026-10-05T16:20:00.000Z", "network": "mainnet" }
```

A found entry is refreshed after 90 days, a miss after one day, and an old entry is served
with `stale: true` when the DCL cannot be reached. `network` is `mainnet`, `testnet` or
`other`, from `DCL_BASE_URL`. The view `_design/catalog/by_fetched` emits `fetchedAt`, for a
future "refresh all".

**The setup code is never stored here**, or anywhere else on the server. Only the two IDs
decoded from it survive the request.

---
````

- [ ] **Step 5: Amend ARCHITECTURE.md**

In the mermaid diagram, add the cache inside `subgraph CDB` and the DCL outside the droplet:

```text
      PROJ[("project_uuid × N<br/>the shared unit")]
      CAT[("matter_catalog<br/>DCL cache, admin-only")]
    end
```

```text
    API -->|provision| PROJ
    API -->|admin| CAT
  end

  DCL["CSA DCL<br/>third party"]
  API -->|"vendor and product IDs only"| DCL
```

and extend the class line to `class LOCAL,USERS,REG,PROJ,CAT store`.

In *The two paths*, replace:

```markdown
**The API handles only what replication cannot**: proving who someone is, listing projects,
serving the profile, and creating databases the browser has no rights to create.
```

with:

```markdown
**The API handles only what replication cannot**: proving who someone is, listing projects,
serving the profile, creating databases the browser has no rights to create, and looking up
manufacturer and product names in the DCL (ADR 0019).
```

Rename `### Three stores, three different exposures` to
`### Four stores, four different exposures`. Replace "governs the other two databases" with
"governs the other server-side databases", and add this row to the end of its table:

```markdown
| `matter_catalog` | **never** — API only | What the DCL says about vendors and models, cached for `POST /catalog/lookup`. Public data, admin-only because no browser needs it. Never holds a setup code. |
```

- [ ] **Step 6: Check the links and the wording**

Run: `grep -rn "0019-setup-code-to-own-api" docs | wc -l`
Expected: `8`. That is two in DATA-MODEL, two in SECURITY-MODEL, one in the ADR README, one in
ADR 0005, one inside ADR 0019, and one in ARCHITECTURE (which cites "ADR 0019" in text, so add
the link there if your count is 7).

Run: `grep -n "vendor and product ids only" docs/*.md`
Expected: no output. The old wording is gone.

Run: `npm run check`
Expected: exit 0, no warnings.

- [ ] **Step 7: Commit**

```bash
git add docs/adr/0019-setup-code-to-own-api.md docs/adr/README.md docs/adr/0005-plaintext-payload-storage.md docs/SECURITY-MODEL.md docs/DATA-MODEL.md docs/ARCHITECTURE.md PRODUCT.md
git commit -m "$(cat <<'EOF'
docs(adr): 0019, a setup code may travel to our own API for the catalogue lookup

Amends ADR 0005 and replaces the "DCL lookup sends ids only" rule in
SECURITY-MODEL.md and DATA-MODEL.md: the code may reach our API in a POST
body, is never stored or logged, and only vendor and product IDs reach the
DCL. Records matter_catalog as a fourth, admin-only, server-side database.

Refs #226

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B2: The backend's own decoder

**Files:**
- Create: `backend/src/catalog/decode.ts`
- Test: `backend/test/catalog/decode.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `decodeCode(code: string): CodeIds`, which throws `CodeError`.
  - `interface CodeIds { readonly vendorId: number; readonly productId: number }`.
  - `class CodeError extends Error { readonly kind: CodeErrorKind }`, with
    `type CodeErrorKind = 'malformed' | 'no-ids'`.
  - Messages never contain the code, `MT:`, or a run of five or more digits.

- [ ] **Step 1: Write the failing test**

Create `backend/test/catalog/decode.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CodeError, decodeCode } from '../../src/catalog/decode.js'

/**
 * The reference vectors are the frontend's own (`frontend/test/domain/matter/payload.test.ts`,
 * `manual-code.test.ts`), copied rather than imported: ADR 0017 keeps the halves apart, and the
 * shared vectors are what keep the two decoders agreeing.
 */
const REFERENCE_QR = 'MT:Y.K9042C00KA0648G00'
const REFERENCE_LONG = '749701123365521327687'
const REFERENCE_SHORT = '34970112332'

/**
 * A real vendor, so the decoder is not only ever tested on test vendors. Produced by the
 * frontend's `encodePayload` and `deriveManualCode` for Aqara (4447) Door and Window Sensor P2
 * (8194), discriminator 3840, passcode 20202021.
 */
const AQARA_QR = 'MT:CUSJ0YJB00KA0648G00'
const AQARA_LONG = '749701123304447081941'

/** The error `decodeCode` throws for this input, or a failure if it throws none. */
function errorFor(input: string): CodeError {
  try {
    decodeCode(input)
  } catch (error) {
    if (error instanceof CodeError) return error
    throw error
  }
  throw new Error('decodeCode accepted the input')
}

describe('decodeCode on the reference vectors', () => {
  it('reads the reference QR payload as test vendor 0xFFF1, product 0x8000', () => {
    expect(decodeCode(REFERENCE_QR)).toEqual({ vendorId: 0xfff1, productId: 0x8000 })
  })

  it('reads the reference 21-digit manual code to the same IDs', () => {
    expect(decodeCode(REFERENCE_LONG)).toEqual({ vendorId: 0xfff1, productId: 0x8000 })
  })

  it('reads a real vendor from a QR payload and from its manual code alike', () => {
    expect(decodeCode(AQARA_QR)).toEqual({ vendorId: 4447, productId: 8194 })
    expect(decodeCode(AQARA_LONG)).toEqual({ vendorId: 4447, productId: 8194 })
  })

  it('answers no-ids for the 11-digit manual code, which is valid and names no product', () => {
    expect(errorFor(REFERENCE_SHORT).kind).toBe('no-ids')
  })
})

describe('decodeCode on what people actually send', () => {
  it.each([
    ['surrounding whitespace on a QR payload', `  ${AQARA_QR}\n`],
    ['surrounding whitespace on a manual code', ` ${AQARA_LONG} `],
    ['hyphenated digit groups', '7497-011-2330-4447-0819-41'],
    ['spaced digit groups', '7497 011 2330 4447 0819 41'],
  ])('tolerates %s', (_case, input) => {
    expect(decodeCode(input)).toEqual({ vendorId: 4447, productId: 8194 })
  })

  it('refuses a lower-case prefix, as the frontend decoder does', () => {
    // Base-38 has no lower-case letters, so `mt:` is a payload typed by hand. Accepting it here
    // would make the backend more lenient than the code the browser could ever have stored.
    expect(errorFor(`mt:${AQARA_QR.slice(3)}`).kind).toBe('malformed')
  })
})

describe('decodeCode on malformed input', () => {
  it.each([
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['the bare prefix', 'MT:'],
    ['a payload too short for the fixed part', 'MT:Y.K90'],
    ['a character outside Base-38', 'MT:Y.K9042C00KA0648G0$'],
    ['a lower-case letter in the body', 'MT:y.K9042C00KA0648G00'],
    ['a trailing chunk of 3 characters', 'MT:Y.K9042C00KA0648G'],
    ['a chunk above its byte range', 'MT:.....'],
    ['the reserved padding bits set', 'MT:Y.K9042C00KA0640A30'],
    ['a wrong check digit', '749701123304447081942'],
    ['a 12-digit number', '349701123321'],
    ['a leading 8, a format this does not know', '84970112331'],
    ['a long code whose leading digit says short', '349701123365521327683'],
    ['a URL', 'https://example.com/MT:Y.K9042C00KA0648G00'],
    ['something far longer than any code', `MT:${'0'.repeat(10_000)}`],
  ])('refuses %s', (_case, input) => {
    expect(errorFor(input).kind).toBe('malformed')
  })

  it.each([
    `${REFERENCE_QR.slice(0, -1)}$`,
    'MT:Y.K9042C00KA0648G',
    REFERENCE_SHORT,
    '749701123304447081942',
    `MT:${'0'.repeat(10_000)}`,
  ])('never puts the code into an error message (%#)', (input) => {
    const { message } = errorFor(input)
    expect(message).not.toContain(input.trim())
    expect(message).not.toContain('MT:')
    expect(message).not.toMatch(/\d{5,}/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix backend exec -- vitest run test/catalog/decode.test.ts`
Expected: FAIL. The file cannot import `../../src/catalog/decode.js` ("Failed to load url" /
"Cannot find module").

- [ ] **Step 3: Write the decoder**

Create `backend/src/catalog/decode.ts`:

```ts
/**
 * Reading a setup code down to its vendor and product IDs, and no further.
 *
 * The browser sends the whole code to `POST /catalog/lookup` (ADR 0019), and this is the only
 * thing the service does with it: find the two IDs the DCL is asked about. The discriminator and
 * the passcode are never extracted, so they cannot end up in a variable somebody later logs.
 *
 * **The backend's own decoder**, not an import from the frontend: ADR 0017 keeps the two halves
 * free of shared code. What keeps them agreeing is that both are tested against the same
 * reference vectors — `frontend/test/domain/matter/payload.test.ts` and `manual-code.test.ts`.
 *
 * **No error message contains the code**, or any part of it. An error message is the most
 * reliable way for a value to reach a log or a response body, and this value is a credential.
 *
 * @module
 */

/** Why a code could not be read: not a code at all, or a valid one that names no product. */
export type CodeErrorKind = 'malformed' | 'no-ids'

/** A code that cannot be read down to a vendor and product ID. Never carries the code itself. */
export class CodeError extends Error {
  override readonly name = 'CodeError'
  readonly kind: CodeErrorKind

  constructor(kind: CodeErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

/** The two IDs the DCL is keyed by. */
export interface CodeIds {
  readonly vendorId: number
  readonly productId: number
}

/** The QR payload prefix. Exact and upper-case: Base-38 has no lower-case letters. */
const PREFIX = 'MT:'

/** Base-38 in value order: digits, upper-case letters, then `-` and `.`. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.'

/** Characters per Base-38 chunk → bytes it carries. Any other trailing length is corrupt. */
const BYTES_PER_CHUNK: Readonly<Record<number, number>> = { 2: 1, 4: 2, 5: 3 }

/** The fixed part of a QR payload: 88 bits, of which the last 4 are reserved padding. */
const STRUCT_BYTES = 11

/** Bit offsets in the packed payload: version (3 bits) comes first. */
const VENDOR_OFFSET = 3
const PRODUCT_OFFSET = 19
const PADDING_OFFSET = 84

/**
 * Longer than any setup code, by a wide margin: the spec caps a payload at 255 characters.
 *
 * Checked before anything else so a 64 KiB body costs one comparison rather than a decode.
 */
const MAX_CODE_LENGTH = 512

const SHORT_MANUAL = 11
const LONG_MANUAL = 21

/** Spaces and hyphens a person types or a label prints between digit groups. */
const SEPARATORS = /[\s-]/g

/** Verhoeff tables, as in the Matter specification §5.1.4.1. */
const MULTIPLY: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const PERMUTE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

const malformed = (message: string): CodeError => new CodeError('malformed', message)

/**
 * The vendor and product IDs in a setup code.
 *
 * Accepts what the browser stores: a QR payload (`MT:` and Base-38) or a manual pairing code,
 * with surrounding whitespace and the usual digit-group separators tolerated.
 *
 * @throws {CodeError} `malformed` for anything that is not a valid code, `no-ids` for a valid
 *   11-digit manual code, which carries no vendor or product ID.
 */
export function decodeCode(code: string): CodeIds {
  if (code.length > MAX_CODE_LENGTH) throw malformed('Longer than any setup code.')

  const trimmed = code.trim()
  // Case-insensitive *detection* only. A lower-case prefix is a payload somebody typed, and it
  // is refused below as one, rather than mistaken for a manual code with letters in it.
  if (/^mt:/i.test(trimmed)) return decodeQr(trimmed)

  const digits = trimmed.replace(SEPARATORS, '')
  if (/^\d+$/.test(digits)) return decodeManual(digits)

  throw malformed('Neither a Matter QR payload nor a manual pairing code.')
}

/** The IDs in a QR payload. See the Matter Core Specification §5.1.3. */
function decodeQr(text: string): CodeIds {
  // The frontend's `decodePayload` refuses a lower-case prefix too; agreeing with it means a
  // code the browser could not have stored is not one this service accepts either.
  if (!text.startsWith(PREFIX)) throw malformed('The QR payload prefix must be upper-case.')

  const bytes = base38(text.slice(PREFIX.length))
  if (bytes.length < STRUCT_BYTES) throw malformed('The QR payload is too short.')
  // Cheap, and the one structural check the fixed part offers: a payload whose padding is set
  // was not produced by a Matter encoder, so its "IDs" are noise.
  if (readBits(bytes, PADDING_OFFSET, 4) !== 0) throw malformed('The reserved bits are set.')

  return {
    vendorId: readBits(bytes, VENDOR_OFFSET, 16),
    productId: readBits(bytes, PRODUCT_OFFSET, 16),
  }
}

/** Base-38, as Matter chunks it: 5 characters for 3 bytes, 4 for 2, 2 for 1. */
function base38(body: string): Uint8Array {
  if (body === '') throw malformed('Nothing follows the QR payload prefix.')

  const bytes: number[] = []
  for (let cursor = 0; cursor < body.length; ) {
    const length = Math.min(5, body.length - cursor)
    const count = BYTES_PER_CHUNK[length]
    if (count === undefined) throw malformed('The QR payload length is not valid Base-38.')

    let value = 0
    // Little-endian within a chunk: the first character is the least significant digit.
    for (let digit = length - 1; digit >= 0; digit -= 1) {
      const index = ALPHABET.indexOf(body.charAt(cursor + digit))
      if (index < 0) throw malformed('The QR payload contains a character outside Base-38.')
      value = value * ALPHABET.length + index
    }
    if (value >= 2 ** (8 * count)) throw malformed('A Base-38 chunk is out of range.')

    for (let byte = 0; byte < count; byte += 1) bytes.push((value >>> (8 * byte)) & 0xff)
    cursor += length
  }
  return Uint8Array.from(bytes)
}

/** `length` bits from `offset`, least significant first, as the payload packs them. */
function readBits(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0
  for (let index = 0; index < length; index += 1) {
    const bit = offset + index
    if ((((bytes[bit >> 3] ?? 0) >> (bit & 7)) & 1) === 1) value |= 1 << index
  }
  return value
}

/** The IDs in a manual pairing code. See the Matter Core Specification §5.1.4. */
function decodeManual(digits: string): CodeIds {
  if (digits.length !== SHORT_MANUAL && digits.length !== LONG_MANUAL) {
    throw malformed('A manual pairing code has 11 or 21 digits.')
  }
  // Before reading anything: a mistyped digit in the ID groups would otherwise ask the DCL
  // about somebody else's product, and answer with its name as if it were this one.
  if (!verhoeffValid(digits)) throw malformed('The check digit does not match.')

  const first = Number(digits.charAt(0))
  if ((first & 0b1000) !== 0) throw malformed('A leading 8 or 9 is a format this does not know.')

  const hasIds = (first & 0b100) !== 0
  if (hasIds !== (digits.length === LONG_MANUAL)) {
    throw malformed('The leading digit contradicts the length.')
  }
  if (!hasIds) throw new CodeError('no-ids', 'This code carries no vendor or product ID.')

  const vendorId = Number(digits.slice(10, 15))
  const productId = Number(digits.slice(15, 20))
  if (vendorId > 0xffff || productId > 0xffff) throw malformed('An ID is out of range.')
  return { vendorId, productId }
}

/** Whether the last digit is the Verhoeff check digit of the rest. */
function verhoeffValid(digits: string): boolean {
  let check = 0
  for (let index = 0; index < digits.length; index += 1) {
    const digit = digits.charCodeAt(digits.length - 1 - index) - 48
    const permuted = PERMUTE[index % 8]?.[digit] ?? 0
    check = MULTIPLY[check]?.[permuted] ?? 0
  }
  return check === 0
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix backend exec -- vitest run test/catalog/decode.test.ts`
Expected: PASS, 29 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `npm --prefix backend run check && npm --prefix backend run typecheck`
Expected: exit 0, no warnings.

- [ ] **Step 6: Commit**

```bash
git add backend/src/catalog/decode.ts backend/test/catalog/decode.test.ts
git commit -m "$(cat <<'EOF'
feat(catalog): decode a setup code to its vendor and product IDs

The backend's own decoder (ADR 0017), tested on the frontend's reference
vectors plus a real-vendor pair. QR payloads and 21-digit manual codes;
the 11-digit code is "no-ids". No error message carries the code.

Refs #226

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B3: The DCL client and its recorded responses

**Files:**
- Create: `backend/src/catalog/dcl.ts`
- Create: `backend/test/support/dcl.ts`
- Test: `backend/test/catalog/dcl.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `dclClient(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = DCL_TIMEOUT_MS): DclClient`
  - `interface DclClient { readonly network: DclNetwork; vendor(vid: number): Promise<DclVendor | 'missing'>; model(vid: number, pid: number): Promise<DclModel | 'missing'> }`
  - `class DclUnavailable extends Error`
  - `type DclNetwork = 'mainnet' | 'testnet' | 'other'`, and `networkOf(baseUrl: string): DclNetwork`
  - `MAINNET_URL = 'https://on.dcl.csa-iot.org/dcl'`, `TESTNET_URL`, `DCL_TIMEOUT_MS = 5000`
  - `interface DclVendor { vendorID: number; vendorName: string; companyLegalName?; companyPreferredName?; vendorLandingPageURL?; [field: string]: unknown }`
  - `interface DclModel { vid: number; pid: number; productName: string; [field: string]: unknown }`
  - Test support: `AQARA_VENDOR`, `AQARA_MODEL`, `DCL_NOT_FOUND`, `AQARA_ROUTES`,
    `fakeDcl(routes): { requests: string[]; fetch: typeof fetch }`, `type Recorded`

- [ ] **Step 1: Write the recorded responses**

Create `backend/test/support/dcl.ts`:

```ts
/**
 * The DCL, as recorded from the live MainNet API on 2026-10-05, and a fake `fetch` that answers
 * with it.
 *
 * Recorded rather than invented, so the mapping is tested against the shape the ledger really
 * sends — including its habit of `""` and `0` for "not set". `creator` is shortened; nothing
 * reads it, and the store drops it.
 *
 * @module
 */

/** `GET /vendorinfo/vendors/4447`. */
export const AQARA_VENDOR = {
  vendorInfo: {
    vendorID: 4447,
    vendorName: 'Aqara',
    companyLegalName: 'Lumi United Technology Co., Ltd.',
    companyPreferredName: '',
    vendorLandingPageURL: 'https://www.aqara.com/',
    creator: 'cosmos1qpz3',
    schemaVersion: 0,
  },
}

/** `GET /model/models/4447/8194`. */
export const AQARA_MODEL = {
  model: {
    vid: 4447,
    pid: 8194,
    deviceTypeId: 21,
    productName: 'Aqara Door and Window Sensor P2',
    productLabel: 'Aqara Door and Window Sensor P2',
    partNumber: 'AS056',
    commissioningCustomFlow: 0,
    commissioningCustomFlowUrl: '',
    commissioningModeInitialStepsHint: 0,
    commissioningModeInitialStepsInstruction:
      '1. Please make sure you have the Matter-compatible app',
    commissioningModeSecondaryStepsHint: 0,
    commissioningModeSecondaryStepsInstruction: '',
    userManualUrl: '',
    supportUrl: '',
    productUrl: 'https://www.aqara.com/en/products.html',
    lsfUrl: 'https://www.aqara.com/en/products.html',
    lsfRevision: 2,
    creator: 'cosmos1',
    schemaVersion: 0,
    enhancedSetupFlowOptions: 0,
    maintenanceUrl: '',
    discoveryCapabilitiesBitmask: 0,
    commissioningFallbackUrl: '',
    factoryResetStepsHint: 0,
    factoryResetStepsInstruction: '',
  },
}

/** The DCL's not-found body, served with HTTP 404. */
export const DCL_NOT_FOUND = { code: 5, message: 'not found', details: [] }

/** One recorded answer: a status and a body, JSON unless it is a string. */
export interface Recorded {
  readonly status: number
  readonly body: unknown
}

/** A fake DCL: the URLs it was asked for, and the `fetch` to inject. */
export interface FakeDcl {
  readonly requests: string[]
  readonly fetch: typeof fetch
}

/**
 * A `fetch` answering from `routes`, keyed by path below the base URL (`/vendorinfo/vendors/4447`).
 *
 * An unknown path answers the DCL's real 404, which is what the ledger does for an ID nobody
 * registered. A route set to an `Error` rejects with it, the way `fetch` does when the network
 * is down.
 */
export function fakeDcl(routes: Readonly<Record<string, Recorded | Error>> = {}): FakeDcl {
  const requests: string[] = []
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const path = url.pathname.replace(/^\/dcl/, '')
    requests.push(path)
    const answer = routes[path] ?? { status: 404, body: DCL_NOT_FOUND }
    if (answer instanceof Error) throw answer
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
    return new Response(text, { status: answer.status })
  }
  return { requests, fetch: fakeFetch as typeof fetch }
}

/** The Aqara vendor and model, as the DCL answers them. */
export const AQARA_ROUTES: Readonly<Record<string, Recorded>> = {
  '/vendorinfo/vendors/4447': { status: 200, body: AQARA_VENDOR },
  '/model/models/4447/8194': { status: 200, body: AQARA_MODEL },
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/test/catalog/dcl.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DclUnavailable,
  dclClient,
  MAINNET_URL,
  networkOf,
  TESTNET_URL,
} from '../../src/catalog/dcl.js'
import { AQARA_MODEL, AQARA_ROUTES, AQARA_VENDOR, DCL_NOT_FOUND, fakeDcl } from '../support/dcl.js'

describe('dclClient reading the ledger', () => {
  it('returns the recorded Aqara vendor record as the DCL sent it', async () => {
    const dcl = fakeDcl(AQARA_ROUTES)
    expect(await dclClient(MAINNET_URL, dcl.fetch).vendor(4447)).toEqual(AQARA_VENDOR.vendorInfo)
  })

  it('returns the recorded Aqara model record as the DCL sent it', async () => {
    const dcl = fakeDcl(AQARA_ROUTES)
    expect(await dclClient(MAINNET_URL, dcl.fetch).model(4447, 8194)).toEqual(AQARA_MODEL.model)
  })

  it('asks by decimal IDs, under the base URL, and nothing else', async () => {
    // The only thing the DCL ever learns is these two numbers (ADR 0019).
    const dcl = fakeDcl(AQARA_ROUTES)
    const client = dclClient(`${MAINNET_URL}/`, dcl.fetch)
    await client.vendor(0x115f)
    await client.model(0x115f, 0x2002)
    expect(dcl.requests).toEqual(['/vendorinfo/vendors/4447', '/model/models/4447/8194'])
  })

  it("answers 'missing' for the DCL's real 404", async () => {
    const client = dclClient(MAINNET_URL, fakeDcl().fetch)
    expect(await client.vendor(4999)).toBe('missing')
    expect(await client.model(4447, 9999)).toBe('missing')
  })
})

describe('dclClient when the ledger cannot answer', () => {
  /** The rejection of one vendor read against these routes. */
  const vendorFailure = (routes: Parameters<typeof fakeDcl>[0], timeoutMs?: number) =>
    dclClient(MAINNET_URL, fakeDcl(routes).fetch, timeoutMs).vendor(4447)

  it('throws DclUnavailable when the network is down', async () => {
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': new TypeError('fetch failed') }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a 5xx that is not JSON', async () => {
    await expect(
      vendorFailure({
        '/vendorinfo/vendors/4447': { status: 502, body: '<html>Bad gateway</html>' },
      }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a 5xx that is JSON', async () => {
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': { status: 503, body: { code: 14 } } }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a 404 that is not the DCL talking', async () => {
    // A proxy's 404, or a mistyped DCL_BASE_URL. Read as a miss, it would be cached for a day
    // and every device would come back "unknown" while the ledger is fine.
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': { status: 404, body: '<html>nope</html>' } }),
    ).rejects.toBeInstanceOf(DclUnavailable)
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': { status: 404, body: { message: 'no route' } } }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a 200 that is not a vendor', async () => {
    for (const body of [{}, { vendorInfo: null }, { vendorInfo: { vendorID: '4447' } }, []]) {
      await expect(
        vendorFailure({ '/vendorinfo/vendors/4447': { status: 200, body } }),
      ).rejects.toBeInstanceOf(DclUnavailable)
    }
  })

  it('throws DclUnavailable for a 200 that is not a model', async () => {
    const client = dclClient(
      MAINNET_URL,
      fakeDcl({ '/model/models/4447/8194': { status: 200, body: { model: { vid: 4447 } } } }).fetch,
    )
    await expect(client.model(4447, 8194)).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a body far larger than any record', async () => {
    const huge = { vendorInfo: { ...AQARA_VENDOR.vendorInfo, padding: 'x'.repeat(300 * 1024) } }
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': { status: 200, body: huge } }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable when the DCL does not answer in time', async () => {
    // A fetch that only ever ends by being aborted, which is what the timeout signal does.
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof fetch
    await expect(dclClient(MAINNET_URL, hanging, 20).vendor(4447)).rejects.toBeInstanceOf(
      DclUnavailable,
    )
  })

  it('never puts the response body into the error message', async () => {
    const error: unknown = await vendorFailure({
      '/vendorinfo/vendors/4447': { status: 500, body: 'secret-ish upstream text' },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(DclUnavailable)
    expect((error as Error).message).not.toContain('secret-ish')
  })

  it('still treats the real not-found body as a miss, not an outage', async () => {
    expect(
      await vendorFailure({ '/vendorinfo/vendors/4447': { status: 404, body: DCL_NOT_FOUND } }),
    ).toBe('missing')
  })
})

describe('networkOf', () => {
  it.each([
    [MAINNET_URL, 'mainnet'],
    [`${MAINNET_URL}/`, 'mainnet'],
    [TESTNET_URL, 'testnet'],
    ['https://dcl.example.test/dcl', 'other'],
  ])('reads %s as %s', (url, network) => {
    expect(networkOf(url)).toBe(network)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm --prefix backend exec -- vitest run test/catalog/dcl.test.ts`
Expected: FAIL. The file cannot import `../../src/catalog/dcl.js`.

- [ ] **Step 4: Write the client**

Create `backend/src/catalog/dcl.ts`:

```ts
/**
 * The CSA's Distributed Compliance Ledger, as far as this service asks it anything.
 *
 * Two reads, both unauthenticated: a vendor by ID, and a model by vendor and product ID. **Only
 * those IDs are ever sent** — the DCL is a third party, and the rule that a payload never goes to
 * one still holds for it (ADR 0019). Nothing in this module can see a setup code: its inputs are
 * numbers.
 *
 * Native `fetch`, injected so tests answer as the DCL without reaching it (ADR 0013), and a
 * five-second timeout, because a lookup is on the path of somebody adding a device.
 *
 * @module
 */

/** MainNet, the ledger production devices are certified on. */
export const MAINNET_URL = 'https://on.dcl.csa-iot.org/dcl'
/** TestNet, for trying a deployment against records nobody relies on. */
export const TESTNET_URL = 'https://on.test-net.dcl.csa-iot.org/dcl'

/** Which ledger a cached record came from, so a switch of `DCL_BASE_URL` is visible in the data. */
export type DclNetwork = 'mainnet' | 'testnet' | 'other'

/** How long one DCL request may take, including its body, before it counts as unreachable. */
export const DCL_TIMEOUT_MS = 5000

/**
 * The largest DCL response body this service reads.
 *
 * A vendor or model record is about a kilobyte. The DCL is a third party, and an answer a
 * thousand times larger than any real one is not a record worth parsing.
 */
const MAX_BODY_CHARS = 256 * 1024

/** A vendor record as the DCL holds it. Kept raw; `policy.ts` decides what the API exposes. */
export interface DclVendor {
  readonly vendorID: number
  readonly vendorName: string
  readonly companyLegalName?: string
  readonly companyPreferredName?: string
  readonly vendorLandingPageURL?: string
  readonly [field: string]: unknown
}

/** A model record as the DCL holds it. Kept raw, for the reason {@link DclVendor} is. */
export interface DclModel {
  readonly vid: number
  readonly pid: number
  readonly productName: string
  readonly [field: string]: unknown
}

/** The DCL could not give an answer: unreachable, slow, failing, or answering nonsense. */
export class DclUnavailable extends Error {
  override readonly name = 'DclUnavailable'
}

/** The two reads. A 404 is an answer — `'missing'` — and anything else unusable throws. */
export interface DclClient {
  /** Which ledger this client reads, recorded on every cached entry. */
  readonly network: DclNetwork
  vendor(vid: number): Promise<DclVendor | 'missing'>
  model(vid: number, pid: number): Promise<DclModel | 'missing'>
}

/** Which ledger a base URL points at. */
export function networkOf(baseUrl: string): DclNetwork {
  const base = baseUrl.replace(/\/+$/, '')
  if (base === MAINNET_URL) return 'mainnet'
  if (base === TESTNET_URL) return 'testnet'
  return 'other'
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Builds the client.
 *
 * @param baseUrl the DCL REST base, e.g. {@link MAINNET_URL}; a trailing slash is tolerated.
 * @param fetchImpl injected so tests drive it without the network.
 * @param timeoutMs injected so the timeout test does not wait five seconds.
 */
export function dclClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DCL_TIMEOUT_MS,
): DclClient {
  const base = baseUrl.replace(/\/+$/, '')

  /**
   * One GET, and its JSON body; `'missing'` for the DCL's own "not found".
   *
   * Every failure becomes {@link DclUnavailable} with a message naming the path and status and
   * **never the body**: it is a third party's text, and the route decides between a stale entry
   * and a 503 on the class alone.
   */
  async function get(path: string): Promise<unknown> {
    let status: number
    let text: string
    try {
      // One signal for the request *and* the body: a server that sends headers promptly and
      // then trickles the body is as unreachable as one that never answers.
      const response = await fetchImpl(`${base}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = response.status
      if (Number(response.headers.get('content-length') ?? '0') > MAX_BODY_CHARS) {
        throw new DclUnavailable(`DCL ${path}: body too large`)
      }
      text = await response.text()
    } catch (error) {
      if (error instanceof DclUnavailable) throw error
      throw new DclUnavailable(`DCL ${path}: unreachable`, { cause: error })
    }
    if (text.length > MAX_BODY_CHARS) throw new DclUnavailable(`DCL ${path}: body too large`)

    let body: unknown
    try {
      body = JSON.parse(text) as unknown
    } catch {
      throw new DclUnavailable(`DCL ${path}: answered ${status} with something that is not JSON`)
    }

    // **Only the DCL's own not-found is a miss**: a 404 carrying `code: 5`. A 404 from anything
    // else — a proxy, a mistyped `DCL_BASE_URL` — would otherwise cache every product in the
    // world as missing for a day, and answer "unknown device" while the ledger is fine.
    if (status === 404 && isObject(body) && body.code === 5) return 'missing'
    if (status !== 200) throw new DclUnavailable(`DCL ${path}: answered ${status}`)
    return body
  }

  return {
    network: networkOf(base),

    async vendor(vid: number): Promise<DclVendor | 'missing'> {
      const path = `/vendorinfo/vendors/${vid}`
      const body = await get(path)
      if (body === 'missing') return 'missing'
      const record = isObject(body) ? body.vendorInfo : undefined
      // A 200 that does not hold a vendor is a ledger answering something else, not a vendor
      // with no name. Treated as an outage, so a cached entry is served rather than overwritten.
      if (
        !isObject(record) ||
        typeof record.vendorID !== 'number' ||
        typeof record.vendorName !== 'string'
      ) {
        throw new DclUnavailable(`DCL ${path}: answered an unexpected shape`)
      }
      return record as DclVendor
    },

    async model(vid: number, pid: number): Promise<DclModel | 'missing'> {
      const path = `/model/models/${vid}/${pid}`
      const body = await get(path)
      if (body === 'missing') return 'missing'
      const record = isObject(body) ? body.model : undefined
      if (
        !isObject(record) ||
        typeof record.vid !== 'number' ||
        typeof record.pid !== 'number' ||
        typeof record.productName !== 'string'
      ) {
        throw new DclUnavailable(`DCL ${path}: answered an unexpected shape`)
      }
      return record as DclModel
    },
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm --prefix backend exec -- vitest run test/catalog/dcl.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 6: Lint and typecheck**

Run: `npm --prefix backend run check && npm --prefix backend run typecheck`
Expected: exit 0, no warnings.

- [ ] **Step 7: Commit**

```bash
git add backend/src/catalog/dcl.ts backend/test/support/dcl.ts backend/test/catalog/dcl.test.ts
git commit -m "$(cat <<'EOF'
feat(catalog): DCL client for vendor and model records

Native fetch with a 5 s timeout covering the body. Only the DCL's own 404
(code 5) is a miss; a 5xx, non-JSON, an unexpected 200 shape, an oversized
body or a foreign 404 is DclUnavailable. Tested on recorded MainNet answers.

Refs #226

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B4: The `matter_catalog` store

**Files:**
- Create: `backend/src/catalog/store.ts`
- Test: `backend/test/catalog/store.test.ts`

**Interfaces:**
- Consumes (B3): `DclVendor`, `DclModel` and `DclNetwork` from `./dcl.js`.
- Consumes (existing): `CouchClient`, `CouchError` and `Revision` from `../couch/client.js`;
  `installDesign` and `once` from `../couch/design.js`.
- Produces:
  - Constants: `CATALOG_DB = 'matter_catalog'`, `CATALOG_DESIGN = 'catalog'`,
    `BY_FETCHED_VIEW = 'by_fetched'`.
  - Types: `EntryStatus = 'found' | 'missing'`; `VendorEntry` (`_id`, `_rev?`,
    `type: 'vendor'`, `vid`, `status`, `fetchedAt`, `network`, `dcl?: DclVendor`);
    `ModelEntry` (the same fields plus `pid`, with `dcl?: DclModel`);
    `CatalogEntry = VendorEntry | ModelEntry`.
  - ID helpers: `vendorEntryId(vid)` and `modelEntryId(vid, pid)`.
  - `withoutCreator<T>(record: T): T`.
  - Setup: `ensureCatalogDatabase(couch): Promise<void>`, `forgetCatalogDatabase(): void`.
  - Access: `catalogStore(couch): CatalogStore`, with `readVendor`, `readModel` and `write`.
    `write` ignores a 409.

- [ ] **Step 1: Write the failing test**

Create `backend/test/catalog/store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BY_FETCHED_VIEW,
  CATALOG_DB,
  CATALOG_DESIGN,
  catalogStore,
  ensureCatalogDatabase,
  forgetCatalogDatabase,
  type VendorEntry,
  withoutCreator,
} from '../../src/catalog/store.js'
import { fakeCouch, operations } from '../support/couch.js'
import { AQARA_VENDOR } from '../support/dcl.js'

beforeEach(() => forgetCatalogDatabase())

/** A found Aqara vendor entry, as the lookup writes one. */
const aqara = (fields: Partial<VendorEntry> = {}): VendorEntry => ({
  _id: 'vendor:4447',
  type: 'vendor',
  vid: 4447,
  status: 'found',
  fetchedAt: '2026-10-05T16:20:00.000Z',
  network: 'mainnet',
  dcl: withoutCreator(AQARA_VENDOR.vendorInfo),
  ...fields,
})

describe('ensureCatalogDatabase', () => {
  it('creates the database and makes it admin-only before installing anything', async () => {
    const fake = fakeCouch()
    await ensureCatalogDatabase(fake.couch)

    expect(operations(fake).slice(0, 2)).toEqual(['createDb', 'putSecurity'])
    expect(fake.security.get(CATALOG_DB)).toEqual({
      admins: { names: [], roles: ['_admin'] },
      members: { names: [], roles: ['_admin'] },
    })
  })

  it('installs the by_fetched view', async () => {
    const fake = fakeCouch()
    await ensureCatalogDatabase(fake.couch)

    const design = fake.documents.get(`${CATALOG_DB}/_design/${CATALOG_DESIGN}`) as
      | { views: Record<string, { map: string }> }
      | undefined
    expect(design?.views[BY_FETCHED_VIEW]?.map).toContain('emit(doc.fetchedAt')
  })

  it('does the work once per process, even when two lookups arrive together', async () => {
    const fake = fakeCouch()
    await Promise.all([ensureCatalogDatabase(fake.couch), ensureCatalogDatabase(fake.couch)])
    const after = fake.calls.length
    await ensureCatalogDatabase(fake.couch)

    expect(operations(fake).filter((operation) => operation === 'createDb')).toHaveLength(1)
    expect(fake.calls.length).toBe(after)
  })

  it('is not bothered by a database another process already created', async () => {
    const fake = fakeCouch({ databases: [CATALOG_DB] })
    await expect(ensureCatalogDatabase(fake.couch)).resolves.toBeUndefined()
  })
})

describe('catalogStore', () => {
  it('writes an entry under its decimal ID and reads it back', async () => {
    const fake = fakeCouch()
    const store = catalogStore(fake.couch)
    await store.write(aqara())

    expect(await store.readVendor(4447)).toMatchObject({ _id: 'vendor:4447', status: 'found' })
    expect(await store.readVendor(4448)).toBeUndefined()
  })

  it('reads model entries by vendor and product', async () => {
    const fake = fakeCouch({
      seed: {
        [`${CATALOG_DB}/model:4447:8194`]: { _id: 'model:4447:8194', _rev: '1-a', type: 'model' },
      },
    })
    expect(await catalogStore(fake.couch).readModel(4447, 8194)).toMatchObject({ type: 'model' })
  })

  it('ignores a conflict: another request stored the same answer first', async () => {
    const fake = fakeCouch({
      seed: { [`${CATALOG_DB}/vendor:4447`]: { ...aqara(), _rev: '1-a' } },
    })
    // No `_rev`: this writer read before the other one wrote.
    await expect(catalogStore(fake.couch).write(aqara())).resolves.toBeUndefined()
  })

  it('throws any other write failure', async () => {
    // Setup is remembered per process, so running it against a healthy CouchDB first means the
    // failure below is the entry's write and not the design document's.
    await ensureCatalogDatabase(fakeCouch().couch)
    const fake = fakeCouch({ fails: { putDoc: CATALOG_DB } })
    await expect(catalogStore(fake.couch).write(aqara())).rejects.toThrow('write vendor:4447')
  })

  it('drops the ledger account from the stored record', () => {
    expect(withoutCreator(AQARA_VENDOR.vendorInfo)).not.toHaveProperty('creator')
    expect(withoutCreator(AQARA_VENDOR.vendorInfo)).toHaveProperty('vendorName', 'Aqara')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix backend exec -- vitest run test/catalog/store.test.ts`
Expected: FAIL. The file cannot import `../../src/catalog/store.js`.

- [ ] **Step 3: Write the store**

Create `backend/src/catalog/store.ts`:

```ts
/**
 * The `matter_catalog` database: what the DCL said about each vendor and model, and when.
 *
 * A cache, not a source of truth — every document can be fetched again from the DCL — so it is
 * created on the first lookup rather than at startup. It is **admin-only** like `matter_manager`:
 * nothing in it is secret, but a browser has no reason to read it, and a database the browser
 * cannot reach is one nobody has to reason about (SECURITY-MODEL.md).
 *
 * Each document keeps the DCL record **raw**, minus `creator`, so a field the app starts using
 * later needs no re-fetch. IDs are decimal, as the DCL's own paths are.
 *
 * @module
 */

import { type CouchClient, CouchError, type Revision } from '../couch/client.js'
import { installDesign, once } from '../couch/design.js'
import type { DclModel, DclNetwork, DclVendor } from './dcl.js'

/** The database the catalogue lives in. */
export const CATALOG_DB = 'matter_catalog'
/** The design document holding {@link BY_FETCHED_VIEW}. */
export const CATALOG_DESIGN = 'catalog'
/** Entries by `fetchedAt`, for the future "refresh all" (issue 6). Costs nothing until then. */
export const BY_FETCHED_VIEW = 'by_fetched'

const BY_FETCHED_MAP = `function (doc) {
  if (doc.fetchedAt) {
    emit(doc.fetchedAt, null)
  }
}`

/** Whether the DCL had the record when it was asked. */
export type EntryStatus = 'found' | 'missing'

/** Common to vendor and model entries. */
interface EntryBase extends Revision {
  readonly status: EntryStatus
  /** ISO 8601, when the DCL was asked. Freshness is measured from here. */
  readonly fetchedAt: string
  readonly network: DclNetwork
}

/** `vendor:{vid}`. `dcl` is present exactly when `status` is `found`. */
export interface VendorEntry extends EntryBase {
  readonly type: 'vendor'
  readonly vid: number
  readonly dcl?: DclVendor
}

/** `model:{vid}:{pid}`. `dcl` is present exactly when `status` is `found`. */
export interface ModelEntry extends EntryBase {
  readonly type: 'model'
  readonly vid: number
  readonly pid: number
  readonly dcl?: DclModel
}

/** Either kind of entry. */
export type CatalogEntry = VendorEntry | ModelEntry

/** The document ID of a vendor entry. Decimal, like the DCL path. */
export const vendorEntryId = (vid: number): string => `vendor:${vid}`
/** The document ID of a model entry. */
export const modelEntryId = (vid: number, pid: number): string => `model:${vid}:${pid}`

/**
 * The DCL record without `creator`.
 *
 * `creator` is the ledger account that wrote the record. It is not about the product, nothing
 * here reads it, and keeping it would put a third party's account identifiers into our backups.
 *
 * Returns `T` rather than `Omit<T, 'creator'>`: the record types carry an index signature, and
 * `Omit` over one erases every named field along with the one it removes.
 */
export function withoutCreator<T extends { readonly [field: string]: unknown }>(record: T): T {
  const { creator: _creator, ...rest } = record
  return rest as T
}

const setup = once(async (couch: CouchClient) => {
  await couch.createDb(CATALOG_DB)
  // Immediately after creation, before the view, for the reason `users/database.ts` gives: until
  // it lands, the database is open to every account in the deployment.
  await couch.putSecurity(CATALOG_DB, {
    admins: { names: [], roles: ['_admin'] },
    members: { names: [], roles: ['_admin'] },
  })
  await installDesign(couch, CATALOG_DB, `_design/${CATALOG_DESIGN}`, {
    [BY_FETCHED_VIEW]: { map: BY_FETCHED_MAP },
  })
})

/** Creates `matter_catalog` if needed, locks it down, and installs its view. Once per process. */
export function ensureCatalogDatabase(couch: CouchClient): Promise<void> {
  return setup.ensure(couch)
}

/** Forgets that setup ran. For tests that use a fresh fake CouchDB each time. */
export function forgetCatalogDatabase(): void {
  setup.forget()
}

/** Reading and writing entries. Every call ensures the database first. */
export interface CatalogStore {
  readVendor(vid: number): Promise<VendorEntry | undefined>
  readModel(vid: number, pid: number): Promise<ModelEntry | undefined>
  /**
   * Stores an entry; carry the `_rev` of the entry it replaces.
   *
   * A 409 is ignored: another request stored the same answer first, which is the ordinary race
   * of two people adding the same product at once. Anything else throws.
   */
  write(entry: CatalogEntry): Promise<void>
}

/** The store, over the service's CouchDB client. */
export function catalogStore(couch: CouchClient): CatalogStore {
  return {
    async readVendor(vid) {
      await ensureCatalogDatabase(couch)
      return couch.getDoc<VendorEntry>(CATALOG_DB, vendorEntryId(vid))
    },

    async readModel(vid, pid) {
      await ensureCatalogDatabase(couch)
      return couch.getDoc<ModelEntry>(CATALOG_DB, modelEntryId(vid, pid))
    },

    async write(entry) {
      await ensureCatalogDatabase(couch)
      try {
        await couch.putDoc(CATALOG_DB, entry)
      } catch (error) {
        // The other writer fetched the same record from the same ledger within the same few
        // seconds. Its copy is as good as ours, and the response uses what we fetched anyway.
        if (error instanceof CouchError && error.status === 409) return
        throw error
      }
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix backend exec -- vitest run test/catalog/store.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `npm --prefix backend run check && npm --prefix backend run typecheck`
Expected: exit 0, no warnings.

- [ ] **Step 6: Commit**

```bash
git add backend/src/catalog/store.ts backend/test/catalog/store.test.ts
git commit -m "$(cat <<'EOF'
feat(catalog): admin-only matter_catalog cache, created on first use

Lazy, once per process like matter_manager; _security before the by_fetched
view. Entries keep the raw DCL record minus creator. A write conflict from a
racing request is ignored.

Refs #226

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B5: The catalogue policy

**Files:**
- Create: `backend/src/catalog/policy.ts`
- Test: `backend/test/catalog/policy.test.ts`

**Interfaces:**
- Consumes (B4): the `VendorEntry` and `ModelEntry` types, and `withoutCreator` in the test.
- Consumes (B3 test support): `AQARA_VENDOR` and `AQARA_MODEL`.
- Produces:
  - `FOUND_TTL_MS` (90 days) and `MISSING_TTL_MS` (1 day).
  - `isFresh(entry: { status; fetchedAt }, now: Date): boolean`. An entry is fresh up to and
    including the TTL; an unparseable date counts as stale.
  - `isTestVendor(vendorId: number): boolean` (0xFFF1–0xFFF4).
  - `text(value: unknown): string | null` and `count(value: unknown): number | null`, the DCL's
    "not set" mapping.
  - `interface CatalogLookup`: the contract shape, field for field.
  - `testVendorLookup(vendorId, productId, now: Date): CatalogLookup`.
  - `toLookup({ vendor: VendorEntry; model: ModelEntry; stale: boolean }): CatalogLookup`.
    `source` is `dcl` only when both entries were found, and `fetchedAt` is the older of the two.

- [ ] **Step 1: Write the failing test**

Create `backend/test/catalog/policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  count,
  FOUND_TTL_MS,
  isFresh,
  isTestVendor,
  MISSING_TTL_MS,
  testVendorLookup,
  text,
  toLookup,
} from '../../src/catalog/policy.js'
import { type ModelEntry, type VendorEntry, withoutCreator } from '../../src/catalog/store.js'
import { AQARA_MODEL, AQARA_VENDOR } from '../support/dcl.js'

const FETCHED = '2026-10-05T16:20:00.000Z'
const at = (offsetMs: number): Date => new Date(Date.parse(FETCHED) + offsetMs)

const vendorFound: VendorEntry = {
  _id: 'vendor:4447',
  type: 'vendor',
  vid: 4447,
  status: 'found',
  fetchedAt: FETCHED,
  network: 'mainnet',
  dcl: withoutCreator(AQARA_VENDOR.vendorInfo),
}
const modelFound: ModelEntry = {
  _id: 'model:4447:8194',
  type: 'model',
  vid: 4447,
  pid: 8194,
  status: 'found',
  fetchedAt: FETCHED,
  network: 'mainnet',
  dcl: withoutCreator(AQARA_MODEL.model),
}
const vendorMissing: VendorEntry = {
  _id: 'vendor:4447',
  type: 'vendor',
  vid: 4447,
  status: 'missing',
  fetchedAt: FETCHED,
  network: 'mainnet',
}
const modelMissing: ModelEntry = {
  _id: 'model:4447:8194',
  type: 'model',
  vid: 4447,
  pid: 8194,
  status: 'missing',
  fetchedAt: FETCHED,
  network: 'mainnet',
}

describe('isFresh', () => {
  const found = { status: 'found', fetchedAt: FETCHED } as const
  const missing = { status: 'missing', fetchedAt: FETCHED } as const

  it('keeps a found entry for 90 days', () => {
    expect(FOUND_TTL_MS).toBe(90 * 86_400_000)
    expect(isFresh(found, at(FOUND_TTL_MS))).toBe(true)
  })

  it('refreshes a found entry at 90 days and one second', () => {
    expect(isFresh(found, at(FOUND_TTL_MS + 1000))).toBe(false)
  })

  it('retries a miss after one day', () => {
    expect(MISSING_TTL_MS).toBe(86_400_000)
    expect(isFresh(missing, at(MISSING_TTL_MS))).toBe(true)
    expect(isFresh(missing, at(MISSING_TTL_MS + 1000))).toBe(false)
  })

  it('treats an unreadable fetchedAt as stale, so a damaged entry is replaced', () => {
    expect(isFresh({ status: 'found', fetchedAt: 'yesterday' }, at(0))).toBe(false)
  })
})

describe('isTestVendor', () => {
  it.each([
    [0xfff0, false],
    [0xfff1, true],
    [0xfff2, true],
    [0xfff3, true],
    [0xfff4, true],
    [0xfff5, false],
    [4447, false],
  ])('vendor %i is a test vendor: %s', (vendorId, expected) => {
    expect(isTestVendor(vendorId)).toBe(expected)
  })
})

describe("the DCL's 'not set'", () => {
  it.each([
    ['', null],
    [undefined, null],
    [42, null],
    ['AS056', 'AS056'],
  ])('reads text %j as %j', (value, expected) => {
    expect(text(value)).toBe(expected)
  })

  it.each([
    [0, null],
    [undefined, null],
    ['21', null],
    [21, 21],
  ])('reads a number %j as %j', (value, expected) => {
    expect(count(value)).toBe(expected)
  })
})

describe('toLookup', () => {
  it('maps the recorded Aqara answer, turning every empty value into null', () => {
    expect(toLookup({ vendor: vendorFound, model: modelFound, stale: false })).toEqual({
      vendorId: 4447,
      productId: 8194,
      source: 'dcl',
      vendor: {
        name: 'Aqara',
        preferredName: null,
        legalName: 'Lumi United Technology Co., Ltd.',
        landingPageUrl: 'https://www.aqara.com/',
      },
      product: {
        name: 'Aqara Door and Window Sensor P2',
        label: 'Aqara Door and Window Sensor P2',
        partNumber: 'AS056',
        deviceTypeId: 21,
        productUrl: 'https://www.aqara.com/en/products.html',
        supportUrl: null,
        userManualUrl: null,
        commissioningCustomFlow: 0,
        commissioningCustomFlowUrl: null,
        commissioningInstructions: '1. Please make sure you have the Matter-compatible app',
        factoryResetInstructions: null,
      },
      fetchedAt: FETCHED,
      stale: false,
    })
  })

  it('answers missing with the vendor kept when only the model is missing', () => {
    const lookup = toLookup({ vendor: vendorFound, model: modelMissing, stale: false })
    expect(lookup.source).toBe('missing')
    expect(lookup.vendor?.name).toBe('Aqara')
    expect(lookup.product).toBeNull()
  })

  it('answers missing with both halves null when neither is in the ledger', () => {
    const lookup = toLookup({ vendor: vendorMissing, model: modelMissing, stale: false })
    expect(lookup).toMatchObject({ source: 'missing', vendor: null, product: null })
  })

  it('reports the older fetchedAt of the two, and passes stale through', () => {
    const older = { ...modelFound, fetchedAt: '2026-07-01T00:00:00.000Z' }
    const lookup = toLookup({ vendor: vendorFound, model: older, stale: true })
    expect(lookup.fetchedAt).toBe('2026-07-01T00:00:00.000Z')
    expect(lookup.stale).toBe(true)
  })
})

describe('testVendorLookup', () => {
  it('names the test vendor and no product', () => {
    expect(testVendorLookup(0xfff1, 0x8000, at(0))).toEqual({
      vendorId: 0xfff1,
      productId: 0x8000,
      source: 'test-vendor',
      vendor: { name: 'Test vendor', preferredName: null, legalName: null, landingPageUrl: null },
      product: null,
      fetchedAt: FETCHED,
      stale: false,
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix backend exec -- vitest run test/catalog/policy.test.ts`
Expected: FAIL. The file cannot import `../../src/catalog/policy.js`.

- [ ] **Step 3: Write the policy**

Create `backend/src/catalog/policy.ts`:

```ts
/**
 * What the catalogue answers, decided without I/O: when a cached entry is still good, which
 * vendor IDs never reach the DCL, and how a DCL record becomes the API's response.
 *
 * Pure, so the rules the spec states in days and in "empty means null" are tested as rules
 * rather than through a fake HTTP round trip.
 *
 * @module
 */

import type { ModelEntry, VendorEntry } from './store.js'

/** A found entry is refreshed after 90 days: product records change rarely, and slowly. */
export const FOUND_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** A miss is retried after a day: a product is often certified after it ships. */
export const MISSING_TTL_MS = 24 * 60 * 60 * 1000

/** The test vendor IDs, 0xFFF1–0xFFF4. Verified absent from MainNet and TestNet. */
const TEST_VENDOR_FIRST = 0xfff1
const TEST_VENDOR_LAST = 0xfff4

/** What the API answers, field for field the contract's `CatalogLookup` schema. */
export interface CatalogLookup {
  readonly vendorId: number
  readonly productId: number
  readonly source: 'dcl' | 'test-vendor' | 'missing'
  readonly vendor: {
    readonly name: string
    readonly preferredName: string | null
    readonly legalName: string | null
    readonly landingPageUrl: string | null
  } | null
  readonly product: {
    readonly name: string
    readonly label: string | null
    readonly partNumber: string | null
    readonly deviceTypeId: number | null
    readonly productUrl: string | null
    readonly supportUrl: string | null
    readonly userManualUrl: string | null
    readonly commissioningCustomFlow: number
    readonly commissioningCustomFlowUrl: string | null
    readonly commissioningInstructions: string | null
    readonly factoryResetInstructions: string | null
  } | null
  readonly fetchedAt: string
  readonly stale: boolean
}

/** Whether a vendor ID is one of the four the specification reserves for testing. */
export function isTestVendor(vendorId: number): boolean {
  return vendorId >= TEST_VENDOR_FIRST && vendorId <= TEST_VENDOR_LAST
}

/**
 * Whether a cached entry may be served without asking the DCL again.
 *
 * Fresh **up to and including** the boundary: an entry is stale from one millisecond past it.
 * An unparseable `fetchedAt` is stale, so a damaged entry is replaced rather than kept forever.
 */
export function isFresh(
  entry: { readonly status: 'found' | 'missing'; readonly fetchedAt: string },
  now: Date,
): boolean {
  const fetched = Date.parse(entry.fetchedAt)
  if (Number.isNaN(fetched)) return false
  const ttl = entry.status === 'found' ? FOUND_TTL_MS : MISSING_TTL_MS
  return now.getTime() - fetched <= ttl
}

/** The DCL's "not set" for text — `""`, or no value at all — as `null`. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The DCL's "not set" for a number — `0`, or no value at all — as `null`. */
export function count(value: unknown): number | null {
  return typeof value === 'number' && value !== 0 ? value : null
}

/** The answer for a test vendor, which touches neither CouchDB nor the DCL. */
export function testVendorLookup(vendorId: number, productId: number, now: Date): CatalogLookup {
  return {
    vendorId,
    productId,
    source: 'test-vendor',
    vendor: { name: 'Test vendor', preferredName: null, legalName: null, landingPageUrl: null },
    product: null,
    fetchedAt: now.toISOString(),
    stale: false,
  }
}

/**
 * The response for two entries, however they were obtained.
 *
 * `source` is `dcl` only when **both** were found; a missing vendor or a missing model is
 * `missing`, with whichever half was found still filled in. `fetchedAt` is the older of the two,
 * so a client never believes a combined answer is fresher than its oldest part.
 */
export function toLookup(input: {
  readonly vendor: VendorEntry
  readonly model: ModelEntry
  readonly stale: boolean
}): CatalogLookup {
  const { vendor, model } = input
  const vendorRecord = vendor.status === 'found' ? vendor.dcl : undefined
  const modelRecord = model.status === 'found' ? model.dcl : undefined

  return {
    vendorId: vendor.vid,
    productId: model.pid,
    source: vendorRecord !== undefined && modelRecord !== undefined ? 'dcl' : 'missing',
    vendor:
      vendorRecord === undefined
        ? null
        : {
            name: vendorRecord.vendorName,
            preferredName: text(vendorRecord.companyPreferredName),
            legalName: text(vendorRecord.companyLegalName),
            landingPageUrl: text(vendorRecord.vendorLandingPageURL),
          },
    product:
      modelRecord === undefined
        ? null
        : {
            name: modelRecord.productName,
            label: text(modelRecord.productLabel),
            partNumber: text(modelRecord.partNumber),
            deviceTypeId: count(modelRecord.deviceTypeId),
            productUrl: text(modelRecord.productUrl),
            supportUrl: text(modelRecord.supportUrl),
            userManualUrl: text(modelRecord.userManualUrl),
            // Not `count`: 0 is a real value here — the standard flow — not "not set".
            commissioningCustomFlow:
              typeof modelRecord.commissioningCustomFlow === 'number'
                ? modelRecord.commissioningCustomFlow
                : 0,
            commissioningCustomFlowUrl: text(modelRecord.commissioningCustomFlowUrl),
            commissioningInstructions: text(modelRecord.commissioningModeInitialStepsInstruction),
            factoryResetInstructions: text(modelRecord.factoryResetStepsInstruction),
          },
    fetchedAt: vendor.fetchedAt < model.fetchedAt ? vendor.fetchedAt : model.fetchedAt,
    stale: input.stale,
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix backend exec -- vitest run test/catalog/policy.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `npm --prefix backend run check && npm --prefix backend run typecheck`
Expected: exit 0, no warnings.

- [ ] **Step 6: Commit**

```bash
git add backend/src/catalog/policy.ts backend/test/catalog/policy.test.ts
git commit -m "$(cat <<'EOF'
feat(catalog): freshness, test vendors and the DCL-to-response mapping

Found entries are fresh for 90 days and misses for one; "" and 0 become
null; source is dcl only when vendor and model were both found. Pure, so
the rules are tested as rules.

Refs #226

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B6: The lookup algorithm

**Files:**
- Create: `backend/src/catalog/lookup.ts`
- Test: `backend/test/catalog/lookup.test.ts`

**Interfaces:**
- Consumes (B3): `DclClient` and `DclUnavailable`; `dclClient` and `MAINNET_URL` in the test.
- Consumes (B2): the `CodeIds` type.
- Consumes (B4): `CatalogStore`, the entry types, `vendorEntryId`, `modelEntryId`,
  `withoutCreator`, `catalogStore`, `CATALOG_DB` and `forgetCatalogDatabase`.
- Consumes (B5): `isFresh`.
- Consumes (existing test support): `fakeCouch` and the `CouchFailures` type.
- Produces:
  - `interface LookupDependencies { store: CatalogStore; dcl: DclClient; now: () => Date; warn: (context: Record<string, unknown>, message: string) => void }`
  - `interface LookupResult { vendor: VendorEntry; model: ModelEntry; stale: boolean }`
  - `lookupEntries(ids: CodeIds, deps: LookupDependencies): Promise<LookupResult | undefined>`.
    It returns `undefined` when the DCL failed and nothing was cached.
  - Warning messages, which the route test asserts: `'DCL unavailable'`,
    `'catalogue cache unreadable; asking the DCL'` and
    `'catalogue cache unwritable; answering anyway'`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/catalog/lookup.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { dclClient, MAINNET_URL } from '../../src/catalog/dcl.js'
import { type LookupDependencies, lookupEntries } from '../../src/catalog/lookup.js'
import { CATALOG_DB, catalogStore, forgetCatalogDatabase } from '../../src/catalog/store.js'
import { type CouchFailures, fakeCouch } from '../support/couch.js'
import { AQARA_ROUTES, fakeDcl, type Recorded } from '../support/dcl.js'

beforeEach(() => forgetCatalogDatabase())

const NOW = new Date('2026-10-05T16:20:00.000Z')
const AQARA = { vendorId: 4447, productId: 8194 }
const DAY_MS = 86_400_000

/** A lookup over a fake CouchDB and a fake DCL, with the warnings it logged. */
function setup(
  options: {
    routes?: Readonly<Record<string, Recorded | Error>>
    seed?: Record<string, Record<string, unknown>>
    couchFails?: CouchFailures
    now?: Date
  } = {},
) {
  const couch = fakeCouch({
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.couchFails === undefined ? {} : { fails: options.couchFails }),
  })
  const dcl = fakeDcl(options.routes ?? AQARA_ROUTES)
  const warnings: string[] = []
  const deps: LookupDependencies = {
    store: catalogStore(couch.couch),
    dcl: dclClient(MAINNET_URL, dcl.fetch),
    now: () => options.now ?? NOW,
    warn: (_context, message) => {
      warnings.push(message)
    },
  }
  return { couch, dcl, deps, warnings }
}

/** A stored entry, `ageMs` old at {@link NOW}. */
const stored = (id: string, status: 'found' | 'missing', ageMs: number, extra = {}) => ({
  [`${CATALOG_DB}/${id}`]: {
    _id: id,
    _rev: '1-a',
    status,
    fetchedAt: new Date(NOW.getTime() - ageMs).toISOString(),
    network: 'mainnet',
    ...extra,
  },
})
const cachedAqara = (ageMs: number) => ({
  ...stored('vendor:4447', 'found', ageMs, {
    type: 'vendor',
    vid: 4447,
    dcl: { vendorID: 4447, vendorName: 'Aqara (cached)' },
  }),
  ...stored('model:4447:8194', 'found', ageMs, {
    type: 'model',
    vid: 4447,
    pid: 8194,
    dcl: { vid: 4447, pid: 8194, productName: 'P2 (cached)' },
  }),
})

describe('lookupEntries with nothing cached', () => {
  it('asks the DCL for both, stores both, and answers fresh', async () => {
    const { couch, dcl, deps } = setup()
    const result = await lookupEntries(AQARA, deps)

    expect(dcl.requests.sort()).toEqual(['/model/models/4447/8194', '/vendorinfo/vendors/4447'])
    expect(result?.stale).toBe(false)
    expect(result?.vendor).toMatchObject({ status: 'found', fetchedAt: NOW.toISOString() })
    expect(couch.documents.get(`${CATALOG_DB}/vendor:4447`)).toMatchObject({ status: 'found' })
    expect(couch.documents.get(`${CATALOG_DB}/model:4447:8194`)).toMatchObject({
      status: 'found',
      network: 'mainnet',
    })
    expect(couch.documents.get(`${CATALOG_DB}/model:4447:8194`)).not.toHaveProperty('dcl.creator')
  })

  it('stores a miss for a model the DCL does not have, with the vendor still found', async () => {
    const { couch, deps } = setup()
    const result = await lookupEntries({ vendorId: 4447, productId: 9999 }, deps)

    expect(result?.vendor.status).toBe('found')
    expect(result?.model.status).toBe('missing')
    expect(couch.documents.get(`${CATALOG_DB}/model:4447:9999`)).toMatchObject({
      status: 'missing',
    })
  })

  it('answers undefined when the DCL is down, so the route can say 503', async () => {
    const { deps, warnings } = setup({
      routes: { '/vendorinfo/vendors/4447': new TypeError('fetch failed') },
    })
    expect(await lookupEntries(AQARA, deps)).toBeUndefined()
    expect(warnings).toContain('DCL unavailable')
  })

  it('handles two first lookups racing for the same product', async () => {
    // Both read "absent", both fetch, both write; the second write is a 409 and is ignored.
    const { couch, dcl, deps } = setup()
    const [first, second] = await Promise.all([
      lookupEntries(AQARA, deps),
      lookupEntries(AQARA, deps),
    ])
    expect(first?.vendor.status).toBe('found')
    expect(second?.vendor.status).toBe('found')
    expect(dcl.requests).toHaveLength(4)
    expect(couch.documents.get(`${CATALOG_DB}/vendor:4447`)).toMatchObject({ _rev: '1-a' })
  })
})

describe('lookupEntries with a cache', () => {
  it('answers a fresh cache hit without asking the DCL', async () => {
    const { dcl, deps } = setup({ seed: cachedAqara(DAY_MS) })
    const result = await lookupEntries(AQARA, deps)

    expect(dcl.requests).toEqual([])
    expect(result?.vendor.dcl?.vendorName).toBe('Aqara (cached)')
  })

  it('refreshes an entry past 90 days, replacing it with its revision', async () => {
    const { couch, dcl, deps } = setup({ seed: cachedAqara(91 * DAY_MS) })
    const result = await lookupEntries(AQARA, deps)

    expect(dcl.requests).toHaveLength(2)
    expect(result?.vendor.dcl?.vendorName).toBe('Aqara')
    expect(couch.documents.get(`${CATALOG_DB}/vendor:4447`)).toMatchObject({
      _rev: '2-a',
      fetchedAt: NOW.toISOString(),
    })
  })

  it('serves an old entry as stale when the DCL is down', async () => {
    const { dcl, deps } = setup({
      seed: cachedAqara(91 * DAY_MS),
      routes: {
        '/vendorinfo/vendors/4447': new TypeError('fetch failed'),
        '/model/models/4447/8194': { status: 502, body: 'Bad gateway' },
      },
    })
    const result = await lookupEntries(AQARA, deps)

    expect(dcl.requests).toHaveLength(2)
    expect(result?.stale).toBe(true)
    expect(result?.model.dcl?.productName).toBe('P2 (cached)')
  })

  it('retries a miss after a day', async () => {
    const seed = {
      ...cachedAqara(DAY_MS),
      ...stored('model:4447:8194', 'missing', DAY_MS + 1000, {
        type: 'model',
        vid: 4447,
        pid: 8194,
      }),
    }
    const { dcl, deps } = setup({ seed })
    const result = await lookupEntries(AQARA, deps)

    expect(dcl.requests).toEqual(['/model/models/4447/8194'])
    expect(result?.model.status).toBe('found')
  })
})

describe('lookupEntries when CouchDB misbehaves', () => {
  it('answers from the DCL when the cache cannot be read', async () => {
    const { deps, warnings } = setup({ couchFails: { getDoc: CATALOG_DB } })
    const result = await lookupEntries(AQARA, deps)

    expect(result?.vendor.status).toBe('found')
    expect(warnings).toContain('catalogue cache unreadable; asking the DCL')
  })

  it('answers from the DCL when the cache cannot be written', async () => {
    const { deps, warnings } = setup({ couchFails: { putDoc: CATALOG_DB } })
    const result = await lookupEntries(AQARA, deps)

    expect(result?.model.status).toBe('found')
    expect(warnings.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix backend exec -- vitest run test/catalog/lookup.test.ts`
Expected: FAIL. The file cannot import `../../src/catalog/lookup.js`.

- [ ] **Step 3: Write the algorithm**

Create `backend/src/catalog/lookup.ts`:

```ts
/**
 * The lookup algorithm: cache first, the DCL when the cache is absent or old, and the old entry
 * when the DCL cannot be reached.
 *
 * Separate from the route so the algorithm can be tested without HTTP, and from `policy.ts`
 * because this is the part with I/O in it.
 *
 * **Degrades rather than fails on CouchDB.** The cache is an optimisation: a CouchDB read that
 * fails is treated as "nothing cached", and a write that fails is logged and skipped, so a
 * catalogue lookup still answers from the DCL while the database is having a bad minute. The
 * failure goes to the log, where somebody can act on it.
 *
 * @module
 */

import { type DclClient, DclUnavailable } from './dcl.js'
import type { CodeIds } from './decode.js'
import { isFresh } from './policy.js'
import {
  type CatalogEntry,
  type CatalogStore,
  type ModelEntry,
  modelEntryId,
  type VendorEntry,
  vendorEntryId,
  withoutCreator,
} from './store.js'

/** What the lookup needs. */
export interface LookupDependencies {
  readonly store: CatalogStore
  readonly dcl: DclClient
  /** The clock, for freshness and for `fetchedAt` on what is written. */
  readonly now: () => Date
  /**
   * Where a degraded step is reported. The route passes `request.log.warn`; nothing passed here
   * ever contains the setup code, because nothing here ever sees it.
   */
  readonly warn: (context: Record<string, unknown>, message: string) => void
}

/** Both entries, and whether either was served past its freshness because the DCL failed. */
export interface LookupResult {
  readonly vendor: VendorEntry
  readonly model: ModelEntry
  readonly stale: boolean
}

/** One entry resolved, or `undefined` when the DCL failed and nothing was cached. */
type Resolved<T> = { readonly entry: T; readonly stale: boolean } | undefined

/**
 * Resolves the vendor and model entries for these IDs.
 *
 * The two halves are independent and run in parallel. Either one unanswerable — the DCL down and
 * nothing cached — makes the whole lookup unanswerable, and the route says 503.
 *
 * @returns `undefined` when the DCL could not be reached and nothing usable was cached.
 */
export async function lookupEntries(
  ids: CodeIds,
  deps: LookupDependencies,
): Promise<LookupResult | undefined> {
  const { vendorId: vid, productId: pid } = ids
  const [vendor, model] = await Promise.all([
    resolve<VendorEntry>(
      deps,
      { vid },
      () => deps.store.readVendor(vid),
      async (fetchedAt) => {
        const record = await deps.dcl.vendor(vid)
        const base = { _id: vendorEntryId(vid), type: 'vendor', vid, fetchedAt } as const
        return record === 'missing'
          ? { ...base, status: 'missing', network: deps.dcl.network }
          : { ...base, status: 'found', network: deps.dcl.network, dcl: withoutCreator(record) }
      },
    ),
    resolve<ModelEntry>(
      deps,
      { vid, pid },
      () => deps.store.readModel(vid, pid),
      async (fetchedAt) => {
        const record = await deps.dcl.model(vid, pid)
        const base = { _id: modelEntryId(vid, pid), type: 'model', vid, pid, fetchedAt } as const
        return record === 'missing'
          ? { ...base, status: 'missing', network: deps.dcl.network }
          : { ...base, status: 'found', network: deps.dcl.network, dcl: withoutCreator(record) }
      },
    ),
  ])

  if (vendor === undefined || model === undefined) return undefined
  return { vendor: vendor.entry, model: model.entry, stale: vendor.stale || model.stale }
}

/**
 * One half of the lookup: cached if fresh, else fetched and stored, else cached and stale.
 *
 * @param context the IDs, for the log line when something degrades.
 * @param read the cached entry, if any.
 * @param fetch the entry built from a DCL answer; throws {@link DclUnavailable} when there is none.
 */
async function resolve<T extends CatalogEntry>(
  deps: LookupDependencies,
  context: Record<string, number>,
  read: () => Promise<T | undefined>,
  fetch: (fetchedAt: string) => Promise<T>,
): Promise<Resolved<T>> {
  const now = deps.now()
  const cached = await read().catch((error: unknown) => {
    deps.warn({ ...context, err: error }, 'catalogue cache unreadable; asking the DCL')
    return undefined
  })
  if (cached !== undefined && isFresh(cached, now)) return { entry: cached, stale: false }

  let fetched: T
  try {
    fetched = await fetch(now.toISOString())
  } catch (error) {
    // Only an outage is survivable. Anything else is a bug in this module, and serving a stale
    // entry would hide it.
    if (!(error instanceof DclUnavailable)) throw error
    deps.warn({ ...context, err: error }, 'DCL unavailable')
    return cached === undefined ? undefined : { entry: cached, stale: true }
  }

  // Replacing an old entry needs its revision; a first write has none to carry.
  const entry = cached?._rev === undefined ? fetched : { ...fetched, _rev: cached._rev }
  await deps.store.write(entry).catch((error: unknown) => {
    deps.warn({ ...context, err: error }, 'catalogue cache unwritable; answering anyway')
  })
  return { entry, stale: false }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix backend exec -- vitest run test/catalog/lookup.test.ts`
Expected: PASS, 10 tests. The race test's `dcl.requests` has length 4, which proves both
lookups fetched and that the second write was the ignored 409.

- [ ] **Step 5: Lint and typecheck**

Run: `npm --prefix backend run check && npm --prefix backend run typecheck`
Expected: exit 0, no warnings.

- [ ] **Step 6: Commit**

```bash
git add backend/src/catalog/lookup.ts backend/test/catalog/lookup.test.ts
git commit -m "$(cat <<'EOF'
feat(catalog): cache-first lookup with stale fallback

Vendor and model resolve in parallel: fresh cache, else the DCL and a write
back, else the old entry marked stale, else nothing (503). CouchDB trouble
degrades to "nothing cached" and is logged.

Refs #226

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B7: `POST /catalog/lookup`, its contract, the per-subject limit and log redaction

**Files:**
- Modify: `openapi.yaml` (the header comment, `tags`, a new path before `components:`, and four
  schemas at the top of `components.schemas`)
- Regenerate: `backend/src/generated/openapi.ts`
- Modify: `backend/src/security/register.ts` (`Limits`, `DEFAULT_LIMITS`)
- Create: `backend/src/catalog/routes.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/logging.ts` (a comment on `'code'`)
- Test: `backend/test/catalog/routes.test.ts` (create)
- Modify: `backend/test/openapi-drift.test.ts`, `backend/test/logging.test.ts`,
  `backend/test/security/server-security.test.ts`

**Interfaces:**
- Consumes: B2's `decodeCode`, `CodeError` and `CodeIds`; B3's `DclClient` (plus `dclClient`
  and `MAINNET_URL` in tests); B4's `catalogStore` and `forgetCatalogDatabase`; B5's
  `isTestVendor`, `testVendorLookup` and `toLookup`; B6's `lookupEntries`. From the existing
  code: `bearerClaims`, `problem`, `rateLimiter`, `Limit` and
  `components['schemas']['CatalogLookup']`.
- Produces:
  - `interface CatalogDependencies { couch; key; deny?; dcl: DclClient; limit: Limit; now?: () => number; clock?: () => Date }`
  - `registerCatalogRoutes(app: FastifyInstance, deps: CatalogDependencies): void`
  - `ServerOptions.catalog?: Omit<CatalogDependencies, 'limit'>`
  - `Limits.catalog: Limit` and `DEFAULT_LIMITS.catalog = { max: 120, windowSeconds: 300 }`
  - HTTP behaviour:
    - 401 `Not signed in`
    - 429 `Too many requests`, with `retry-after`
    - 400 `Not a setup code`
    - 422 `No vendor or product id in this code`
    - 503 `Catalogue unavailable`
    - 200 `CatalogLookup`, with `cache-control: private, no-store`

- [ ] **Step 1: Write the failing route test**

Create `backend/test/catalog/routes.test.ts`:

```ts
import { generateKeyPairSync } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { denyList } from '../../src/auth/deny-list.js'
import { signingKeyFromPem } from '../../src/auth/jwt.js'
import { dclClient, MAINNET_URL } from '../../src/catalog/dcl.js'
import { registerCatalogRoutes } from '../../src/catalog/routes.js'
import { CATALOG_DB, forgetCatalogDatabase } from '../../src/catalog/store.js'
import { redactionOptions } from '../../src/logging.js'
import { buildServer } from '../../src/server.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'
import { fakeCouch } from '../support/couch.js'
import { AQARA_ROUTES, fakeDcl, type Recorded } from '../support/dcl.js'
import { accessTokenFor } from '../support/tokens.js'

const KEY = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(
    'catalog',
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  )
})()

const ADA = { sub: 'google|ada', email: 'ada@example.test' }
const GRACE = { sub: 'google|grace', email: 'grace@example.test' }

/** Reference vectors: see `decode.test.ts` for where they come from. */
const TEST_VENDOR_QR = 'MT:Y.K9042C00KA0648G00'
const AQARA_QR = 'MT:CUSJ0YJB00KA0648G00'
const AQARA_LONG = '749701123304447081941'
const AQARA_UNKNOWN_MODEL_QR = 'MT:0W-T3ELB00KA0648G00'
const SHORT_MANUAL = '34970112332'

const NOW = new Date('2026-10-05T16:20:00.000Z')

const operation = operationsOf(loadContract()).find(
  (candidate) => candidate.method === 'POST' && candidate.path === '/catalog/lookup',
)

let app: FastifyInstance | undefined

beforeEach(() => forgetCatalogDatabase())
afterEach(async () => {
  await app?.close()
  app = undefined
})

/**
 * The route on a bare Fastify, logging **everything** into `lines` through the service's own
 * redaction options — so the redaction assertion reads what this service would really write.
 */
function catalogApp(
  options: {
    routes?: Readonly<Record<string, Recorded | Error>>
    seed?: Record<string, Record<string, unknown>>
    max?: number
  } = {},
) {
  const lines: string[] = []
  const couch = fakeCouch(options.seed === undefined ? {} : { seed: options.seed })
  const dcl = fakeDcl(options.routes ?? AQARA_ROUTES)
  const deny = denyList(() => Math.floor(Date.now() / 1000))
  const instance = Fastify({
    logger: {
      ...redactionOptions(),
      level: 'trace',
      stream: { write: (line) => lines.push(line) },
    },
  })
  registerCatalogRoutes(instance, {
    couch: couch.couch,
    key: KEY,
    deny,
    dcl: dclClient(MAINNET_URL, dcl.fetch),
    limit: { max: options.max ?? 120, windowSeconds: 300 },
    clock: () => NOW,
  })
  app = instance
  return { app: instance, couch, dcl, lines, deny }
}

/** One lookup, signed in as `who` unless `who` is `null`. */
const lookup = (instance: FastifyInstance, payload: unknown, who: typeof ADA | null = ADA) =>
  instance.inject({
    method: 'POST',
    url: '/catalog/lookup',
    payload: payload as object,
    headers: {
      'content-type': 'application/json',
      ...(who === null ? {} : { authorization: `Bearer ${accessTokenFor(KEY, who)}` }),
    },
  })

/** The response checked against the contract for its status, media type included. */
function expectContract(response: Awaited<ReturnType<typeof lookup>>): void {
  const status = String(response.statusCode)
  expect(operation?.declared, `${status} is not declared`).toContain(status)
  expect(response.headers['content-type']).toMatch(
    new RegExp(`^${operation?.mediaTypes[status]?.replace('+', '\\+')}(;|$)`),
  )
  expect(validate(response.json(), operation?.responses[status])).toEqual([])
}

describe('POST /catalog/lookup: the error table', () => {
  it('answers 401 without a token', async () => {
    const { app, dcl } = catalogApp()
    const response = await lookup(app, { code: AQARA_QR }, null)
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ title: 'Not signed in' })
    expect(dcl.requests).toEqual([])
    expectContract(response)
  })

  it('answers 401 to a signed-out token', async () => {
    const { app, deny } = catalogApp()
    const token = accessTokenFor(KEY, ADA)
    const jti = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).jti
    deny.deny(jti, Math.floor(Date.now() / 1000) + 3600)
    const response = await app.inject({
      method: 'POST',
      url: '/catalog/lookup',
      payload: { code: AQARA_QR },
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(401)
  })

  it.each([
    ['no code', {}],
    ['a code that is not text', { code: 4447 }],
    ['text that is not a code', { code: 'hello' }],
    ['a lower-case prefix', { code: AQARA_QR.toLowerCase() }],
  ])('answers 400 for %s', async (_case, payload) => {
    const { app, dcl } = catalogApp()
    const response = await lookup(app, payload)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ title: 'Not a setup code' })
    expect(dcl.requests).toEqual([])
    expectContract(response)
  })

  it('answers 400 for a request with no body at all', async () => {
    const { app } = catalogApp()
    const response = await app.inject({
      method: 'POST',
      url: '/catalog/lookup',
      headers: { authorization: `Bearer ${accessTokenFor(KEY, ADA)}` },
    })
    expect(response.statusCode).toBe(400)
    expectContract(response)
  })

  it('answers 422 for the 11-digit manual code', async () => {
    const { app, dcl } = catalogApp()
    const response = await lookup(app, { code: SHORT_MANUAL })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ title: 'No vendor or product id in this code' })
    expect(dcl.requests).toEqual([])
    expectContract(response)
  })

  it('answers 429 with retry-after past the limit, counted per subject', async () => {
    const { app } = catalogApp({ max: 2 })
    await lookup(app, { code: TEST_VENDOR_QR })
    await lookup(app, { code: TEST_VENDOR_QR })
    const refused = await lookup(app, { code: TEST_VENDOR_QR })

    expect(refused.statusCode).toBe(429)
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expectContract(refused)
    // Somebody else's budget is their own.
    expect((await lookup(app, { code: TEST_VENDOR_QR }, GRACE)).statusCode).toBe(200)
  })

  it('does not let unauthenticated requests spend a signed-in budget', async () => {
    const { app } = catalogApp({ max: 1 })
    for (const _ of [1, 2, 3]) await lookup(app, { code: TEST_VENDOR_QR }, null)
    expect((await lookup(app, { code: TEST_VENDOR_QR })).statusCode).toBe(200)
  })

  it('answers 503 when the DCL is down and nothing is cached', async () => {
    const { app } = catalogApp({
      routes: { '/vendorinfo/vendors/4447': new TypeError('fetch failed') },
    })
    const response = await lookup(app, { code: AQARA_QR })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ title: 'Catalogue unavailable' })
    expectContract(response)
  })
})

describe('POST /catalog/lookup: answers', () => {
  it('answers the Aqara sensor from the DCL, and the manual code the same', async () => {
    const { app } = catalogApp()
    const response = await lookup(app, { code: AQARA_QR })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.json()).toMatchObject({
      vendorId: 4447,
      productId: 8194,
      source: 'dcl',
      vendor: { name: 'Aqara', preferredName: null },
      product: { name: 'Aqara Door and Window Sensor P2', partNumber: 'AS056', supportUrl: null },
      fetchedAt: NOW.toISOString(),
      stale: false,
    })
    expectContract(response)
    expect((await lookup(app, { code: ` ${AQARA_LONG} ` })).json()).toMatchObject({
      source: 'dcl',
    })
  })

  it('answers 200 missing, with the vendor, for a model the DCL does not have', async () => {
    const { app } = catalogApp()
    const response = await lookup(app, { code: AQARA_UNKNOWN_MODEL_QR })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      productId: 9999,
      source: 'missing',
      vendor: { name: 'Aqara' },
      product: null,
    })
    expectContract(response)
  })

  it('answers a test vendor locally, touching neither CouchDB nor the DCL', async () => {
    const { app, couch, dcl } = catalogApp()
    const response = await lookup(app, { code: TEST_VENDOR_QR })

    expect(response.json()).toMatchObject({
      vendorId: 0xfff1,
      source: 'test-vendor',
      vendor: { name: 'Test vendor' },
      product: null,
    })
    expect(dcl.requests).toEqual([])
    expect(couch.calls).toEqual([])
    expectContract(response)
  })

  it('answers a cache hit without calling the DCL', async () => {
    const { app, dcl } = catalogApp()
    await lookup(app, { code: AQARA_QR })
    const before = dcl.requests.length
    const again = await lookup(app, { code: AQARA_QR })

    expect(again.json()).toMatchObject({ source: 'dcl', stale: false })
    expect(dcl.requests.length).toBe(before)
  })

  it('serves a stale entry when the DCL fails', async () => {
    const old = '2026-01-01T00:00:00.000Z'
    const { app } = catalogApp({
      routes: {
        '/vendorinfo/vendors/4447': new TypeError('fetch failed'),
        '/model/models/4447/8194': new TypeError('fetch failed'),
      },
      seed: {
        [`${CATALOG_DB}/vendor:4447`]: {
          _id: 'vendor:4447',
          _rev: '1-a',
          type: 'vendor',
          vid: 4447,
          status: 'found',
          fetchedAt: old,
          network: 'mainnet',
          dcl: { vendorID: 4447, vendorName: 'Aqara' },
        },
        [`${CATALOG_DB}/model:4447:8194`]: {
          _id: 'model:4447:8194',
          _rev: '1-a',
          type: 'model',
          vid: 4447,
          pid: 8194,
          status: 'found',
          fetchedAt: old,
          network: 'mainnet',
          dcl: { vid: 4447, pid: 8194, productName: 'Aqara Door and Window Sensor P2' },
        },
      },
    })
    const response = await lookup(app, { code: AQARA_QR })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ source: 'dcl', stale: true, fetchedAt: old })
    expectContract(response)
  })
})

describe('POST /catalog/lookup: the code never reaches a log or a response', () => {
  it('logs no MT: and no manual-code digits, on any path', async () => {
    const { app, lines } = catalogApp({
      routes: { '/vendorinfo/vendors/4447': new TypeError('fetch failed') },
    })
    const responses = [
      await lookup(app, { code: AQARA_QR }), // 503, with a warning logged
      await lookup(app, { code: AQARA_LONG }), // 503 again
      await lookup(app, { code: `${AQARA_QR}$` }), // 400
      await lookup(app, { code: SHORT_MANUAL }), // 422
      await lookup(app, { code: TEST_VENDOR_QR }), // 200
      // Not JSON at all: Fastify's own parser refuses it.
      await app.inject({
        method: 'POST',
        url: '/catalog/lookup',
        payload: AQARA_QR,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessTokenFor(KEY, ADA)}`,
        },
      }),
    ]
    const log = lines.join('\n')

    // The positive control: logging was on and the warning path ran, so silence means redaction
    // rather than a logger that was never called.
    expect(log).toContain('DCL unavailable')
    expect(log).not.toContain('MT:')
    expect(log).not.toContain(AQARA_LONG)
    expect(log).not.toContain(SHORT_MANUAL)
    for (const response of responses) {
      expect(response.body).not.toContain('MT:')
      expect(response.body).not.toContain(AQARA_LONG)
      expect(response.body).not.toContain(SHORT_MANUAL)
    }
  })
})

describe('buildServer wiring', () => {
  it('registers the route only when catalogue dependencies are given', () => {
    const without = buildServer({ logger: false })
    expect(without.registeredRoutes().map((route) => route.url)).not.toContain('/catalog/lookup')
    void without.close()
  })

  it('takes the limit from the security options', async () => {
    const couch = fakeCouch()
    const server = buildServer({
      logger: false,
      security: {
        limits: {
          auth: { max: 20, windowSeconds: 300 },
          token: { max: 60, windowSeconds: 300 },
          catalog: { max: 1, windowSeconds: 300 },
        },
      },
      catalog: { couch: couch.couch, key: KEY, dcl: dclClient(MAINNET_URL, fakeDcl().fetch) },
    })
    app = server
    expect((await lookup(server, { code: TEST_VENDOR_QR })).statusCode).toBe(200)
    expect((await lookup(server, { code: TEST_VENDOR_QR })).statusCode).toBe(429)
  })
})
```

- [ ] **Step 2: Pin `code` in the logging test**

In `backend/test/logging.test.ts`, insert this test immediately before
`it('says a value was there', () => {`:

```ts
  it('redacts a setup code in a catalogue lookup body', () => {
    // `code` was on the list for OAuth. `POST /catalog/lookup` gives it a second meaning — a
    // Matter payload or manual code in `{ code }` — and this pins the second one, so trimming
    // the list back to "the OAuth fields" one day cannot quietly drop it (ADR 0019).
    expect(logLine({ body: { code: SECRET } })).not.toContain(SECRET)
    expect(logLine({ req: { body: { code: '749701123304447081941' } } })).not.toContain(
      '749701123304447081941',
    )
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm --prefix backend exec -- vitest run test/catalog/routes.test.ts test/logging.test.ts`
Expected: `routes.test.ts` FAILS, because it cannot import `../../src/catalog/routes.js`.
`logging.test.ts` PASSES already: `code` has been redacted since the OAuth work. This step pins
the field for its second meaning and does not add it.

- [ ] **Step 4: Add the operation to the contract**

In `openapi.yaml`'s header comment, replace the two lines

```yaml
# CouchDB validates itself. This API only does what replication cannot: identity, and
# provisioning databases the browser has no rights to create.
```

with

```yaml
# CouchDB validates itself. This API only does what replication cannot: identity,
# provisioning databases the browser has no rights to create, and the DCL catalogue lookup
# (ADR 0019) - the one operation that receives a setup code.
```

Add the tag after `profile`:

```yaml
  - name: catalog
    description: |
      Manufacturer and product names from the CSA's Distributed Compliance Ledger, cached by
      this API. The one operation that receives a setup code; see ADR 0019 for why it may.
```

Insert the path immediately before the top-level `components:` line, after the
`/transfers/{projectId}` `delete` operation:

```yaml
  /catalog/lookup:
    post:
      tags: [catalog]
      operationId: lookupCatalog
      summary: Name the manufacturer and product of a setup code
      description: |
        Decodes the code to its vendor and product IDs and answers what the CSA's Distributed
        Compliance Ledger (DCL) says about them, from a cache the API keeps in `matter_catalog`.

        **The code travels in the body**, never in the URL, so it appears in no access log. The
        API decodes it in memory and never stores or logs it; **only the two IDs reach the
        DCL** (ADR 0019).

        Open to every plan: the answer is public catalogue data, and the client copies it into
        the device document wherever that lives.

        Test vendors 0xFFF1–0xFFF4 are answered locally as `test-vendor` and never sent to the
        DCL. `missing` is a normal 200, not an error: the ledger simply has no record. A cached
        record past its freshness is served with `stale: true` when the DCL cannot be reached.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CatalogLookupRequest' }
      responses:
        '200':
          description: What the catalogue knows about this vendor and product
          content:
            application/json:
              schema: { $ref: '#/components/schemas/CatalogLookup' }
        '400':
          description: Not a decodable setup code. Never echoes the code.
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/Problem' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '422':
          description: |
            A valid code that carries no vendor or product ID - the 11-digit manual pairing
            code. There is nothing to look up, and asking again will not change that.
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/Problem' }
        '429':
          description: |
            Too many lookups by this account. Counted per signed-in subject, not per address,
            so one account cannot use this as a free DCL proxy.
          headers:
            retry-after:
              description: Seconds until the window resets. Never zero.
              schema: { type: integer, minimum: 1 }
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/Problem' }
        '503':
          description: |
            The DCL is unreachable or did not answer within five seconds, and nothing is cached
            for this vendor and product. Safe to retry later.
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/Problem' }
```

Insert these schemas immediately after `  schemas:` and before `    Role:`:

```yaml
    CatalogLookupRequest:
      type: object
      required: [code]
      properties:
        code:
          type: string
          description: |
            A QR payload (`MT:` and Base-38) or a 21-digit manual pairing code, as scanned or
            typed. Surrounding whitespace and digit-group separators are tolerated.

    CatalogLookup:
      type: object
      description: |
        What the catalogue knows about one vendor and product. Every text the DCL leaves empty,
        and every number it leaves 0, is `null` here. DCL text is untrusted: render it as text,
        and a URL only when it is `https:`.
      required: [vendorId, productId, source, vendor, product, fetchedAt, stale]
      properties:
        vendorId: { type: integer, description: 'The vendor ID decoded from the code.' }
        productId: { type: integer, description: 'The product ID decoded from the code.' }
        source:
          type: string
          enum: [dcl, test-vendor, missing]
          description: |
            `dcl` when the ledger has both the vendor and the model; `missing` when it lacks
            either, with whichever half it has still filled in; `test-vendor` for 0xFFF1–0xFFF4.
        vendor:
          oneOf:
            - $ref: '#/components/schemas/CatalogVendor'
            - type: 'null'
        product:
          oneOf:
            - $ref: '#/components/schemas/CatalogProduct'
            - type: 'null'
        fetchedAt:
          type: string
          format: date-time
          description: When the DCL was asked; the older of the two records when they differ.
        stale:
          type: boolean
          description: |
            `true` when a record past its freshness (90 days found, 1 day missing) was served
            because the DCL could not be reached.

    CatalogVendor:
      type: object
      required: [name, preferredName, legalName, landingPageUrl]
      properties:
        name: { type: string, description: 'The DCL `vendorName`.' }
        preferredName: { type: [string, 'null'], description: 'The DCL `companyPreferredName`.' }
        legalName: { type: [string, 'null'], description: 'The DCL `companyLegalName`.' }
        landingPageUrl: { type: [string, 'null'], description: 'The DCL `vendorLandingPageURL`.' }

    CatalogProduct:
      type: object
      required:
        - name
        - label
        - partNumber
        - deviceTypeId
        - productUrl
        - supportUrl
        - userManualUrl
        - commissioningCustomFlow
        - commissioningCustomFlowUrl
        - commissioningInstructions
        - factoryResetInstructions
      properties:
        name: { type: string, description: 'The DCL `productName`.' }
        label: { type: [string, 'null'], description: 'The DCL `productLabel`.' }
        partNumber: { type: [string, 'null'] }
        deviceTypeId: { type: [integer, 'null'] }
        productUrl: { type: [string, 'null'] }
        supportUrl: { type: [string, 'null'] }
        userManualUrl: { type: [string, 'null'] }
        commissioningCustomFlow:
          type: integer
          description: 0 standard, 1 user action required, 2 custom. Not nulled; 0 is a value.
        commissioningCustomFlowUrl: { type: [string, 'null'] }
        commissioningInstructions:
          type: [string, 'null']
          description: The DCL `commissioningModeInitialStepsInstruction`.
        factoryResetInstructions:
          type: [string, 'null']
          description: The DCL `factoryResetStepsInstruction`.
```

- [ ] **Step 5: Regenerate the types and check them**

Run: `npm run openapi:types && npm run check:openapi-types`
Expected: `openapi types: wrote backend/src/generated/openapi.ts from openapi.yaml`, then
`openapi types: ok (backend/src/generated/openapi.ts matches openapi.yaml)`.

- [ ] **Step 6: Add the `catalog` limit**

In `backend/src/security/register.ts`, add to `interface Limits`, after `readonly token: Limit`:

```ts
  /**
   * Catalogue lookups, counted **per signed-in subject** rather than per address.
   *
   * Not applied by the hook below: the subject is known only once the route has verified the
   * bearer token, so `catalog/routes.ts` counts after authenticating. Configured here anyway, so
   * every limit the service has is set in one place (ADR 0016).
   *
   * Generous for a person — a whole house added in an afternoon, plus backfill — and far short
   * of what a script using this as a free DCL proxy would want.
   */
  readonly catalog: Limit
```

and to `DEFAULT_LIMITS`, after `token`:

```ts
  catalog: { max: 120, windowSeconds: 300 },
```

`catalog` is required, so update the two `limits:` literals in
`backend/test/security/server-security.test.ts`. The first, in `server()`, becomes:

```ts
      limits: {
        auth: { max: 3, windowSeconds: 60 },
        token: { max: 6, windowSeconds: 60 },
        catalog: { max: 9, windowSeconds: 60 },
      },
```

The second, the `maxClients: 4` case, gains the line
`          catalog: { max: 9, windowSeconds: 60 },` after its `token` line.

- [ ] **Step 7: Write the route**

Create `backend/src/catalog/routes.ts`:

```ts
/**
 * `POST /catalog/lookup`: the manufacturer and product behind a setup code.
 *
 * **The one route that receives a setup code** (ADR 0019). It decodes the code in memory, keeps
 * the two IDs, and lets the code go: it is never stored, never logged, and never in a response.
 * The redaction list carries `code` for the case where somebody logs a request body anyway.
 *
 * Authenticated with the access token, like every route but sign-in, and open to **every plan**:
 * the answer is public catalogue data and costs this service no storage of the caller's own.
 *
 * @module
 */

import type { FastifyInstance } from 'fastify'
import { bearerClaims } from '../auth/bearer.js'
import type { DenyList } from '../auth/deny-list.js'
import type { SigningKey } from '../auth/jwt.js'
import type { CouchClient } from '../couch/client.js'
import type { components } from '../generated/openapi.js'
import { problem } from '../problem.js'
import { type Limit, rateLimiter } from '../security/rate-limit.js'
import type { DclClient } from './dcl.js'
import { CodeError, type CodeIds, decodeCode } from './decode.js'
import { lookupEntries } from './lookup.js'
import { isTestVendor, testVendorLookup, toLookup } from './policy.js'
import { catalogStore } from './store.js'

/** What the catalogue route needs. */
export interface CatalogDependencies {
  /** Where `matter_catalog` lives. The same client the other routes use. */
  readonly couch: CouchClient
  /** The key the access token is verified with — the one CouchDB validates it with. */
  readonly key: SigningKey
  /** Access tokens signed out before their expiry. */
  readonly deny?: DenyList
  readonly dcl: DclClient
  /** Lookups per subject per window. `buildServer` passes `Limits.catalog`. */
  readonly limit: Limit
  /** The clock in seconds, for token verification and the rate limit. */
  readonly now?: () => number
  /** The clock as a date, for freshness and `fetchedAt`. */
  readonly clock?: () => Date
}

/** The response body, as the contract declares it. A shape it does not declare will not compile. */
type CatalogLookupBody = components['schemas']['CatalogLookup']

/** Registers `POST /catalog/lookup`. */
export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogDependencies): void {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const clock = deps.clock ?? (() => new Date())
  const store = catalogStore(deps.couch)
  // Per subject, and in the handler rather than in `registerSecurity`'s hook. That hook runs
  // before routing with no key to verify a token with, so all it could count is the address — and
  // an address is shared by a household or an office, while the abuse this guards against is one
  // *account* using the endpoint as a free DCL proxy. Counting after authentication also means
  // unauthenticated requests cannot spend a signed-in user's budget.
  const limiter = rateLimiter(deps.limit, now)

  app.post('/catalog/lookup', async (request, reply) => {
    const caller = bearerClaims(request, deps.key, now, deps.deny)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const decision = limiter.check(`catalog:${caller.sub}`)
    if (!decision.allowed) {
      reply.header('retry-after', String(decision.retryAfterSeconds))
      return problem(reply, { title: 'Too many requests', status: 429 })
    }

    const code = (request.body as { code?: unknown } | undefined)?.code
    if (typeof code !== 'string') return problem(reply, { title: 'Not a setup code', status: 400 })

    let ids: CodeIds
    try {
      ids = decodeCode(code)
    } catch (error) {
      if (!(error instanceof CodeError)) throw error
      // Fixed titles, and never the error's message: the client switches on the status, and a
      // title built from the input is how a code would find its way into a response.
      return error.kind === 'no-ids'
        ? problem(reply, { title: 'No vendor or product id in this code', status: 422 })
        : problem(reply, { title: 'Not a setup code', status: 400 })
    }

    // Per caller in effect: the body is public data, but the request carried a credential.
    reply.header('cache-control', 'private, no-store')

    if (isTestVendor(ids.vendorId)) {
      const body: CatalogLookupBody = testVendorLookup(ids.vendorId, ids.productId, clock())
      return body
    }

    const result = await lookupEntries(ids, {
      store,
      dcl: deps.dcl,
      now: clock,
      // The IDs only. The code never reaches this function, so it cannot reach a log line.
      warn: (context, message) => request.log.warn(context, message),
    })
    if (result === undefined) {
      return problem(reply, { title: 'Catalogue unavailable', status: 503 })
    }

    const body: CatalogLookupBody = toLookup(result)
    return body
  })
}
```

- [ ] **Step 8: Register it in `buildServer`**

In `backend/src/server.ts`:

1. Add the import after the `./auth/routes.js` import:

```ts
import { type CatalogDependencies, registerCatalogRoutes } from './catalog/routes.js'
```

2. Change the `./security/register.js` import to:

```ts
import { DEFAULT_LIMITS, registerSecurity, type SecurityOptions } from './security/register.js'
```

3. Add this to `ServerOptions`, after `readonly projects?: ProjectDependencies`:

```ts
  /**
   * The catalogue lookup (ADR 0019).
   *
   * Everything but the rate limit, which comes from `security.limits` so that every limit is
   * configured in one place. Absent means the route is absent, which the contract-drift check
   * reads as unimplemented — which is true.
   */
  readonly catalog?: Omit<CatalogDependencies, 'limit'>
```

4. Add this after `if (options.projects !== undefined) registerProjectRoutes(app, options.projects)`:

```ts
  if (options.catalog !== undefined) {
    registerCatalogRoutes(app, {
      ...options.catalog,
      limit: (options.security?.limits ?? DEFAULT_LIMITS).catalog,
    })
  }
```

- [ ] **Step 9: Give `code` its second reason in `logging.ts`**

In `backend/src/logging.ts`, replace the bare `'code',` line in `REDACTED_FIELDS` with:

```ts
  // Twice over: the OAuth authorisation code, and the setup code `POST /catalog/lookup` takes
  // as `{ code }` — a Matter payload or a manual pairing code, which is a passcode (ADR 0019).
  'code',
```

- [ ] **Step 10: Wire the drift check**

In `backend/test/openapi-drift.test.ts`:

1. Add the imports after the `refresh-store.js` import:

```ts
import { dclClient, MAINNET_URL } from '../src/catalog/dcl.js'
import { forgetCatalogDatabase } from '../src/catalog/store.js'
```

2. In `server()`, call `forgetCatalogDatabase()` right after `forgetUsersDatabase()`.
3. In the `buildServer({ ... })` call in `server()`, after the `projects: { ... }` block, add:

```ts
    // A DCL that is never reachable: the drift pass must make no network call, and an
    // unreachable ledger with an empty cache is what reaches the 503.
    catalog: {
      couch,
      key,
      deny,
      dcl: dclClient(MAINNET_URL, async () => {
        throw new TypeError('fetch failed')
      }),
    },
```

4. In `extraRequests`, before `if (route === 'POST /projects') {`, add:

```ts
    if (route === 'POST /catalog/lookup') {
      // The empty-body pass reaches the 400; these reach the other declared answers. The test
      // vendor's 200 needs no DCL; the real vendor's 503 is the unreachable DCL configured above.
      return [
        { headers: credentials(), payload: { code: 'MT:Y.K9042C00KA0648G00' }, expected: 200 },
        { headers: credentials(), payload: { code: '34970112332' }, expected: 422 },
        { headers: credentials(), payload: { code: 'MT:CUSJ0YJB00KA0648G00' }, expected: 503 },
      ]
    }
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npm --prefix backend exec -- vitest run test/catalog test/logging.test.ts test/openapi-drift.test.ts test/security`
Expected: PASS. `routes.test.ts` has 19 tests. The drift file lists
`POST /catalog/lookup answers what the contract declares` as passing, and its
"is reported rather than failed" test, which requires an empty `pending` list, still passes.

- [ ] **Step 12: Verify the whole backend**

Run: `npm run check:openapi-types && npm --prefix backend run verify`
Expected: exit 0. Biome reports "No fixes applied", the typecheck is clean, every test passes,
and the coverage thresholds hold (`src/**` ≥ 70%; `src/catalog` was measured at 97.5%
statements and 92.5% branches).

- [ ] **Step 13: Commit**

```bash
git add openapi.yaml backend/src/generated/openapi.ts backend/src/security/register.ts backend/src/catalog/routes.ts backend/src/server.ts backend/src/logging.ts backend/test/catalog/routes.test.ts backend/test/openapi-drift.test.ts backend/test/logging.test.ts backend/test/security/server-security.test.ts
git commit -m "$(cat <<'EOF'
feat(api): POST /catalog/lookup with a per-subject rate limit

Bearer-authenticated, every plan. 400/422 for undecodable or id-less codes,
test vendors answered locally, 503 only when the DCL is down and nothing is
cached. The limit (Limits.catalog, 120 per 300 s) counts after auth, by
subject. Contract, generated types and drift check updated; a route test
captures the log and finds no code in it.

Refs #226

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B8: Composition (`DCL_BASE_URL`), the smoke script and the backend README

**Files:**
- Modify: `backend/src/composition.ts`
- Modify: `backend/test/composition.test.ts`
- Create: `backend/test/smoke/dcl-smoke.ts`
- Modify: `backend/package.json` (`scripts`)
- Modify: `backend/README.md`

**Interfaces:**
- Consumes (B3): `dclClient` and `MAINNET_URL`. The smoke script also uses B5's `toLookup` and
  B4's `vendorEntryId`, `modelEntryId` and `withoutCreator`.
- Consumes (B7): `ServerOptions.catalog`.
- Produces:
  - `serverOptions(env).catalog` whenever CouchDB and the signing key are configured.
  - `DCL_BASE_URL`, which must be an `https:` URL or startup throws; default `MAINNET_URL`.
  - `npm --prefix backend run dcl:smoke`.

- [ ] **Step 1: Write the failing composition tests**

In `backend/test/composition.test.ts`, in `describe('a fully configured deployment')`, before
`it("allows the application's own origin", ...)`:

```ts
  it('serves the catalogue lookup', () => {
    expect(routesFor(COMPLETE)).toContain('POST /catalog/lookup')
  })

  it('asks DCL MainNet unless told otherwise', () => {
    expect(serverOptions(COMPLETE).catalog?.dcl.network).toBe('mainnet')
    expect(
      serverOptions({ ...COMPLETE, DCL_BASE_URL: 'https://on.test-net.dcl.csa-iot.org/dcl/' })
        .catalog?.dcl.network,
    ).toBe('testnet')
  })
```

In `describe('a deployment that is part-way through being set up')`, before
`it('serves no project routes without a signing key', ...)`:

```ts
  it('serves no catalogue lookup without CouchDB', () => {
    const { COUCHDB_URL: _url, ...withoutCouch } = COMPLETE

    expect(routesFor(withoutCouch)).not.toContain('POST /catalog/lookup')
  })
```

In `describe('a deployment that is configured wrongly')`, before
`it('refuses a signing key that is not an EC key', ...)`:

```ts
  it.each([
    ['not a URL', 'on.dcl.csa-iot.org/dcl'],
    ['plain http', 'http://on.dcl.csa-iot.org/dcl'],
  ])('refuses to start on a DCL_BASE_URL that is %s', (_case, url) => {
    expect(() => serverOptions({ ...COMPLETE, DCL_BASE_URL: url })).toThrow(/DCL_BASE_URL/)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix backend exec -- vitest run test/composition.test.ts`
Expected: FAIL, in 4 tests. "serves the catalogue lookup" fails because the route list lacks
`POST /catalog/lookup`. "asks DCL MainNet" fails because `catalog` is undefined. Both
`DCL_BASE_URL` cases fail with "expected function to throw". "serves no catalogue lookup
without CouchDB" passes already; keep it, because it guards the "absent means absent" side.

- [ ] **Step 3: Wire `catalog` in `serverOptions`**

In `backend/src/composition.ts`, add the import after the `./auth/routes.js` import:

```ts
import { dclClient, MAINNET_URL } from './catalog/dcl.js'
```

Add this function after `couchFrom`:

```ts
/**
 * Which DCL the catalogue asks: `DCL_BASE_URL`, or MainNet when it is unset.
 *
 * Refused at startup unless it is an `https:` URL, for the reason a bad origin is: the
 * alternative is a service that starts, looks healthy, and answers every lookup with a 503.
 * And plain `http:` would let anyone on the path rewrite the names shown for every device.
 *
 * @throws {Error} when the value is not an `https:` URL.
 */
function dclBaseUrlFrom(env: Environment): string {
  const raw = value(env.DCL_BASE_URL) ?? MAINNET_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('DCL_BASE_URL is not a URL.')
  }
  if (url.protocol !== 'https:') throw new Error('DCL_BASE_URL must be an https: URL.')
  return raw.replace(/\/+$/, '')
}
```

In `serverOptions`'s returned object, after the `profile: { records, ensureRecord, key, deny },`
line:

```ts
    // The same CouchDB and the same access-token check as everything else: the lookup needs
    // nothing a deployment with projects does not already have, so it is served whenever they are.
    catalog: { couch, key, deny, dcl: dclClient(dclBaseUrlFrom(env)) },
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm --prefix backend exec -- vitest run test/composition.test.ts`
Expected: PASS, 35 tests.

- [ ] **Step 5: Add the opt-in smoke script**

Create `backend/test/smoke/dcl-smoke.ts`. It is not a `*.test.ts`, so vitest never collects it,
and CI makes no live call:

```ts
/**
 * `npm run dcl:smoke`: the live DCL still answers in the shape `dcl.ts` and `policy.ts` expect.
 *
 * **Opt-in and by hand.** CI makes no live calls (the spec, "Testing"): a third party's uptime
 * must not decide whether a pull request is green. Run this when the DCL changes its API, or
 * before trusting a new `DCL_BASE_URL`.
 *
 * Not a `*.test.ts`, so vitest never collects it; `tsc --build` compiles it like the tests.
 *
 * @module
 */

import { dclClient, MAINNET_URL } from '../../src/catalog/dcl.js'
import { toLookup } from '../../src/catalog/policy.js'
import { modelEntryId, vendorEntryId, withoutCreator } from '../../src/catalog/store.js'

const base = process.env.DCL_BASE_URL ?? MAINNET_URL
const dcl = dclClient(base)
const failures: string[] = []

/** Records a failed expectation rather than stopping, so one run reports everything. */
function check(what: string, ok: boolean): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const vendor = await dcl.vendor(4447)
const model = await dcl.model(4447, 8194)
check('vendor 4447 is found', vendor !== 'missing')
check('model 4447/8194 is found', model !== 'missing')
// The test vendors are verified absent from both networks; their 404 must read as a miss, which
// is what proves the not-found body still carries `code: 5`.
check('test vendor 0xFFF1 is missing', (await dcl.vendor(0xfff1)) === 'missing')

if (vendor !== 'missing' && model !== 'missing') {
  const fetchedAt = new Date().toISOString()
  const lookup = toLookup({
    vendor: {
      _id: vendorEntryId(4447),
      type: 'vendor',
      vid: 4447,
      status: 'found',
      fetchedAt,
      network: dcl.network,
      dcl: withoutCreator(vendor),
    },
    model: {
      _id: modelEntryId(4447, 8194),
      type: 'model',
      vid: 4447,
      pid: 8194,
      status: 'found',
      fetchedAt,
      network: dcl.network,
      dcl: withoutCreator(model),
    },
    stale: false,
  })
  check('the vendor is still called Aqara', lookup.vendor?.name === 'Aqara')
  check('the part number is still AS056', lookup.product?.partNumber === 'AS056')
  check('the device type is still 21', lookup.product?.deviceTypeId === 21)
  console.log(JSON.stringify(lookup, null, 2))
}

console.log(
  failures.length === 0 ? `\nDCL at ${base}: as expected.` : `\n${failures.length} failed.`,
)
process.exitCode = failures.length === 0 ? 0 : 1
```

In `backend/package.json` `scripts`, after `"verify"`, add:

```json
    "dcl:smoke": "tsc --build && node dist/test/smoke/dcl-smoke.js"
```

Run it by hand, once, with network access:

Run: `npm --prefix backend run dcl:smoke`
Expected: six `ok` lines (vendor 4447 found, model 4447/8194 found, test vendor 0xFFF1
missing, Aqara, AS056, device type 21), the mapped lookup as JSON, and
`DCL at https://on.dcl.csa-iot.org/dcl: as expected.`, exit 0. It passed on 2026-10-07.

- [ ] **Step 6: Document it in the backend README**

In `backend/README.md`, in `## Logging`, replace "Besides the usual credential names it redacts
`payload`, `manualCode`, `passcode` and `discriminator`:" with "Besides the usual credential
names it redacts `payload`, `manualCode`, `passcode` and `discriminator`, and `code` covers the
setup code `POST /catalog/lookup` receives as well as the OAuth code:". Then add this section
before `## Protecting the service`:

```markdown
## The catalogue lookup

`POST /catalog/lookup` (`src/catalog/`) turns a setup code into a manufacturer and product name
from the CSA's Distributed Compliance Ledger. It is the one route that receives a setup code
([ADR 0019](../docs/adr/0019-setup-code-to-own-api.md)): the code is decoded in memory and never
stored or logged, and only the vendor and product IDs reach the DCL.

Answers are cached in the admin-only `matter_catalog` database, created on the first lookup:
found records for 90 days and misses for a day, with an old record served as `stale` while the
DCL is unreachable. Test vendors 0xFFF1–0xFFF4 never leave the process. Lookups are limited per
signed-in account (`Limits.catalog`, 120 per five minutes), not per address.

| Variable | |
|---|---|
| `DCL_BASE_URL` | The DCL REST base. Default MainNet, `https://on.dcl.csa-iot.org/dcl`; TestNet is `https://on.test-net.dcl.csa-iot.org/dcl`. Must be `https:`, or the service refuses to start |

CI never calls the DCL. `npm run dcl:smoke` checks the live response shape by hand: run it when
the DCL changes its API, or before trusting a new `DCL_BASE_URL`.
```

- [ ] **Step 7: Verify the whole repository**

Run: `npm run verify`
Expected: exit 0, with every row green and no warnings: the dependency, npmrc, node,
dependabot, root-tsc and openapi-types checks, Biome, the frontend verify, and the backend
verify with its coverage gates.

- [ ] **Step 8: Commit**

```bash
git add backend/src/composition.ts backend/test/composition.test.ts backend/test/smoke/dcl-smoke.ts backend/package.json backend/README.md
git commit -m "$(cat <<'EOF'
feat(api): serve the catalogue lookup wherever CouchDB is configured

DCL_BASE_URL selects the ledger (default MainNet) and must be https, or the
service refuses to start. Adds the opt-in `npm run dcl:smoke` against the
live DCL, and documents the route in the backend README.

Refs #226

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B9: Deploy the API to wisselroot after the PR merges

Cloudflare Pages deploys only the frontend. Nothing deploys the API, and #227 calls this
endpoint, so this step is part of #226's acceptance. **Run it only after the #226 PR has been
merged to `main`.** Never print `.env` lines on the droplet: the EC private keys span several
lines, so `cut -d= -f1` leaks key material. If you need the variable names, use
`grep -oE '^[A-Z_]+=' .env`.

**Files:** none in the repository.

**Interfaces:**
- Consumes: `main` with B1–B8 merged.
- Produces: `https://api.matter-manager.io/catalog/lookup` (reached by the app at
  `https://app.matter-manager.io/api/catalog/lookup`), answering 401 without a token.

- [ ] **Step 1: Record the running revision and tag a rollback image**

```bash
ssh wisselroot 'cd /opt/matter-manager && git rev-parse --short HEAD'
```

Note the short SHA (`<old>`), then:

```bash
ssh wisselroot 'docker tag matter-manager/api:local matter-manager/api:rollback-<old>'
```

- [ ] **Step 2: Check out `main` and rebuild the API**

```bash
ssh wisselroot 'cd /opt/matter-manager && git fetch && git checkout --detach origin/main && git log -1 --oneline'
ssh wisselroot 'cd /opt/matter-manager-api && docker compose build api && docker compose up -d api'
```

Expected: the log line shows the merge commit of the #226 PR, the build succeeds, and
`api` is recreated.

`DCL_BASE_URL` needs no `.env` change, because the default is MainNet. Add it only if this
deployment is meant to use another ledger.

- [ ] **Step 3: Wait for health**

```bash
ssh wisselroot 'cd /opt/matter-manager-api && docker compose ps api'
curl -fsS https://api.matter-manager.io/healthz
```

Expected: the container reports `healthy` and the body is `{"status":"ok"}`.

- [ ] **Step 4: Prove the route is there and refuses anonymous callers**

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -X POST \
  -H 'content-type: application/json' -d '{"code":"34970112332"}' \
  https://api.matter-manager.io/catalog/lookup
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -X POST \
  -H 'content-type: application/json' -d '{"code":"34970112332"}' \
  https://app.matter-manager.io/api/catalog/lookup
```

Expected: `401 application/problem+json` from both. A `404` means the old image is still
running, or the proxy is not forwarding. The body is the reference short code from the
frontend tests, not a real device's code.

- [ ] **Step 5: Confirm startup was clean, and roll back if it was not**

```bash
ssh wisselroot 'cd /opt/matter-manager-api && docker compose logs --since 10m api | grep -iE "error|DCL_BASE_URL" || true'
```

Expected: no output. If Step 3 or Step 4 fails, roll back by retagging and restarting:

```bash
ssh wisselroot 'docker tag matter-manager/api:rollback-<old> matter-manager/api:local && cd /opt/matter-manager-api && docker compose up -d api'
```

`docker compose up -d` does not rebuild unless it is given `--build`, so it starts the
retagged image.

- [ ] **Step 6: Tick the issue's acceptance box**

```bash
gh issue comment 226 --body "Deployed to wisselroot at $(ssh wisselroot 'cd /opt/matter-manager && git rev-parse --short HEAD'): /healthz ok; POST /catalog/lookup without a token answers 401 application/problem+json directly and through /api."
```

---

### Self-review against the spec (backend scope)

| Spec requirement | Task |
|---|---|
| `decode.ts` on the frontend's reference vectors, malformed input, error texts free of the code | B2 |
| `dcl.ts`: injected fetch, recorded Aqara 4447 and 4447/8194, the real 404, the timeout, a non-JSON 5xx | B3 |
| `matter_catalog`: admin-only, lazy, `by_fetched`, raw record minus `creator`, decimal IDs, `network` | B4 |
| `policy.ts`: fresh, stale at 90 days and one second, a miss at 1 day, empty to `null` | B5 |
| Algorithm steps 2–4: parallel fetches, write-back, 409 ignored, stale on failure, 503 with nothing cached | B6 |
| Route: 401, 429, a test vendor never calling the DCL, a cache hit never calling the DCL, stale on failure, 503, log redaction | B7 |
| Every row of the error table, and 200 `missing` (#226 acceptance) | B7 (route tests and drift) |
| OpenAPI operation and schemas, generated types, drift test | B7 |
| `Limits.catalog` keyed by subject, 120 per 300 s | B7 |
| `code` redacted | B7 (pinned) |
| `DCL_BASE_URL`, default MainNet | B8 |
| Opt-in `npm run dcl:smoke`; no live calls in CI | B8 |
| SECURITY-MODEL.md, DATA-MODEL.md and ADR 0005 amended | B1 |
| Deployed to wisselroot | B9 |

---

## Part C — Look up when adding a device (#227)

| File | Change | Responsibility |
| --- | --- | --- |
| `frontend/src/ui/catalog.ts` | Create | `catalogApi` client, `LookupOutcome`, response validation, `retry-after` parsing |
| `frontend/src/ui/composition.ts` | Modify | `catalog(fetchImpl)` wired to `API_BASE` and `accessToken` |
| `frontend/src/ui/views/device-form.ts` | Modify | `CatalogNames`, `catalogNames()`, `renderCatalogLines()` shared by both forms |
| `frontend/src/ui/views/add-device.ts` | Modify | Debounced, abortable lookup; hint and names; result passed to `planNewDevice` |
| `frontend/test/ui/catalog.test.ts` | Create | Client against a fake `fetch` (node) |
| `frontend/test/ui/support/catalog.ts` | Create | `AQARA_LOOKUP`, `aqaraPayload()`, `fakeCatalog()` for browser tests |
| `frontend/test/ui/views/add-device.browser.test.ts` | Modify | Lookup behaviour |
| `frontend/xliff/de.xlf`, `frontend/src/ui/generated/locales/de.ts` | Regenerate | German strings |

### Task C1: The `catalogApi` client

**Files:**
- Create: `frontend/src/ui/catalog.ts`
- Modify: `frontend/src/ui/composition.ts:31,215-218` (import; factory after `profile`)
- Test: `frontend/test/ui/catalog.test.ts`

**Interfaces:**
- Consumes: `CatalogLookup` from `../domain/index.js`; `accessToken` (`() => string | undefined`) and `API_BASE` in composition.
- Produces: `export type LookupOutcome`; `export interface CatalogApi { lookup(code: string, signal?: AbortSignal): Promise<LookupOutcome> }`; `export function catalogApi(baseUrl: string, token: () => string | undefined, fetchImpl: typeof fetch = fetch): CatalogApi`; `export function retryAfterSeconds(header: string | null): number`; `export const DEFAULT_RETRY_AFTER_SECONDS = 60`; `export function isCatalogLookup(body: unknown): body is CatalogLookup`; composition `export function catalog(fetchImpl: typeof fetch = fetch): CatalogApi`.

- [ ] **Step 1: Write the failing test.** Create `frontend/test/ui/catalog.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogLookup } from '../../src/domain/index.js'
import {
  catalogApi,
  DEFAULT_RETRY_AFTER_SECONDS,
  isCatalogLookup,
  retryAfterSeconds,
} from '../../src/ui/catalog.js'

const CODE = 'MT:Y.K9042C00KA0648G00'

const ANSWER: CatalogLookup = {
  vendorId: 0xfff1,
  productId: 0x8000,
  source: 'test-vendor',
  vendor: { name: 'Test vendor', preferredName: null, legalName: null, landingPageUrl: null },
  product: null,
  fetchedAt: '2026-10-05T16:20:00.000Z',
  stale: false,
}

/** A `fetch` that answers once with the given response and records what it was asked. */
function answering(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (response instanceof Error) throw response
    return response
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('catalogApi', () => {
  it('posts the code in the body, with the bearer token, never in the URL', async () => {
    const { calls, fetchImpl } = answering(json(200, ANSWER))
    await catalogApi('/api/', () => 'tok', fetchImpl).lookup(CODE)

    expect(calls[0]?.url).toBe('/api/catalog/lookup')
    expect(calls[0]?.url).not.toContain('MT:')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: CODE })
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('reports a found answer', async () => {
    const { fetchImpl } = answering(json(200, ANSWER))
    expect(await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE)).toEqual({
      kind: 'found',
      lookup: ANSWER,
    })
  })

  it('answers signed-out without a request when no token is held', async () => {
    const { calls, fetchImpl } = answering(json(200, ANSWER))
    expect(await catalogApi('/api', () => undefined, fetchImpl).lookup(CODE)).toEqual({
      kind: 'signed-out',
    })
    expect(calls).toHaveLength(0)
  })

  it.each([
    [401, { kind: 'signed-out' }],
    [400, { kind: 'unusable' }],
    [422, { kind: 'unusable' }],
    [403, { kind: 'unavailable' }],
    [500, { kind: 'unavailable' }],
    [503, { kind: 'unavailable' }],
  ])('maps %i to %o', async (status, outcome) => {
    const { fetchImpl } = answering(json(status, { title: 'x' }))
    expect(await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE)).toEqual(outcome)
  })

  it('reports rate limiting with the server’s retry-after', async () => {
    const { fetchImpl } = answering(json(429, {}, { 'retry-after': '17' }))
    expect(await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE)).toEqual({
      kind: 'rate-limited',
      retryAfterSeconds: 17,
    })
  })

  it('reports a network failure or an abort as unavailable, and never throws', async () => {
    const { fetchImpl } = answering(new TypeError('Failed to fetch'))
    expect(await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE)).toEqual({
      kind: 'unavailable',
    })
    const aborted = answering(new DOMException('aborted', 'AbortError'))
    expect(await catalogApi('/api', () => 'tok', aborted.fetchImpl).lookup(CODE)).toEqual({
      kind: 'unavailable',
    })
  })

  it('passes the abort signal to fetch', async () => {
    const { calls, fetchImpl } = answering(json(200, ANSWER))
    const controller = new AbortController()
    await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE, controller.signal)
    expect(calls[0]?.init?.signal).toBe(controller.signal)
  })

  it('treats a 200 that is not a catalogue answer as unavailable', async () => {
    for (const body of [{}, { ...ANSWER, source: 'guess' }, 'nope']) {
      const { fetchImpl } = answering(json(200, body))
      expect(await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE)).toEqual({
        kind: 'unavailable',
      })
    }
    const garbled = answering(new Response('<html>', { status: 200 }))
    expect(await catalogApi('/api', () => 'tok', garbled.fetchImpl).lookup(CODE)).toEqual({
      kind: 'unavailable',
    })
  })

  it('never writes the code to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    )
    for (const response of [new TypeError('x'), json(500, {}), json(200, {})]) {
      await catalogApi('/api', () => 'tok', answering(response).fetchImpl).lookup(CODE)
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('retryAfterSeconds', () => {
  it.each([
    ['17', 17],
    ['0.2', 1],
    ['99999', 3600],
    ['0', DEFAULT_RETRY_AFTER_SECONDS],
    ['Wed, 21 Oct 2026 07:28:00 GMT', DEFAULT_RETRY_AFTER_SECONDS],
    [null, DEFAULT_RETRY_AFTER_SECONDS],
  ])('%s → %i', (header, seconds) => {
    expect(retryAfterSeconds(header)).toBe(seconds)
  })
})

describe('isCatalogLookup', () => {
  it('accepts a found answer with a vendor and a product', () => {
    expect(
      isCatalogLookup({
        ...ANSWER,
        source: 'dcl',
        product: {
          name: 'P2',
          label: null,
          partNumber: 'AS056',
          deviceTypeId: 21,
          productUrl: null,
          supportUrl: null,
          userManualUrl: null,
          commissioningCustomFlow: 0,
          commissioningCustomFlowUrl: null,
          commissioningInstructions: null,
          factoryResetInstructions: null,
        },
      }),
    ).toBe(true)
  })

  it('refuses a product whose fields have the wrong types', () => {
    expect(isCatalogLookup({ ...ANSWER, product: { name: 7 } })).toBe(false)
    expect(isCatalogLookup({ ...ANSWER, vendor: { name: 'x', preferredName: 3 } })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure.**
Run: `npx vitest run --project ui-node test/ui/catalog.test.ts`
Expected: FAIL, cannot load `../../src/ui/catalog.js`.

- [ ] **Step 3: Implement.** Create `frontend/src/ui/catalog.ts`:

```ts
/**
 * The catalogue lookup: manufacturer and product for a setup code, from our own API.
 *
 * **The code goes to our API, in a POST body.** It is a secret (it contains the passcode), so it
 * never appears in a URL, a log or an error. The backend decodes it in memory and sends only
 * vendor and product ids to the DCL (spec §Security). Nothing here writes to the console.
 *
 * **It never throws.** Every caller treats a failed lookup the same way (save without names, let
 * backfill catch up), so a failure is an outcome to switch on, not an exception to remember to
 * catch. The status decides the outcome, never the problem title.
 *
 * @module
 */

import type { CatalogLookup } from '../domain/index.js'

/** What a lookup came to. */
export type LookupOutcome =
  | { readonly kind: 'found'; readonly lookup: CatalogLookup }
  /** No token, or the API said 401. */
  | { readonly kind: 'signed-out' }
  /** 429: wait this long before the next request. */
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  /** A network error, an abort, a 5xx, or an answer that is not a catalogue answer. */
  | { readonly kind: 'unavailable' }
  /** 400 or 422: the code cannot be looked up, now or later. */
  | { readonly kind: 'unusable' }

/** How lookups are made. Injected so views and backfill test without a server. */
export interface CatalogApi {
  lookup(code: string, signal?: AbortSignal): Promise<LookupOutcome>
}

/** Used when a 429 carries no usable `retry-after` (absent, zero, or an HTTP date). */
export const DEFAULT_RETRY_AFTER_SECONDS = 60

/** The longest wait honoured, so one bad header cannot park backfill for a day. */
const MAX_RETRY_AFTER_SECONDS = 3600

const UNAVAILABLE: LookupOutcome = { kind: 'unavailable' }
const SOURCES: readonly unknown[] = ['dcl', 'test-vendor', 'missing']

/** Seconds to wait from a `retry-after` header given in seconds. */
export function retryAfterSeconds(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header)
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_SECONDS
  return Math.min(Math.max(1, Math.ceil(seconds)), MAX_RETRY_AFTER_SECONDS)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const stringOrNull = (value: unknown): boolean => value === null || typeof value === 'string'
const numberOrNull = (value: unknown): boolean => value === null || typeof value === 'number'

function isVendor(value: unknown): boolean {
  if (value === null) return true
  if (!isRecord(value) || typeof value.name !== 'string') return false
  return [value.preferredName, value.legalName, value.landingPageUrl].every(stringOrNull)
}

function isProduct(value: unknown): boolean {
  if (value === null) return true
  if (!isRecord(value) || typeof value.name !== 'string') return false
  if (typeof value.commissioningCustomFlow !== 'number' || !numberOrNull(value.deviceTypeId)) {
    return false
  }
  return [
    value.label,
    value.partNumber,
    value.productUrl,
    value.supportUrl,
    value.userManualUrl,
    value.commissioningCustomFlowUrl,
    value.commissioningInstructions,
    value.factoryResetInstructions,
  ].every(stringOrNull)
}

/**
 * Whether a parsed 200 body really is a catalogue answer.
 *
 * Checked by shape at the trust boundary, as `requestTokens` does: a proxy's HTML page or an
 * older server must become `unavailable`, not a device named `undefined`.
 */
export function isCatalogLookup(body: unknown): body is CatalogLookup {
  return (
    isRecord(body) &&
    typeof body.vendorId === 'number' &&
    typeof body.productId === 'number' &&
    SOURCES.includes(body.source) &&
    typeof body.fetchedAt === 'string' &&
    typeof body.stale === 'boolean' &&
    isVendor(body.vendor) &&
    isProduct(body.product)
  )
}

/**
 * The API client.
 *
 * @param baseUrl `/api`, behind the application's own origin
 * @param token the access token getter, as `projectsApi` takes it; with none held, `lookup`
 *   answers `signed-out` without a request
 * @param fetchImpl injected by tests
 */
export function catalogApi(
  baseUrl: string,
  token: () => string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogApi {
  const base = baseUrl.replace(/\/+$/, '')

  return {
    async lookup(code: string, signal?: AbortSignal): Promise<LookupOutcome> {
      const held = token()
      if (held === undefined) return { kind: 'signed-out' }

      let response: Response
      try {
        response = await fetchImpl(`${base}/catalog/lookup`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${held}`,
          },
          body: JSON.stringify({ code }),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch {
        // Offline, a dropped connection, or aborted because the code changed. Not logged: the
        // request carried the code.
        return UNAVAILABLE
      }

      if (response.status === 401) return { kind: 'signed-out' }
      if (response.status === 429) {
        return {
          kind: 'rate-limited',
          retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')),
        }
      }
      if (response.status === 400 || response.status === 422) return { kind: 'unusable' }
      if (!response.ok) return UNAVAILABLE

      let body: unknown
      try {
        body = await response.json()
      } catch {
        return UNAVAILABLE
      }
      return isCatalogLookup(body) ? { kind: 'found', lookup: body } : UNAVAILABLE
    },
  }
}
```

In `composition.ts` add `import { type CatalogApi, catalogApi } from './catalog.js'` (sorted with the other imports) and after `profile()`:

```ts
/**
 * The catalogue lookup: manufacturer and product for a setup code (#227).
 *
 * The same token getter as {@link projects}: a lookup made with no token held answers
 * `signed-out` without a request.
 */
export function catalog(fetchImpl: typeof fetch = fetch): CatalogApi {
  return catalogApi(API_BASE, accessToken, fetchImpl)
}
```

- [ ] **Step 4: Run to verify it passes.**
Run: `npx vitest run --project ui-node test/ui/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/ui/catalog.ts src/ui/composition.ts test/ui/catalog.test.ts
git commit -m "feat(web): catalogApi client for the catalogue lookup (#227)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task C2: Shared read-only catalogue lines in the device form

**Files:**
- Modify: `frontend/src/ui/views/device-form.ts:1-15` (imports), after `messageFor` (new methods)
- Create: `frontend/test/ui/support/catalog.ts`

**Interfaces:**
- Consumes: `catalogFields`, `manufacturerName`, `CatalogLookup` (Part A).
- Produces: in `device-form.ts`: `export interface CatalogNames { readonly manufacturer?: string | undefined; readonly product?: string | undefined }`; `export function catalogNames(lookup: CatalogLookup): CatalogNames`; `protected renderCatalogLines(names: CatalogNames): TemplateResult | ''` on `DeviceFormView` (markup: `[data-catalog]`, `[data-catalog-manufacturer]`, `[data-catalog-product]`). Test support: `AQARA_LOOKUP: CatalogLookup`, `aqaraPayload(): string`, `fakeCatalog(answer)`.

- [ ] **Step 1: Load the `webawesome-design` and `webawesome` skills** (CLAUDE.md). Read `references/layouts-inpage.md` (this is a piece of a page: utilities only).

- [ ] **Step 2: Create the test support.** `frontend/test/ui/support/catalog.ts`:

```ts
import type { CatalogLookup } from '../../../src/domain/index.js'
import { encodePayload } from '../../../src/domain/index.js'
import type { CatalogApi, LookupOutcome } from '../../../src/ui/catalog.js'

/** The recorded Aqara answer (vendor 4447, model 4447/8194), as the API maps it. */
export const AQARA_LOOKUP: CatalogLookup = {
  vendorId: 4447,
  productId: 8194,
  source: 'dcl',
  vendor: {
    name: 'Aqara',
    preferredName: 'Aqara Home',
    legalName: 'Lumi United Technology Co., Ltd.',
    landingPageUrl: 'https://www.aqara.com/',
  },
  product: {
    name: 'Aqara Door and Window Sensor P2',
    label: 'Aqara Door and Window Sensor P2',
    partNumber: 'AS056',
    deviceTypeId: 21,
    productUrl: 'https://www.aqara.com/en/products.html',
    supportUrl: null,
    userManualUrl: null,
    commissioningCustomFlow: 0,
    commissioningCustomFlowUrl: null,
    commissioningInstructions: '1. Please make sure the sensor is powered.',
    factoryResetInstructions: null,
  },
  fetchedAt: '2026-10-05T16:20:00.000Z',
  stale: false,
}

/**
 * A real `MT:` payload for vendor 4447, product 8194, built by our own encoder.
 *
 * Encoded rather than written out so nobody has to trust a hand-copied Base38 string; the
 * reference passcode and discriminator are reused.
 */
export function aqaraPayload(): string {
  return encodePayload({
    version: 0,
    vendorId: 4447,
    productId: 8194,
    customFlow: 'standard',
    discovery: { softAp: false, ble: true, onNetwork: false, raw: 0b010 },
    discriminator: 3840,
    passcode: 20202021,
    extension: new Uint8Array(),
  })
}

/** A catalogue that records every call and answers with whatever the test says. */
export function fakeCatalog(answer: (code: string) => Promise<LookupOutcome>) {
  const calls: Array<{ readonly code: string; readonly signal: AbortSignal | undefined }> = []
  const api: CatalogApi = {
    lookup: (code, signal) => {
      calls.push({ code, signal })
      return answer(code)
    },
  }
  return { api, calls }
}

/** A promise the test settles by hand, for answers that must arrive at a chosen moment. */
export function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
```

- [ ] **Step 3: Implement the shared lines.** In `device-form.ts` extend the domain import with `type CatalogLookup, catalogFields, manufacturerName,` and add after `fieldValue`:

```ts
/** The two names a form shows from the catalogue, either possibly unknown. */
export interface CatalogNames {
  readonly manufacturer?: string | undefined
  readonly product?: string | undefined
}

/**
 * The names a catalogue answer gives, by the same rules the device document will get them.
 *
 * Through `catalogFields` rather than read off the answer, so the form never shows a name the
 * saved device would not have (a blank one, or a test vendor's server-side spelling).
 */
export function catalogNames(lookup: CatalogLookup): CatalogNames {
  const fields = catalogFields(lookup, '')
  return { manufacturer: manufacturerName(fields), product: fields.productName }
}
```

and in `DeviceFormView`, after `messageFor`:

```ts
  /**
   * The manufacturer and product, read-only, or nothing when neither is known.
   *
   * Read-only on both forms: these come from the catalogue and are replaced whole when it is
   * asked again, so an edit here would be silently undone (spec §Editing).
   */
  protected renderCatalogLines(names: CatalogNames): TemplateResult | '' {
    if (names.manufacturer === undefined && names.product === undefined) return ''
    return html`
      <div class="wa-cluster wa-gap-l" data-catalog>
        ${
          names.manufacturer === undefined
            ? ''
            : html`<div class="wa-stack wa-gap-3xs">
                <small class="app-empty">${msg('Manufacturer')}</small>
                <span data-catalog-manufacturer>${names.manufacturer}</span>
              </div>`
        }
        ${
          names.product === undefined
            ? ''
            : html`<div class="wa-stack wa-gap-3xs">
                <small class="app-empty">${msg('Product')}</small>
                <span data-catalog-product>${names.product}</span>
              </div>`
        }
      </div>
    `
  }
```

- [ ] **Step 4: Typecheck.**
Run: `npm run typecheck && npx biome check src/ui/views/device-form.ts test/ui/support/catalog.ts`
Expected: no errors, no warnings. (Behaviour is tested through the add form in Task C3 and the edit form in Task E2.)

- [ ] **Step 5: Commit.**

```bash
git add src/ui/views/device-form.ts test/ui/support/catalog.ts
git commit -m "feat(web): read-only manufacturer and product lines for the device forms (#227)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task C3: The add form looks the code up in the background

**Files:**
- Modify: `frontend/src/ui/views/add-device.ts` (imports `:1-15`; properties `:42-49`; fields; `onScan :119-126`; `onUpload :155-169`; `onSubmit :198-203`; `render :235-242`; new `disconnectedCallback`)
- Test: `frontend/test/ui/views/add-device.browser.test.ts` (helper + new `describe`)
- Regenerate: `frontend/xliff/de.xlf`, `frontend/src/ui/generated/locales/de.ts`

**Interfaces:**
- Consumes: `CatalogApi`, `LookupOutcome` (C1); `catalog()` (composition); `catalogNames`, `renderCatalogLines` (C2); `planNewDevice(…, catalog?)` (A3); `accessToken()`.
- Produces: `export const LOOKUP_DEBOUNCE_MS = 300`; on `AddDeviceView`: `catalog?: CatalogApi` (property, `attribute: false`), `signedIn: () => boolean`, `online: () => boolean` (plain fields, bound by tests); markup `[data-catalog-status]` (always present, `role="status"`), `[data-catalog-pending]`.

- [ ] **Step 1: Load the `webawesome-design` and `webawesome` skills.** Check `references/components/input.md` for the events `wa-input` emits (`input`, `change`).

- [ ] **Step 2: Write the failing tests.** In `add-device.browser.test.ts`, add imports:

```ts
import type { CatalogApi, LookupOutcome } from '../../../src/ui/catalog.js'
import { AQARA_LOOKUP, aqaraPayload, deferred, fakeCatalog } from '../support/catalog.js'
```

Add `catalog` to `form()` (default `undefined` keeps every existing test as it was: no token is held in tests, so no lookup runs):

```ts
async function form(
  repositories: ProjectRepositories = database.repositories,
  scanSource: ScanSource | undefined = neverAvailable(),
  catalog?: { api: CatalogApi; online?: boolean },
): Promise<AddDeviceView> {
  await Promise.all([
    customElements.whenDefined('wa-input'),
    customElements.whenDefined('wa-combobox'),
    customElements.whenDefined('wa-option'),
  ])
  return (await fixture(
    html`<add-device-view
      .repositories=${repositories}
      .scanSource=${scanSource}
      .catalog=${catalog?.api}
      .signedIn=${() => catalog !== undefined}
      .online=${() => catalog?.online ?? true}
    ></add-device-view>`,
  )) as AddDeviceView
}

/** Types into the setup-code field the way a keyboard does: value, then an `input` event. */
function typeCode(element: HTMLElement, code: string): void {
  fill(element, 'credential', code)
  element
    .querySelector('[data-field="credential"]')
    ?.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
}

const found = (): Promise<LookupOutcome> =>
  Promise.resolve({ kind: 'found', lookup: AQARA_LOOKUP })
```

Append:

```ts
describe('looking up the manufacturer', () => {
  it('shows a quiet hint while it asks, then the names', async () => {
    const answer = deferred<LookupOutcome>()
    const { api, calls } = fakeCatalog(() => answer.promise)
    const element = await form(database.repositories, neverAvailable(), { api })

    typeCode(element, aqaraPayload())
    await waitUntil(() => element.querySelector('[data-catalog-pending]') !== null, 'no hint')
    expect(element.querySelector('[data-catalog-status]')?.getAttribute('role')).toBe('status')
    expect(calls[0]?.code).toBe(aqaraPayload())

    answer.resolve({ kind: 'found', lookup: AQARA_LOOKUP })
    await waitUntil(() => element.querySelector('[data-catalog]') !== null, 'no names')
    expect(element.querySelector('[data-catalog-pending]')).toBeNull()
    // The preferred name, not the vendor name: what people call the company.
    expect(element.querySelector('[data-catalog-manufacturer]')?.textContent).toBe('Aqara Home')
    expect(element.querySelector('[data-catalog-product]')?.textContent).toBe(
      'Aqara Door and Window Sensor P2',
    )
  })

  it('waits for typing to pause before asking', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })

    typeCode(element, aqaraPayload())
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls).toHaveLength(0)
    await waitUntil(() => calls.length === 1, 'never asked', { timeout: 1000 })
  })

  it('copies the answer into the saved device', async () => {
    const { api } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => element.querySelector('[data-catalog]') !== null, 'no names')

    fill(element, 'name', 'Front door sensor')
    typeRoom(element, 'Hall')
    await submit(element, async () => (await devices()).length === 1)

    const [device] = await devices()
    expect(device?.vendorName).toBe('Aqara')
    expect(device?.vendorPreferredName).toBe('Aqara Home')
    expect(device?.partNumber).toBe('AS056')
    expect(device?.catalogSource).toBe('found')
    expect(device?.payloadVersion).toBe(0)
    expect(device?.discovery).toEqual({ softAp: false, ble: true, onNetwork: false })
  })

  it('asks nothing while the browser is offline, and saves without names', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api, online: false })
    typeCode(element, aqaraPayload())
    fill(element, 'name', 'Front door sensor')
    typeRoom(element, 'Hall')
    await new Promise((resolve) => setTimeout(resolve, 400))

    await submit(element, async () => (await devices()).length === 1)

    expect(calls).toHaveLength(0)
    const [device] = await devices()
    expect(device).not.toHaveProperty('vendorName')
    expect(device).not.toHaveProperty('catalogCheckedAt')
  })

  it('shows nothing alarming when the lookup fails, and saves without names', async () => {
    const { api } = fakeCatalog(() => Promise.resolve({ kind: 'unavailable' }))
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await new Promise((resolve) => setTimeout(resolve, 400))
    await element.updateComplete

    expect(element.querySelector('[data-catalog]')).toBeNull()
    expect(element.querySelector('wa-callout')).toBeNull()
  })

  it('aborts the earlier lookup when the code changes', async () => {
    const { api, calls } = fakeCatalog(() => new Promise<LookupOutcome>(() => {}))
    const element = await form(database.repositories, neverAvailable(), { api })

    typeCode(element, aqaraPayload())
    await waitUntil(() => calls.length === 1, 'never asked')
    typeCode(element, '749701123365521327687')

    expect(calls[0]?.signal?.aborted).toBe(true)
    // A 21-digit code carries the ids, so it is looked up too, by its digits.
    await waitUntil(() => calls.length === 2, 'the new code was never asked')
    expect(calls[1]?.code).toBe('749701123365521327687')
  })

  it('never asks about an 11-digit code, which carries no ids', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, SHORT_CODE)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(calls).toHaveLength(0)
  })

  it('aborts the lookup when the form closes', async () => {
    const { api, calls } = fakeCatalog(() => new Promise<LookupOutcome>(() => {}))
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => calls.length === 1, 'never asked')

    element.remove()

    expect(calls[0]?.signal?.aborted).toBe(true)
  })

  it('does not wait for a slow lookup before saving, and ignores it when it lands', async () => {
    const answer = deferred<LookupOutcome>()
    const { api, calls } = fakeCatalog(() => answer.promise)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => calls.length === 1, 'never asked')

    fill(element, 'name', 'Front door sensor')
    typeRoom(element, 'Hall')
    await submit(element, async () => (await devices()).length === 1)
    answer.resolve({ kind: 'found', lookup: AQARA_LOOKUP })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const all = await devices()
    expect(all).toHaveLength(1)
    expect(all[0]).not.toHaveProperty('vendorName')
  })

  it('drops the names when the code is edited after they arrived', async () => {
    const { api } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => element.querySelector('[data-catalog]') !== null, 'no names')

    typeCode(element, SHORT_CODE)
    await element.updateComplete
    expect(element.querySelector('[data-catalog]')).toBeNull()

    fill(element, 'name', 'Hall sensor')
    typeRoom(element, 'Hall')
    await submit(element, async () => (await devices()).length === 1)
    expect((await devices())[0]).not.toHaveProperty('vendorName')
  })

  it('looks up a code that arrives from the camera', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, scanningSource(aqaraPayload()), { api })
    await waitUntil(() => element.querySelector('[data-scan]') !== null)
    ;(element.querySelector('[data-scan]') as HTMLElement).click()
    await waitUntil(() => calls.length === 1, 'a scanned code was never looked up')
  })
})
```

- [ ] **Step 3: Run to verify failure.**
Run: `npx vitest run --project ui test/ui/views/add-device.browser.test.ts`
Expected: the new tests FAIL (`no hint`, `never asked`); every existing test still PASSES.

- [ ] **Step 4: Implement.** In `add-device.ts`, change the imports:

```ts
import { msg } from '@lit/localize'
import { html, type TemplateResult } from 'lit'
import {
  type CatalogLookup,
  type DeviceDraft,
  DraftError,
  PayloadError,
  type PayloadProblem,
  planNewDevice,
  readCredential,
} from '../../domain/index.js'
import type { CatalogApi } from '../catalog.js'
import { catalog } from '../composition.js'
import { imageMessage } from '../i18n/problems.js'
import { codesFromImage, type ImageProblem, ImageScanError } from '../scan/image.js'
import { cameraSource, type ScanSource } from '../scan/source.js'
import { accessToken } from '../tokens.js'
import { catalogNames, DeviceFormView, fieldValue } from './device-form.js'
import './scan-dialog.js'
```

Add after `today()`:

```ts
/** How long typing must pause before the code is looked up (spec §Adding a device). */
export const LOOKUP_DEBOUNCE_MS = 300

/** Where the background lookup stands, and for which code. */
type LookupState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly code: string }
  | { readonly kind: 'found'; readonly code: string; readonly result: CatalogLookup }

const IDLE: LookupState = { kind: 'idle' }
```

Add to `static override properties`: `catalog: { attribute: false }, lookupState: { state: true },` and in the class body after `decodeImage`:

```ts
  /** Bound by a test to a fake; the real API otherwise. */
  declare catalog?: CatalogApi
  /** Where the background lookup stands. Never read by anything that saves except `onSubmit`. */
  declare lookupState: LookupState
  /**
   * Whether a lookup may be attempted at all. Plain fields rather than reactive properties,
   * like {@link decodeImage}: a test binds them, nothing renders from them.
   *
   * `signedIn` asks for a token rather than the shell's session state, which this view cannot
   * see; a token is exactly what the request needs.
   */
  signedIn: () => boolean = () => accessToken() !== undefined
  /** `navigator.onLine` is trusted only to say *offline* (`connectivity.ts`). */
  online: () => boolean = () => navigator.onLine !== false

  private lookupTimer: ReturnType<typeof setTimeout> | undefined
  private lookupAbort: AbortController | undefined
```

In the constructor add `this.lookupState = IDLE`. Add the methods (after `checkScanning`):

```ts
  override disconnectedCallback(): void {
    // The form closing is one of the two moments the spec aborts a lookup; the other is the
    // code changing. Nothing reactive is set here: the element is leaving.
    this.stopLookup()
    super.disconnectedCallback()
  }

  /**
   * The code as the catalogue should receive it, or `undefined` when there is nothing to ask:
   * not a readable code, or an 11-digit code, which carries no vendor or product id.
   *
   * Normalised (the payload, or the digits of a manual code), so "the same code typed with a
   * trailing space" is recognised as the same question.
   */
  private lookupCode(): string | undefined {
    let credential: ReturnType<typeof readCredential>
    try {
      credential = readCredential(fieldValue(this, '[data-field="credential"]'))
    } catch {
      return undefined
    }
    if (credential.vendorId === undefined || credential.productId === undefined) return undefined
    return credential.payload ?? credential.manualCode
  }

  /** Stops whatever is scheduled or in flight, without touching what is shown. */
  private stopLookup(): void {
    clearTimeout(this.lookupTimer)
    this.lookupTimer = undefined
    this.lookupAbort?.abort()
    this.lookupAbort = undefined
  }

  /**
   * Starts a lookup for whatever the field now holds, after the debounce.
   *
   * Called on every change of the field: typing, a scan, an upload. Anything already scheduled
   * or in flight is aborted first, and the names on screen go with it, because they describe a
   * code that is no longer there. Never awaited by anything: submit reads {@link lookupState}
   * as it is at that moment.
   */
  private scheduleLookup(): void {
    const code = this.lookupCode()
    const state = this.lookupState
    if (code !== undefined && state.kind !== 'idle' && state.code === code) return

    this.stopLookup()
    this.lookupState = IDLE
    if (code === undefined || !this.signedIn() || !this.online()) return

    const controller = new AbortController()
    this.lookupAbort = controller
    this.lookupTimer = setTimeout(() => {
      void this.runLookup(code, controller.signal)
    }, LOOKUP_DEBOUNCE_MS)
  }

  private async runLookup(code: string, signal: AbortSignal): Promise<void> {
    this.lookupTimer = undefined
    this.lookupState = { kind: 'pending', code }
    const outcome = await (this.catalog ?? catalog()).lookup(code, signal)
    // Aborted means a newer question replaced this one, or the form closed; either way this
    // answer is about nothing on screen.
    if (signal.aborted) return
    this.lookupAbort = undefined
    // Every failure ends the same way: no names, nothing alarming. Backfill catches up later.
    this.lookupState =
      outcome.kind === 'found' ? { kind: 'found', code, result: outcome.lookup } : IDLE
  }

  /**
   * The answer to pass to `planNewDevice`, or `undefined`.
   *
   * Only an answer for the code in the field *now*: one that landed for the code before it was
   * corrected must not name this device.
   */
  private answerForSave(): CatalogLookup | undefined {
    const state = this.lookupState
    return state.kind === 'found' && state.code === this.lookupCode() ? state.result : undefined
  }

  /** The hint while asking, the names once answered. Always in the tree, so it is announced. */
  private renderLookup(): TemplateResult {
    const state = this.lookupState
    return html`
      <div role="status" data-catalog-status>
        ${
          state.kind === 'pending'
            ? html`<small class="app-empty" data-catalog-pending>
                ${msg('Looking up manufacturer…')}
              </small>`
            : ''
        }
        ${state.kind === 'found' ? this.renderCatalogLines(catalogNames(state.result)) : ''}
      </div>
    `
  }
```

In `onScan`, after `this.setControlValue(...)` add `this.scheduleLookup()`. In `onUpload`, after `this.setControlValue('[data-field="credential"]', code)` add `this.scheduleLookup()`. In `onSubmit`, replace the `planNewDevice(...)` call with:

```ts
        creation = planNewDevice(
          this.draft(),
          rooms,
          {
            uuid: () => crypto.randomUUID(),
            now: () => new Date().toISOString(),
          },
          // Whatever has arrived by now. Submit never waits for a lookup: saving offline, or
          // before the answer, is the normal case, and backfill fills the names in later.
          this.answerForSave(),
        )
```

In `render`, give the credential input an `@input` handler and render the status right after it:

```ts
          <wa-input
            data-field="credential"
            label=${msg('Setup code')}
            hint=${this.messageFor('credential') ?? msg('The MT: code from the QR label, or the numeric pairing code beneath it.')}
            autocomplete="off"
            spellcheck="false"
            @input=${() => this.scheduleLookup()}
          ></wa-input>

          ${this.renderLookup()}
```

- [ ] **Step 5: Run to verify it passes.**
Run: `npx vitest run --project ui test/ui/views/add-device.browser.test.ts`
Expected: PASS, no console output.

- [ ] **Step 6: German.** Run `npm run i18n:extract`. Open `xliff/de.xlf`; for each new unit add a `<target>`:

| `<source>` | `<target>` |
| --- | --- |
| `Looking up manufacturer…` | `Hersteller wird gesucht …` |
| `Manufacturer` | `Hersteller` |

(`Product` exists: `Produkt`.) Then `npm run i18n:build && npm run check:i18n`. Expected: `check:i18n` passes (no missing targets, generated files current).

- [ ] **Step 7: Verify and commit.**
Run (repo root): `npm run verify`. Expected: exits 0, zero warnings, `src/ui` ≥ 70%.

```bash
git add src/ui/views/add-device.ts test/ui/views/add-device.browser.test.ts xliff/de.xlf src/ui/generated
git commit -m "feat(web): look up the manufacturer while a device is added (#227)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Push `feat/catalog-lookup-227`, open the PR against `feat/catalog-capture-225` (`Closes #227`).

---

## Part D — Backfill when online (#228)

| File | Change | Responsibility |
| --- | --- | --- |
| `frontend/src/ui/catalog-backfill.ts` | Create | `catalogBackfill(deps)` runner, `abortableDelay`, `defaultCatalogBackfill()` |
| `frontend/src/ui/app-shell.ts` | Modify | Start on sign-in, regained network and project switch; stop on sign-out, session end, switch, disconnect |
| `frontend/test/ui/catalog-backfill.browser.test.ts` | Create | Runner against a real browser database and a fake API |
| `frontend/test/ui/app-shell.browser.test.ts` | Modify | Shell triggers |

### Task D1: The backfill runner

**Files:**
- Create: `frontend/src/ui/catalog-backfill.ts`
- Test: `frontend/test/ui/catalog-backfill.browser.test.ts`

**Interfaces:**
- Consumes: `needsCatalogLookup`, `catalogFields`, `withCatalogBlock`, `DeviceDocument` (Part A); `CatalogApi`, `LookupOutcome` (C1); `catalog()` (composition); `Repository<DeviceDocument>` (`src/data`); `projectDatabase()`, `projectIsEditable()` (`ui/db/project-database.ts`).
- Produces:
  - `export const BACKFILL_GAP_MS = 1000`
  - `export interface BackfillDependencies { readonly lookup: CatalogApi['lookup']; readonly devices: () => Repository<DeviceDocument>; readonly editable: () => boolean; readonly now: () => Date; readonly wait: (ms: number, signal: AbortSignal) => Promise<void> }`
  - `export interface CatalogBackfill { trigger(): void; stop(): void; idle(): Promise<void> }`
  - `export function catalogBackfill(deps: BackfillDependencies): CatalogBackfill`
  - `export function abortableDelay(ms: number, signal: AbortSignal): Promise<void>`
  - `export function defaultCatalogBackfill(): CatalogBackfill`

- [ ] **Step 1: Write the failing tests.** Create `frontend/test/ui/catalog-backfill.browser.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repository } from '../../src/data/index.js'
import type { DeviceDocument, Unsaved } from '../../src/domain/index.js'
import type { LookupOutcome } from '../../src/ui/catalog.js'
import {
  abortableDelay,
  BACKFILL_GAP_MS,
  type BackfillDependencies,
  catalogBackfill,
} from '../../src/ui/catalog-backfill.js'
import { browserDatabase, type TestDatabase } from './support/browser-database.js'
import { AQARA_LOOKUP, deferred, fakeCatalog } from './support/catalog.js'

const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const LONG_CODE = '749701123365521327687'
const SHORT_CODE = '34970112332'
const NOW = new Date('2026-10-07T12:00:00.000Z')

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
})

afterEach(async () => {
  await database.destroy()
})

const device = (id: string, extra: Partial<DeviceDocument> = {}): Unsaved<DeviceDocument> => ({
  _id: `device:${id}`,
  type: 'device',
  name: `Device ${id}`,
  roomId: 'room:hall',
  manualCode: LONG_CODE,
  payload: PAYLOAD,
  spot: 'door frame',
  serial: 'SN-1',
  installedAt: '2026-10-01',
  addedAt: '2026-10-01T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

/** The runner with a fake API, the test database, and a wait that only records. */
function runner(
  answer: (code: string) => Promise<LookupOutcome>,
  overrides: Partial<BackfillDependencies> = {},
) {
  const { api, calls } = fakeCatalog(answer)
  const waits: number[] = []
  const backfill = catalogBackfill({
    lookup: api.lookup,
    devices: () => database.repositories.devices,
    editable: () => true,
    now: () => NOW,
    wait: async (ms) => {
      waits.push(ms)
    },
    ...overrides,
  })
  return { backfill, calls, waits }
}

const found = (): Promise<LookupOutcome> =>
  Promise.resolve({ kind: 'found', lookup: AQARA_LOOKUP })

describe('catalogue backfill', () => {
  it('writes the block once, then skips the device', async () => {
    await database.repositories.devices.save(device('a'))
    const { backfill, calls } = runner(found)

    backfill.trigger()
    await backfill.idle()
    backfill.trigger()
    await backfill.idle()

    expect(calls).toHaveLength(1)
    const stored = await database.repositories.devices.get('device:a')
    expect(stored?.vendorName).toBe('Aqara')
    expect(stored?.catalogCheckedAt).toBe(NOW.toISOString())
  })

  it('never touches what the user entered', async () => {
    await database.repositories.devices.save(
      device('a', {
        remarks: [
          {
            id: 'r1',
            text: 'Battery replaced',
            authorSub: 's',
            authorName: 'S',
            createdAt: '2026-10-02T00:00:00.000Z',
          },
        ],
      }),
    )
    const before = await database.repositories.devices.get('device:a')
    const { backfill } = runner(found)

    backfill.trigger()
    await backfill.idle()

    const after = await database.repositories.devices.get('device:a')
    for (const key of ['name', 'roomId', 'spot', 'serial', 'installedAt', 'addedAt', 'disabled', 'remarks', 'manualCode', 'payload'] as const) {
      expect(after?.[key]).toEqual(before?.[key])
    }
  })

  it('asks for a 21-digit code by its digits, and never for an 11-digit one', async () => {
    const { payload: _payload, ...manualOnly } = device('long')
    await database.repositories.devices.save(manualOnly)
    const { payload: _p, ...short } = device('short', { manualCode: SHORT_CODE })
    await database.repositories.devices.save(short)
    const { backfill, calls } = runner(found)

    backfill.trigger()
    await backfill.idle()

    expect(calls.map((call) => call.code)).toEqual([LONG_CODE])
  })

  it('does nothing in a project that cannot be edited', async () => {
    await database.repositories.devices.save(device('a'))
    const { backfill, calls } = runner(found, { editable: () => false })

    backfill.trigger()
    await backfill.idle()

    expect(calls).toHaveLength(0)
    expect((await database.repositories.devices.get('device:a'))?.catalogCheckedAt).toBeUndefined()
  })

  it('stops at the first network failure and writes nothing', async () => {
    await database.repositories.devices.save(device('a'))
    await database.repositories.devices.save(device('b'))
    const { backfill, calls } = runner(() => Promise.resolve({ kind: 'unavailable' }))

    backfill.trigger()
    await backfill.idle()

    expect(calls).toHaveLength(1)
    const all = await database.repositories.devices.list()
    expect(all.every((d) => d.catalogCheckedAt === undefined)).toBe(true)
  })

  it('stops when signed out', async () => {
    await database.repositories.devices.save(device('a'))
    await database.repositories.devices.save(device('b'))
    const { backfill, calls } = runner(() => Promise.resolve({ kind: 'signed-out' }))
    backfill.trigger()
    await backfill.idle()
    expect(calls).toHaveLength(1)
  })

  it('leaves one second between requests', async () => {
    for (const id of ['a', 'b', 'c']) await database.repositories.devices.save(device(id))
    const { backfill, waits } = runner(found)
    backfill.trigger()
    await backfill.idle()
    expect(waits).toEqual([BACKFILL_GAP_MS, BACKFILL_GAP_MS])
  })

  it('waits for retry-after on 429, then asks the same device again', async () => {
    await database.repositories.devices.save(device('a'))
    let first = true
    const { backfill, calls, waits } = runner(() => {
      if (first) {
        first = false
        return Promise.resolve({ kind: 'rate-limited', retryAfterSeconds: 17 })
      }
      return found()
    })

    backfill.trigger()
    await backfill.idle()

    expect(waits).toEqual([17_000])
    expect(calls.map((call) => call.code)).toEqual([PAYLOAD, PAYLOAD])
    expect((await database.repositories.devices.get('device:a'))?.catalogSource).toBe('found')
  })

  it('retries a miss after a day, and not before', async () => {
    const day = 24 * 60 * 60 * 1000
    await database.repositories.devices.save(
      device('old', {
        catalogSource: 'missing',
        catalogCheckedAt: new Date(NOW.getTime() - day - 60_000).toISOString(),
      }),
    )
    await database.repositories.devices.save(
      device('fresh', {
        catalogSource: 'missing',
        catalogCheckedAt: new Date(NOW.getTime() - day + 60_000).toISOString(),
      }),
    )
    const { backfill, calls } = runner(found)
    backfill.trigger()
    await backfill.idle()
    expect(calls).toHaveLength(1)
    expect((await database.repositories.devices.get('device:old'))?.catalogSource).toBe('found')
  })

  it('writes nothing after stop, even when the answer was already on its way', async () => {
    // A project switch or a sign-out mid-run: the answer belongs to a project nobody is in.
    await database.repositories.devices.save(device('a'))
    const answer = deferred<LookupOutcome>()
    const { backfill, calls } = runner(() => answer.promise)

    backfill.trigger()
    while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    backfill.stop()
    answer.resolve({ kind: 'found', lookup: AQARA_LOOKUP })
    await backfill.idle()

    expect(calls[0]?.signal?.aborted).toBe(true)
    expect((await database.repositories.devices.get('device:a'))?.catalogCheckedAt).toBeUndefined()
  })

  it('keeps a concurrent user edit, and fills the block on the next run', async () => {
    await database.repositories.devices.save(device('a'))
    const real = database.repositories.devices
    let raced = false
    // The user renames the device between backfill reading it and writing it: the write is
    // refused (409), and must neither throw nor overwrite the rename.
    const racing: Repository<DeviceDocument> = {
      ...real,
      get: async (id) => {
        const read = await real.get(id)
        if (!raced && read !== undefined) {
          raced = true
          const { updatedAt: _stamp, ...unsaved } = read
          await real.save({ ...unsaved, name: 'Renamed by hand' })
        }
        return read
      },
    }
    const { backfill } = runner(found, { devices: () => racing })

    backfill.trigger()
    await backfill.idle()
    expect((await real.get('device:a'))?.name).toBe('Renamed by hand')
    expect((await real.get('device:a'))?.catalogCheckedAt).toBeUndefined()

    backfill.trigger()
    await backfill.idle()
    const after = await real.get('device:a')
    expect(after?.name).toBe('Renamed by hand')
    expect(after?.vendorName).toBe('Aqara')
  })

  it('runs again once when triggered while running, never twice at once', async () => {
    await database.repositories.devices.save(device('a'))
    const answer = deferred<LookupOutcome>()
    let active = 0
    let most = 0
    const { backfill, calls } = runner(async () => {
      active += 1
      most = Math.max(most, active)
      const outcome = await answer.promise
      active -= 1
      return outcome
    })

    backfill.trigger()
    backfill.trigger()
    backfill.trigger()
    answer.resolve({ kind: 'unavailable' })
    await backfill.idle()

    expect(most).toBe(1)
    expect(calls).toHaveLength(2)
  })
})

describe('abortableDelay', () => {
  it('resolves early when aborted', async () => {
    const controller = new AbortController()
    const started = performance.now()
    const waiting = abortableDelay(10_000, controller.signal)
    controller.abort()
    await waiting
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('resolves at once for a signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await abortableDelay(10_000, controller.signal)
  })
})
```

- [ ] **Step 2: Run to verify failure.**
Run: `npx vitest run --project ui test/ui/catalog-backfill.browser.test.ts`
Expected: FAIL, cannot load `../../src/ui/catalog-backfill.js`.

- [ ] **Step 3: Implement.** Create `frontend/src/ui/catalog-backfill.ts`:

```ts
/**
 * Filling in manufacturer and product for devices added offline (#228).
 *
 * A device added in a basement has no names: the lookup never ran. This asks the catalogue for
 * each such device once a session and a network exist, and writes the answer into the device as
 * an ordinary edit, so it syncs and merges like any other (`mergeDevice` keeps the newer block).
 *
 * **Polite by construction.** One request at a time, a second between requests, stop at the
 * first sign the API cannot help (offline, signed out), and on 429 wait as long as asked. The
 * next trigger (sign-in, network back, project switch) starts again from the top; the device
 * documents themselves record what is done, so there is no queue to persist.
 *
 * **Writes only the catalogue block**, on a fresh read, through `devices.save`. A save refused
 * because somebody edited the device in the meantime is left alone: their edit stands, and the
 * next run fills the block on top of it.
 *
 * Nothing is logged: every document here carries a setup code.
 *
 * @module
 */

import type { Repository } from '../data/index.js'
import {
  type CatalogLookup,
  catalogFields,
  type DeviceDocument,
  needsCatalogLookup,
  withCatalogBlock,
} from '../domain/index.js'
import type { CatalogApi } from './catalog.js'
import { catalog } from './composition.js'
import { projectDatabase, projectIsEditable } from './db/project-database.js'

/** The pause between two requests. */
export const BACKFILL_GAP_MS = 1000

/** What backfill needs; every impure thing is injected so the tests control time and network. */
export interface BackfillDependencies {
  readonly lookup: CatalogApi['lookup']
  /** The open project's devices, read at the start of each run. */
  readonly devices: () => Repository<DeviceDocument>
  /** Whether the open project may be written; a read-only shared project is never backfilled. */
  readonly editable: () => boolean
  readonly now: () => Date
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
}

/** A running backfill, as the shell holds it. */
export interface CatalogBackfill {
  /** Starts a run, or asks for one more after the current run. Never runs two at once. */
  trigger(): void
  /** Aborts the current run and forgets any pending one. Nothing is written after this. */
  stop(): void
  /** Settles when no run is in progress. For tests. */
  idle(): Promise<void>
}

/** A `setTimeout` that ends early, and quietly, when the signal aborts. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** What to send: the payload if there is one, else the digits of the manual code. */
const codeOf = (device: DeviceDocument): string => device.payload ?? device.manualCode

/**
 * Writes one answer into one device, on a fresh read.
 *
 * Re-read rather than written over the listed copy: the list may be seconds old, and saving it
 * would quietly revert whatever was edited since. Checked again with `needsCatalogLookup`, so a
 * block written meanwhile by another tab or replica is not replaced by this answer.
 */
async function fill(
  devices: Repository<DeviceDocument>,
  id: string,
  lookup: CatalogLookup,
  deps: BackfillDependencies,
  signal: AbortSignal,
): Promise<void> {
  const fresh = await devices.get(id)
  if (signal.aborted || fresh === undefined) return
  const at = deps.now()
  if (!needsCatalogLookup(fresh, at)) return
  const { updatedAt: _stamp, ...unsaved } = fresh
  try {
    await devices.save(withCatalogBlock(unsaved, catalogFields(lookup, at.toISOString())))
  } catch {
    // A 409: the device changed between the read and the write. The edit stands; the next run
    // fills the block on top of it. Not logged: the document holds the setup code.
  }
}

/** One pass over the open project. Returns early at the first reason to stop. */
async function runOnce(deps: BackfillDependencies, signal: AbortSignal): Promise<void> {
  if (!deps.editable()) return
  const devices = deps.devices()
  const listed = await devices.list()
  const now = deps.now()
  const candidates = listed.filter((device) => needsCatalogLookup(device, now))

  let first = true
  for (const candidate of candidates) {
    for (;;) {
      if (!first) await deps.wait(BACKFILL_GAP_MS, signal)
      first = false
      if (signal.aborted) return

      const outcome = await deps.lookup(codeOf(candidate), signal)
      if (signal.aborted) return

      if (outcome.kind === 'rate-limited') {
        await deps.wait(outcome.retryAfterSeconds * 1000, signal)
        // The retry-after already was the pause; the same device is asked again at once.
        first = true
        continue
      }
      // Offline, a 5xx, or no session: nothing later in this pass would fare better.
      if (outcome.kind === 'unavailable' || outcome.kind === 'signed-out') return
      // `unusable` (a stored code the API cannot read) is skipped, not recorded: it is retried
      // on the next trigger at the cost of one request, rather than marked done on a guess.
      if (outcome.kind === 'found') await fill(devices, candidate._id, outcome.lookup, deps, signal)
      break
    }
  }
}

/**
 * The backfill runner.
 *
 * Coalesces triggers: one arriving mid-run asks for exactly one more run afterwards, which is
 * what a project switch during a run needs (stop, then a run over the new project).
 */
export function catalogBackfill(deps: BackfillDependencies): CatalogBackfill {
  let controller: AbortController | undefined
  let running: Promise<void> | undefined
  let again = false

  const loop = async (): Promise<void> => {
    do {
      again = false
      controller = new AbortController()
      try {
        await runOnce(deps, controller.signal)
      } catch {
        // An unreadable database. The next trigger tries again; nothing is logged (secrets).
      }
    } while (again)
    running = undefined
  }

  return {
    trigger(): void {
      if (running !== undefined) {
        again = true
        return
      }
      running = loop()
    },
    stop(): void {
      again = false
      controller?.abort()
    },
    idle: () => running ?? Promise.resolve(),
  }
}

/** The application's backfill: the real API, the open project, the system clock. */
export function defaultCatalogBackfill(): CatalogBackfill {
  const api = catalog()
  return catalogBackfill({
    lookup: (code, signal) => api.lookup(code, signal),
    devices: () => projectDatabase().devices,
    editable: projectIsEditable,
    now: () => new Date(),
    wait: abortableDelay,
  })
}
```

- [ ] **Step 4: Run to verify it passes.**
Run: `npx vitest run --project ui test/ui/catalog-backfill.browser.test.ts`
Expected: PASS. (If "runs again once when triggered while running" sees 3 calls, the coalescing is wrong: two triggers mid-run must yield exactly one more run.)

- [ ] **Step 5: Commit.**

```bash
git add src/ui/catalog-backfill.ts test/ui/catalog-backfill.browser.test.ts
git commit -m "feat(sync): backfill manufacturer and product for devices added offline (#228)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task D2: The shell starts and stops backfill

**Files:**
- Modify: `frontend/src/ui/app-shell.ts` (imports `:4-46`; `properties` `:173-193`; declarations near `:249`; `connectedCallback :284-304`; `onTokenOutcome :316-356`; `disconnectedCallback :400-411`; `signOut :578-600`)
- Test: `frontend/test/ui/app-shell.browser.test.ts:409-471` (`driven`), new tests after `:556`

**Interfaces:**
- Consumes: `CatalogBackfill`, `defaultCatalogBackfill()` (D1); `PROJECT_CHANGED` (`current-project.ts`).
- Produces: `AppShell.backfill?: CatalogBackfill` (`attribute: false`, injected by tests).

- [ ] **Step 1: Write the failing tests.** In `app-shell.browser.test.ts` add imports `import { PROJECT_CHANGED } from '../../src/ui/current-project.js'` and `import type { CatalogBackfill } from '../../src/ui/catalog-backfill.js'`. Add above `driven`:

```ts
/** A network the test can take away and give back. */
function controllableNetwork() {
  const listeners = new Set<() => void>()
  const source = {
    onLine: true,
    addEventListener: (_type: 'online' | 'offline', listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: 'online' | 'offline', listener: () => void) => {
      listeners.delete(listener)
    },
  }
  return {
    source,
    set(online: boolean) {
      source.onLine = online
      for (const listener of listeners) listener()
    },
  }
}

/** A backfill that only counts. */
function spyBackfill() {
  const backfill = { trigger: vi.fn(), stop: vi.fn(), idle: async () => {} }
  return backfill satisfies CatalogBackfill
}
```

Change `driven` to `const driven = async (connectivity: typeof NETWORK = NETWORK, backfill = spyBackfill()) => {`, replace `.connectivity=${NETWORK}` with `.connectivity=${connectivity}`, add `.backfill=${backfill}` to the fixture, and return `backfill` in the result object. Append:

```ts
it('backfills once after sign-in, not on every token refresh', async () => {
  const { play, backfill } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  await play({ kind: 'refreshed', expiresIn: 300 })
  expect(backfill.trigger).toHaveBeenCalledOnce()
})

it('backfills when the network comes back while signed in, and not while signed out', async () => {
  const network = controllableNetwork()
  const { play, backfill } = await driven(network.source)
  network.set(false)
  network.set(true)
  expect(backfill.trigger).not.toHaveBeenCalled()

  await play({ kind: 'refreshed', expiresIn: 300 })
  backfill.trigger.mockClear()
  network.set(false)
  network.set(true)
  expect(backfill.trigger).toHaveBeenCalledOnce()
})

it('restarts backfill on a project switch, stopping the old run first', async () => {
  const { play, backfill } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  backfill.trigger.mockClear()

  window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))

  expect(backfill.stop).toHaveBeenCalled()
  expect(backfill.trigger).toHaveBeenCalledOnce()
  expect(backfill.stop.mock.invocationCallOrder.at(-1)).toBeLessThan(
    backfill.trigger.mock.invocationCallOrder[0] ?? 0,
  )
})

it('does not backfill a project switched to while signed out', async () => {
  const { backfill } = await driven()
  window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))
  expect(backfill.trigger).not.toHaveBeenCalled()
})

it('stops backfill when the session ends, is signed out elsewhere, or the shell goes', async () => {
  for (const outcome of [{ kind: 'ended' }, { kind: 'signed-out' }] as const) {
    const { element, play, backfill } = await driven()
    await play({ kind: 'refreshed', expiresIn: 300 })
    await play(outcome)
    expect(backfill.stop).toHaveBeenCalled()
    element.remove()
  }
  const { element, backfill } = await driven()
  element.remove()
  expect(backfill.stop).toHaveBeenCalled()
})

it('stops backfill before signing out', async () => {
  const { element, play, backfill, signOutOf } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  await waitUntil(() => element.querySelector('[data-sign-out]') !== null, 'not signed in')
  ;(element.querySelector('[data-sign-out]') as HTMLElement).click()
  await waitUntil(() => element.querySelector('[data-confirm-sign-out]') !== null, 'no dialog')
  ;(element.querySelector('[data-confirm-sign-out]') as HTMLElement).click()
  await waitUntil(() => signOutOf.mock.calls.length > 0, 'never signed out')
  expect(backfill.stop.mock.invocationCallOrder[0]).toBeLessThan(
    signOutOf.mock.invocationCallOrder[0] ?? 0,
  )
})
```

- [ ] **Step 2: Run to verify failure.**
Run: `npx vitest run --project ui test/ui/app-shell.browser.test.ts`
Expected: the six new tests FAIL (`trigger` never called); all existing tests PASS.

- [ ] **Step 3: Implement.** In `app-shell.ts` add imports:

```ts
import { type CatalogBackfill, defaultCatalogBackfill } from './catalog-backfill.js'
import { PROJECT_CHANGED } from './current-project.js'
```

Add `backfill: { attribute: false },` to `properties` and, after `declare connectivity?`:

```ts
  /**
   * Fills in manufacturer and product for devices added offline (#228). Injected by tests; the
   * real one is built on first use, so a shell that never signs in never builds it.
   */
  declare backfill?: CatalogBackfill
  private realBackfill: CatalogBackfill | undefined
  private catalogBackfill(): CatalogBackfill {
    this.realBackfill ??= this.backfill ?? defaultCatalogBackfill()
    return this.realBackfill
  }

  /**
   * Backfill follows the open project: the old run is stopped (its answers belong to a project
   * nobody is looking at) and a new one starts over the new project, when signed in and online.
   */
  private readonly onProjectChanged = (): void => {
    this.catalogBackfill().stop()
    if (this.session === 'signed-in' && this.online) this.catalogBackfill().trigger()
  }
```

In `connectedCallback` add `window.addEventListener(PROJECT_CHANGED, this.onProjectChanged)` after the `hashchange` listener, and in the connectivity callback, after the existing `if (regained …) void this.projects.refresh(true)`:

```ts
        // The other half of "on connectivity becoming online" (spec §Backfill).
        if (regained && this.session === 'signed-in') this.catalogBackfill().trigger()
```

In `onTokenOutcome`, case `'refreshed'`: replace `if (!wasSignedIn) this.startSyncing()` with:

```ts
        if (!wasSignedIn) {
          this.startSyncing()
          // Once after sign-in, on the transition only: `refreshed` repeats before every expiry.
          this.catalogBackfill().trigger()
        }
```

In case `'signed-out'`, inside `if (this.session === 'signed-in') {`, add `this.catalogBackfill().stop()` before `this.endReplication()`. In case `'ended'`, add `this.catalogBackfill().stop()` before `this.endReplication()`. In `signOut()`, add `this.catalogBackfill().stop()` directly after `this.projects.end()`. In `disconnectedCallback`, add before `this.tokenRefresher?.stop()`:

```ts
    window.removeEventListener(PROJECT_CHANGED, this.onProjectChanged)
    // Not `catalogBackfill()`: a shell that never signed in must not build a real backfill just
    // to stop it. An injected one is stopped even if it was never adopted.
    ;(this.realBackfill ?? this.backfill)?.stop()
```

- [ ] **Step 4: Run to verify it passes.**
Run: `npx vitest run --project ui test/ui/app-shell.browser.test.ts test/ui/shell-projects.browser.test.ts test/ui/project-switch.browser.test.ts`
Expected: PASS, no console output.

- [ ] **Step 5: Verify and commit.**
Run (repo root): `npm run verify`. Expected: exits 0; `check:graph` reports no unreachable module (`catalog-backfill.ts` is reached from `app-shell.ts`).

```bash
git add src/ui/app-shell.ts test/ui/app-shell.browser.test.ts
git commit -m "feat(sync): the shell starts and stops catalogue backfill (#228)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Push `feat/catalog-backfill-228`, PR against `feat/catalog-lookup-227` (`Closes #228`).

---

## Part E — Display (#229)

| File | Change | Responsibility |
| --- | --- | --- |
| `frontend/src/ui/views/device.ts` | Modify | Manufacturer, part number, links, pairing tags, two `<wa-details>` |
| `frontend/src/ui/styles/app.css` | Modify | `.app-catalog-text` (wraps untrusted text) |
| `frontend/src/ui/main.ts` | Modify | Register `wa-details` |
| `frontend/src/ui/views/edit-device.ts` | Modify | Read-only manufacturer and product |
| `frontend/src/ui/pdf/inventory.ts`, `frontend/src/ui/pdf/download.ts` | Modify | Preferred manufacturer, part number line |
| `frontend/src/domain/documents/browse.ts` | Modify | Search the part number and preferred name |
| `PRODUCT.md` | Modify | Auto-fill claim (the secrets sentence belongs to Task B1) |
| `frontend/xliff/de.xlf`, `frontend/src/ui/generated/locales/de.ts` | Regenerate | German |
| Tests | Modify | `test/ui/views/device.browser.test.ts`, `test/ui/views/edit-device.browser.test.ts`, `test/ui/pdf/inventory.browser.test.ts`, `test/ui/pdf/german.browser.test.ts`, `test/domain/documents/browse.test.ts` |

### Task E1: The device page shows what the catalogue knows

**Files:**
- Modify: `frontend/src/ui/views/device.ts:4-19` (imports), `:661-683` (`field`, `hex`, `renderDetails`), `:722` (render call)
- Modify: `frontend/src/ui/styles/app.css` (after `.app-remark-body`)
- Modify: `frontend/src/ui/main.ts:24` (add details import after dialog)
- Test: `frontend/test/ui/views/device.browser.test.ts`

**Interfaces:**
- Consumes: `isHttpsUrl`, `manufacturerName` (Part A); device fields from A2.
- Produces markup hooks: `[data-links]`, `a[data-link="product"|"support"|"manual"|"commissioning-flow"]`, `[data-pairing]`, `wa-tag[data-discovery="ble"|"soft-ap"|"on-network"]`, `wa-tag[data-flow="custom"|"user-action"]`, `wa-details[data-pairing-steps]`, `wa-details[data-factory-reset]`, `.app-catalog-text`.

- [ ] **Step 1: Load the `webawesome-design` and `webawesome` skills.** Read `references/components/details.md` (`summary` attribute, `open`) and `references/components/tag.md` (`size`, `variant`, `appearance`). DESIGN.md: these tags are facts, not statuses, so they are neutral, size `s`, without icons, and never focusable (The One Status Vocabulary Rule reserves icons and coloured variants for status).

- [ ] **Step 2: Write the failing tests.** In `device.browser.test.ts` add `import '@awesome.me/webawesome-pro/dist/components/details/details.js'` with the other component imports and `import '../../../src/ui/styles/app.css'`. Append:

```ts
describe('what the catalogue knows', () => {
  const CATALOGUED: Partial<DeviceDocument> = {
    vendorName: 'Aqara',
    vendorPreferredName: 'Aqara Home',
    productName: 'Aqara Door and Window Sensor P2',
    partNumber: 'AS056',
    productUrl: 'https://www.aqara.com/en/products.html',
    supportUrl: 'https://www.aqara.com/support',
    userManualUrl: 'https://www.aqara.com/manual.pdf',
    commissioningFlowUrl: 'https://www.aqara.com/pairing',
    commissioningInstructions: '1. Power it.\n2. Hold the button.',
    factoryResetInstructions: 'Hold the button for 10 seconds.',
    commissioningFlow: 'custom',
    discovery: { softAp: true, ble: true, onNetwork: true },
    catalogCheckedAt: '2026-10-05T16:20:00.000Z',
    catalogSource: 'found',
  }

  it('names the manufacturer by its preferred name, then the vendor name, then the id', async () => {
    await seed(lamp(CATALOGUED))
    expect((await page()).textContent).toContain('Aqara Home')
  })

  it('falls back to the vendor name', async () => {
    await seed(lamp({ vendorName: 'Aqara' }))
    const element = await page()
    expect(element.textContent).toContain('Aqara')
    expect(element.textContent).not.toContain('0xFFF1')
  })

  it('shows the part number', async () => {
    await seed(lamp(CATALOGUED))
    expect((await page()).textContent).toContain('AS056')
  })

  it('links product, support and manual pages in a new tab, without an opener', async () => {
    await seed(lamp(CATALOGUED))
    const element = await page()
    for (const kind of ['product', 'support', 'manual']) {
      const link = element.querySelector(`a[data-link="${kind}"]`)
      expect(link?.getAttribute('target')).toBe('_blank')
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(element.querySelector('a[data-link="support"]')?.getAttribute('href')).toBe(
      'https://www.aqara.com/support',
    )
  })

  it('renders no link for a URL that is not https, whoever wrote it', async () => {
    // `catalogFields` drops these, but a document can arrive by sync from any client.
    await seed(
      lamp({
        productUrl: 'javascript:alert(1)',
        supportUrl: 'http://www.aqara.com/support',
        commissioningFlowUrl: 'data:text/html,hi',
      }),
    )
    const element = await page()
    expect(element.querySelector('[data-links]')).toBeNull()
    expect(element.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(element.querySelector('[data-pairing-steps]')).toBeNull()
  })

  it('shows pairing steps and the factory reset as plain text in two sections', async () => {
    await seed(
      lamp({
        ...CATALOGUED,
        factoryResetInstructions: '<img src=x onerror="window.hacked=true">',
      }),
    )
    const element = await page()
    const pairing = element.querySelector('wa-details[data-pairing-steps]')
    expect(pairing?.textContent).toContain('2. Hold the button.')
    expect(pairing?.querySelector('a[data-link="commissioning-flow"]')).not.toBeNull()
    const reset = element.querySelector('wa-details[data-factory-reset]')
    expect(reset?.textContent).toContain('<img src=x')
    expect(reset?.querySelector('img')).toBeNull()
  })

  it('shows neither section, no links and no tags for a device the catalogue never saw', async () => {
    await seed(lamp())
    const element = await page()
    expect(element.querySelector('wa-details')).toBeNull()
    expect(element.querySelector('[data-links]')).toBeNull()
    expect(element.querySelector('[data-pairing]')).toBeNull()
  })

  it('tags discovery and a flow that needs the manufacturer’s app', async () => {
    await seed(lamp(CATALOGUED))
    const element = await page()
    expect(element.querySelector('wa-tag[data-discovery="ble"]')?.textContent).toContain('BLE')
    expect(element.querySelector('wa-tag[data-discovery="soft-ap"]')?.textContent).toContain(
      'Wi-Fi',
    )
    expect(element.querySelector('wa-tag[data-discovery="on-network"]')).not.toBeNull()
    expect(element.querySelector('wa-tag[data-flow="custom"]')?.textContent).toContain(
      'Needs the manufacturer’s app',
    )
  })

  it('tags no flow for the standard one', async () => {
    await seed(lamp({ commissioningFlow: 'standard', discovery: { softAp: false, ble: true, onNetwork: false } }))
    const element = await page()
    expect(element.querySelector('wa-tag[data-flow]')).toBeNull()
    expect(element.querySelectorAll('wa-tag[data-discovery]')).toHaveLength(1)
  })

  it('wraps very long instructions at 360 px instead of widening the page', async () => {
    await seed(lamp({ commissioningInstructions: `${'x'.repeat(2000)} ${'Long word '.repeat(200)}` }))
    const element = await page()
    const frame = document.createElement('div')
    frame.style.width = '360px'
    element.replaceWith(frame)
    frame.append(element)
    const details = element.querySelector('wa-details[data-pairing-steps]') as HTMLElement & {
      open: boolean
      updateComplete: Promise<unknown>
    }
    details.open = true
    await details.updateComplete
    const text = element.querySelector('.app-catalog-text') as HTMLElement
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth)
    expect(frame.scrollWidth).toBeLessThanOrEqual(360)
  })
})
```

- [ ] **Step 3: Run to verify failure.**
Run: `npx vitest run --project ui test/ui/views/device.browser.test.ts`
Expected: new tests FAIL (no `Aqara Home`, no `[data-link]`); existing ones PASS (including the `0xFFF1` assertion: `lamp()` has no names).

- [ ] **Step 4: Implement.** In `device.ts` extend the domain import with `isHttpsUrl, manufacturerName,`. Replace `renderDetails` and add the catalogue renderers after `hex`:

```ts
  private renderDetails(device: DeviceDocument): TemplateResult {
    return html`
      <div class="wa-grid app-details">
        ${this.field(msg('Room'), this.room?.path ?? msg('Without a room'))}
        ${this.field(msg('Spot'), device.spot)}
        ${this.field(msg('Manufacturer'), manufacturerName(device) ?? this.hex(device.vendorId))}
        ${this.field(msg('Product'), device.productName ?? this.hex(device.productId))}
        ${this.field(msg('Part number'), device.partNumber)}
        ${this.field(msg('Serial number'), device.serial)}
        ${this.field(msg('Installed'), device.installedAt)}
      </div>
    `
  }

  /**
   * A link to the manufacturer, or nothing.
   *
   * `https:` is checked here again although `catalogFields` already filtered it: a device
   * document can arrive by sync from any client, and this is where a URL becomes clickable.
   * A new tab without an opener or a referrer, because the page is the manufacturer's.
   */
  private link(label: string, url: string | undefined, kind: string): TemplateResult | '' {
    if (!isHttpsUrl(url)) return ''
    return html`<a href=${url} target="_blank" rel="noopener noreferrer" data-link=${kind}>
      ${label}<span class="wa-visually-hidden"> (${msg('opens in a new tab')})</span>
    </a>`
  }

  /** How the device is found and whether it needs more than the usual pairing. */
  private renderPairing(device: DeviceDocument): TemplateResult | '' {
    // Each tag written out in full: an attribute *name* cannot be a Lit binding, so a helper
    // taking `data-discovery` vs `data-flow` as a parameter would need `unsafeStatic`.
    const tags = [
      device.discovery?.ble === true
        ? html`<wa-tag size="s" variant="neutral" data-discovery="ble">${msg('BLE')}</wa-tag>`
        : '',
      device.discovery?.softAp === true
        ? html`<wa-tag size="s" variant="neutral" data-discovery="soft-ap">${msg('Wi-Fi')}</wa-tag>`
        : '',
      device.discovery?.onNetwork === true
        ? html`<wa-tag size="s" variant="neutral" data-discovery="on-network">${msg('On network')}</wa-tag>`
        : '',
      device.commissioningFlow === 'custom'
        ? html`<wa-tag size="s" variant="neutral" data-flow="custom">${msg('Needs the manufacturer’s app')}</wa-tag>`
        : '',
      device.commissioningFlow === 'userActionRequired'
        ? html`<wa-tag size="s" variant="neutral" data-flow="user-action">${msg('Needs a step on the device first')}</wa-tag>`
        : '',
    ].filter((entry) => entry !== '')
    if (tags.length === 0) return ''
    return html`
      <div class="wa-stack wa-gap-3xs" data-pairing>
        <small class="app-empty">${msg('Pairing')}</small>
        <div class="wa-cluster wa-gap-2xs">${tags}</div>
      </div>
    `
  }

  /**
   * Links, pairing facts and the two instruction sections; each only when it has content.
   *
   * DCL text is untrusted, so it goes in as a text binding (Lit escapes it), never through
   * `unsafeHTML`. `.app-catalog-text` keeps the line breaks the manufacturer wrote and wraps a
   * long unbroken string rather than widening a phone screen.
   */
  private renderCatalog(device: DeviceDocument): TemplateResult {
    const links = [
      this.link(msg('Product page'), device.productUrl, 'product'),
      this.link(msg('Support'), device.supportUrl, 'support'),
      this.link(msg('User manual'), device.userManualUrl, 'manual'),
    ].filter((entry) => entry !== '')
    const flowLink = this.link(
      msg('The manufacturer’s pairing instructions'),
      device.commissioningFlowUrl,
      'commissioning-flow',
    )
    const steps = device.commissioningInstructions
    const reset = device.factoryResetInstructions

    return html`
      ${links.length === 0 ? '' : html`<div class="wa-cluster wa-gap-m" data-links>${links}</div>`}
      ${this.renderPairing(device)}
      ${
        steps === undefined && flowLink === ''
          ? ''
          : html`<wa-details summary=${msg('How to put it in pairing mode')} data-pairing-steps>
              <div class="wa-stack wa-gap-s">
                ${steps === undefined ? '' : html`<p class="app-catalog-text">${steps}</p>`}
                ${flowLink}
              </div>
            </wa-details>`
      }
      ${
        reset === undefined
          ? ''
          : html`<wa-details summary=${msg('Factory reset')} data-factory-reset>
              <p class="app-catalog-text">${reset}</p>
            </wa-details>`
      }
    `
  }
```

In `render`, change line 722 to:

```ts
        ${this.renderCode(device)} ${this.renderActions(device)} ${this.renderDetails(device)}
        ${this.renderCatalog(device)} ${this.renderRemarks(device)}
```

In `app.css`, after `.app-remark-body`:

```css
/* Instructions from the DCL. Untrusted text, rendered as text: the manufacturer's line breaks
   are kept (they number the steps), and a long unbroken string wraps rather than widening a
   phone screen. Same reasoning as .app-remark-body. */
.app-catalog-text {
  margin: 0;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
```

In `main.ts`, add `import '@awesome.me/webawesome-pro/dist/components/details/details.js'` after the dialog import.

- [ ] **Step 5: Run to verify it passes.**
Run: `npx vitest run --project ui test/ui/views/device.browser.test.ts test/ui/views/icons.browser.test.ts`
Expected: PASS (no new `<wa-icon>` names, so the bundled-icon test is unaffected; `wa-details` uses the built-in `system` library).

- [ ] **Step 6: Commit.**

```bash
git add src/ui/views/device.ts src/ui/styles/app.css src/ui/main.ts test/ui/views/device.browser.test.ts
git commit -m "feat(web): device page shows manufacturer, links, pairing and reset steps (#229)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task E2: Edit form, PDF, search, PRODUCT.md and German

**Files:**
- Modify: `frontend/src/ui/views/edit-device.ts:3-10,174-185`
- Modify: `frontend/src/ui/pdf/inventory.ts:42-56,66-79,245-250`; `frontend/src/ui/pdf/download.ts:16-26`
- Modify: `frontend/src/domain/documents/browse.ts:52-73`
- Modify: `PRODUCT.md:31`
- Test: `frontend/test/ui/views/edit-device.browser.test.ts`, `frontend/test/ui/pdf/inventory.browser.test.ts`, `frontend/test/ui/pdf/german.browser.test.ts`, `frontend/test/domain/documents/browse.test.ts`

**Interfaces:**
- Consumes: `manufacturerName` (A2); `renderCatalogLines` (C2).
- Produces: `InventoryLabels.partNumber: string`.

- [ ] **Step 1: Load the `webawesome-design` and `webawesome` skills.**

- [ ] **Step 2: Write the failing tests.**

`browse.test.ts`, inside `describe('search')` (extend `catalogue` with a third device rather than changing the two existing ones):

```ts
  it('matches a part number and a preferred manufacturer name', () => {
    const withCatalogue = [
      ...catalogue,
      device('Door sensor', KITCHEN._id, { partNumber: 'AS056', vendorPreferredName: 'Aqara Home' }),
    ]
    expect(names(browseDevices(withCatalogue, ROOMS, { query: 'as056' }))).toEqual([['Door sensor']])
    expect(names(browseDevices(withCatalogue, ROOMS, { query: 'aqara home' }))).toEqual([
      ['Door sensor'],
    ])
  })
```

`inventory.browser.test.ts`: add `partNumber: 'Part number',` to `LABELS`, `import { extractText } from './text-extraction.js'`, and:

```ts
describe('what the catalogue knows', () => {
  it('prints the preferred manufacturer name and the part number', async () => {
    const bytes = await buildInventoryPdf(
      groupsFor([
        device({
          vendorName: 'Aqara',
          vendorPreferredName: 'Aqara Home',
          productName: 'Door and Window Sensor P2',
          partNumber: 'AS056',
        }),
      ]),
      { labels: LABELS },
    )
    const text = (await extractText(bytes)).join('\n')
    expect(text).toContain('Aqara Home Door and Window Sensor P2')
    expect(text).toContain('Part number: AS056')
  })
})
```

`german.browser.test.ts`: add `partNumber: 'Teilenummer',` to its `LABELS`.

`edit-device.browser.test.ts`:

```ts
describe('the catalogue names', () => {
  it('shows manufacturer and product read-only, and keeps them through a save', async () => {
    await seed(lamp({ vendorName: 'Aqara', vendorPreferredName: 'Aqara Home', productName: 'P2' }))
    const element = await form()
    await waitUntil(() => element.querySelector('[data-catalog]') !== null, 'no names')

    expect(element.querySelector('[data-catalog-manufacturer]')?.textContent).toBe('Aqara Home')
    expect(element.querySelector('[data-catalog] wa-input, [data-catalog] input')).toBeNull()

    element.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitUntil(async () => (await database.repositories.devices.get(DEVICE_ID))?._rev?.startsWith('2-') === true)
    expect((await database.repositories.devices.get(DEVICE_ID))?.vendorPreferredName).toBe('Aqara Home')
  })
})
```

(Use the file's existing `form(uuid?, repositories?)` helper; if it waits for a different readiness condition, follow it.)

- [ ] **Step 3: Run to verify failure.**
Run: `npx vitest run --project domain test/domain/documents/browse.test.ts && npx vitest run --project ui test/ui/pdf test/ui/views/edit-device.browser.test.ts`
Expected: FAIL in the new tests; `tsc`-level failures in the PDF tests are not reported by Vitest, so also run `npm run typecheck` (Expected: error, `partNumber` is not in `InventoryLabels`).

- [ ] **Step 4: Implement.**

`browse.ts`: update the comment (`… product. \`spot\`, \`vendorName\`, \`vendorPreferredName\` and \`partNumber\` are here too: "ceiling", "the Ikea one" and "AS056" are all how people describe a device they are looking for …`) and the array:

```ts
  return [
    device.name,
    path,
    device.spot,
    device.serial,
    device.productName,
    device.vendorName,
    device.vendorPreferredName,
    device.partNumber,
  ]
```

`inventory.ts`: import `manufacturerName` with the other domain imports; add to `InventoryLabels` after `pairingCode`:

```ts
  /** Precedes the manufacturer's part number, e.g. "Part number". */
  readonly partNumber: string
```

replace the named branch of `productOf`:

```ts
  if (device.productName !== undefined) {
    // The preferred name: what people call the company, and what the device page shows.
    const manufacturer = manufacturerName(device)
    return manufacturer === undefined ? device.productName : `${manufacturer} ${device.productName}`
  }
```

and add the part number as a detail line (five detail lines plus name and pairing code still fit `entryHeight: 116`: 11 + 5 × 13 + 18 = 94 pt):

```ts
  const details = [
    productOf(block),
    device.partNumber === undefined ? undefined : `${labels.partNumber}: ${device.partNumber}`,
    `${labels.installed}: ${device.installedAt}`,
    device.spot,
    device.serial,
  ].filter((value): value is string => value !== undefined && value !== '')
```

`download.ts`: add `partNumber: msg('Part number'),` after `pairingCode`.

`edit-device.ts`: add `manufacturerName,` to the domain import and, after the pairing-code `<div>` in `render`:

```ts
        <!-- From the catalogue, so read-only: a lookup replaces the block whole, and an edit here
             would be undone without a word (spec §Editing). -->
        ${this.renderCatalogLines({ manufacturer: manufacturerName(device), product: device.productName })}
```

`PRODUCT.md` line 31, replace with:

```markdown
- **The code is a string, not a picture** (`MT:` plus Base38). It is stored exactly and reproduced at any size. Its vendor and product IDs are looked up in the CSA's Distributed Compliance Ledger when the device is added, or as soon as the app is next online and signed in, and the manufacturer, product name, links and pairing instructions are copied onto the device.
```

(The secrets sentence in §Capabilities and Constraints is amended by Task B1, together with the other security documents.)

- [ ] **Step 5: German.** `npm run i18n:extract`, then add targets in `xliff/de.xlf`:

| `<source>` | `<target>` |
| --- | --- |
| `Part number` | `Teilenummer` |
| `opens in a new tab` | `öffnet in einem neuen Tab` |
| `BLE` | `BLE` |
| `Wi-Fi` | `WLAN` |
| `On network` | `Im Netzwerk` |
| `Needs the manufacturer’s app` | `Erfordert die App des Herstellers` |
| `Needs a step on the device first` | `Erfordert zuerst einen Schritt am Gerät` |
| `Pairing` | `Kopplung` |
| `Product page` | `Produktseite` |
| `Support` | `Support` |
| `User manual` | `Bedienungsanleitung` |
| `The manufacturer’s pairing instructions` | `Kopplungsanleitung des Herstellers` |
| `How to put it in pairing mode` | `So versetzen Sie das Gerät in den Kopplungsmodus` |
| `Factory reset` | `Auf Werkseinstellungen zurücksetzen` |

(`Vendor` disappears from the catalogue because the device page now says `Manufacturer`, which Part C already translated as `Hersteller`.) Then `npm run i18n:build && npm run check:i18n`. Expected: passes.

- [ ] **Step 6: Run everything touched.**
Run: `npx vitest run --project domain test/domain/documents && npx vitest run --project ui test/ui/pdf test/ui/views test/ui/i18n`
Expected: PASS (the i18n locale-switch tests still find every view's text).

- [ ] **Step 7: Verify, commit, PR.**
Run (repo root): `npm run verify`. Expected: exits 0, zero warnings, every coverage gate met, `check:lazy-pdf` still passes (no new static import of `pdf-lib`).

```bash
git add src/ui/views/edit-device.ts src/ui/pdf src/domain/documents/browse.ts test ../PRODUCT.md xliff/de.xlf src/ui/generated
git commit -m "feat(web): catalogue names in the edit form, PDF and search; German (#229)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Push `feat/catalog-display-229`, PR against `feat/catalog-backfill-228` (`Closes #229`). Before merging, look at the device page at 360 px in light and dark (DESIGN.md "Do"), and at desktop width: the links wrap in their cluster, the tags wrap, both details sections open with the focus ring visible.

---

## Review-focus candidates for the frontend

Each line names the input, the expected behaviour, and the test that pins it.

| Input or condition | Expected | Pinned in |
| --- | --- | --- |
| Lookup result arrives after Save | Device saved without names, no second write | C3 "does not wait for a slow lookup before saving, and ignores it when it lands" |
| Code edited after the result arrived | Names cleared; saved device has none | C3 "drops the names when the code is edited after they arrived"; A3 "ignores an answer about a different device" |
| Device from a 21-digit manual code, no payload | Looked up by its digits at add time and by backfill | C3 "aborts the earlier lookup when the code changes" (second call); D1 "asks for a 21-digit code by its digits…"; A2 `needsCatalogLookup` |
| 11-digit code | No request, ever | C3 "never asks about an 11-digit code"; D1 same test; A2 |
| DCL URL with `javascript:`/`http:`/`data:` scheme, from the API or from sync | Dropped on copy; no `<a>` on the page | A2 "keeps a URL only when it is https"; E1 "renders no link for a URL that is not https, whoever wrote it" |
| DCL text containing HTML | Shown as text | E1 "shows pairing steps and the factory reset as plain text" |
| Backfill racing a user edit (409) | Edit kept, block filled next run | D1 "keeps a concurrent user edit, and fills the block on the next run" |
| Backfill and an edit on two replicas (sync conflict) | Merge keeps the newer block and the newer scalars | A4 "keeps the block from the revision that looked it up, under a newer edit without one" |
| Project switch mid-backfill | Old run aborted, nothing written, new run over the new project | D1 "writes nothing after stop…"; D2 "restarts backfill on a project switch, stopping the old run first" |
| Read-only shared project | No request, no write | D1 "does nothing in a project that cannot be edited" |
| Sign-out or session end mid-backfill | Stopped before sign-out runs | D2 "stops backfill when the session ends…", "stops backfill before signing out" |
| 429 with `retry-after` / with an HTTP date | Waits that long (date → 60 s), retries the same device | C1 `retryAfterSeconds`; D1 "waits for retry-after on 429…" |
| Proxy returns HTML with status 200 | `unavailable`, no device named `undefined` | C1 "treats a 200 that is not a catalogue answer as unavailable" |
| The code in logs | Never written to the console, never in the URL | C1 "never writes the code to the console", "posts the code in the body…" |
| Very long instruction text at 360 px | Wraps, no horizontal scroll | E1 "wraps very long instructions at 360 px…" |
| Repeated `refreshed` outcomes | Backfill triggered once per sign-in | D2 "backfills once after sign-in, not on every token refresh" |
| Many triggers during one run | At most one run at a time, one follow-up run | D1 "runs again once when triggered while running…" |

## Contract mismatches against the real code, and how they were resolved

1. **Token getter type.** The contract writes `token: () => Promise<string | undefined>`, but it also says "match the real signature". `projectsApi` takes `token: () => string | undefined` (synchronous, `accessToken` from `tokens.ts`), and `profileApi` takes no getter at all (it calls `accessToken()` directly). The plan uses `catalogApi(baseUrl: string, token: () => string | undefined, fetchImpl: typeof fetch = fetch)`, like `projectsApi`. The backend plan is unaffected.
2. **`needsCatalogLookup` parameter.** The contract says `(device: DeviceDocument, now: Date)`. The plan types it as `Pick<DeviceDocument, 'payload' | 'manualCode' | 'catalogCheckedAt' | 'catalogSource'>`, which every `DeviceDocument` satisfies, so callers written against the contract compile unchanged.
3. **"URL fields are kept only when they parse as `https:`".** `src/domain` has no `URL` (`tsconfig.domain.json` uses `lib: ["ES2023"]`, `types: []`). The plan uses a strict pattern, `^https://` followed by a non-empty host with no whitespace, plus a control-character check (`isHttpsUrl`). It errs towards dropping a link. The same check runs again where a link is rendered.
4. **`DraftClock` time.** The contract says `catalogFields(catalog, clock.now)`. In the real code `DraftClock.now` is a function, `() => string`. `planNewDevice` reads it once and uses the value for both `addedAt` and `catalogCheckedAt`.
5. **Extra domain exports, not in the contract.** `withCatalogBlock` (used by `mergeDevice` and backfill to replace the block whole, so `CATALOG_FIELD_KEYS` has one consumer pattern), `isHttpsUrl`, `manufacturerName`, `TEST_VENDOR_NAME`, `CATALOG_MISS_RETRY_MS`, and the types `CatalogSource`, `DeviceDiscovery` and `CatalogBearing`. All are additions, and none renames a contract name. `public-api.test.ts` lists them.
6. **`mergeDevice` generic bound.** `mergeDevice<T extends RemarkBearing>` becomes `<T extends RemarkBearing & CatalogBearing>`. `CatalogBearing` has only an optional field, so every existing caller (`src/data/project-database.ts`, the tests) still compiles.
7. **`planNewDevice` ignores a mismatched answer.** This is not in the contract. A `catalog` whose `vendorId`/`productId` differ from the code's is ignored. That protects against a stale answer and does not change the signature.
8. **Non-standard flow tag.** The spec names one tag, "Needs the manufacturer's app". `CustomFlow` has two non-standard values. `custom` gets that tag. `userActionRequired` means the device needs a button press, not an app, so it gets "Needs a step on the device first" rather than a false claim. `reserved` gets no tag. If the reviewer wants strictly one tag, delete the `userActionRequired` line in `renderPairing`.
9. **The "How to put it in pairing mode" section** shows when the instructions **or** an `https:` custom-flow link exist. A link alone is still useful. The spec says "when their text exists".
10. **Device page label** changes from `Vendor` to `Manufacturer`, to match the spec and the add form. The German stays "Hersteller".
11. **Docs ownership overlap with the backend plan.** Part A edits the DATA-MODEL.md sentence "the DCL lookup sends vendor and product ids only" and the matching doc comment on `DeviceDocument.manualCode`. Part E edits the PRODUCT.md secrets sentence. The spec assigns the SECURITY-MODEL.md and ADR 0005 amendments to #226. If the backend plan also edits DATA-MODEL.md, the second PR must rebase onto the first, not duplicate it.
12. **Discovery storage.** The spec stores `{ softAp, ble, onNetwork }`, while `DeviceCredential` keeps the full `DiscoveryCapabilities` (with `raw`). `planNewDevice` copies only the three booleans, as the spec says. `raw` stays recoverable from the stored payload.
