ALTER TABLE "ImportJob"
  ADD CONSTRAINT "ImportJob_organizationId_id_key" UNIQUE ("organizationId", "id");

ALTER TABLE "IntegrationSource"
  ADD CONSTRAINT "IntegrationSource_organizationId_id_key" UNIQUE ("organizationId", "id");

ALTER TABLE "MeterReading"
  ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "sourceId" UUID,
  ADD COLUMN "importJobId" UUID;

ALTER TABLE "MeterReading"
  ADD CONSTRAINT "MeterReading_organizationId_sourceId_fkey"
    FOREIGN KEY ("organizationId", "sourceId")
    REFERENCES "IntegrationSource"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MeterReading_organizationId_importJobId_fkey"
    FOREIGN KEY ("organizationId", "importJobId")
    REFERENCES "ImportJob"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "MeterReading_organizationId_sourceId_idx"
  ON "MeterReading"("organizationId", "sourceId");
CREATE INDEX "MeterReading_organizationId_importJobId_idx"
  ON "MeterReading"("organizationId", "importJobId");
