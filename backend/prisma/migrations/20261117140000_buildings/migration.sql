CREATE TABLE "Building" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "siteId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Building_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Building_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Building_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Building_organizationId_siteId_code_key" ON "Building"("organizationId", "siteId", "code");
CREATE INDEX "Building_organizationId_siteId_idx" ON "Building"("organizationId", "siteId");
