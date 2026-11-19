CREATE TABLE "IntegrationCredential" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "secretHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntegrationCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "IntegrationCredential_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "IntegrationSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IntegrationCredential_secretHash_key" ON "IntegrationCredential"("secretHash");
CREATE INDEX "IntegrationCredential_organizationId_sourceId_idx" ON "IntegrationCredential"("organizationId", "sourceId");
