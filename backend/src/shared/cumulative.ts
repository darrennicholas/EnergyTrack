import { Prisma } from '@prisma/client'

export type RegisterDelta = { delta: Prisma.Decimal | null; event: 'ROLLOVER' | 'RESET' | null }
export type RolloverConfiguration = { rolloverValue: unknown | null; effectiveFrom?: Date; effectiveTo?: Date | null }

export function rolloverValueAt(timestamp: Date, meter: { rolloverValue?: unknown | null; configurationVersions?: RolloverConfiguration[] }) {
  const version = meter.configurationVersions?.find(item => item.effectiveFrom && item.effectiveFrom <= timestamp && (!item.effectiveTo || timestamp <= item.effectiveTo))
  return version ? version.rolloverValue : meter.rolloverValue
}

/** Convert consecutive cumulative register values into energy without hiding resets. */
export function cumulativeDelta(previous: unknown, current: unknown, rolloverValue?: unknown | null): RegisterDelta {
  const before = new Prisma.Decimal(String(previous)), after = new Prisma.Decimal(String(current))
  if (after.gte(before)) return { delta: after.sub(before), event: null }
  if (rolloverValue !== undefined && rolloverValue !== null) {
    const modulus = new Prisma.Decimal(String(rolloverValue))
    if (modulus.gt(before) && modulus.gt(after)) return { delta: modulus.sub(before).add(after), event: 'ROLLOVER' }
  }
  return { delta: null, event: 'RESET' }
}
