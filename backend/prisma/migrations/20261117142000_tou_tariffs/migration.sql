ALTER TABLE "Tariff"
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'IDR',
  ADD COLUMN "tariffType" TEXT NOT NULL DEFAULT 'FLAT',
  ADD COLUMN "fixedCharge" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxPercent" DECIMAL(7,4) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "Tariff_type_check" CHECK ("tariffType" IN ('FLAT', 'TOU')),
  ADD CONSTRAINT "Tariff_currency_check" CHECK ("currency" = 'IDR'),
  ADD CONSTRAINT "Tariff_values_check" CHECK ("unitRate" >= 0 AND "fixedCharge" >= 0 AND "taxPercent" BETWEEN 0 AND 100);
CREATE UNIQUE INDEX "Tariff_organizationId_id_key" ON "Tariff"("organizationId", "id");

CREATE TABLE "TariffRate" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "tariffId" UUID NOT NULL,
  "startMinute" INTEGER NOT NULL,
  "endMinute" INTEGER NOT NULL,
  "unitRate" DECIMAL(18,4) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TariffRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TariffRate_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TariffRate_tariff_fkey" FOREIGN KEY ("organizationId", "tariffId") REFERENCES "Tariff"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TariffRate_minute_range_check" CHECK ("startMinute" >= 0 AND "startMinute" < "endMinute" AND "endMinute" <= 1440),
  CONSTRAINT "TariffRate_value_check" CHECK ("unitRate" >= 0),
  CONSTRAINT "TariffRate_tariffId_startMinute_key" UNIQUE ("tariffId", "startMinute")
);
CREATE INDEX "TariffRate_organizationId_tariffId_idx" ON "TariffRate"("organizationId", "tariffId");
