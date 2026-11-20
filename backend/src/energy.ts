import { Prisma } from '@prisma/client'
import { cumulativeDelta, rolloverValueAt, type RolloverConfiguration } from './shared/cumulative.js'

export type EnergyReading = {
  meterId: string
  timestamp: Date
  value: unknown
  unit: string
  meter: { meterType: string; metric: string; rolloverValue?: unknown | null; configurationVersions?: RolloverConfiguration[]; site?: { timezone: string } }
}

export type EnergyBucket = 'HOUR' | 'DAY' | 'WEEK' | 'MONTH'

export function localBucketKey(timestamp: Date, timezone: string, bucket: EnergyBucket): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', ...(bucket === 'HOUR' ? { hour: '2-digit', hourCycle: 'h23' as const } : {}) }).formatToParts(timestamp)
  const get = (name: string) => parts.find(part => part.type === name)?.value ?? ''
  const year = Number(get('year')), month = Number(get('month')), day = Number(get('day'))
  if (bucket === 'MONTH') return `${get('year')}-${get('month')}`
  if (bucket === 'HOUR') {
    const offsetName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(timestamp).find(part => part.type === 'timeZoneName')?.value ?? 'GMT'
    const offset = offsetName === 'GMT' ? '+00:00' : offsetName.replace('GMT', '')
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:00${offset}`
  }
  if (bucket === 'DAY') return `${get('year')}-${get('month')}-${get('day')}`
  const localDate = new Date(Date.UTC(year, month - 1, day)), isoDay = localDate.getUTCDay() || 7
  localDate.setUTCDate(localDate.getUTCDate() + 4 - isoDay)
  const weekYear = localDate.getUTCFullYear(), yearStart = new Date(Date.UTC(weekYear, 0, 1)), week = Math.ceil((((localDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${weekYear}-W${String(week).padStart(2, '0')}`
}

function energyByDay(readings: EnergyReading[], prior: EnergyReading[], local: boolean, bucket: EnergyBucket = 'DAY', timezoneOverride?: string) {
  const previous = new Map<string, Prisma.Decimal>()
  for (const reading of prior) {
    if (reading.meter.meterType === 'CUMULATIVE' && reading.meter.metric === 'ENERGY_IMPORT' && reading.unit === 'kWh')
      previous.set(reading.meterId, new Prisma.Decimal(String(reading.value)))
  }
  const buckets = new Map<string, Prisma.Decimal>()
  const resetBuckets = new Set<string>(), rolloverBuckets = new Set<string>()
  for (const reading of [...readings].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
    if (reading.meter.metric !== 'ENERGY_IMPORT' || reading.unit !== 'kWh') continue
    const value = new Prisma.Decimal(String(reading.value))
    const timezone = timezoneOverride ?? reading.meter.site?.timezone
    const key = local && timezone ? localBucketKey(reading.timestamp, timezone, bucket) : bucket === 'MONTH' ? reading.timestamp.toISOString().slice(0, 7) : bucket === 'WEEK' ? localBucketKey(reading.timestamp, 'UTC', 'WEEK') : bucket === 'HOUR' ? `${reading.timestamp.toISOString().slice(0, 13)}:00` : reading.timestamp.toISOString().slice(0, 10)
    let delta: Prisma.Decimal | undefined
    if (reading.meter.meterType === 'INTERVAL') delta = value
    else if (reading.meter.meterType === 'CUMULATIVE') {
      const old = previous.get(reading.meterId)
      if (old !== undefined) {
        const result = cumulativeDelta(old, value, rolloverValueAt(reading.timestamp, reading.meter))
        delta = result.delta ?? undefined
        if (result.event === 'RESET') resetBuckets.add(key)
        if (result.event === 'ROLLOVER') rolloverBuckets.add(key)
      }
      previous.set(reading.meterId, value)
    }
    if (delta !== undefined) {
      buckets.set(key, (buckets.get(key) || new Prisma.Decimal(0)).add(delta))
    }
  }
  return [...buckets].map(([date, kwh]) => ({ date, kwh: Number(kwh.toDecimalPlaces(2).toFixed(2)), unit: 'kWh', quality: resetBuckets.has(date) ? 'REVIEW_REQUIRED' : rolloverBuckets.has(date) ? 'ROLLOVER_ADJUSTED' : 'VALIDATED' }))
}

/** Calculate validated energy by UTC day; prior readings establish period boundaries. */
export function energyByUtcDay(readings: EnergyReading[], prior: EnergyReading[] = []) { return energyByDay(readings, prior, false) }

/** Calculate validated energy by each reading's site-local calendar day. */
export function energyByLocalDay(readings: EnergyReading[], prior: EnergyReading[] = []) { return energyByDay(readings, prior, true) }

/** Calculate validated energy by each reading's site-local hour. */
export function energyByLocalHour(readings: EnergyReading[], prior: EnergyReading[] = []) { return energyByDay(readings, prior, true, 'HOUR') }

/** Calculate validated energy by an explicitly selected IANA calendar day. */
export function energyByTimezoneDay(readings: EnergyReading[], prior: EnergyReading[], timezone: string) { return energyByDay(readings, prior, true, 'DAY', timezone) }

/** Calculate energy by an explicitly selected IANA calendar bucket. */
export function energyByTimezoneBucket(readings: EnergyReading[], prior: EnergyReading[], timezone: string, bucket: EnergyBucket) { return energyByDay(readings, prior, true, bucket, timezone) }

/** Calculate validated energy in site-local ISO weeks. */
export function energyByLocalWeek(readings: EnergyReading[], prior: EnergyReading[] = []) { return energyByDay(readings, prior, true, 'WEEK') }

/** Calculate validated energy in site-local calendar months. */
export function energyByLocalMonth(readings: EnergyReading[], prior: EnergyReading[] = []) { return energyByDay(readings, prior, true, 'MONTH') }

