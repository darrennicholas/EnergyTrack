import { describe, expect, it } from 'vitest'
import { estimateEmissions, estimateEmissionsByYear } from './emissions.js'

const factor = { id: 'f', region: 'Jawa', factor: '0.8', unit: 'kgCO2e/kWh', publicationSource: 'Source', sourceUrl: 'https://example.com', applicableYear: 2026, effectiveFrom: new Date('2026-01-01'), effectiveTo: new Date('2026-12-31') }
const r = (time: string, value: string) => ({ meterId: 'm', timestamp: new Date(time), value, unit: 'kWh', meter: { meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', site: { timezone: 'Asia/Jakarta' } } })
describe('emission estimates', () => {
  it('uses the factor provenance and converts kg to tonnes', () => {
    expect(estimateEmissions([r('2026-11-17T00:00:00Z', '100')], [], factor)).toMatchObject({ estimatedTco2e: '0.080000', factor: { id: 'f', publicationSource: 'Source' } })
  })
  it('leaves the total unknown when the factor is not effective', () => {
    expect(estimateEmissions([r('2027-01-01T00:00:00Z', '100')], [], factor)).toMatchObject({ estimatedTco2e: null, uncoveredKwh: '100.000000' })
  })
  it('selects a region/year factor per site-local reading date', () => {
    const next = { ...factor, id: 'f-2027', factor: '1.2', applicableYear: 2027, effectiveFrom: new Date('2027-01-01'), effectiveTo: new Date('2027-12-31') }
    const result = estimateEmissionsByYear([r('2026-12-31T16:30:00Z', '100'), r('2027-01-01T18:00:00Z', '100')], [], [factor, next])
    expect(result).toMatchObject({ estimatedTco2e: '0.200000', factors: [{ id: 'f', applicableYear: 2026 }, { id: 'f-2027', applicableYear: 2027 }] })
  })
  it('returns energy-source provenance and does not apply non-electric factors to electricity readings', () => {
    const gas = { ...factor, energySource: 'NATURAL_GAS' }
    expect(() => estimateEmissions([r('2026-11-17T00:00:00Z', '100')], [], gas)).toThrow('INCOMPATIBLE_ENERGY_SOURCE')
    expect(estimateEmissionsByYear([r('2026-11-17T00:00:00Z', '100')], [], [gas])).toMatchObject({ estimatedTco2e: null, uncoveredKwh: '100.000000', factors: [] })
  })
})
