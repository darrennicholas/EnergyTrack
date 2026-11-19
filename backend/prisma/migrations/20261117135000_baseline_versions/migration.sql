ALTER TABLE "Baseline" ADD COLUMN "groupId" UUID, ADD COLUMN "supersedesId" UUID, ADD COLUMN "approvedBy" UUID, ADD COLUMN "approvedAt" TIMESTAMPTZ(6);
UPDATE "Baseline" SET "groupId" = "id";
ALTER TABLE "Baseline" ALTER COLUMN "groupId" SET NOT NULL;
ALTER TABLE "Baseline" ADD CONSTRAINT "Baseline_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "Baseline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Baseline" ADD CONSTRAINT "Baseline_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Baseline_organizationId_groupId_version_key" ON "Baseline"("organizationId", "groupId", "version");
CREATE UNIQUE INDEX "Baseline_one_draft_per_group_key" ON "Baseline"("organizationId", "groupId") WHERE "status" = 'DRAFT';
