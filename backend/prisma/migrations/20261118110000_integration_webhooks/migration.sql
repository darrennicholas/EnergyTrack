CREATE TABLE "IntegrationWebhook" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "events" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "secretEncrypted" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDeliveredAt" TIMESTAMPTZ(6),
  CONSTRAINT "IntegrationWebhook_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntegrationWebhook_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "IntegrationWebhook_organizationId_status_createdAt_idx" ON "IntegrationWebhook"("organizationId", "status", "createdAt" DESC);
CREATE TABLE "WebhookDelivery" (
  "id" UUID NOT NULL,
  "webhookId" UUID NOT NULL,
  "event" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "responseCode" INTEGER,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "IntegrationWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WebhookDelivery_webhookId_createdAt_idx" ON "WebhookDelivery"("webhookId", "createdAt" DESC);
CREATE TABLE "WebhookOutbox" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "event" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(6),
  "deliveredAt" TIMESTAMPTZ(6),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebhookOutbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "WebhookOutbox_status_nextAttemptAt_createdAt_idx" ON "WebhookOutbox"("status", "nextAttemptAt", "createdAt");
