CREATE TABLE "MeterEnergyAggregate" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "meterId" UUID NOT NULL,
  "granularity" TEXT NOT NULL,
  "bucketKey" VARCHAR(40) NOT NULL,
  "bucketStart" TIMESTAMPTZ(6) NOT NULL,
  "localDate" VARCHAR(10) NOT NULL,
  "timezone" TEXT NOT NULL,
  "energyKwh" DECIMAL(22,6) NOT NULL,
  "readingCount" INTEGER NOT NULL DEFAULT 0,
  "expectedReadingCount" INTEGER NOT NULL DEFAULT 0,
  "completenessPercent" DECIMAL(5,2),
  "resetCount" INTEGER NOT NULL DEFAULT 0,
  "rolloverCount" INTEGER NOT NULL DEFAULT 0,
  "quality" TEXT NOT NULL DEFAULT 'VALIDATED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "MeterEnergyAggregate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MeterEnergyAggregate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MeterEnergyAggregate_organizationId_meterId_fkey" FOREIGN KEY ("organizationId", "meterId") REFERENCES "Meter"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MeterEnergyAggregate_org_meter_granularity_bucket_key" ON "MeterEnergyAggregate"("organizationId", "meterId", "granularity", "bucketKey");
CREATE INDEX "MeterEnergyAggregate_org_granularity_start_meter_idx" ON "MeterEnergyAggregate"("organizationId", "granularity", "bucketStart", "meterId");

INSERT INTO "MeterRollupTask" ("id", "organizationId", "meterId", "requestedFrom", "generation", "processedGeneration", "status", "nextAttemptAt", "createdAt", "updatedAt")
SELECT gen_random_uuid(), m."organizationId", m."id", MIN(r."timestamp"), 1, 0, 'QUEUED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Meter" m
JOIN "MeterReading" r ON r."organizationId" = m."organizationId" AND r."meterId" = m."id"
WHERE m."metric" = 'ENERGY_IMPORT' AND m."unit" = 'kWh' AND r."quality" = 'VALID' AND r."unit" = 'kWh'
GROUP BY m."organizationId", m."id"
ON CONFLICT ("organizationId", "meterId") DO UPDATE SET
  "requestedFrom" = LEAST("MeterRollupTask"."requestedFrom", EXCLUDED."requestedFrom"),
  "generation" = "MeterRollupTask"."generation" + 1,
  "status" = CASE WHEN "MeterRollupTask"."status" = 'PROCESSING' THEN 'PROCESSING' ELSE 'QUEUED' END,
  "nextAttemptAt" = CURRENT_TIMESTAMP,
  "lastError" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;
