CREATE UNIQUE INDEX "Site_organizationId_id_key" ON "Site"("organizationId", "id");

CREATE TABLE "ForecastRun" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "siteId" UUID NOT NULL,
  "requestedBy" UUID NOT NULL,
  "model" TEXT NOT NULL,
  "parameters" JSONB NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ForecastRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ForecastRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ForecastRun_organizationId_siteId_fkey" FOREIGN KEY ("organizationId", "siteId") REFERENCES "Site"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ForecastRun_organizationId_requestedBy_fkey" FOREIGN KEY ("organizationId", "requestedBy") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ForecastRun_organizationId_siteId_createdAt_idx" ON "ForecastRun"("organizationId", "siteId", "createdAt" DESC);
CREATE INDEX "ForecastRun_organizationId_requestedBy_createdAt_idx" ON "ForecastRun"("organizationId", "requestedBy", "createdAt" DESC);
