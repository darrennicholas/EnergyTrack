import { Prisma, PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { alertBreached, alertWindow } from './alert-metrics.js'
import { rolloverValueAt } from './cumulative.js'

type Rule = { id: string; name: string; metric: string; operator: string; threshold: Prisma.Decimal; thresholdMax: Prisma.Decimal | null; windowMinutes: number; cooldownMinutes: number; channels: unknown; assigneeId: string | null }

/** Evaluate fresh measured values while holding rule locks; one active incident per meter and rule. */
export async function evaluateAlerts(tx: Prisma.TransactionClient, organizationId: string, meterIds: string[], actorId: string | null) {
  const now = new Date()
  const meters = await tx.meter.findMany({ where: { organizationId, id: { in: [...new Set(meterIds)].sort() } }, orderBy: { id: 'asc' } })
  for (const meter of meters) {
    const rules = await tx.$queryRaw<Rule[]>`SELECT "id", "name", "metric", "operator", "threshold", "thresholdMax", "windowMinutes", "cooldownMinutes", "channels", "assigneeId" FROM "AlertRule" WHERE "organizationId" = ${organizationId}::uuid AND "active" = TRUE AND "metric" = ${meter.metric} AND (("scopeType" = 'METER' AND "scopeId" = ${meter.id}::uuid) OR ("scopeType" = 'SITE' AND "scopeId" = ${meter.siteId}::uuid)) ORDER BY "id" FOR UPDATE`
    for (const rule of rules) {
      const start = new Date(now.getTime() - rule.windowMinutes * 60_000)
      const readings = await tx.meterReading.findMany({ where: { organizationId, meterId: meter.id, quality: 'VALID', timestamp: { gte: start, lte: now } }, select: { timestamp: true, value: true, meter: { select: { rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } } } } }, orderBy: { timestamp: 'asc' } })
      const result = alertWindow({ metric: meter.metric, meterType: meter.meterType, intervalMinutes: meter.intervalMinutes, start, end: now, readings: readings.map(({ timestamp, value, meter: config }) => ({ timestamp, value, rolloverValue: rolloverValueAt(timestamp, config) })) })
      if (!result || !alertBreached(result.value, result.complete, rule.operator, rule.threshold, rule.thresholdMax)) continue
      const active = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Alert" WHERE "organizationId" = ${organizationId}::uuid AND "ruleId" = ${rule.id}::uuid AND "meterId" = ${meter.id}::uuid AND "status" IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING') LIMIT 1`
      if (active.length) continue
      const previous = await tx.$queryRaw<{ triggeredAt: Date }[]>`SELECT "triggeredAt" FROM "Alert" WHERE "organizationId" = ${organizationId}::uuid AND "ruleId" = ${rule.id}::uuid AND "meterId" = ${meter.id}::uuid ORDER BY "triggeredAt" DESC LIMIT 1`
      if (previous[0] && now.getTime() - previous[0].triggeredAt.getTime() < rule.cooldownMinutes * 60_000) continue
      const id = randomUUID(), message = `${rule.name}: ${result.value.toString()} ${meter.unit} (${meter.code})`
      const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "Alert" ("id", "organizationId", "ruleId", "meterId", "message") VALUES (${id}::uuid, ${organizationId}::uuid, ${rule.id}::uuid, ${meter.id}::uuid, ${message}) ON CONFLICT DO NOTHING RETURNING "id"`
      if (inserted.length) {
        await tx.auditLog.create({ data: { organizationId, userId: actorId, action: 'ALERT_TRIGGERED', entity: 'Alert', entityId: id, details: { ruleId: rule.id, meterId: meter.id, value: result.value.toString(), unit: meter.unit, windowStart: start.toISOString(), windowEnd: now.toISOString(), complete: result.complete } } })
        await tx.webhookOutbox.create({ data: { organizationId, event: 'alert.created', payload: { alertId: id, ruleId: rule.id, meterId: meter.id, meterCode: meter.code, siteId: meter.siteId, message, value: result.value.toString(), unit: meter.unit, triggeredAt: now.toISOString() } } })
        const channels = Array.isArray(rule.channels) ? rule.channels.filter((channel): channel is 'EMAIL' | 'IN_APP' => channel === 'EMAIL' || channel === 'IN_APP') : []
        if (channels.includes('EMAIL') || channels.includes('IN_APP')) {
          const recipients = await tx.user.findMany({ where: { organizationId, active: true, ...(rule.assigneeId ? { id: rule.assigneeId } : {}), OR: [{ role: { in: ['ADMIN', 'EXECUTIVE'] } }, { siteAssignments: { some: { organizationId, siteId: meter.siteId } } }] }, select: { id: true, email: true, notificationPreference: { select: { inAppEnabled: true, emailEnabled: true } } } })
          const deliveries = recipients.flatMap(({ id: userId, email, notificationPreference }) => [
            ...(channels.includes('IN_APP') && (notificationPreference?.inAppEnabled ?? true) ? [{ organizationId, alertId: id, userId, channel: 'IN_APP', recipientEmail: email, status: 'SENT', sentAt: now }] : []),
            ...(channels.includes('EMAIL') && (notificationPreference?.emailEnabled ?? false) ? [{ organizationId, alertId: id, userId, channel: 'EMAIL', recipientEmail: email }] : []),
          ])
          if (deliveries.length) await tx.notificationDelivery.createMany({ data: deliveries, skipDuplicates: true })
        }
      }
    }
  }
}

/** Periodically re-evaluate active, healthy meter windows; advisory lock prevents duplicate work across API replicas. */
export async function evaluateScheduledAlerts(db: PrismaClient) {
  return db.$transaction(async tx => {
    const lock = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(71942, 7) AS acquired`
    if (!lock[0]?.acquired) return 0
    const rows = await tx.$queryRaw<{ organizationId: string; id: string }[]>`SELECT DISTINCT m."organizationId", m."id" FROM "Meter" m JOIN "AlertRule" r ON r."organizationId" = m."organizationId" AND r."metric" = m."metric" AND r."active" = TRUE AND ((r."scopeType" = 'METER' AND r."scopeId" = m."id") OR (r."scopeType" = 'SITE' AND r."scopeId" = m."siteId")) WHERE m."status" IN ('ONLINE', 'OFFLINE') ORDER BY m."organizationId", m."id"`
    const groups = new Map<string, string[]>()
    for (const row of rows) groups.set(row.organizationId, [...(groups.get(row.organizationId) ?? []), row.id])
    for (const [organizationId, ids] of groups) await evaluateAlerts(tx, organizationId, ids, null)
    return rows.length
  }, { timeout: 30_000 })
}
