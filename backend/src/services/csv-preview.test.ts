import { describe, expect, it, vi } from 'vitest'
import { Prisma, type PrismaClient } from '@prisma/client'
import { validateCsvPreview } from './csv-preview.js'

describe('CSV preview meter configuration', () => {
  it('uses the multiplier in effect for each reading', async () => {
    const meter = { id: 'meter-1', code: 'M1', metric: 'ENERGY_IMPORT', unit: 'kWh', multiplier: new Prisma.Decimal(3), configurationVersions: [
      { effectiveFrom: new Date('2026-02-01T00:00:00Z'), effectiveTo: null, multiplier: new Prisma.Decimal(3) },
      { effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: new Date('2026-01-31T23:59:59.999Z'), multiplier: new Prisma.Decimal(2) }
    ] }
    const db = { meter: { findMany: vi.fn().mockResolvedValue([meter]) } } as unknown as PrismaClient
    const result = await validateCsvPreview(db, 'meterCode,timestamp,rawValue,unit\nM1,2026-01-15T00:00:00Z,10,kWh\nM1,2026-02-15T00:00:00Z,10,kWh', 'org', undefined, 'source')
    expect('error' in result).toBe(false)
    if ('error' in result) throw new Error(result.error)
    expect(result.valid.map(row => row.value.toString())).toEqual(['20', '30'])
  })
})
