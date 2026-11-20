import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { multiplierAt } from './meter-configuration.js'

describe('multiplierAt', () => {
  const versions = [
    { effectiveFrom: new Date('2026-02-01T00:00:00Z'), effectiveTo: null, multiplier: new Prisma.Decimal(3) },
    { effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: new Date('2026-01-31T23:59:59.999Z'), multiplier: new Prisma.Decimal(2) }
  ]
  it('uses the version effective at the reading timestamp', () => {
    expect(multiplierAt(new Date('2026-01-31T23:59:59.999Z'), versions, new Prisma.Decimal(3)).toString()).toBe('2')
    expect(multiplierAt(new Date('2026-02-01T00:00:00Z'), versions, new Prisma.Decimal(3)).toString()).toBe('3')
  })
  it('uses the earliest configuration for older legacy readings and the meter value without history', () => {
    expect(multiplierAt(new Date('2025-01-01T00:00:00Z'), versions, new Prisma.Decimal(3)).toString()).toBe('2')
    expect(multiplierAt(new Date(), [], new Prisma.Decimal(4)).toString()).toBe('4')
  })
})
