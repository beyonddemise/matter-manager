import { describe, expect, it } from 'vitest'
import { TEST_VENDOR_NAME } from '../../../src/domain/index.js'
import { shownManufacturer } from '../../../src/ui/i18n/manufacturer.js'

/**
 * #238: "Test vendor" is the one manufacturer name the application writes itself. It is stored
 * in English, as data, and must read in the interface's language wherever it is shown.
 */
describe('shownManufacturer', () => {
  it('shows the stored test-vendor name in the given language', () => {
    expect(shownManufacturer(TEST_VENDOR_NAME, 'Testhersteller')).toBe('Testhersteller')
  })

  it('leaves every manufacturer the catalogue named as it is', () => {
    expect(shownManufacturer('Aqara Home', 'Testhersteller')).toBe('Aqara Home')
    // Only the exact stored value is the application's own words; a near miss is a name.
    expect(shownManufacturer('test vendor', 'Testhersteller')).toBe('test vendor')
  })

  it('passes an unknown manufacturer through, so the caller keeps its own fallback', () => {
    expect(shownManufacturer(undefined, 'Testhersteller')).toBeUndefined()
  })
})
