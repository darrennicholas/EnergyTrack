CREATE TABLE "WorkspaceRecord" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "module" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "payload" JSONB NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkspaceRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkspaceRecord_organizationId_module_createdAt_idx" ON "WorkspaceRecord"("organizationId", "module", "createdAt" DESC);
