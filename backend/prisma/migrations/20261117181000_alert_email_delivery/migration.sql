ALTER TABLE "Alert" ADD CONSTRAINT "Alert_organizationId_id_key" UNIQUE ("organizationId", "id");

CREATE TABLE "NotificationPreference" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "inAppEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationPreference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NotificationPreference_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");
CREATE UNIQUE INDEX "NotificationPreference_organizationId_userId_key" ON "NotificationPreference"("organizationId", "userId");

CREATE TABLE "NotificationDelivery" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "alertId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "channel" TEXT NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMPTZ(6),
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationDelivery_alert_fkey" FOREIGN KEY ("organizationId", "alertId") REFERENCES "Alert"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NotificationDelivery_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotificationDelivery_alertId_channel_recipientEmail_key" ON "NotificationDelivery"("alertId", "channel", "recipientEmail");
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_createdAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "NotificationDelivery_organizationId_userId_createdAt_idx" ON "NotificationDelivery"("organizationId", "userId", "createdAt" DESC);
