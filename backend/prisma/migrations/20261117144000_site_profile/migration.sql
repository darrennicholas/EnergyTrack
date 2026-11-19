CREATE UNIQUE INDEX "User_organizationId_id_key" ON "User"("organizationId", "id");
ALTER TABLE "Site"
  ADD COLUMN "latitude" DECIMAL(9,6),
  ADD COLUMN "longitude" DECIMAL(10,6),
  ADD COLUMN "operatingSchedule" JSONB,
  ADD COLUMN "managerId" UUID,
  ADD CONSTRAINT "Site_coordinates_check" CHECK (("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90) AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180)),
  ADD CONSTRAINT "Site_manager_fkey" FOREIGN KEY ("organizationId", "managerId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Site_organizationId_managerId_idx" ON "Site"("organizationId", "managerId");
