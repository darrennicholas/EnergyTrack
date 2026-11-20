import 'dotenv/config'
import process from 'node:process'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
const db = new PrismaClient()
if (process.env.NODE_ENV === 'production') throw new Error('The local seed uses a shared password and cannot run in production.')
const passwordHash = await bcrypt.hash('developer123', 12)
const organization = await db.organization.upsert({ where: { code: 'DEMO' }, update: { name: 'EnergiTrack' }, create: { code: 'DEMO', name: 'EnergiTrack' } })
await db.user.upsert({ where: { email: 'admin@energitrack.local' }, update: { fullName: 'Administrator', passwordHash, role: 'ADMIN', organizationId: organization.id, active: true }, create: { email: 'admin@energitrack.local', fullName: 'Administrator', passwordHash, role: 'ADMIN', organizationId: organization.id } })
const admin = await db.user.findUniqueOrThrow({ where: { email: 'admin@energitrack.local' } })
const roleSeeds = [
  { code: 'ADMIN', name: 'Organization Admin', description: 'Mengelola pengguna dan konfigurasi organisasi.', scope: 'ORGANIZATION', permissions: ['*','org.manage','users.manage','roles.manage','sites.manage','site.read','asset.manage','meter.manage','meter.read','meter.configure','meter.maintain','reading.import','monitor.read','alert.read','alert.manage','alert.acknowledge','alert.investigate','tariff.manage','cost.read','baseline.manage','audit.approve','audit.read','auditlog.read','report.export','report.generate','report.read','dashboard.read','forecast.read','forecast.run','emissions.read','emissions.manage','integrations.manage','notification.preferences.manage','notification.read'] },
  { code: 'ENERGY_MANAGER', name: 'Energy Manager', description: 'Mengelola efisiensi energi, biaya, baseline, dan audit.', scope: 'ASSIGNED_SITES', permissions: ['site.read','meter.read','monitor.read','alert.read','tariff.manage','cost.read','baseline.manage','audit.approve','report.export','forecast.read','forecast.run','notification.preferences.manage','notification.read'] },
  { code: 'FACILITY_MANAGER', name: 'Facility Manager', description: 'Mengelola site, aset, meter, dan impor bacaan.', scope: 'ASSIGNED_SITES', permissions: ['site.read','asset.manage','meter.read','meter.configure','reading.import','meter.maintain','maintenance.manage','notification.preferences.manage','notification.read'] },
  { code: 'ANALYST', name: 'Energy Analyst', description: 'Membaca analitik, alert, emisi, dan laporan.', scope: 'ASSIGNED_SITES', permissions: ['site.read','meter.read','monitor.read','alert.read','alert.acknowledge','report.generate','emissions.read','forecast.read','forecast.run','notification.preferences.manage','notification.read'] },
  { code: 'TECHNICIAN', name: 'Technician', description: 'Melaksanakan pemeliharaan dan investigasi.', scope: 'ASSIGNED_SITES', permissions: ['site.read','meter.read','meter.maintain','maintenance.assigned','alert.read','alert.investigate','notification.preferences.manage','notification.read'] },
  { code: 'EXECUTIVE', name: 'Executive', description: 'Membaca ringkasan organisasi dan laporan.', scope: 'ORGANIZATION', permissions: ['dashboard.read','report.read','notification.preferences.manage','notification.read'] },
  { code: 'AUDITOR', name: 'Auditor', description: 'Membaca dan menjalankan audit yang ditugaskan.', scope: 'ASSIGNED_SITES', permissions: ['audit.read','audit.submit','audit.evidence.manage','auditlog.read','audit.assigned','notification.preferences.manage','notification.read'] },
] as const
for (const roleSeed of roleSeeds) {
  const role = await db.role.upsert({ where: { organizationId_code: { organizationId: organization.id, code: roleSeed.code } }, update: { name: roleSeed.name, description: roleSeed.description, scope: roleSeed.scope, isSystem: true, active: true }, create: { organizationId: organization.id, code: roleSeed.code, name: roleSeed.name, description: roleSeed.description, scope: roleSeed.scope, isSystem: true, active: true } })
  const permissions = await db.permission.findMany({ where: { code: { in: [...roleSeed.permissions] } }, select: { id: true, code: true } })
  if (permissions.length !== roleSeed.permissions.length) throw new Error(`Permission catalog is incomplete for demo role ${roleSeed.code}.`)
  await db.rolePermission.createMany({ data: permissions.map(permission => ({ roleId: role.id, permissionId: permission.id })), skipDuplicates: true })
}
const adminRole = await db.role.findUniqueOrThrow({ where: { organizationId_code: { organizationId: organization.id, code: 'ADMIN' } } })
await db.organizationMembership.upsert({ where: { organizationId_userId: { organizationId: organization.id, userId: admin.id } }, update: { role: adminRole.code, roleId: adminRole.id, status: 'ACTIVE' }, create: { organizationId: organization.id, userId: admin.id, role: adminRole.code, roleId: adminRole.id, status: 'ACTIVE' } })
const platformAdminEmail = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase()
if (platformAdminEmail) {
  const platformAdmin = await db.user.findUnique({ where: { email: platformAdminEmail }, select: { id: true, active: true } })
  if (!platformAdmin?.active) throw new Error('PLATFORM_ADMIN_EMAIL must identify an existing active user before granting platform permissions.')
  const granted = await db.$queryRaw<{ userId: string }[]>`INSERT INTO "PlatformAdmin" ("userId", "grantedBy", "reason") VALUES (${platformAdmin.id}::uuid, ${admin.id}::uuid, 'Configured by the database seed operator') ON CONFLICT ("userId") DO NOTHING RETURNING "userId"`
  if (granted.length) await db.$executeRaw`INSERT INTO "PlatformAuditLog" ("userId", "action", "entity", "entityId", "details") VALUES (${admin.id}::uuid, 'PLATFORM_ADMIN_GRANTED', 'User', ${platformAdmin.id}, ${JSON.stringify({ targetEmail: platformAdminEmail, reason: 'Configured by the database seed operator' })}::jsonb)`
}
const sites = await Promise.all([
  db.site.upsert({ where: { organizationId_code: { organizationId: organization.id, code: 'SITE-JKT-01' } }, update: {}, create: { organizationId: organization.id, code: 'SITE-JKT-01', name: 'Pabrik Jakarta', type: 'FACTORY', address: 'Kawasan Industri Jakarta, Indonesia', timezone: 'Asia/Jakarta' } }),
  db.site.upsert({ where: { organizationId_code: { organizationId: organization.id, code: 'SITE-BDG-01' } }, update: {}, create: { organizationId: organization.id, code: 'SITE-BDG-01', name: 'Kantor Bandung', type: 'OFFICE', address: 'Pusat Kota Bandung, Indonesia', timezone: 'Asia/Jakarta' } })
])
const roleUsers = [
  { email: 'energy.manager@energitrack.local', fullName: 'Energy Manager', role: 'ENERGY_MANAGER' },
  { email: 'facility.manager@energitrack.local', fullName: 'Facility Manager', role: 'FACILITY_MANAGER' },
  { email: 'analyst@energitrack.local', fullName: 'Analyst', role: 'ANALYST' },
  { email: 'technician@energitrack.local', fullName: 'Technician', role: 'TECHNICIAN' },
  { email: 'executive@energitrack.local', fullName: 'Executive', role: 'EXECUTIVE' },
  { email: 'auditor@energitrack.local', fullName: 'Auditor', role: 'AUDITOR' },
] as const
for (const roleUser of roleUsers) {
  const user = await db.user.upsert({ where: { email: roleUser.email }, update: { fullName: roleUser.fullName, passwordHash, role: roleUser.role, organizationId: organization.id, active: true }, create: { ...roleUser, passwordHash, organizationId: organization.id } })
  const role = await db.role.findUniqueOrThrow({ where: { organizationId_code: { organizationId: organization.id, code: roleUser.role } } })
  await db.organizationMembership.upsert({ where: { organizationId_userId: { organizationId: organization.id, userId: user.id } }, update: { role: role.code, roleId: role.id, status: 'ACTIVE' }, create: { organizationId: organization.id, userId: user.id, role: role.code, roleId: role.id, status: 'ACTIVE' } })
  await db.siteAssignment.deleteMany({ where: { organizationId: organization.id, userId: user.id } })
  if (role.scope === 'ASSIGNED_SITES') await db.siteAssignment.createMany({ data: sites.map(site => ({ organizationId: organization.id, userId: user.id, siteId: site.id })), skipDuplicates: true })
}
const seededEmails = ['admin@energitrack.local', ...roleUsers.map(user => user.email)]
const oldSeedUsers = await db.user.findMany({ where: { organizationId: organization.id, role: { in: roleSeeds.map(role => role.code) }, email: { endsWith: '@energitrack.local', mode: 'insensitive', notIn: seededEmails } }, select: { id: true } })
// Retain historical user references, but prevent obsolete local seed accounts from logging in or appearing as members.
if (oldSeedUsers.length) await db.$transaction([
  db.siteAssignment.deleteMany({ where: { organizationId: organization.id, userId: { in: oldSeedUsers.map(user => user.id) } } }),
  db.organizationMembership.deleteMany({ where: { organizationId: organization.id, userId: { in: oldSeedUsers.map(user => user.id) } } }),
  db.user.updateMany({ where: { id: { in: oldSeedUsers.map(user => user.id) } }, data: { active: false } })
])
const seededMembershipCount = await db.organizationMembership.count({ where: { organizationId: organization.id, status: 'ACTIVE', user: { email: { in: seededEmails }, active: true } } })
if (seededMembershipCount !== 7) throw new Error(`Expected exactly seven seed accounts, found ${seededMembershipCount}.`)
const meter = await db.meter.upsert({ where: { organizationId_code: { organizationId: organization.id, code: 'MTR-JKT-MAIN' } }, update: {}, create: { organizationId: organization.id, siteId: sites[0].id, code: 'MTR-JKT-MAIN', meterType: 'CUMULATIVE', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'SIMULATOR', intervalMinutes: 60, multiplier: 1, status: 'ONLINE' } })
const count = await db.meterReading.count({ where: { meterId: meter.id } })
if (count === 0) {
  const now = Date.now(), readings = Array.from({ length: 31 }, (_, i) => ({ organizationId: organization.id, meterId: meter.id, externalId: `demo-${i}`, timestamp: new Date(now - (30 - i) * 86400000), rawValue: String(10000 + i * 840 + Math.sin(i) * 60), value: String(10000 + i * 840 + Math.sin(i) * 60), unit: 'kWh', quality: 'VALID' }))
  await db.meterReading.createMany({ data: readings, skipDuplicates: true })
}
await db.auditLog.createMany({ data: [{ organizationId: organization.id, userId: admin.id, action: 'DEMO_SEED', entity: 'Organization', entityId: organization.id, details: { illustrative: true } }], skipDuplicates: true })
await db.$disconnect()
console.log(`Akun aktif (password: developer123): admin@energitrack.local, ${roleUsers.map(user => user.email).join(', ')}. Data fasilitas dan bacaan bersifat ilustratif.`)
