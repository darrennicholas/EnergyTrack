CREATE TABLE "MeterEnergyRollup" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "meterId" UUID NOT NULL,
  "localDate" VARCHAR(10) NOT NULL,
  "timezone" TEXT NOT NULL,
  "energyKwh" DECIMAL(22,6) NOT NULL,
  "readingCount" INTEGER NOT NULL DEFAULT 0,
  "resetCount" INTEGER NOT NULL DEFAULT 0,
  "rolloverCount" INTEGER NOT NULL DEFAULT 0,
  "quality" TEXT NOT NULL DEFAULT 'VALIDATED',
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "MeterEnergyRollup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MeterEnergyRollup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MeterEnergyRollup_organizationId_meterId_fkey" FOREIGN KEY ("organizationId", "meterId") REFERENCES "Meter"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MeterEnergyRollup_organizationId_meterId_localDate_key" ON "MeterEnergyRollup"("organizationId", "meterId", "localDate");
CREATE INDEX "MeterEnergyRollup_organizationId_localDate_meterId_idx" ON "MeterEnergyRollup"("organizationId", "localDate", "meterId");

CREATE TABLE "MeterRollupTask" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "meterId" UUID NOT NULL,
  "requestedFrom" TIMESTAMPTZ(6) NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "processedGeneration" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(6),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "MeterRollupTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MeterRollupTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MeterRollupTask_organizationId_meterId_fkey" FOREIGN KEY ("organizationId", "meterId") REFERENCES "Meter"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MeterRollupTask_organizationId_meterId_key" ON "MeterRollupTask"("organizationId", "meterId");
CREATE INDEX "MeterRollupTask_status_nextAttemptAt_createdAt_idx" ON "MeterRollupTask"("status", "nextAttemptAt", "createdAt");

INSERT INTO "MeterRollupTask" ("id", "organizationId", "meterId", "requestedFrom", "generation", "processedGeneration", "status", "nextAttemptAt", "createdAt", "updatedAt")
SELECT gen_random_uuid(), m."organizationId", m."id", MIN(r."timestamp"), 1, 0, 'QUEUED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Meter" m JOIN "MeterReading" r ON r."organizationId" = m."organizationId" AND r."meterId" = m."id"
WHERE m."metric" = 'ENERGY_IMPORT' AND m."unit" = 'kWh' AND r."quality" = 'VALID' AND r."unit" = 'kWh'
GROUP BY m."organizationId", m."id";
