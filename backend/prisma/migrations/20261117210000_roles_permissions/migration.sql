CREATE TABLE "Role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'ASSIGNED_SITES',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Role_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Role_organizationId_code_key" UNIQUE ("organizationId", "code"),
    CONSTRAINT "Role_organizationId_id_key" UNIQUE ("organizationId", "id")
);
CREATE INDEX "Role_organizationId_active_idx" ON "Role"("organizationId", "active");

CREATE TABLE "Permission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Permission_code_key" UNIQUE ("code")
);

CREATE TABLE "RolePermission" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionId"),
    CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

ALTER TABLE "OrganizationMembership" ADD COLUMN "roleId" UUID;
ALTER TABLE "Invitation" ADD COLUMN "roleId" UUID;

INSERT INTO "Role" ("organizationId", "code", "name", "description", "scope", "isSystem")
SELECT org."id", role."code", role."name", role."description", role."scope", true
FROM "Organization" org
CROSS JOIN (VALUES
  ('ADMIN', 'Organization Admin', 'Mengelola pengguna dan konfigurasi organisasi.', 'ORGANIZATION'),
  ('ENERGY_MANAGER', 'Energy Manager', 'Mengelola efisiensi energi, biaya, baseline, dan audit.', 'ASSIGNED_SITES'),
  ('FACILITY_MANAGER', 'Facility Manager', 'Mengelola site, aset, meter, dan impor bacaan.', 'ASSIGNED_SITES'),
  ('ANALYST', 'Energy Analyst', 'Membaca analitik, alert, emisi, dan laporan.', 'ASSIGNED_SITES'),
  ('TECHNICIAN', 'Technician', 'Melaksanakan pemeliharaan dan investigasi.', 'ASSIGNED_SITES'),
  ('EXECUTIVE', 'Executive', 'Membaca ringkasan organisasi dan laporan.', 'ORGANIZATION'),
  ('AUDITOR', 'Auditor', 'Membaca dan menjalankan audit yang ditugaskan.', 'ASSIGNED_SITES')
) AS role("code", "name", "description", "scope");

INSERT INTO "Permission" ("code", "module", "name", "description") VALUES
  ('*', 'platform', 'Full access', 'Unrestricted organization access for the organization administrator role.'),
  ('org.manage', 'organization', 'Manage organization', 'Update organization profile and policy settings.'),
  ('users.manage', 'identity', 'Manage users', 'Invite, suspend, assign roles, and manage site access.'),
  ('roles.manage', 'identity', 'Manage roles', 'Create and update organization roles and permissions.'),
  ('sites.manage', 'facilities', 'Manage sites', 'Create, update, and archive organization sites.'),
  ('site.read', 'facilities', 'Read sites', 'Read sites included in organization scope or assignments.'),
  ('asset.manage', 'facilities', 'Manage assets', 'Manage buildings and facility assets.'),
  ('meter.manage', 'facilities', 'Manage meters', 'Create and manage meter records.'),
  ('meter.read', 'facilities', 'Read meters', 'Read meters included in organization scope or assignments.'),
  ('meter.configure', 'facilities', 'Configure meters', 'Change effective meter configuration.'),
  ('meter.maintain', 'maintenance', 'Maintain meters', 'Manage assigned meter maintenance.'),
  ('reading.import', 'ingestion', 'Import readings', 'Import and correct metered readings.'),
  ('monitor.read', 'monitoring', 'Read monitoring', 'Read validated energy and demand analytics.'),
  ('alert.read', 'alerts', 'Read alerts', 'Read alerts and alert rules.'),
  ('alert.manage', 'alerts', 'Manage alert rules', 'Create and update organization alert rules.'),
  ('alert.acknowledge', 'alerts', 'Acknowledge alerts', 'Acknowledge and resolve alert incidents.'),
  ('alert.investigate', 'alerts', 'Investigate alerts', 'Investigate assigned alert incidents.'),
  ('tariff.manage', 'cost', 'Manage tariffs', 'Manage tariff versions and assignments.'),
  ('cost.read', 'cost', 'Read cost analysis', 'Read estimated energy costs.'),
  ('baseline.manage', 'optimization', 'Manage baselines and targets', 'Manage baselines and energy targets.'),
  ('audit.approve', 'audits', 'Approve audits', 'Manage audits and approvals at assigned sites.'),
  ('audit.submit', 'audits', 'Submit audit results', 'Submit findings for audits assigned to the current member.'),
  ('audit.read', 'audits', 'Read audits', 'Read assigned energy audits.'),
  ('audit.evidence.manage', 'audits', 'Manage audit evidence', 'Upload and download evidence for accessible audits.'),
  ('auditlog.read', 'governance', 'Read audit logs', 'Read audit events within permitted scope.'),
  ('report.export', 'reports', 'Export reports', 'Generate and export energy reports.'),
  ('report.generate', 'reports', 'Generate reports', 'Generate reports for assigned sites.'),
  ('report.read', 'reports', 'Read reports', 'Read organization reports.'),
  ('dashboard.read', 'monitoring', 'Read organization dashboard', 'Read executive organization summaries.'),
  ('forecast.read', 'analytics', 'Read forecasts', 'Read forecast results and history.'),
  ('forecast.run', 'analytics', 'Run forecasts', 'Create forecast runs for assigned sites.'),
  ('emissions.read', 'sustainability', 'Read emissions', 'Read estimated emissions and factor catalog.'),
  ('emissions.manage', 'sustainability', 'Manage emission factors', 'Manage organization emission factor versions.'),
  ('integrations.manage', 'integrations', 'Manage integrations', 'Manage API sources and credentials.'),
  ('notification.preferences.manage', 'notifications', 'Manage notification preferences', 'Manage personal notification preferences.'),
  ('notification.read', 'notifications', 'Read notifications', 'Read personal notification delivery history.');

WITH grants(role_code, codes) AS (VALUES
  ('ADMIN', ARRAY['*','org.manage','users.manage','roles.manage','sites.manage','site.read','asset.manage','meter.manage','meter.read','meter.configure','meter.maintain','reading.import','monitor.read','alert.read','alert.manage','alert.acknowledge','alert.investigate','tariff.manage','cost.read','baseline.manage','audit.approve','audit.read','auditlog.read','report.export','report.generate','report.read','dashboard.read','forecast.read','forecast.run','emissions.read','emissions.manage','integrations.manage','notification.preferences.manage','notification.read']::TEXT[]),
  ('ENERGY_MANAGER', ARRAY['site.read','meter.read','monitor.read','alert.read','tariff.manage','cost.read','baseline.manage','audit.approve','report.export','forecast.read','forecast.run','notification.preferences.manage','notification.read']::TEXT[]),
  ('FACILITY_MANAGER', ARRAY['site.read','asset.manage','meter.read','meter.configure','reading.import','meter.maintain','notification.preferences.manage','notification.read']::TEXT[]),
  ('ANALYST', ARRAY['site.read','meter.read','monitor.read','alert.read','alert.acknowledge','report.generate','emissions.read','forecast.read','forecast.run','notification.preferences.manage','notification.read']::TEXT[]),
  ('TECHNICIAN', ARRAY['site.read','meter.read','meter.maintain','alert.read','alert.investigate','notification.preferences.manage','notification.read']::TEXT[]),
  ('EXECUTIVE', ARRAY['dashboard.read','report.read','notification.preferences.manage','notification.read']::TEXT[]),
  ('AUDITOR', ARRAY['audit.read','audit.submit','audit.evidence.manage','auditlog.read','notification.preferences.manage','notification.read']::TEXT[])
)
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM grants
JOIN "Role" role ON role."code" = grants.role_code AND role."isSystem"
CROSS JOIN LATERAL unnest(grants.codes) AS grant_code
JOIN "Permission" permission ON permission."code" = grant_code;

UPDATE "OrganizationMembership" membership
SET "roleId" = role."id"
FROM "Role" role
WHERE role."organizationId" = membership."organizationId" AND role."code" = membership."role";

UPDATE "Invitation" invitation
SET "roleId" = role."id"
FROM "Role" role
WHERE role."organizationId" = invitation."organizationId" AND role."code" = invitation."role";

ALTER TABLE "OrganizationMembership" ALTER COLUMN "roleId" SET NOT NULL;
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "OrganizationMembership_roleId_idx" ON "OrganizationMembership"("roleId");
ALTER TABLE "Invitation" ALTER COLUMN "roleId" SET NOT NULL;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Invitation_roleId_idx" ON "Invitation"("roleId");
