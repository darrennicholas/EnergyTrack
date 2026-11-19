CREATE TABLE "PlatformAdmin" (
    "userId" UUID NOT NULL,
    "grantedBy" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "PlatformAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlatformAdmin_grantedBy_fkey" FOREIGN KEY ("grantedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "PlatformAuditLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformAuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PlatformAuditLog_createdAt_idx" ON "PlatformAuditLog"("createdAt" DESC);
CREATE INDEX "PlatformAuditLog_userId_createdAt_idx" ON "PlatformAuditLog"("userId", "createdAt" DESC);

INSERT INTO "Permission" ("code", "module", "name", "description") VALUES
  ('tenant.provision', 'platform', 'Provision tenants', 'Create organization tenants and their initial administrator invitation.'),
  ('platform.config', 'platform', 'Read platform configuration', 'Read non-secret platform configuration and integration readiness.')
ON CONFLICT ("code") DO NOTHING;

UPDATE "Permission" SET "module" = 'organization' WHERE "code" = '*';
