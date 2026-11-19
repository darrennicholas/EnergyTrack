CREATE UNIQUE INDEX "Meter_organizationId_id_key" ON "Meter"("organizationId", "id");
CREATE TABLE "MeterConfigVersion" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "meterId" UUID NOT NULL,
  "meterType" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "intervalMinutes" INTEGER NOT NULL,
  "multiplier" DECIMAL(18,6) NOT NULL,
  "effectiveFrom" TIMESTAMPTZ(6) NOT NULL,
  "effectiveTo" TIMESTAMPTZ(6),
  "createdBy" UUID,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MeterConfigVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MeterConfigVersion_meter_fkey" FOREIGN KEY ("organizationId", "meterId") REFERENCES "Meter"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MeterConfigVersion_actor_fkey" FOREIGN KEY ("organizationId", "createdBy") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MeterConfigVersion_dates_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  CONSTRAINT "MeterConfigVersion_interval_check" CHECK ("intervalMinutes" IN (1, 5, 15, 30, 60)),
  CONSTRAINT "MeterConfigVersion_multiplier_check" CHECK ("multiplier" > 0 AND "multiplier" <= 1000000),
  CONSTRAINT "MeterConfigVersion_reason_check" CHECK (length("reason") BETWEEN 2 AND 1000)
);
INSERT INTO "MeterConfigVersion" ("id", "organizationId", "meterId", "meterType", "metric", "unit", "sourceType", "intervalMinutes", "multiplier", "effectiveFrom", "effectiveTo", "createdBy", "reason")
SELECT gen_random_uuid(), m."organizationId", m."id", m."meterType", m."metric", m."unit", m."sourceType", m."intervalMinutes", m."multiplier", COALESCE(m."installedAt", m."createdAt"), NULL, NULL, 'Migrasi konfigurasi meter awal'
FROM "Meter" m;
CREATE INDEX "MeterConfigVersion_organizationId_meterId_effectiveFrom_idx" ON "MeterConfigVersion"("organizationId", "meterId", "effectiveFrom" DESC);
