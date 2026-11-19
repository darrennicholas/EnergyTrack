ALTER TABLE "ReportJob"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(6);

CREATE INDEX "ReportJob_status_nextAttemptAt_createdAt_idx"
  ON "ReportJob"("status", "nextAttemptAt", "createdAt");
