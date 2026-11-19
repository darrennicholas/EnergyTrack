CREATE UNIQUE INDEX "MeterReading_organizationId_id_key" ON "MeterReading"("organizationId", "id");

CREATE TABLE "ReadingRevision" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "readingId" UUID NOT NULL,
  "previousValue" DECIMAL(20,6) NOT NULL,
  "correctedValue" DECIMAL(20,6) NOT NULL,
  "quality" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReadingRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReadingRevision_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReadingRevision_reading_fkey" FOREIGN KEY ("organizationId", "readingId") REFERENCES "MeterReading"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReadingRevision_actor_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReadingRevision_quality_check" CHECK ("quality" IN ('VALID', 'ESTIMATED', 'SUSPECT', 'INVALID')),
  CONSTRAINT "ReadingRevision_reason_check" CHECK (length("reason") BETWEEN 2 AND 1000)
);
CREATE INDEX "ReadingRevision_organizationId_readingId_createdAt_idx" ON "ReadingRevision"("organizationId", "readingId", "createdAt" DESC);
