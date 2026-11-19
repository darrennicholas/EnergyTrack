CREATE TABLE "OrganizationMembership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrganizationMembership_organizationId_userId_key" UNIQUE ("organizationId", "userId"),
    CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrganizationMembership_status_check" CHECK ("status" IN ('ACTIVE', 'SUSPENDED'))
);

CREATE INDEX "OrganizationMembership_userId_status_idx" ON "OrganizationMembership"("userId", "status");

INSERT INTO "OrganizationMembership" ("organizationId", "userId", "role", "status")
SELECT "organizationId", "id", "role", CASE WHEN "active" THEN 'ACTIVE' ELSE 'SUSPENDED' END
FROM "User";

DO $$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = '"User"'::regclass
      AND cardinality(conkey) > 1
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_row.table_name, constraint_row.conname);
  END LOOP;
END $$;

DO $$
DECLARE relation_row RECORD;
DECLARE column_number SMALLINT;
BEGIN
  FOR relation_row IN
    SELECT * FROM (VALUES
      ('PasswordResetToken', 'userId'),
      ('Site', 'managerId'),
      ('SiteAssignment', 'userId'),
      ('MeterConfigVersion', 'createdBy'),
      ('MaintenanceEvidence', 'uploadedBy'),
      ('NotificationPreference', 'userId'),
      ('NotificationDelivery', 'userId'),
      ('ForecastRun', 'requestedBy'),
      ('EnergyAudit', 'assignedAuditorId'),
      ('AuditEvidence', 'uploadedBy')
    ) AS relations(table_name, column_name)
  LOOP
    SELECT attnum INTO column_number FROM pg_attribute
    WHERE attrelid = to_regclass(format('public.%I', relation_row.table_name))
      AND attname = relation_row.column_name AND NOT attisdropped;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE contype = 'f'
        AND conrelid = to_regclass(format('public.%I', relation_row.table_name))
        AND confrelid = '"User"'::regclass
        AND conkey = ARRAY[column_number]::smallint[]
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE', relation_row.table_name, relation_row.table_name || '_' || relation_row.column_name || '_membership_fkey', relation_row.column_name);
    END IF;
  END LOOP;
END $$;
