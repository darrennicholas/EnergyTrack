ALTER TABLE "EnergyAudit" ADD CONSTRAINT "EnergyAudit_organizationId_id_key" UNIQUE ("organizationId", "id");

CREATE TABLE "AuditEvidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "auditId" UUID NOT NULL,
  "uploadedBy" UUID NOT NULL,
  "fileName" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "scanProvider" TEXT NOT NULL,
  "scanId" TEXT,
  "scannedAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuditEvidence_organizationId_auditId_fkey" FOREIGN KEY ("organizationId", "auditId") REFERENCES "EnergyAudit"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AuditEvidence_organizationId_uploadedBy_fkey" FOREIGN KEY ("organizationId", "uploadedBy") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AuditEvidence_sizeBytes_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 5242880),
  CONSTRAINT "AuditEvidence_contentType_check" CHECK ("contentType" IN ('application/pdf', 'image/jpeg', 'image/png'))
);
CREATE INDEX "AuditEvidence_organizationId_auditId_createdAt_idx" ON "AuditEvidence"("organizationId", "auditId", "createdAt" DESC);
