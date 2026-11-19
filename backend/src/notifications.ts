import { PrismaClient } from '@prisma/client'
import { deliverEmail } from './email-delivery.js'

const maxAttempts = 5
export const notificationRetryDelayMs = (attempt: number) => 15_000 * 2 ** Math.max(0, attempt - 1)

/** Claim one email outbox row atomically so parallel API instances cannot send it twice. */
export async function deliverOneAlertEmail(db: PrismaClient) {
  const delivery = await db.$transaction(async tx => {
    await tx.$executeRaw`UPDATE "NotificationDelivery" SET "status" = 'QUEUED', "processingAt" = NULL, "nextAttemptAt" = NULL WHERE "status" = 'PROCESSING' AND "processingAt" < CURRENT_TIMESTAMP - INTERVAL '10 minutes'`
    const rows = await tx.$queryRaw<{ id: string; organizationId: string; alertId: string; userId: string; attemptCount: number }[]>`WITH candidate AS (SELECT "id" FROM "NotificationDelivery" WHERE "status" = 'QUEUED' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= CURRENT_TIMESTAMP) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE "NotificationDelivery" d SET "status" = 'PROCESSING', "processingAt" = CURRENT_TIMESTAMP, "attemptCount" = d."attemptCount" + 1 FROM candidate WHERE d."id" = candidate."id" RETURNING d."id", d."organizationId", d."alertId", d."userId", d."attemptCount"`
    return rows[0] ?? null
  })
  if (!delivery) return false
  const preference = await db.notificationPreference.findFirst({ where: { organizationId: delivery.organizationId, userId: delivery.userId, emailEnabled: true, user: { active: true } }, select: { user: { select: { email: true, fullName: true } } } })
  if (!preference) {
    await db.$executeRaw`UPDATE "NotificationDelivery" SET "status" = 'CANCELLED', "processingAt" = NULL, "lastError" = 'Email preference disabled before delivery.' WHERE "id" = ${delivery.id}::uuid AND "status" = 'PROCESSING'`
    return true
  }
  const alert = await db.alert.findFirst({ where: { id: delivery.alertId, organizationId: delivery.organizationId }, select: { message: true } })
  if (!alert) {
    await db.$executeRaw`UPDATE "NotificationDelivery" SET "status" = 'FAILED', "processingAt" = NULL, "lastError" = 'Alert record no longer exists.' WHERE "id" = ${delivery.id}::uuid AND "status" = 'PROCESSING'`
    return true
  }
  try {
    await deliverEmail({ to: preference.user.email, subject: 'Peringatan energi EnergiTrack', text: `Halo ${preference.user.fullName},\n\n${alert.message}\n\nBuka EnergiTrack untuk meninjau detail dan tindakan yang diperlukan.` })
    await db.$transaction(async tx => {
      const updated = await tx.$executeRaw`UPDATE "NotificationDelivery" SET "status" = 'SENT', "processingAt" = NULL, "recipientEmail" = ${preference.user.email}, "sentAt" = CURRENT_TIMESTAMP, "nextAttemptAt" = NULL, "lastError" = NULL WHERE "id" = ${delivery.id}::uuid AND "status" = 'PROCESSING'`
      if (updated) await tx.auditLog.create({ data: { organizationId: delivery.organizationId, userId: delivery.userId, action: 'ALERT_EMAIL_SENT', entity: 'NotificationDelivery', entityId: delivery.id, details: { alertId: delivery.alertId, attemptCount: delivery.attemptCount } } })
    })
  } catch (error) {
    const retry = delivery.attemptCount < maxAttempts, delayMs = retry ? notificationRetryDelayMs(delivery.attemptCount) : 0
    const reason = error instanceof Error ? error.message.slice(0, 300) : 'Email delivery failed.'
    await db.$transaction(async tx => {
      const updated = await tx.$executeRaw`UPDATE "NotificationDelivery" SET "status" = ${retry ? 'QUEUED' : 'FAILED'}, "processingAt" = NULL, "nextAttemptAt" = ${retry ? new Date(Date.now() + delayMs) : null}, "lastError" = ${reason} WHERE "id" = ${delivery.id}::uuid AND "status" = 'PROCESSING'`
      if (updated) await tx.auditLog.create({ data: { organizationId: delivery.organizationId, userId: delivery.userId, action: retry ? 'ALERT_EMAIL_RETRY_SCHEDULED' : 'ALERT_EMAIL_FAILED', entity: 'NotificationDelivery', entityId: delivery.id, details: { alertId: delivery.alertId, attemptCount: delivery.attemptCount, retryInSeconds: retry ? delayMs / 1000 : null } } })
    })
  }
  return true
}

export const notificationMaxAttempts = maxAttempts
