import { Prisma } from '@prisma/client'

type Version = { effectiveFrom: Date; effectiveTo: Date | null; multiplier: Prisma.Decimal }

// Older meters may have readings before their first recorded configuration.
export function multiplierAt(timestamp: Date, versions: Version[], fallback: Prisma.Decimal): Prisma.Decimal {
  const matching = versions.find(version => version.effectiveFrom <= timestamp && (!version.effectiveTo || version.effectiveTo >= timestamp))
  if (matching) return matching.multiplier
  const earliest = versions.reduce<Version | undefined>((result, version) => !result || version.effectiveFrom < result.effectiveFrom ? version : result, undefined)
  return earliest && timestamp < earliest.effectiveFrom ? earliest.multiplier : fallback
}
