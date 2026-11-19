ALTER TABLE "Asset" ADD COLUMN "buildingId" UUID;
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Meter" ADD COLUMN "assetId" UUID, ADD COLUMN "serialNumber" TEXT, ADD COLUMN "installedAt" TIMESTAMPTZ(6), ADD COLUMN "decommissionedAt" TIMESTAMPTZ(6);
ALTER TABLE "Meter" ADD CONSTRAINT "Meter_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Meter" ADD CONSTRAINT "Meter_installation_dates_check" CHECK ("installedAt" IS NULL OR "decommissionedAt" IS NULL OR "installedAt" <= "decommissionedAt");
CREATE UNIQUE INDEX "Meter_active_serial_key" ON "Meter"("organizationId", "serialNumber") WHERE "serialNumber" IS NOT NULL AND "status" <> 'RETIRED';
