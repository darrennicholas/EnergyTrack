ALTER TABLE "ImportJob" ADD COLUMN "sourceId" UUID;
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_organizationId_sourceId_fkey" FOREIGN KEY ("organizationId", "sourceId") REFERENCES "IntegrationSource" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ImportJob_organizationId_sourceId_idx" ON "ImportJob" ("organizationId", "sourceId");
