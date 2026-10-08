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
