ALTER TABLE "AlertRule"
  ADD COLUMN "scopeType" TEXT,
  ADD COLUMN "scopeId" UUID,
  ADD COLUMN "operator" TEXT NOT NULL DEFAULT 'GT',
  ADD COLUMN "thresholdMax" DECIMAL(18,4),
  ADD COLUMN "windowMinutes" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "channels" JSONB NOT NULL DEFAULT '["IN_APP"]'::jsonb,
  ADD COLUMN "assigneeId" UUID;
ALTER TABLE "Alert" ADD COLUMN "meterId" UUID;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Alert_active_rule_meter_key" ON "Alert" ("ruleId", "meterId") WHERE "meterId" IS NOT NULL AND "status" IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING');
