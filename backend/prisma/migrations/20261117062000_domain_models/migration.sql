-- CreateTable
CREATE TABLE "Asset" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "mode" TEXT NOT NULL,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Baseline" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "value" DECIMAL(20,6) NOT NULL,
    "denominator" DECIMAL(20,6),
    "denominatorUnit" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalNotes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Baseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnergyTarget" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "targetValue" DECIMAL(20,6) NOT NULL,
    "unit" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnergyTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnergyAudit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "assignedAuditor" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalComments" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnergyAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditFinding" (
    "id" UUID NOT NULL,
    "auditId" UUID NOT NULL,
    "severity" TEXT NOT NULL,
    "observation" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrectiveAction" (
    "id" UUID NOT NULL,
    "findingId" UUID NOT NULL,
    "ownerId" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "outcome" TEXT,
    "evidenceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorrectiveAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmissionFactor" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "region" TEXT NOT NULL,
    "factor" DECIMAL(20,10) NOT NULL,
    "unit" TEXT NOT NULL,
    "publicationSource" TEXT NOT NULL,
    "applicableYear" INTEGER NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmissionFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportJob" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "failureReason" TEXT,
    "filePath" TEXT,
    "requestedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ReportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSource" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "secretHash" TEXT,
    "allowedMeterIds" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Asset_organizationId_siteId_idx" ON "Asset"("organizationId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_organizationId_code_key" ON "Asset"("organizationId", "code");

-- CreateIndex
CREATE INDEX "ImportJob_organizationId_createdAt_idx" ON "ImportJob"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Baseline_organizationId_siteId_idx" ON "Baseline"("organizationId", "siteId");

-- CreateIndex
CREATE INDEX "EnergyTarget_organizationId_siteId_idx" ON "EnergyTarget"("organizationId", "siteId");

-- CreateIndex
CREATE INDEX "EnergyAudit_organizationId_status_idx" ON "EnergyAudit"("organizationId", "status");

-- CreateIndex
CREATE INDEX "EmissionFactor_organizationId_applicableYear_idx" ON "EmissionFactor"("organizationId", "applicableYear");

-- CreateIndex
CREATE INDEX "ReportJob_organizationId_createdAt_idx" ON "ReportJob"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "IntegrationSource_organizationId_status_idx" ON "IntegrationSource"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "AuditFinding" ADD CONSTRAINT "AuditFinding_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "EnergyAudit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectiveAction" ADD CONSTRAINT "CorrectiveAction_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "AuditFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

