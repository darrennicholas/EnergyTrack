import { describe, expect, it } from 'vitest'
import { aggregateBucket, expectedReadings } from './rollups.js'

describe('persistent rollup bucket boundaries', () => {
  it('keeps local hours distinct across daylight-saving fallback', () => {
    const first = aggregateBucket('HOUR', new Date('2026-11-01T05:30:00Z'), 'America/New_York')
    const repeated = aggregateBucket('HOUR', new Date('2026-11-01T06:30:00Z'), 'America/New_York')
    expect(first.bucketKey).toBe('2026-11-01T01:00-04:00')
    expect(repeated.bucketKey).toBe('2026-11-01T01:00-05:00')
    expect(first.bucketStart.toISOString()).toBe('2026-11-01T05:00:00.000Z')
    expect(repeated.bucketStart.toISOString()).toBe('2026-11-01T06:00:00.000Z')
  })

  it('uses the actual 23-hour local day when calculating completeness', () => {
    const bucket = { ...aggregateBucket('DAY', new Date('2026-03-08T12:00:00Z'), 'America/New_York'), energy: 0, readingCount: 0, resetCount: 0, rolloverCount: 0 }
    expect(expectedReadings('DAY', bucket, 'America/New_York', 60)).toBe(23)
  })

  it('uses 30 local calendar days for the expected monthly readings', () => {
    const bucket = { ...aggregateBucket('MONTH', new Date('2026-11-18T12:00:00Z'), 'Asia/Jakarta'), energy: 0, readingCount: 0, resetCount: 0, rolloverCount: 0 }
    expect(expectedReadings('MONTH', bucket, 'Asia/Jakarta', 60)).toBe(720)
  })
})
