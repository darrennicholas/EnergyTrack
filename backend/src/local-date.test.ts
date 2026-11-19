import { describe, expect, it } from 'vitest'
import { localCalendarWindow, localDateStartUtc, nextLocalDate } from './local-date.js'

describe('site-local date boundaries', () => {
  it('converts midnight using the site timezone offset', () => {
    expect(localDateStartUtc('2026-11-17', 'Asia/Jakarta').toISOString()).toBe('2026-11-16T17:00:00.000Z')
  })

  it('uses the offset on each local day across a daylight-saving transition', () => {
    expect(localDateStartUtc('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(localDateStartUtc('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })

  it('validates dates and advances calendar days independent of UTC offset', () => {
    expect(nextLocalDate('2026-03-08')).toBe('2026-03-09')
    expect(() => localDateStartUtc('2026-02-30', 'UTC')).toThrow('INVALID_LOCAL_DATE')
  })

  it('keeps forecast windows at a fixed number of local days across DST', () => {
    const window = localCalendarWindow('2026-03-09', 1, 'America/New_York')
    expect(window.startDate).toBe('2026-03-08')
    expect(window.start.toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(window.end.toISOString()).toBe('2026-03-09T04:00:00.000Z')
    expect(window.end.getTime() - window.start.getTime()).toBe(23 * 60 * 60 * 1000)
  })
})
