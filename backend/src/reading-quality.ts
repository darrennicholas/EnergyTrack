import { cumulativeDelta, rolloverValueAt, type RolloverConfiguration } from './shared/cumulative.js'

export type QualityReading = {
  meterId: string
  externalId?: string | null
  timestamp: Date
  value: unknown
  quality: string
  meter: {
    code: string
    meterType: string
    metric: string
    unit: string
    intervalMinutes: number
    rolloverValue?: unknown | null
    configurationVersions?: RolloverConfiguration[]
  }
}

export type ReadingIssue = {
  type: 'REGISTER_RESET' | 'REGISTER_ROLLOVER' | 'DATA_GAP' | 'QUALITY_FLAG' | 'DUPLICATE_TIMESTAMP'
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  meterId: string
  meterCode: string
  timestamp: string
  previousTimestamp?: string
  observedValue?: string
  previousValue?: string
  quality?: string
  missingIntervals?: number
  message: string
}

/** Derive reviewable quality issues from raw records so late arrivals are included immediately. */
export function detectReadingIssues(readings: QualityReading[], prior: QualityReading[] = [], start?: Date, end?: Date): ReadingIssue[] {
  const grouped = new Map<string, QualityReading[]>()
  for (const row of [...prior, ...readings]) grouped.set(row.meterId, [...(grouped.get(row.meterId) ?? []), row])
  const issues: ReadingIssue[] = []
  for (const rows of grouped.values()) {
    rows.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    const meter = rows[0].meter
    for (let i = 0; i < rows.length; i++) {
      const current = rows[i], at = current.timestamp.getTime()
      const inPeriod = (!start || at >= start.getTime()) && (!end || at < end.getTime())
      if (inPeriod && current.quality !== 'VALID') issues.push({ type: 'QUALITY_FLAG', severity: current.quality === 'INVALID' ? 'CRITICAL' : 'WARNING', meterId: current.meterId, meterCode: meter.code, timestamp: current.timestamp.toISOString(), observedValue: String(current.value), quality: current.quality, message: `Bacaan berstatus ${current.quality} perlu ditinjau.` })
      const previous = rows[i - 1]
      if (!previous) continue
      const elapsed = at - previous.timestamp.getTime(), interval = meter.intervalMinutes * 60_000
      if (inPeriod && elapsed > interval * 1.5) {
        const missingIntervals = Math.max(1, Math.floor(elapsed / interval) - 1)
        issues.push({ type: 'DATA_GAP', severity: 'WARNING', meterId: current.meterId, meterCode: meter.code, timestamp: current.timestamp.toISOString(), previousTimestamp: previous.timestamp.toISOString(), missingIntervals, message: `Ada ${missingIntervals} interval bacaan yang hilang.` })
      }
      if (inPeriod && current.timestamp.getTime() === previous.timestamp.getTime() && String(current.value) !== String(previous.value)) issues.push({ type: 'DUPLICATE_TIMESTAMP', severity: 'WARNING', meterId: current.meterId, meterCode: meter.code, timestamp: current.timestamp.toISOString(), observedValue: String(current.value), previousValue: String(previous.value), message: 'Timestamp memiliki lebih dari satu nilai meter.' })
      if (inPeriod && meter.meterType === 'CUMULATIVE' && meter.metric === 'ENERGY_IMPORT' && meter.unit === 'kWh' && current.quality === 'VALID' && previous.quality === 'VALID') {
        const delta = cumulativeDelta(previous.value, current.value, rolloverValueAt(current.timestamp, current.meter))
        if (delta.event === 'RESET') issues.push({ type: 'REGISTER_RESET', severity: 'CRITICAL', meterId: current.meterId, meterCode: meter.code, timestamp: current.timestamp.toISOString(), previousTimestamp: previous.timestamp.toISOString(), previousValue: String(previous.value), observedValue: String(current.value), message: 'Register turun tanpa modulus rollover yang berlaku; delta tidak dihitung dan perlu diperiksa.' })
        if (delta.event === 'ROLLOVER') issues.push({ type: 'REGISTER_ROLLOVER', severity: 'INFO', meterId: current.meterId, meterCode: meter.code, timestamp: current.timestamp.toISOString(), previousTimestamp: previous.timestamp.toISOString(), previousValue: String(previous.value), observedValue: String(current.value), message: `Rollover register dikoreksi menggunakan modulus ${String(rolloverValueAt(current.timestamp, current.meter))}.` })
      }
    }
  }
  return issues.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.meterCode.localeCompare(b.meterCode) || a.type.localeCompare(b.type))
}
