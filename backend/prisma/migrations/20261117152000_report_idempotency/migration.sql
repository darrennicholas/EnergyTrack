ALTER TABLE "ReportJob"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "requestHash" TEXT;
CREATE UNIQUE INDEX "ReportJob_organizationId_idempotencyKey_key" ON "ReportJob"("organizationId", "idempotencyKey");
