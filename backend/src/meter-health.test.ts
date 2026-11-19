import { describe, expect, it } from 'vitest'
import { readingIsFresh } from './meter-health.js'

describe('meter heartbeat freshness', () => {
  const now = new Date('2026-11-17T00:10:00Z')
  it('accepts only recent, non-future readings', () => {
    expect(readingIsFresh(new Date('2026-11-17T00:00:00Z'), 5, now)).toBe(true)
    expect(readingIsFresh(new Date('2026-11-16T23:59:59Z'), 5, now)).toBe(false)
    expect(readingIsFresh(new Date('2026-11-17T00:10:01Z'), 5, now)).toBe(false)
  })
})
