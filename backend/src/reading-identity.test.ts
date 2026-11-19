import { describe, expect, it } from 'vitest'
import { readingIdentity } from './reading-identity.js'

describe('fallback reading identity', () => {
  it('normalizes equivalent timestamps and distinguishes meters and values', () => {
    const id = readingIdentity('meter-a', new Date('2026-11-17T07:00:00+07:00'), '12.5', 'kWh')
    expect(id).toBe(readingIdentity('meter-a', new Date('2026-11-17T00:00:00Z'), '12.5', 'kWh'))
    expect(id).not.toBe(readingIdentity('meter-b', new Date('2026-11-17T00:00:00Z'), '12.5', 'kWh'))
    expect(id).not.toBe(readingIdentity('meter-a', new Date('2026-11-17T00:00:00Z'), '12.6', 'kWh'))
  })
})
