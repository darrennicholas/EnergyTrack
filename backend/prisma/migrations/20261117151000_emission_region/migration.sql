ALTER TABLE "Site" ADD COLUMN "emissionRegion" TEXT;
CREATE INDEX "Site_organizationId_emissionRegion_idx" ON "Site"("organizationId", "emissionRegion");
