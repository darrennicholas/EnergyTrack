import type { Request, RequestHandler, Response, Router } from 'express'
import { Prisma, PrismaClient } from '@prisma/client'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AssignmentRequiredError, InvitationConflictError, InvalidRoleError, LastAdminError } from '../errors.js'
import { deliverEmail, emailDeliveryConfigured } from '../email-delivery.js'

type PageQuery = { page: number; pageSize: number; sort: string; direction: 'asc' | 'desc'; search: string; requested: boolean }
type Dependencies = {
  db: PrismaClient
  auth: RequestHandler
  csrf: RequestHandler
  admin: RequestHandler
  platformPermission: (permission: 'platform.config' | 'tenant.provision') => RequestHandler
  wrap: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler
  ok: (res: Response, data: unknown, status?: number) => unknown
  fail: (res: Response, status: number, code: string, message: string) => unknown
  pageQuery: (req: Request, fields: string[], defaultSort: string) => PageQuery
  pageResult: <T>(items: T[], total: number, query: PageQuery) => unknown
  logEvent: (level: 'info' | 'error', event: string, fields?: Record<string, unknown>) => void
}

export function registerAdministrationRoutes(api: Router, { db, auth, csrf, admin, platformPermission, wrap, ok, fail, pageQuery, pageResult, logEvent }: Dependencies) {api.get('/organization', auth, admin, wrap(async (_req, res) => ok(res, res.locals.user.organization)))
api.patch('/organization', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(200).optional(), auditApprovalSoD: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0, 'Tidak ada perubahan.').parse(req.body), org = res.locals.user.organizationId
  const item = await db.$transaction(async tx => {
    const updated = await tx.organization.update({ where: { id: org }, data: input })
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'ORGANIZATION_UPDATED', entity: 'Organization', entityId: org, details: { fields: Object.keys(input) } } })
    return updated
  })
  return ok(res, item)
}))
const provisionedRoleSeeds = [
  { code: 'ADMIN', name: 'Organization Admin', description: 'Mengelola pengguna dan konfigurasi organisasi.', scope: 'ORGANIZATION', permissions: ['*','org.manage','users.manage','roles.manage','sites.manage','site.read','asset.manage','meter.manage','meter.read','meter.configure','meter.maintain','reading.import','monitor.read','alert.read','alert.manage','alert.acknowledge','alert.investigate','tariff.manage','cost.read','baseline.manage','audit.approve','audit.read','auditlog.read','report.export','report.generate','report.read','dashboard.read','forecast.read','forecast.run','emissions.read','emissions.manage','integrations.manage','notification.preferences.manage','notification.read'] },
  { code: 'ENERGY_MANAGER', name: 'Energy Manager', description: 'Mengelola efisiensi energi, biaya, baseline, dan audit.', scope: 'ASSIGNED_SITES', permissions: ['site.read','meter.read','monitor.read','alert.read','tariff.manage','cost.read','baseline.manage','audit.approve','report.export','forecast.read','forecast.run','notification.preferences.manage','notification.read'] },
  { code: 'FACILITY_MANAGER', name: 'Facility Manager', description: 'Mengelola site, aset, meter, dan impor bacaan.', scope: 'ASSIGNED_SITES', permissions: ['site.read','asset.manage','meter.read','meter.configure','reading.import','meter.maintain','maintenance.manage','notification.preferences.manage','notification.read'] },
  { code: 'ANALYST', name: 'Energy Analyst', description: 'Membaca analitik, alert, emisi, dan laporan.', scope: 'ASSIGNED_SITES', permissions: ['site.read','meter.read','monitor.read','alert.read','alert.acknowledge','report.generate','emissions.read','forecast.read','forecast.run','notification.preferences.manage','notification.read'] },
  { code: 'TECHNICIAN', name: 'Technician', description: 'Melaksanakan pemeliharaan dan investigasi.', scope: 'ASSIGNED_SITES', permissions: ['site.read','meter.read','meter.maintain','maintenance.assigned','alert.read','alert.investigate','notification.preferences.manage','notification.read'] },
  { code: 'EXECUTIVE', name: 'Executive', description: 'Membaca ringkasan organisasi dan laporan.', scope: 'ORGANIZATION', permissions: ['dashboard.read','report.read','notification.preferences.manage','notification.read'] },
  { code: 'AUDITOR', name: 'Auditor', description: 'Membaca dan menjalankan audit yang ditugaskan.', scope: 'ASSIGNED_SITES', permissions: ['audit.read','audit.submit','audit.evidence.manage','auditlog.read','audit.assigned','notification.preferences.manage','notification.read'] },
] as const
api.get('/platform/permissions', auth, platformPermission('platform.config'), wrap(async (_req, res) => ok(res, await db.permission.findMany({ where: { module: 'platform' }, orderBy: { code: 'asc' } }))))
api.get('/platform/config', auth, platformPermission('platform.config'), wrap(async (_req, res) => ok(res, {
  environment: process.env.NODE_ENV || 'development',
  emailDeliveryConfigured: emailDeliveryConfigured(),
  evidenceScannerConfigured: !!(process.env.EVIDENCE_SCAN_URL || process.env.AUDIT_EVIDENCE_SCAN_URL) && !!(process.env.EVIDENCE_SCAN_TOKEN || process.env.AUDIT_EVIDENCE_SCAN_TOKEN),
})))
api.get('/platform/audit-logs', auth, platformPermission('platform.config'), wrap(async (req, res) => {
  const query=pageQuery(req,['action','entity','createdAt'],'createdAt'),where=query.search?Prisma.sql`WHERE "action" ILIKE ${`%${query.search}%`} OR "entity" ILIKE ${`%${query.search}%`}`:Prisma.empty
  const order=({action:Prisma.sql`"action"`,entity:Prisma.sql`"entity"`,createdAt:Prisma.sql`"createdAt"`})[query.sort]||Prisma.sql`"createdAt"`,direction=query.direction==='asc'?Prisma.sql`ASC`:Prisma.sql`DESC`,offset=query.requested?(query.page-1)*query.pageSize:0,take=query.requested?query.pageSize:25
  const [rows,count]=await Promise.all([db.$queryRaw<any[]>(Prisma.sql`SELECT "id", "userId", "action", "entity", "entityId", "details", "createdAt" FROM "PlatformAuditLog" ${where} ORDER BY ${order} ${direction} LIMIT ${take} OFFSET ${offset}`),db.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "PlatformAuditLog" ${where}`)])
  return ok(res,pageResult(rows,Number(count[0]?.count??0),query))
}))
api.get('/platform/organizations', auth, platformPermission('tenant.provision'), wrap(async (req, res) => {const query=pageQuery(req,['name','code'],'name'),where=query.search?{OR:[{name:{contains:query.search,mode:'insensitive' as const}},{code:{contains:query.search,mode:'insensitive' as const}}]}:{},[total,rows]=await Promise.all([db.organization.count({where}),db.organization.findMany({where,select:{id:true,code:true,name:true,_count:{select:{memberships:true,sites:true}}},orderBy:{[query.sort]:query.direction},skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:25})]);return ok(res,pageResult(rows,total,query))}))
api.post('/platform/organizations', auth, csrf, platformPermission('tenant.provision'), wrap(async (req, res) => {
  const input = z.object({ code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{1,63}$/), name: z.string().trim().min(2).max(200), adminEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()), adminFullName: z.string().trim().min(2).max(150) }).strict().parse(req.body)
  if (process.env.NODE_ENV === 'production' && !emailDeliveryConfigured()) return fail(res, 503, 'EMAIL_DELIVERY_UNAVAILABLE', 'Gateway email wajib dikonfigurasi untuk mengundang administrator tenant.')
  const token = `inv_${randomBytes(32).toString('hex')}`, tokenHash = createHash('sha256').update(token).digest('hex'), invitationId = randomUUID(), expiresAt = new Date(Date.now() + 24 * 60 * 60_000), actorId = res.locals.user.id
  const provisioned = await db.$transaction(async tx => {
    const organization = await tx.organization.create({ data: { code: input.code, name: input.name } })
    let adminRoleId = ''
    for (const roleSeed of provisionedRoleSeeds) {
      const role = await tx.role.create({ data: { organizationId: organization.id, code: roleSeed.code, name: roleSeed.name, description: roleSeed.description, scope: roleSeed.scope, isSystem: true } })
      if (role.code === 'ADMIN') adminRoleId = role.id
      const permissionRows = await tx.permission.findMany({ where: { code: { in: [...roleSeed.permissions] } }, select: { id: true, code: true } })
      if (permissionRows.length !== roleSeed.permissions.length) throw new Error(`Permission catalog is incomplete while provisioning tenant role ${roleSeed.code}.`)
      await tx.rolePermission.createMany({ data: permissionRows.map(permission => ({ roleId: role.id, permissionId: permission.id })) })
    }
    await tx.invitation.create({ data: { id: invitationId, organizationId: organization.id, email: input.adminEmail, fullName: input.adminFullName, role: 'ADMIN', roleId: adminRoleId, siteIds: [], tokenHash, expiresAt, createdBy: actorId } })
    await tx.$executeRaw`INSERT INTO "PlatformAuditLog" ("userId", "action", "entity", "entityId", "details") VALUES (${actorId}::uuid, 'TENANT_PROVISIONED', 'Organization', ${organization.id}, ${JSON.stringify({ code: organization.code, name: organization.name, adminEmail: input.adminEmail })}::jsonb)`
    return organization
  })
  res.setHeader('Cache-Control', 'no-store')
  if (emailDeliveryConfigured()) {
    const appUrl = process.env.APP_PUBLIC_URL || 'http://127.0.0.1:5173'
    try {
      await deliverEmail({ to: input.adminEmail, subject: 'Undangan administrator EnergiTrack', text: `Halo ${input.adminFullName}, organisasi ${input.name} telah dibuat dan Anda diundang sebagai Organization Admin. Terima undangan dalam 24 jam melalui: ${new URL(`/accept-invitation?token=${encodeURIComponent(token)}`, appUrl).toString()}` })
      return ok(res, { organization: provisioned, invitationId, expiresAt, emailDelivered: true }, 201)
    } catch (error) {
      logEvent('error', 'platform_tenant_invitation_delivery_failed', { error, organizationId: provisioned.id })
      await db.$transaction(async tx => {
        await tx.invitation.updateMany({ where: { id: invitationId, organizationId: provisioned.id, acceptedAt: null }, data: { revokedAt: new Date() } })
        await tx.$executeRaw`INSERT INTO "PlatformAuditLog" ("userId", "action", "entity", "entityId", "details") VALUES (${actorId}::uuid, 'TENANT_ADMIN_INVITATION_EMAIL_FAILED', 'Organization', ${provisioned.id}, ${JSON.stringify({ invitationId })}::jsonb)`
      })
      return fail(res, 503, 'EMAIL_DELIVERY_FAILED', 'Tenant dibuat, tetapi email administrator gagal dikirim; undangan dibatalkan.')
    }
  }
  return ok(res, { organization: provisioned, invitationId, expiresAt, emailDelivered: false, token }, 201)
}))
api.get('/permissions', auth, admin, wrap(async (_req, res) => ok(res, await db.permission.findMany({ where: { module: { not: 'platform' }, code: { not: '*' } }, orderBy: [{ module: 'asc' }, { code: 'asc' }] }))))
api.get('/roles', auth, admin, wrap(async (req, res) => {const query=pageQuery(req,['name','code','createdAt'],'name'),where={organizationId:res.locals.user.organizationId,...(query.search?{OR:[{name:{contains:query.search,mode:'insensitive' as const}},{code:{contains:query.search,mode:'insensitive' as const}}]}:{})};const [total,rows]=await Promise.all([db.role.count({where}),db.role.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,include:{permissions:{include:{permission:true},orderBy:{permissionId:'asc'}},_count:{select:{memberships:true}}},orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query))}))
api.post('/roles', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(100), description: z.string().trim().max(500).optional(), scope: z.enum(['ORGANIZATION', 'ASSIGNED_SITES']), permissionCodes: z.array(z.string().min(2).max(100)).max(100) }).strict().parse(req.body)
  const codes = [...new Set(input.permissionCodes)], permissions = await db.permission.findMany({ where: { code: { in: codes }, module: { not: 'platform' } }, select: { id: true, code: true } })
  if (permissions.length !== codes.length || codes.includes('*')) return fail(res, 422, 'VALIDATION_ERROR', 'Permission tidak valid untuk role kustom.')
  const organizationId = res.locals.user.organizationId, code = `CUSTOM_${input.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)}`
  const role = await db.$transaction(async tx => {
    const created = await tx.role.create({ data: { organizationId, code, name: input.name, description: input.description, scope: input.scope, isSystem: false } })
    if (permissions.length) await tx.rolePermission.createMany({ data: permissions.map(permission => ({ roleId: created.id, permissionId: permission.id })) })
    await tx.auditLog.create({ data: { organizationId, userId: res.locals.user.id, action: 'ROLE_CREATED', entity: 'Role', entityId: created.id, details: { name: created.name, code, scope: created.scope, permissions: codes } } })
    return tx.role.findUnique({ where: { id: created.id }, include: { permissions: { include: { permission: true } } } })
  })
  return ok(res, role, 201)
}))
api.patch('/roles/:id', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(100).optional(), description: z.string().trim().max(500).nullable().optional(), scope: z.enum(['ORGANIZATION', 'ASSIGNED_SITES']).optional(), active: z.boolean().optional(), permissionCodes: z.array(z.string().min(2).max(100)).max(100).optional() }).strict().refine(value => Object.keys(value).length > 0, 'Tidak ada perubahan.').parse(req.body)
  const org = res.locals.user.organizationId, currentRole = await db.role.findFirst({ where: { id: req.params.id, organizationId: org }, include: { _count: { select: { memberships: true } } } })
  if (!currentRole) return fail(res, 404, 'NOT_FOUND', 'Role tidak ditemukan.')
  if (input.active === false && currentRole._count.memberships) return fail(res, 409, 'ROLE_IN_USE', 'Role yang masih digunakan tidak dapat dinonaktifkan.')
  const codes = input.permissionCodes && [...new Set(input.permissionCodes)], permissions = codes ? await db.permission.findMany({ where: { code: { in: codes }, module: { not: 'platform' } }, select: { id: true, code: true } }) : []
  if (codes && (permissions.length !== codes.length || (!currentRole.isSystem && codes.includes('*')))) return fail(res, 422, 'VALIDATION_ERROR', 'Permission tidak valid untuk role ini.')
  const updated = await db.$transaction(async tx => {
    const role = await tx.role.update({ where: { id: currentRole.id }, data: { ...(input.name ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.scope ? { scope: input.scope } : {}), ...(input.active !== undefined ? { active: input.active } : {}) } })
    if (codes) {
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } })
      if (permissions.length) await tx.rolePermission.createMany({ data: permissions.map(permission => ({ roleId: role.id, permissionId: permission.id })) })
    }
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'ROLE_UPDATED', entity: 'Role', entityId: role.id, details: { fields: Object.keys(input), ...(codes ? { permissions: codes } : {}) } } })
    return tx.role.findUnique({ where: { id: role.id }, include: { permissions: { include: { permission: true } } } })
  })
  return ok(res, updated)
}))
api.get('/users', auth, admin, wrap(async (req, res) => {
  const query=pageQuery(req,['createdAt','email','fullName','role'],'fullName'), organizationId=res.locals.user.organizationId, where={organizationId,...(query.search?{user:{OR:[{fullName:{contains:query.search,mode:'insensitive' as const}},{email:{contains:query.search,mode:'insensitive' as const}}]}}:{})}
  const orderBy=query.sort==='email'?{user:{email:query.direction}}:query.sort==='fullName'?{user:{fullName:query.direction}}:query.sort==='role'?{roleDefinition:{code:query.direction}}:{createdAt:query.direction}
  const [total,memberships] = await Promise.all([db.organizationMembership.count({where}),db.organizationMembership.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,include: { user: { select: { id: true, email: true, fullName: true, active: true } }, roleDefinition: { select: { id: true, code: true, name: true, scope: true } } }, orderBy})])
  return ok(res,pageResult(memberships.map(({ user, roleDefinition, status }) => ({ ...user, role: roleDefinition.code, roleId: roleDefinition.id, roleName: roleDefinition.name, scope: roleDefinition.scope, active: status === 'ACTIVE' && user.active })),total,query))
}))
api.patch('/users/:id', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ role: z.enum(['ADMIN', 'ENERGY_MANAGER', 'FACILITY_MANAGER', 'ANALYST', 'TECHNICIAN', 'EXECUTIVE', 'AUDITOR']).optional(), roleId: z.string().uuid().optional(), active: z.boolean().optional(), siteIds: z.array(z.string().uuid()).max(500).optional() }).strict().refine(value => !(value.role && value.roleId), 'Gunakan role atau roleId, bukan keduanya.').parse(req.body)
  if (!Object.keys(input).length) return fail(res, 422, 'VALIDATION_ERROR', 'Tidak ada perubahan.')
  const org = res.locals.user.organizationId, ids = input.siteIds && [...new Set(input.siteIds)]
  if (ids && await db.site.count({ where: { organizationId: org, id: { in: ids } } }) !== ids.length) return fail(res, 422, 'VALIDATION_ERROR', 'Site tidak valid untuk organisasi ini.')
  const member = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${org}::uuid FOR UPDATE`
    const membership = await tx.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId: org, userId: req.params.id } }, include: { user: true, roleDefinition: { include: { permissions: { include: { permission: true } } } } } })
    if (!membership) return null
    const user = membership.user
    const nextRole = input.roleId
      ? await tx.role.findFirst({ where: { id: input.roleId, organizationId: org, active: true }, include: { permissions: { include: { permission: true } } } })
      : input.role
        ? await tx.role.findFirst({ where: { organizationId: org, code: input.role, active: true }, include: { permissions: { include: { permission: true } } } })
        : membership.roleDefinition
    if (!nextRole) throw new InvalidRoleError()
    const role = nextRole.code, active = input.active ?? (membership.status === 'ACTIVE')
    const currentCanManageOrg = membership.roleDefinition.permissions.some(item => item.permission.code === '*' || item.permission.code === 'org.manage')
    const nextCanManageOrg = nextRole.permissions.some(item => item.permission.code === '*' || item.permission.code === 'org.manage')
    if (currentCanManageOrg && membership.status === 'ACTIVE' && (!nextCanManageOrg || !active)) {
      const adminCount = await tx.organizationMembership.count({ where: { organizationId: org, status: 'ACTIVE', roleDefinition: { active: true, permissions: { some: { permission: { code: { in: ['*', 'org.manage'] } } } } } } })
      if (adminCount <= 1) throw new LastAdminError()
    }
    if (active && nextRole.scope === 'ASSIGNED_SITES') {
      const assigned = ids ?? (await tx.$queryRaw<{ siteId: string }[]>`SELECT "siteId" FROM "SiteAssignment" WHERE "organizationId" = ${org}::uuid AND "userId" = ${user.id}::uuid`).map(x => x.siteId)
      if (!assigned.length) throw new AssignmentRequiredError()
    }
    const updated = await tx.organizationMembership.update({ where: { id: membership.id }, data: { role, roleId: nextRole.id, status: active ? 'ACTIVE' : 'SUSPENDED' } })
    if (ids) {
      await tx.$executeRaw`DELETE FROM "SiteAssignment" WHERE "organizationId" = ${org}::uuid AND "userId" = ${user.id}::uuid`
      for (const siteId of ids) await tx.$executeRaw`INSERT INTO "SiteAssignment" ("id", "organizationId", "userId", "siteId") VALUES (${randomUUID()}::uuid, ${org}::uuid, ${user.id}::uuid, ${siteId}::uuid)`
    }
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'USER_MEMBERSHIP_UPDATED', entity: 'User', entityId: user.id, details: { previousRole: membership.role, role, previousActive: membership.status === 'ACTIVE', active, ...(ids ? { siteIds: ids } : {}) } } })
    if (!active) await tx.$executeRaw`DELETE FROM "session" WHERE "sess"::jsonb ->> 'userId' = ${user.id} AND "sess"::jsonb ->> 'organizationId' = ${org}`
    return { id: user.id, email: user.email, fullName: user.fullName, role: updated.role, roleId: updated.roleId, roleName: nextRole.name, scope: nextRole.scope, active: updated.status === 'ACTIVE' && user.active }
  })
  return member ? ok(res, member) : fail(res, 404, 'NOT_FOUND', 'Pengguna tidak ditemukan.')
}))
api.get('/invitations', auth, admin, wrap(async (req, res) => {const query=pageQuery(req,['createdAt','email','fullName','expiresAt'],'createdAt'),org=res.locals.user.organizationId,search=query.search?Prisma.sql`AND (i."email" ILIKE ${`%${query.search}%`} OR i."fullName" ILIKE ${`%${query.search}%`})`:Prisma.empty,where=Prisma.sql`FROM "Invitation" i JOIN "Role" r ON r."id"=i."roleId" AND r."organizationId"=i."organizationId" WHERE i."organizationId"=${org}::uuid ${search}`;const [counts,rows]=await Promise.all([db.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*)::bigint ${where}`),db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`SELECT i."id",i."email",i."fullName",i."role",i."roleId",r."name" AS "roleName",i."siteIds",i."expiresAt",i."acceptedAt",i."revokedAt",i."createdAt" ${where} ORDER BY i.${Prisma.raw(`"${query.sort}"`)} ${Prisma.raw(query.direction.toUpperCase())} LIMIT ${query.requested?query.pageSize:1000} OFFSET ${query.requested?(query.page-1)*query.pageSize:0}`)]);return ok(res,pageResult(rows,Number(counts[0]?.count||0),query))}))
api.post('/invitations', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ email: z.string().trim().email().max(254).transform(s => s.toLowerCase()), fullName: z.string().trim().min(2).max(150), role: z.enum(['ADMIN', 'ENERGY_MANAGER', 'FACILITY_MANAGER', 'ANALYST', 'TECHNICIAN', 'EXECUTIVE', 'AUDITOR']).optional(), roleId: z.string().uuid().optional(), siteIds: z.array(z.string().uuid()).max(500).default([]) }).refine(v => !!v.role || !!v.roleId, { path: ['roleId'], message: 'Pilih role organisasi.' }).refine(v => !(v.role && v.roleId), { path: ['roleId'], message: 'Gunakan role atau roleId, bukan keduanya.' }).parse(req.body)
  if (process.env.NODE_ENV === 'production' && !emailDeliveryConfigured()) return fail(res, 503, 'EMAIL_DELIVERY_UNAVAILABLE', 'Pengiriman email belum dikonfigurasi.')
  const org = res.locals.user.organizationId, ids = [...new Set(input.siteIds)]
  const roleDefinition = input.roleId
    ? await db.role.findFirst({ where: { id: input.roleId, organizationId: org, active: true } })
    : await db.role.findFirst({ where: { organizationId: org, code: input.role, active: true } })
  if (!roleDefinition) return fail(res, 422, 'VALIDATION_ERROR', 'Role tidak aktif atau bukan milik organisasi ini.')
  if (roleDefinition.scope === 'ASSIGNED_SITES' && !ids.length) return fail(res, 422, 'SITE_ASSIGNMENT_REQUIRED', 'Role ini memerlukan setidaknya satu site.')
  const existingUser = await db.user.findUnique({ where: { email: input.email }, select: { id: true } })
  if (existingUser && await db.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId: org, userId: existingUser.id } } })) return fail(res, 409, 'CONFLICT', 'Pengguna sudah menjadi anggota organisasi ini.')
  if (await db.site.count({ where: { organizationId: org, id: { in: ids } } }) !== ids.length) return fail(res, 422, 'VALIDATION_ERROR', 'Site tidak valid untuk organisasi ini.')
  const token = `inv_${randomBytes(32).toString('hex')}`, tokenHash = createHash('sha256').update(token).digest('hex'), id = randomUUID(), expiresAt = new Date(Date.now() + 24 * 60 * 60_000)
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${org}::uuid FOR UPDATE`
    const invitedUser = await tx.user.findUnique({ where: { email: input.email }, select: { id: true } })
    if (invitedUser && await tx.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId: org, userId: invitedUser.id } } })) throw new InvitationConflictError()
    await tx.$executeRaw`UPDATE "Invitation" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "organizationId" = ${org}::uuid AND "email" = ${input.email} AND "acceptedAt" IS NULL AND "revokedAt" IS NULL`
    await tx.$executeRaw`INSERT INTO "Invitation" ("id", "organizationId", "email", "fullName", "role", "roleId", "siteIds", "tokenHash", "expiresAt", "createdBy") VALUES (${id}::uuid, ${org}::uuid, ${input.email}, ${input.fullName}, ${roleDefinition.code}, ${roleDefinition.id}::uuid, ${JSON.stringify(ids)}::jsonb, ${tokenHash}, ${expiresAt}, ${res.locals.user.id}::uuid)`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'INVITATION_CREATED', entity: 'Invitation', entityId: id, details: { email: input.email, role: roleDefinition.code, roleId: roleDefinition.id, siteIds: ids } } })
  })
  res.setHeader('Cache-Control', 'no-store')
  if (emailDeliveryConfigured()) {
    const appUrl = process.env.APP_PUBLIC_URL || 'http://127.0.0.1:5173'
    try {
      await deliverEmail({ to: input.email, subject: 'Undangan EnergiTrack', text: `Halo ${input.fullName}, Anda diundang ke EnergiTrack sebagai ${roleDefinition.name}. Terima undangan dalam 24 jam melalui: ${new URL(`/accept-invitation?token=${encodeURIComponent(token)}`, appUrl).toString()}` })
      return ok(res, { id, email: input.email, expiresAt, emailDelivered: true }, 201)
    } catch (error) {
      logEvent('error', 'invitation_email_delivery_failed', { error })
      await db.$transaction(async tx => {
        await tx.$executeRaw`UPDATE "Invitation" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id}::uuid AND "organizationId" = ${org}::uuid AND "acceptedAt" IS NULL`
        await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'INVITATION_EMAIL_FAILED', entity: 'Invitation', entityId: id } })
      })
      return fail(res, 503, 'EMAIL_DELIVERY_FAILED', 'Email undangan gagal dikirim; undangan dibatalkan agar tautan tidak menggantung.')
    }
  }
  return ok(res, { id, email: input.email, expiresAt, emailDelivered: false, token }, 201)
}))
}
