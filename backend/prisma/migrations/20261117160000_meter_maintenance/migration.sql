CREATE TABLE "MeterMaintenance" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "meterId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMPTZ(6),
    "assignedTo" UUID,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "workNotes" TEXT,
    "outcome" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "MeterMaintenance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MeterMaintenance_organizationId_meterId_fkey"
      FOREIGN KEY ("organizationId", "meterId")
      REFERENCES "Meter"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "MeterMaintenance_organizationId_meterId_createdAt_idx"
  ON "MeterMaintenance"("organizationId", "meterId", "createdAt" DESC);
CREATE INDEX "MeterMaintenance_organizationId_status_scheduledAt_idx"
  ON "MeterMaintenance"("organizationId", "status", "scheduledAt");
