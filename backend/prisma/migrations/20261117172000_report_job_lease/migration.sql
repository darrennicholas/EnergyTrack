ALTER TABLE "ReportJob" ADD COLUMN "processingAt" TIMESTAMPTZ(6);
CREATE INDEX "ReportJob_status_processingAt_idx" ON "ReportJob"("status", "processingAt");
