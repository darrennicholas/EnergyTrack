CREATE TABLE "QuarantinedReading" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "importJobId" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "resolvedAt" TIMESTAMPTZ(6),
  "resolvedBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuarantinedReading_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuarantinedReading_organizationId_importJobId_fkey"
    FOREIGN KEY ("organizationId", "importJobId")
    REFERENCES "ImportJob"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "QuarantinedReading_organizationId_id_key"
  ON "QuarantinedReading"("organizationId", "id");
CREATE INDEX "QuarantinedReading_organizationId_status_createdAt_idx"
  ON "QuarantinedReading"("organizationId", "status", "createdAt" DESC);
