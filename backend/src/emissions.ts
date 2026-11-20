import { Prisma } from '@prisma/client'
import { siteDate } from './cost.js'
import { cumulativeDelta, rolloverValueAt, type RolloverConfiguration } from './shared/cumulative.js'

export type Reading = { meterId: string; timestamp: Date; value: unknown; unit: string; meter: { meterType: string; metric: string; rolloverValue?: unknown | null; configurationVersions?: RolloverConfiguration[]; site: { timezone: string } } }
export type Factor = { id: string; region: string; energySource?: string; factor: unknown; unit: string; publicationSource: string; sourceUrl: string; applicableYear: number; effectiveFrom: Date; effectiveTo: Date | null }

/** Energy is assigned to the local date of its ending reading, matching cost estimation. */
export function estimateEmissions(readings: Reading[], prior: Reading[], factor: Factor) {
  if (factor.unit !== 'kgCO2e/kWh') throw new Error('INCOMPATIBLE_FACTOR_UNIT')
  if (factor.energySource && factor.energySource !== 'ELECTRICITY') throw new Error('INCOMPATIBLE_ENERGY_SOURCE')
  const previous = new Map<string, Prisma.Decimal>()
  for (const r of prior) if (r.meter.meterType === 'CUMULATIVE' && r.meter.metric === 'ENERGY_IMPORT' && r.unit === 'kWh') previous.set(r.meterId, new Prisma.Decimal(String(r.value)))
  let covered = new Prisma.Decimal(0), uncovered = new Prisma.Decimal(0), unknownIntervals = 0, intervals = 0
  const from = factor.effectiveFrom.toISOString().slice(0, 10), to = factor.effectiveTo?.toISOString().slice(0, 10)
  for (const reading of readings) {
    if (reading.meter.metric !== 'ENERGY_IMPORT' || reading.unit !== 'kWh') continue
    const value = new Prisma.Decimal(String(reading.value))
    let energy: Prisma.Decimal | undefined
    if (reading.meter.meterType === 'INTERVAL') energy = value
    else if (reading.meter.meterType === 'CUMULATIVE') {
      const old = previous.get(reading.meterId)
      if (old) { const result = cumulativeDelta(old, value, rolloverValueAt(reading.timestamp, reading.meter)); energy = result.delta ?? undefined; if (result.event === 'RESET') unknownIntervals++ } else unknownIntervals++
      previous.set(reading.meterId, value)
    }
    if (!energy) continue
    intervals++
    const date = siteDate(reading.timestamp, reading.meter.site.timezone)
    if (date.slice(0, 4) === String(factor.applicableYear) && date >= from && (!to || date <= to)) covered = covered.add(energy); else uncovered = uncovered.add(energy)
  }
  const partial = covered.mul(new Prisma.Decimal(String(factor.factor))).div(1000).toDecimalPlaces(6).toFixed(6)
  return { estimatedTco2e: intervals && uncovered.isZero() && unknownIntervals === 0 ? partial : null, coveredTco2e: intervals ? partial : null, coveredKwh: covered.toFixed(6), uncoveredKwh: uncovered.toFixed(6), unknownIntervals, intervals, factor: { id: factor.id, region: factor.region, energySource: factor.energySource ?? 'ELECTRICITY', value: String(factor.factor), unit: factor.unit, publicationSource: factor.publicationSource, sourceUrl: factor.sourceUrl, applicableYear: factor.applicableYear, effectiveFrom: from, effectiveTo: to ?? null }, note: 'Estimasi, bukan inventaris emisi terverifikasi; kelengkapan interval belum diperiksa.' }
}

/** Select a factor by each interval's site-local year and effective dates. */
export function estimateEmissionsByYear(readings: Reading[], prior: Reading[], factors: Factor[]) {
  if (factors.some(factor => factor.unit !== 'kgCO2e/kWh')) throw new Error('INCOMPATIBLE_FACTOR_UNIT')
  const previous = new Map<string, Prisma.Decimal>()
  for (const reading of prior) if (reading.meter.meterType === 'CUMULATIVE' && reading.meter.metric === 'ENERGY_IMPORT' && reading.unit === 'kWh') previous.set(reading.meterId, new Prisma.Decimal(String(reading.value)))
  let coveredKwh = new Prisma.Decimal(0), uncoveredKwh = new Prisma.Decimal(0), emissions = new Prisma.Decimal(0), unknownIntervals = 0, intervals = 0
  const used = new Map<string, Factor>()
  for (const reading of readings) {
    if (reading.meter.metric !== 'ENERGY_IMPORT' || reading.unit !== 'kWh') continue
    const value = new Prisma.Decimal(String(reading.value))
    let energy: Prisma.Decimal | undefined
    if (reading.meter.meterType === 'INTERVAL') energy = value
    else if (reading.meter.meterType === 'CUMULATIVE') {
      const old = previous.get(reading.meterId)
      if (old) { const result = cumulativeDelta(old, value, rolloverValueAt(reading.timestamp, reading.meter)); energy = result.delta ?? undefined; if (result.event === 'RESET') unknownIntervals++ } else unknownIntervals++
      previous.set(reading.meterId, value)
    }
    if (!energy) continue
    intervals++
    const date = siteDate(reading.timestamp, reading.meter.site.timezone), year = Number(date.slice(0, 4))
    const matching = factors.filter(factor => (factor.energySource ?? 'ELECTRICITY') === 'ELECTRICITY' && factor.applicableYear === year && date >= factor.effectiveFrom.toISOString().slice(0, 10) && (!factor.effectiveTo || date <= factor.effectiveTo.toISOString().slice(0, 10)))
    if (matching.length > 1) throw new Error('OVERLAPPING_EMISSION_FACTORS')
    const factor = matching[0]
    if (!factor) { uncoveredKwh = uncoveredKwh.add(energy); continue }
    coveredKwh = coveredKwh.add(energy)
    emissions = emissions.add(energy.mul(new Prisma.Decimal(String(factor.factor))).div(1000))
    used.set(factor.id, factor)
  }
  const estimated = intervals > 0 && uncoveredKwh.isZero() && unknownIntervals === 0
  return { estimatedTco2e: estimated ? emissions.toDecimalPlaces(6).toFixed(6) : null, coveredTco2e: intervals ? emissions.toDecimalPlaces(6).toFixed(6) : null, coveredKwh: coveredKwh.toFixed(6), uncoveredKwh: uncoveredKwh.toFixed(6), unknownIntervals, intervals, factors: [...used.values()].map(factor => ({ id: factor.id, region: factor.region, energySource: factor.energySource ?? 'ELECTRICITY', value: String(factor.factor), unit: factor.unit, publicationSource: factor.publicationSource, sourceUrl: factor.sourceUrl, applicableYear: factor.applicableYear, effectiveFrom: factor.effectiveFrom.toISOString().slice(0, 10), effectiveTo: factor.effectiveTo?.toISOString().slice(0, 10) ?? null })), note: 'Faktor dipilih berdasarkan wilayah site dan tahun lokal tiap bacaan; hasil tetap estimasi, bukan inventaris terverifikasi.' }
}
