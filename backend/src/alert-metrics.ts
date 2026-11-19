import { Prisma } from '@prisma/client'
import { cumulativeDelta } from './cumulative.js'

export type AlertSample = { timestamp: Date; value: unknown; rolloverValue?: unknown | null }
export type AlertMetricInput = { metric: string; meterType: string; intervalMinutes: number; start: Date; end: Date; readings: AlertSample[] }

/** Observed demand maximum or nonnegative energy within the window, without filling gaps. */
export function alertWindow(input: AlertMetricInput) {
  const interval = input.intervalMinutes * 60_000
  const samples = [...input.readings].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  if (!samples.length || interval <= 0) return null
  const times = samples.map(r => r.timestamp.getTime())
  if (new Set(times).size !== times.length) return null
  const complete = times[0] <= input.start.getTime() + interval && times[times.length - 1] >= input.end.getTime() - interval && times.every((t, i) => !i || t - times[i - 1] <= interval)
  if (input.metric === 'POWER_DEMAND') return { value: samples.reduce((max, r) => Prisma.Decimal.max(max, new Prisma.Decimal(String(r.value))), new Prisma.Decimal(0)), complete }
  if (input.metric !== 'ENERGY_IMPORT') return null
  if (input.meterType === 'INTERVAL') {
    const inside = samples.filter(r => r.timestamp.getTime() - interval >= input.start.getTime())
    if (!inside.length) return null
    return { value: inside.reduce((sum, r) => sum.add(new Prisma.Decimal(String(r.value))), new Prisma.Decimal(0)), complete: complete && inside.length === samples.length }
  }
  if (input.meterType !== 'CUMULATIVE' || samples.length < 2) return null
  let sum = new Prisma.Decimal(0), reset = false
  for (let i = 1; i < samples.length; i++) {
    const result = cumulativeDelta(samples[i - 1].value, samples[i].value, samples[i].rolloverValue)
    if (result.delta) sum = sum.add(result.delta)
    if (result.event === 'RESET') reset = true
  }
  // A partial boundary interval cannot support a reliable low-consumption comparison.
  return { value: sum, complete: complete && !reset && times[0] === input.start.getTime() }
}

export function alertBreached(value: Prisma.Decimal, complete: boolean, operator: string, min: Prisma.Decimal, max?: Prisma.Decimal | null) {
  if (operator === 'GT') return value.gt(min)
  if (operator === 'LT') return complete && value.lt(min)
  if (operator === 'OUTSIDE_RANGE' && max) return value.gt(max) || (complete && value.lt(min))
  return false
}
