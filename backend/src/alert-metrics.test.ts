import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { alertBreached, alertWindow } from './alert-metrics.js'

const start = new Date('2026-11-17T00:00:00Z'), end = new Date('2026-11-17T00:15:00Z')
const sample = (minute: number, value: string) => ({ timestamp: new Date(start.getTime() + minute * 60000), value })
describe('alert window evaluation', () => {
  it('computes observed interval consumption without inventing missing readings', () => {
    const result = alertWindow({ metric: 'ENERGY_IMPORT', meterType: 'INTERVAL', intervalMinutes: 5, start, end, readings: [sample(5, '2'), sample(15, '3')] })!
    expect(result.value.toString()).toBe('5')
    expect(result.complete).toBe(false)
    expect(alertBreached(result.value, result.complete, 'GT', new Prisma.Decimal(4))).toBe(true)
    expect(alertBreached(result.value, result.complete, 'LT', new Prisma.Decimal(10))).toBe(false)
  })
  it('does not count a cumulative reset as negative energy or prove a low threshold', () => {
    const result = alertWindow({ metric: 'ENERGY_IMPORT', meterType: 'CUMULATIVE', intervalMinutes: 5, start, end, readings: [sample(0, '100'), sample(5, '5'), sample(10, '8'), sample(15, '10')] })!
    expect(result.value.toString()).toBe('5')
    expect(result.complete).toBe(false)
  })
  it('evaluates complete power windows and rejects ambiguous timestamps', () => {
    const input = { metric: 'POWER_DEMAND', meterType: 'INTERVAL', intervalMinutes: 5, start, end, readings: [sample(5, '2'), sample(10, '3'), sample(15, '4')] }
    const result = alertWindow(input)!
    expect(result.complete).toBe(true)
    expect(alertBreached(result.value, result.complete, 'OUTSIDE_RANGE', new Prisma.Decimal(1), new Prisma.Decimal(3))).toBe(true)
    expect(alertWindow({ ...input, readings: [...input.readings, sample(15, '8')] })).toBeNull()
  })
})
