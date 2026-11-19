CREATE TABLE "ForecastDriver" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "weatherIndex" DECIMAL(12,4),
    "productionUnits" DECIMAL(18,4),
    "source" TEXT NOT NULL,
    "sourceReference" TEXT,
    "metadata" JSONB,
    "updatedBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ForecastDriver_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ForecastDriver_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ForecastDriver_siteId_organizationId_fkey" FOREIGN KEY ("organizationId", "siteId") REFERENCES "Site"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ForecastDriver_organizationId_siteId_date_key" ON "ForecastDriver"("organizationId", "siteId", "date");
CREATE INDEX "ForecastDriver_organizationId_siteId_date_idx" ON "ForecastDriver"("organizationId", "siteId", "date");
