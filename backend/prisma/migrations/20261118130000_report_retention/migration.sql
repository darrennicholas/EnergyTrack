ALTER TABLE "ReportJob" ADD COLUMN "expiresAt" TIMESTAMPTZ(6);
CREATE INDEX "ReportJob_status_expiresAt_idx" ON "ReportJob"("status", "expiresAt");
