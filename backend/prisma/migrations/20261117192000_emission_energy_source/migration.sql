ALTER TABLE "EmissionFactor"
ADD COLUMN "energySource" TEXT NOT NULL DEFAULT 'ELECTRICITY';

ALTER TABLE "EmissionFactor"
ADD CONSTRAINT "EmissionFactor_energySource_check"
CHECK ("energySource" IN ('ELECTRICITY', 'NATURAL_GAS', 'DIESEL', 'GASOLINE', 'STEAM', 'OTHER'));
