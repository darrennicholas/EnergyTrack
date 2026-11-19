ALTER TABLE "Meter" ADD COLUMN "rolloverValue" DECIMAL(20,6);
ALTER TABLE "MeterConfigVersion" ADD COLUMN "rolloverValue" DECIMAL(20,6);

ALTER TABLE "Meter"
  ADD CONSTRAINT "Meter_rolloverValue_positive_check"
  CHECK ("rolloverValue" IS NULL OR "rolloverValue" > 0);
ALTER TABLE "MeterConfigVersion"
  ADD CONSTRAINT "MeterConfigVersion_rolloverValue_positive_check"
  CHECK ("rolloverValue" IS NULL OR "rolloverValue" > 0);
