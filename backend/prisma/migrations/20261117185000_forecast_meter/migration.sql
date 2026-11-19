ALTER TABLE "ForecastRun" ADD COLUMN "meterId" UUID;
ALTER TABLE "ForecastRun" ADD CONSTRAINT "ForecastRun_organizationId_meterId_fkey"
  FOREIGN KEY ("organizationId", "meterId") REFERENCES "Meter"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ForecastRun_organizationId_meterId_createdAt_idx"
  ON "ForecastRun"("organizationId", "meterId", "createdAt" DESC);
