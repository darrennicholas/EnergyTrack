import { describe, expect, it } from 'vitest'
import { detectReadingIssues, type QualityReading } from './reading-quality.js'

const meter = { code: 'M-1', meterType: 'CUMULATIVE', metric: 'ENERGY_IMPORT', unit: 'kWh', intervalMinutes: 15 }
const reading = (time: string, value: string, quality = 'VALID', meterInfo = meter): QualityReading => ({ meterId: 'meter-1', timestamp: new Date(time), value, quality, meter: meterInfo })

describe('reading quality review', () => {
  it('flags reset, missing intervals, non-valid quality, and conflicting timestamps', () => {
    const previous = reading('2026-01-01T00:00:00Z', '100')
    const rows = [
      reading('2026-01-01T00:15:00Z', '5'),
      reading('2026-01-01T01:00:00Z', '9', 'SUSPECT'),
      reading('2026-01-01T01:00:00Z', '10')
    ]
    const issues = detectReadingIssues(rows, [previous], new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'))
    expect(issues.map(issue => issue.type)).toEqual(['REGISTER_RESET', 'DATA_GAP', 'DUPLICATE_TIMESTAMP', 'QUALITY_FLAG'])
    expect(issues.find(issue => issue.type === 'REGISTER_RESET')).toMatchObject({ severity: 'CRITICAL', previousValue: '100', observedValue: '5' })
    expect(issues.find(issue => issue.type === 'DATA_GAP')?.missingIntervals).toBe(2)
  })
  it('reports a configured rollover as informational and handles out-of-order arrivals', () => {
    const rolloverMeter = { ...meter, rolloverValue: '10000' }
    const rows = [reading('2026-01-01T00:30:00Z', '0.2', 'VALID', rolloverMeter), reading('2026-01-01T00:15:00Z', '9999.9', 'VALID', rolloverMeter)]
    const issues = detectReadingIssues(rows, [reading('2026-01-01T00:00:00Z', '9999.5', 'VALID', rolloverMeter)])
    expect(issues.filter(issue => issue.type === 'REGISTER_ROLLOVER')).toHaveLength(1)
    expect(issues.some(issue => issue.type === 'REGISTER_RESET')).toBe(false)
  })
})
