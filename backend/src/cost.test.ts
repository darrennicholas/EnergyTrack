import { describe, expect, it } from 'vitest'
import { estimateFixedCharges, estimateFlatCost } from './cost.js'

const r = (time: string, value: string) => ({ meterId: 'm', timestamp: new Date(time), value, unit: 'kWh', meter: { meterType: 'CUMULATIVE', metric: 'ENERGY_IMPORT', site: { timezone: 'Asia/Jakarta' } } })
const assignment = (id: string, start: string, end: string | null, rate: string) => ({ meterId: 'm', tariffId: id, tariffName: id, unitRate: rate, effectiveFrom: new Date(start), effectiveTo: end ? new Date(end) : null })
describe('historical flat tariff estimates', () => {
  it('uses the version in effect on the site-local reading date', () => {
    const rates = [assignment('old', '2026-01-01', '2026-01-31', '100'), assignment('new', '2026-02-01', null, '200')]
    const result = estimateFlatCost([r('2026-01-31T10:00:00Z', '110'), r('2026-01-31T18:00:00Z', '115')], [r('2026-01-30T00:00:00Z', '100')], rates)
    expect(result.estimatedCostIdr).toBe('2000.00')
    expect(result.tariffs.map(t => t.tariffId)).toEqual(['old', 'new'])
  })
  it('does not report a complete estimate for resets or missing rates', () => {
    const result = estimateFlatCost([r('2026-02-01T00:00:00Z', '5'), r('2026-02-01T01:00:00Z', '8')], [r('2026-01-31T00:00:00Z', '100')], [])
    expect(result).toMatchObject({ estimatedCostIdr: null, unpricedKwh: '3.000000', unknownIntervals: 1 })
  })
  it('prices a configured cumulative meter rollover as a nonnegative delta', () => {
    const before = { ...r('2026-01-31T23:00:00Z', '9999.9'), meter: { meterType: 'CUMULATIVE', metric: 'ENERGY_IMPORT', rolloverValue: '10000', site: { timezone: 'Asia/Jakarta' } } }
    const after = { ...r('2026-02-01T00:00:00Z', '0.2'), meter: { ...before.meter } }
    const rate = assignment('rollover', '2026-01-01', null, '100')
    const result = estimateFlatCost([after], [before], [rate])
    expect(result).toMatchObject({ estimatedCostIdr: '30.00', unknownIntervals: 0, pricedKwh: '0.300000' })
  })
  it('selects the site-local time-of-use rate and applies configured tax', () => {
    const tou = { ...assignment('tou', '2026-02-01', null, '0'), tariffType: 'TOU', taxPercent: '11', rates: [{ startMinute: 0, endMinute: 420, unitRate: '100' }, { startMinute: 420, endMinute: 1440, unitRate: '200' }] }
    const result = estimateFlatCost([r('2026-02-01T00:30:00Z', '10')], [r('2026-01-31T00:00:00Z', '0')], [tou])
    expect(result.estimatedCostIdr).toBe('2220.00')
    expect(result.tariffs[0].unitRate).toBe('200')
  })
  it('prorates monthly fixed charges over local calendar days and applies tax', () => {
    const charges = estimateFixedCharges([{ ...assignment('monthly', '2026-11-01', null, '0'), fixedCharge: '300', taxPercent: '10', timezone: 'Asia/Jakarta' }], new Date('2026-11-17T00:00:00Z'), new Date('2026-11-18T00:00:00Z'))
    expect(charges).toEqual({ fixedChargeBeforeTaxIdr: '20.00', fixedChargeIdr: '22.00' })
  })
})
