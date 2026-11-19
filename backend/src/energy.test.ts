import { describe, expect, it } from 'vitest'
import { energyByLocalDay, energyByLocalHour, energyByLocalMonth, energyByLocalWeek, energyByTimezoneBucket, energyByTimezoneDay, energyByUtcDay, type EnergyReading } from './energy.js'

const reading = (meterId: string, value: number | string, type = 'CUMULATIVE', date = '2026-11-17T00:00:00Z'): EnergyReading => ({ meterId, value, timestamp: new Date(date), unit: 'kWh', meter: { meterType: type, metric: 'ENERGY_IMPORT' } })

describe('energy aggregation', () => {
  it('uses the previous register across the period boundary and counts interval readings', () => {
    expect(energyByUtcDay([reading('a', 110), reading('b', 3, 'INTERVAL')], [reading('a', 100)])).toMatchObject([{ date: '2026-11-17', kwh: 13 }])
  })
  it('does not count a meter reset as negative consumption', () => {
    expect(energyByUtcDay([reading('a', 5), reading('a', 8)], [reading('a', 100)])).toMatchObject([{ kwh: 3, quality: 'REVIEW_REQUIRED' }])
  })
  it('recognizes a configured register rollover and retains that provenance', () => {
    const before = { ...reading('rollover', '9999.9'), meter: { meterType: 'CUMULATIVE', metric: 'ENERGY_IMPORT', rolloverValue: '10000' } }
    const after = { ...reading('rollover', '0.2', 'CUMULATIVE', '2026-11-17T01:00:00Z'), meter: { meterType: 'CUMULATIVE', metric: 'ENERGY_IMPORT', rolloverValue: '10000' } }
    expect(energyByUtcDay([after], [before])).toMatchObject([{ kwh: 0.3, quality: 'ROLLOVER_ADJUSTED' }])
  })
  it('sorts out-of-order arrivals before calculating cumulative deltas', () => {
    expect(energyByUtcDay([reading('a', 30, 'CUMULATIVE', '2026-11-17T02:00:00Z'), reading('a', 20, 'CUMULATIVE', '2026-11-17T01:00:00Z')], [reading('a', 10, 'CUMULATIVE', '2026-11-17T00:00:00Z')])).toMatchObject([{ kwh: 20, quality: 'VALIDATED' }])
  })
  it('does not claim zero consumption from a lone cumulative reading', () => {
    expect(energyByUtcDay([reading('a', 100)])).toEqual([])
  })
  it('calculates small deltas from large decimal registers before rounding', () => {
    const prior = { ...reading('a', 0), value: '9999999999999.000000' }
    const current = { ...reading('a', 0), value: '9999999999999.010000' }
    expect(energyByUtcDay([current], [prior])).toMatchObject([{ kwh: 0.01 }])
  })
  it('uses the site timezone for monitoring day buckets without changing UTC exports', () => {
    const local = { ...reading('a', 3, 'INTERVAL', '2026-11-17T17:30:00Z'), meter: { meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', site: { timezone: 'Asia/Jakarta' } } }
    expect(energyByLocalDay([local])).toMatchObject([{ date: '2026-11-18', kwh: 3 }])
    expect(energyByUtcDay([local])).toMatchObject([{ date: '2026-11-17', kwh: 3 }])
  })
  it('uses the explicitly selected report timezone for aggregation', () => {
    const reportReading = reading('a', 3, 'INTERVAL', '2026-11-17T23:30:00Z')
    expect(energyByTimezoneDay([reportReading], [], 'Pacific/Kiritimati')).toMatchObject([{ date: '2026-11-18', kwh: 3 }])
    expect(energyByTimezoneDay([reportReading], [], 'America/Adak')).toMatchObject([{ date: '2026-11-17', kwh: 3 }])
  })
  it('uses the same generic hourly bucket aggregation for exports as monitoring', () => {
    const local = { ...reading('a', 3, 'INTERVAL', '2026-11-17T17:30:00Z'), meter: { meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', site: { timezone: 'Asia/Jakarta' } } }
    expect(energyByTimezoneBucket([local], [], 'Asia/Jakarta', 'HOUR')).toEqual(energyByLocalHour([local]))
    expect(energyByTimezoneBucket([local], [], 'Asia/Jakarta', 'HOUR')).toMatchObject([{ date: '2026-11-18T00:00+07:00', kwh: 3 }])
  })
  it('aggregates validated usage by local ISO week and calendar month', () => {
    const local = { ...reading('a', 3, 'INTERVAL', '2026-11-17T00:30:00Z'), meter: { meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', site: { timezone: 'Asia/Jakarta' } } }
    expect(energyByLocalWeek([local])).toMatchObject([{ date: '2026-W47', kwh: 3 }])
    expect(energyByLocalMonth([local])).toMatchObject([{ date: '2026-11', kwh: 3 }])
  })
})
