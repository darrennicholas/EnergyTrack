CREATE TABLE "TariffAssignment" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "meterId" UUID NOT NULL,
  "tariffId" UUID NOT NULL,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TariffAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TariffAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TariffAssignment_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TariffAssignment_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "Tariff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TariffAssignment_dates_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);
CREATE INDEX "TariffAssignment_organizationId_meterId_effectiveFrom_idx" ON "TariffAssignment"("organizationId", "meterId", "effectiveFrom");
