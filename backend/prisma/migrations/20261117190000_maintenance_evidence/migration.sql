ALTER TABLE "MeterMaintenance" ADD CONSTRAINT "MeterMaintenance_organizationId_id_key" UNIQUE ("organizationId", "id");

CREATE TABLE "MaintenanceEvidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "maintenanceId" UUID NOT NULL,
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
  CONSTRAINT "MaintenanceEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MaintenanceEvidence_organizationId_maintenanceId_fkey" FOREIGN KEY ("organizationId", "maintenanceId") REFERENCES "MeterMaintenance"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MaintenanceEvidence_organizationId_uploadedBy_fkey" FOREIGN KEY ("organizationId", "uploadedBy") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MaintenanceEvidence_sizeBytes_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 5242880),
  CONSTRAINT "MaintenanceEvidence_contentType_check" CHECK ("contentType" IN ('application/pdf', 'image/jpeg', 'image/png'))
);

CREATE INDEX "MaintenanceEvidence_organizationId_maintenanceId_createdAt_idx" ON "MaintenanceEvidence"("organizationId", "maintenanceId", "createdAt" DESC);
