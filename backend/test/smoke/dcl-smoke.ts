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
