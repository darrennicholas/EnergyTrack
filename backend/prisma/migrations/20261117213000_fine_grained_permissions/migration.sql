INSERT INTO "Permission" ("code", "module", "name", "description") VALUES
  ('maintenance.manage', 'maintenance', 'Manage site maintenance', 'Schedule and manage maintenance work at accessible sites.'),
  ('maintenance.assigned', 'maintenance', 'Perform assigned maintenance', 'Read and update only maintenance work assigned to the current member.'),
  ('audit.assigned', 'audits', 'Perform assigned audits', 'Read and submit only audits assigned to the current member.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "Role" role
JOIN (VALUES
  ('FACILITY_MANAGER', 'maintenance.manage'),
  ('TECHNICIAN', 'maintenance.assigned'),
  ('AUDITOR', 'audit.assigned')
) AS grant_row("roleCode", "permissionCode") ON grant_row."roleCode" = role."code"
JOIN "Permission" permission ON permission."code" = grant_row."permissionCode"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
