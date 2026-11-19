import { Prisma } from '@prisma/client'
import { cumulativeDelta, rolloverValueAt, type RolloverConfiguration } from './cumulative.js'

type CostReading = { meterId: string; timestamp: Date; value: unknown; unit: string; meter: { meterType: string; metric: string; rolloverValue?: unknown | null; configurationVersions?: RolloverConfiguration[]; site: { timezone: string } } }
type RateAssignment = { meterId: string; tariffId: string; tariffName: string; unitRate: unknown; tariffType?: string; taxPercent?: unknown; fixedCharge?: unknown; timezone?: string; rates?: { startMinute: number; endMinute: number; unitRate: unknown }[]; effectiveFrom: Date; effectiveTo: Date | null }
const day = (value: Date) => value.toISOString().slice(0, 10)
export function siteDate(timestamp: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp)
  const get = (name: string) => parts.find(part => part.type === name)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function estimateFixedCharges(assignments: RateAssignment[], periodStart: Date, periodEnd: Date) {
  if (periodEnd <= periodStart) throw new Error('INVALID_PERIOD')
  let beforeTax = new Prisma.Decimal(0), afterTax = new Prisma.Decimal(0)
  const lastInstant = new Date(periodEnd.getTime() - 1)
  for (const assignment of assignments) {
    const monthly = new Prisma.Decimal(String(assignment.fixedCharge ?? 0))
    if (monthly.isZero() || !assignment.timezone) continue
    const firstDay = siteDate(periodStart, assignment.timezone), lastDay = siteDate(lastInstant, assignment.timezone)
    const cursor = new Date(`${firstDay}T00:00:00.000Z`), last = new Date(`${lastDay}T00:00:00.000Z`)
    while (cursor <= last) {
      const date = cursor.toISOString().slice(0, 10)
      if (day(assignment.effectiveFrom) <= date && (!assignment.effectiveTo || day(assignment.effectiveTo) >= date)) {
        const monthDays = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate()
        const daily = monthly.div(monthDays)
        beforeTax = beforeTax.add(daily)
        afterTax = afterTax.add(daily.mul(new Prisma.Decimal(1).add(new Prisma.Decimal(String(assignment.taxPercent ?? 0)).div(100))))
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }
  return { fixedChargeBeforeTaxIdr: beforeTax.toDecimalPlaces(2).toFixed(2), fixedChargeIdr: afterTax.toDecimalPlaces(2).toFixed(2) }
}

function siteMinute(timestamp: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp)
  const get = (name: string) => Number(parts.find(part => part.type === name)?.value)
  return get('hour') * 60 + get('minute')
}

/** Flat tariff estimate; each interval is priced at its ending reading's site-local date. */
export function estimateFlatCost(readings: CostReading[], prior: CostReading[], assignments: RateAssignment[]) {
  const previous = new Map<string, Prisma.Decimal>(), used = new Map<string, { tariffId: string; name: string; unitRate: string }>()
  for (const reading of prior) if (reading.meter.meterType === 'CUMULATIVE' && reading.meter.metric === 'ENERGY_IMPORT' && reading.unit === 'kWh') previous.set(reading.meterId, new Prisma.Decimal(String(reading.value)))
  let cost = new Prisma.Decimal(0), priced = new Prisma.Decimal(0), unpriced = new Prisma.Decimal(0), unknownIntervals = 0, intervals = 0
  for (const reading of readings) {
    if (reading.meter.metric !== 'ENERGY_IMPORT' || reading.unit !== 'kWh') continue
    const value = new Prisma.Decimal(String(reading.value))
    let energy: Prisma.Decimal | undefined
    if (reading.meter.meterType === 'INTERVAL') energy = value
    else if (reading.meter.meterType === 'CUMULATIVE') {
      const old = previous.get(reading.meterId)
      if (old) {
        const result = cumulativeDelta(old, value, rolloverValueAt(reading.timestamp, reading.meter))
        energy = result.delta ?? undefined
        if (result.event === 'RESET') unknownIntervals++
      } else unknownIntervals++
      previous.set(reading.meterId, value)
    }
    if (!energy) continue
    intervals++
    const date = siteDate(reading.timestamp, reading.meter.site.timezone)
    const matches = assignments.filter(a => a.meterId === reading.meterId && day(a.effectiveFrom) <= date && (!a.effectiveTo || day(a.effectiveTo) >= date))
    if (matches.length > 1) throw new Error('OVERLAPPING_TARIFFS')
    const assignment = matches[0]
    if (!assignment) { unpriced = unpriced.add(energy); continue }
    const rate = assignment.tariffType === 'TOU'
      ? assignment.rates?.find(item => item.startMinute <= siteMinute(reading.timestamp, reading.meter.site.timezone) && siteMinute(reading.timestamp, reading.meter.site.timezone) < item.endMinute)?.unitRate
      : assignment.unitRate
    if (rate === undefined) { unpriced = unpriced.add(energy); continue }
    const baseCost = energy.mul(new Prisma.Decimal(String(rate)))
    const tax = new Prisma.Decimal(String(assignment.taxPercent ?? 0))
    cost = cost.add(baseCost.mul(new Prisma.Decimal(1).add(tax.div(100))))
    priced = priced.add(energy)
    used.set(assignment.tariffId, { tariffId: assignment.tariffId, name: assignment.tariffName, unitRate: String(rate) })
  }
  return { currency: 'IDR', unit: 'kWh', estimatedCostIdr: intervals && unpriced.isZero() && unknownIntervals === 0 ? cost.toDecimalPlaces(2).toFixed(2) : null, pricedCostIdr: intervals ? cost.toDecimalPlaces(2).toFixed(2) : null, pricedKwh: priced.toDecimalPlaces(6).toFixed(6), unpricedKwh: unpriced.toDecimalPlaces(6).toFixed(6), unknownIntervals, intervals, tariffs: [...used.values()] }
}
