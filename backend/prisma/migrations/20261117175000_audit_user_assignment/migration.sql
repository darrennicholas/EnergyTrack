ALTER TABLE "EnergyAudit" ADD COLUMN "assignedAuditorId" UUID;

ALTER TABLE "EnergyAudit"
  ADD CONSTRAINT "EnergyAudit_assignedAuditorId_fkey"
  FOREIGN KEY ("organizationId", "assignedAuditorId")
  REFERENCES "User"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "EnergyAudit_organizationId_assignedAuditorId_status_idx"
  ON "EnergyAudit"("organizationId", "assignedAuditorId", "status");
