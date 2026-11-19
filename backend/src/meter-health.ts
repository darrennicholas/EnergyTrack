import { Prisma, type PrismaClient } from '@prisma/client'

export function readingIsFresh(timestamp: Date, intervalMinutes: number, now: Date) {
  const age = now.getTime() - timestamp.getTime()
  return age >= 0 && age <= intervalMinutes * 2 * 60_000
}

export async function promoteFreshMeters(tx: Prisma.TransactionClient, organizationId: string, rows: { meterId: string; timestamp: Date; quality: string }[], actorId: string | null) {
  const now = new Date(), ids = [...new Set(rows.filter(row => row.quality === 'VALID').map(row => row.meterId))]
  const meters = await tx.meter.findMany({ where: { organizationId, id: { in: ids }, status: { in: ['TESTING', 'OFFLINE'] } }, orderBy: { id: 'asc' } })
  for (const meter of meters) {
    if (!rows.some(row => row.meterId === meter.id && row.quality === 'VALID' && readingIsFresh(row.timestamp, meter.intervalMinutes, now))) continue
    const changed = await tx.meter.updateMany({ where: { id: meter.id, organizationId, status: { in: ['TESTING', 'OFFLINE'] } }, data: { status: 'ONLINE' } })
    if (changed.count) await tx.auditLog.create({ data: { organizationId, userId: actorId, action: 'METER_ONLINE', entity: 'Meter', entityId: meter.id, details: { reason: 'FRESH_VALID_READING' } } })
  }
}

/** Rechecks freshness under the meter lock, making repeated or concurrent sweeps safe. */
export async function sweepMeterHealth(db: PrismaClient, organizationId?: string) {
  const meters = await db.meter.findMany({ where: { status: 'ONLINE', ...(organizationId ? { organizationId } : {}) }, select: { id: true, organizationId: true }, orderBy: { id: 'asc' } })
  for (const meter of meters) await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ status: string; intervalMinutes: number }[]>`SELECT "status", "intervalMinutes" FROM "Meter" WHERE "id" = ${meter.id}::uuid AND "organizationId" = ${meter.organizationId}::uuid FOR UPDATE`
    if (!rows[0] || rows[0].status !== 'ONLINE') return
    const now = new Date()
    const latest = await tx.meterReading.findFirst({ where: { organizationId: meter.organizationId, meterId: meter.id, quality: 'VALID', timestamp: { lte: now } }, orderBy: { timestamp: 'desc' }, select: { timestamp: true } })
    if (latest && readingIsFresh(latest.timestamp, rows[0].intervalMinutes, now)) return
    const changed = await tx.meter.updateMany({ where: { id: meter.id, organizationId: meter.organizationId, status: 'ONLINE' }, data: { status: 'OFFLINE' } })
    if (changed.count) await tx.auditLog.create({ data: { organizationId: meter.organizationId, action: 'METER_OFFLINE', entity: 'Meter', entityId: meter.id, details: { reason: 'HEARTBEAT_TIMEOUT' } } })
  })
}
