import 'dotenv/config'
import express, { type Request, type Response, type NextFunction } from 'express'
import session from 'express-session'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import helmet from 'helmet'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import { Prisma, PrismaClient } from '@prisma/client'
import { z, ZodError } from 'zod'
import { parse } from 'csv-parse/sync'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { energyByLocalDay, energyByTimezoneBucket, energyByUtcDay, localBucketKey, type EnergyReading } from './energy.js'
import { estimateFixedCharges, estimateFlatCost, siteDate } from './cost.js'
import { estimateEmissions, estimateEmissionsByYear } from './emissions.js'
import { evaluateAlerts, evaluateScheduledAlerts } from './alerts.js'
import { promoteFreshMeters, sweepMeterHealth } from './meter-health.js'
import { readingIdentity } from './shared/reading-identity.js'
import { multiplierAt } from './modules/ingestion/services/meter-configuration.js'
import { detectReadingIssues } from './reading-quality.js'
import { createPdfReport, createXlsxReport, reportColumns } from './shared/report-files.js'
import { reportRetry } from './shared/report-retry.js'
import { deliverEmail, emailDeliveryConfigured } from './shared/email-delivery.js'
import { deliverOneAlertEmail } from './notifications.js'
import { localDateStartUtc, nextLocalDate } from './shared/local-date.js'
import { isIP } from 'node:net'
import { scanEvidence } from './shared/evidence-scanner.js'
import { enqueueReadingRollups, processOneMeterRollup } from './rollups.js'
import { objectStorage, objectStorageConfigured } from './shared/object-storage.js'
import { registerDataSourceRoutes } from './modules/data-sources/routes/index.js'
import { registerReadingPreviewRoutes } from './modules/ingestion/routes/reading-preview.js'
import { registerForecastRoutes } from './modules/forecast/routes/index.js'
import { registerAdministrationRoutes } from './modules/administration/routes/index.js'
import { startScheduler } from './workers/scheduler.js'
import { AssignmentRequiredError, InvitationConflictError, InvalidRoleError, LastAdminError } from './shared/errors.js'

declare module 'express-session' { interface SessionData { userId?: string; organizationId?: string; csrf?: string } }
const databaseUrl = process.env.DATABASE_URL
const secret = process.env.SESSION_SECRET
if (!databaseUrl || !secret || secret.length < 32) throw new Error('DATABASE_URL and a SESSION_SECRET of at least 32 characters are required')
if (process.env.NODE_ENV === 'production' && (!process.env.WEBHOOK_ENCRYPTION_KEY || process.env.WEBHOOK_ENCRYPTION_KEY.length < 32)) throw new Error('Production requires a separate WEBHOOK_ENCRYPTION_KEY of at least 32 characters')
if (process.env.NODE_ENV === 'production' && !objectStorageConfigured) throw new Error('Production requires OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY, OBJECT_STORAGE_SECRET_KEY, and OBJECT_STORAGE_REGION.')
if (process.env.NODE_ENV === 'production' && !emailDeliveryConfigured()) throw new Error('Production requires EMAIL_DELIVERY_URL, EMAIL_DELIVERY_TOKEN, and EMAIL_FROM_ADDRESS.')
if (process.env.NODE_ENV === 'production') { let publicUrl: URL | null = null; try { publicUrl = new URL(process.env.APP_PUBLIC_URL || '') } catch { /* fail closed below */ }; if (publicUrl?.protocol !== 'https:') throw new Error('Production requires APP_PUBLIC_URL using HTTPS.') }
if (process.env.NODE_ENV === 'production' && (!(process.env.EVIDENCE_SCAN_URL || process.env.AUDIT_EVIDENCE_SCAN_URL) || !(process.env.EVIDENCE_SCAN_TOKEN || process.env.AUDIT_EVIDENCE_SCAN_TOKEN))) throw new Error('Production requires a malware scanning gateway URL and token.')
const db = new PrismaClient()
const backgroundWorkersEnabled = process.env.WORKER_ONLY === '1' || process.env.WORKERS_ENABLED === 'true' || process.env.NODE_ENV !== 'production'
const app = express()
app.disable('x-powered-by')
const requestMetrics = { requests: 0, errors: 0, durationMs: 0 }
app.use((req, res, next) => { const started = performance.now(); res.on('finish', () => { requestMetrics.requests++; if (res.statusCode >= 500) requestMetrics.errors++; requestMetrics.durationMs += performance.now() - started }); next() })
app.use(helmet())
const allowedOrigins = new Set((process.env.APP_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174').split(',').map(value => value.trim()).filter(Boolean))
app.use(cors({ origin: (origin, callback) => callback(null, !!origin && allowedOrigins.has(origin)), credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'], methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }))
app.use((req, res, next) => {
  const origin = req.get('Origin')
  if (origin && !allowedOrigins.has(origin) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return fail(res, 403, 'ORIGIN_DENIED', 'Origin tidak diizinkan.')
  next()
})
app.use(express.json({ limit: '12mb' }))
// Bound work before schema validation, including for malformed nested arrays.
app.use((req, res, next) => {
  const stack: { value: unknown; depth: number }[] = [{ value: req.body, depth: 0 }]
  let count = 0
  while (stack.length) {
    const item = stack.pop()!
    if (++count > 50_000 || item.depth > 20) return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_COMPLEX', message: 'Struktur permintaan terlalu besar.' } })
    if (!item.value || typeof item.value !== 'object') continue
    if (Array.isArray(item.value) && item.value.length > 5000) return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_COMPLEX', message: 'Terlalu banyak elemen.' } })
    for (const child of Object.values(item.value)) {
      if (stack.length + count >= 50_000) return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_COMPLEX', message: 'Struktur permintaan terlalu besar.' } })
      stack.push({ value: child, depth: item.depth + 1 })
    }
  }
  next()
})
const PgStore = connectPgSimple(session)
app.use(session({ store: new PgStore({ pool: new Pool({ connectionString: databaseUrl }), createTableIfMissing: true }), secret, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 } }))
const api = express.Router()
const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data })
const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ success: false, error: { code, message } })
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'production' ? 15 : 50,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => fail(res, 429, 'LOGIN_RATE_LIMITED', 'Terlalu banyak percobaan login. Tunggu beberapa menit lalu coba lagi.')
})
api.get('/health/live', (_req, res) => ok(res, { status: 'LIVE' }))
api.get('/health/ready', async (_req, res) => {
  try { await db.$queryRaw`SELECT 1`; return ok(res, { status: 'READY' }) }
  catch { return fail(res, 503, 'NOT_READY', 'Database belum siap.') }
})
api.get('/health/metrics', (req, res) => {
  const configured = process.env.METRICS_TOKEN
  const supplied = req.get('Authorization')?.replace(/^Bearer\s+/i, '') || ''
  if (!configured || supplied.length !== configured.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(configured))) return fail(res, 404, 'NOT_FOUND', 'Metrik tidak tersedia.')
  res.type('text/plain; version=0.0.4; charset=utf-8').send([
    '# HELP energytrack_http_requests_total Total HTTP requests handled by this process.', '# TYPE energytrack_http_requests_total counter', `energytrack_http_requests_total ${requestMetrics.requests}`,
    '# HELP energytrack_http_errors_total HTTP responses with server error status.', '# TYPE energytrack_http_errors_total counter', `energytrack_http_errors_total ${requestMetrics.errors}`,
    '# HELP energytrack_http_request_duration_ms_sum Sum of request duration in milliseconds.', '# TYPE energytrack_http_request_duration_ms_sum counter', `energytrack_http_request_duration_ms_sum ${requestMetrics.durationMs.toFixed(3)}`,
    '# HELP energytrack_process_uptime_seconds Process uptime in seconds.', '# TYPE energytrack_process_uptime_seconds gauge', `energytrack_process_uptime_seconds ${process.uptime().toFixed(3)}`
  ].join('\n') + '\n')
})
function redactLogValue(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: redactLogValue(value.message) }
  if (typeof value === 'string') return value.replace(/(Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]').replace(/([?&](?:token|signature|secret|password|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
  if (Array.isArray(value)) return value.map(redactLogValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [/password|token|secret|authorization|api.?key/i.test(key) ? '[REDACTED_KEY]' : key, /password|token|secret|authorization|api.?key/i.test(key) ? '[REDACTED]' : redactLogValue(item)]))
  return value
}
function logEvent(level: 'info' | 'error', event: string, fields: Record<string, unknown> = {}) {
  console[level](JSON.stringify(redactLogValue({ timestamp: new Date().toISOString(), level, event, ...fields })))
}
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next) }
type PageQuery = { page:number; pageSize:number; sort:string; direction:'asc'|'desc'; search:string; requested:boolean }
function pageQuery(req:Request, sortFields:string[], defaultSort:string):PageQuery {
  const input=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25),sort:z.string().max(40).optional(),sortBy:z.string().max(40).optional(),direction:z.enum(['asc','desc']).optional(),sortOrder:z.enum(['asc','desc']).optional(),search:z.string().trim().max(200).default('')}).parse(req.query)
  const requestedSort=input.sortBy??input.sort
  return {page:input.page,pageSize:input.pageSize,sort:requestedSort&&sortFields.includes(requestedSort)?requestedSort:defaultSort,direction:input.sortOrder??input.direction??'asc',search:input.search,requested:['page','pageSize','sort','sortBy','direction','sortOrder','search'].some(key=>req.query[key]!==undefined)}
}
function pageResult<T>(items:T[],total:number,query:PageQuery) { return query.requested?{items,pagination:{page:query.page,pageSize:query.pageSize,total,pageCount:Math.ceil(total/query.pageSize),sort:query.sort,direction:query.direction,sortBy:query.sort,sortOrder:query.direction,search:query.search||null}}:items }
const current = async (req: Request) => {
  if (!req.session.userId) { if (req.path === '/auth/me') logEvent('info', 'auth_context_missing', { reason: 'session_user_missing', sessionId: req.sessionID }); return null }
  const user = await db.user.findFirst({ where: { id: req.session.userId } })
  if (!user?.active) { if (req.path === '/auth/me') logEvent('info', 'auth_context_missing', { reason: 'user_missing_or_inactive', userId: req.session.userId }); return null }
  const platformAdmin = (await db.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "PlatformAdmin" WHERE "userId" = ${user.id}::uuid`)[0]
  if (platformAdmin) return { ...user, organizationId: null, role: 'PLATFORM_ADMIN', scope: 'PLATFORM', permissions: ['tenant.provision', 'platform.config'], organization: null, membershipId: null, roleId: null, platformAdmin: true }
  const membership = req.session.organizationId
    ? await db.organizationMembership.findFirst({ where: { userId: user.id, organizationId: req.session.organizationId, status: 'ACTIVE' }, include: { organization: true, roleDefinition: { include: { permissions: { include: { permission: true } } } } } })
    : (await db.organizationMembership.findFirst({ where: { userId: user.id, organizationId: user.organizationId, status: 'ACTIVE' }, include: { organization: true, roleDefinition: { include: { permissions: { include: { permission: true } } } } } }))
      ?? await db.organizationMembership.findFirst({ where: { userId: user.id, status: 'ACTIVE' }, include: { organization: true, roleDefinition: { include: { permissions: { include: { permission: true } } } } }, orderBy: [{ organizationId: 'asc' }] })
  if (!membership || !membership.roleDefinition.active) { if (req.path === '/auth/me') logEvent('info', 'auth_context_missing', { reason: 'membership_missing_or_role_inactive', userId: user.id, organizationId: req.session.organizationId, membershipStatus: membership?.status, roleActive: membership?.roleDefinition.active }); return null }
  if (!req.session.organizationId) req.session.organizationId = membership.organizationId
  return { ...user, organizationId: membership.organizationId, role: membership.roleDefinition.code, scope: membership.roleDefinition.scope, permissions: membership.roleDefinition.permissions.map(item => item.permission.code), organization: membership.organization, membershipId: membership.id, roleId: membership.roleId }
}
const auth = (req: Request, res: Response, next: NextFunction) => { current(req).then(user => { if (!user) return fail(res, 401, 'UNAUTHENTICATED', 'Silakan masuk.'); res.locals.user = user; next() }).catch(next) }
const csrf = (req: Request, res: Response, next: NextFunction) => { const supplied = req.get('X-CSRF-Token') || ''; const expected = req.session.csrf || ''; if (!expected || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return fail(res, 403, 'CSRF_INVALID', 'Token keamanan tidak valid.'); next() }
const hasPermission = (user: { role: string; permissions?: string[] }, permission: string) => !!user.permissions?.includes('*') || !!user.permissions?.includes(permission)
const hasExplicitPermission = (user: { permissions?: string[] }, permission: string) => !!user.permissions?.includes(permission)
const admin = (req: Request, res: Response, next: NextFunction) => {
  const path = req.path
  const permission = path === '/organization' ? 'org.manage'
    : /^\/(?:users|invitations|site-assignments)(?:\/|$)/.test(path) ? 'users.manage'
    : path === '/roles' || /^\/roles\//.test(path) || path === '/permissions' ? 'roles.manage'
    : /^\/(?:integration-sources|webhooks)(?:\/|$)/.test(path) ? 'integrations.manage'
    : /^\/sites(?:\/|$)/.test(path) ? 'sites.manage'
    : /^\/(?:ingestion\/readings|reading-imports|quarantined-readings|meters\/[^/]+\/readings\/[^/]+\/revisions)(?:\/|$)/.test(path) ? 'reading.import'
    : path === '/alert-rules' ? 'alert.manage'
    : path === '/emission-factors' ? 'emissions.manage'
    : 'org.manage'
  return hasPermission(res.locals.user, permission) ? next() : fail(res, 403, 'FORBIDDEN', 'Akses ditolak.')
}
const platformPermission = (permission: 'tenant.provision' | 'platform.config') => (_req: Request, res: Response, next: NextFunction) => {
  const user = res.locals.user
  return user.scope === 'PLATFORM' && hasPermission(user, permission) ? next() : fail(res, 403, 'FORBIDDEN', 'Permission platform tidak tersedia.')
}
const allowRoles = (...allowed: string[]) => (_req: Request, res: Response, next: NextFunction) => {
  const capability: Record<string, string[]> = { ADMIN: ['*'], ENERGY_MANAGER: ['tariff.manage', 'cost.read', 'baseline.manage', 'audit.approve', 'report.export', 'forecast.run'], FACILITY_MANAGER: ['asset.manage', 'meter.configure', 'reading.import', 'meter.maintain', 'maintenance.manage'], ANALYST: ['monitor.read', 'alert.acknowledge', 'report.generate', 'emissions.read', 'forecast.run'], TECHNICIAN: ['maintenance.assigned', 'meter.maintain', 'alert.investigate'], EXECUTIVE: ['dashboard.read', 'report.read'], AUDITOR: ['audit.read', 'audit.assigned', 'audit.submit', 'auditlog.read'] }
  const permitted = allowed.some(role => (capability[role] ?? []).some(permission => hasPermission(res.locals.user, permission)))
  return permitted ? next() : fail(res, 403, 'FORBIDDEN', 'Akses ditolak.')
}
const maintenanceRole = (_req: Request, res: Response, next: NextFunction) => { if (!['maintenance.manage', 'maintenance.assigned', 'meter.maintain'].some(permission => hasPermission(res.locals.user, permission))) return fail(res, 403, 'FORBIDDEN', 'Akses pemeliharaan tidak tersedia.'); next() }
const passwordSchema = z.string().min(12).max(200).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Kata sandi maksimum 72 byte UTF-8.')
const readingRowSchema = z.object({ meterId: z.string().uuid(), externalReadingId: z.string().trim().min(1).max(200).optional(), timestamp: z.string().datetime({ offset: true }), value: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/), unit: z.enum(['kWh', 'kW']), metric: z.enum(['ENERGY_IMPORT', 'POWER_DEMAND']).optional(), quality: z.enum(['VALID', 'ESTIMATED', 'SUSPECT', 'INVALID']).default('VALID') })
const readingsSchema = z.object({ readings: z.array(readingRowSchema).min(1).max(5000) })
type ReadingInput = z.infer<typeof readingsSchema>['readings']
class IngestionError extends Error {}
class SourceRevokedError extends Error {}
class InvitationError extends Error {}
class ExistingAccountAuthenticationError extends Error {}
async function lockIngestionMeters(tx: Prisma.TransactionClient, organizationId: string, ids: string[]) {
  const unique = [...new Set(ids)].sort()
  if (!unique.length) return
  const rows = await tx.$queryRaw<{ id: string; status: string; siteStatus: string }[]>(Prisma.sql`SELECT m."id", m."status", s."status" AS "siteStatus" FROM "Meter" m JOIN "Site" s ON s."id" = m."siteId" AND s."organizationId" = m."organizationId" WHERE m."organizationId" = ${organizationId}::uuid AND m."id" IN (${Prisma.join(unique.map(id => Prisma.sql`${id}::uuid`))}) ORDER BY m."id" FOR UPDATE OF m FOR SHARE OF s`)
  if (rows.length !== unique.length || rows.some(row => row.status === 'RETIRED' || row.siteStatus === 'ARCHIVED')) throw new IngestionError('Meter atau site tidak aktif, retired, archived, atau di luar organisasi.')
}
async function ingestBatch(orgId: string, readings: ReadingInput, actorId: string | null, sourceId?: string, credentialHash?: string) {
  const ids = [...new Set(readings.map(x => x.meterId))]
  const meters = await db.meter.findMany({ where: { id: { in: ids }, organizationId: orgId, status: { not: 'RETIRED' }, site: { status: { not: 'ARCHIVED' } } }, include: { configurationVersions: { select: { effectiveFrom: true, effectiveTo: true, multiplier: true } } } })
  if (meters.length !== ids.length) throw new IngestionError('Ada meter tidak aktif atau di luar organisasi.')
  const meterMap = new Map(meters.map(m => [m.id, m])), data: Prisma.MeterReadingCreateManyInput[] = []
  for (const row of readings) {
    const meter = meterMap.get(row.meterId)!
    if (meter.unit !== row.unit) throw new IngestionError(`Unit tidak sesuai untuk meter ${meter.code}.`)
    if (row.metric && meter.metric !== row.metric) throw new IngestionError(`Metrik tidak sesuai untuk meter ${meter.code}.`)
    const timestamp = new Date(row.timestamp)
    const value = new Prisma.Decimal(row.value).mul(multiplierAt(timestamp, meter.configurationVersions, meter.multiplier))
    if (value.gte('100000000000000')) throw new IngestionError(`Nilai untuk meter ${meter.code} terlalu besar setelah multiplier.`)
    const externalId = row.externalReadingId ? (sourceId ? `source:${sourceId}:${row.externalReadingId}` : row.externalReadingId) : readingIdentity(meter.id, timestamp, row.value, row.unit)
    data.push({ organizationId: orgId, meterId: meter.id, externalId, timestamp, rawValue: row.value, value, unit: row.unit, quality: row.quality, sourceType: sourceId ? 'API' : meter.sourceType, sourceId: sourceId ?? null, importJobId: null })
  }
  const accepted = await db.$transaction(async tx => {
    if (sourceId) {
      const rows = await tx.$queryRaw<{ status: string; secretHash: string | null }[]>`SELECT "status", "secretHash" FROM "IntegrationSource" WHERE "id" = ${sourceId}::uuid AND "organizationId" = ${orgId}::uuid FOR UPDATE`
      if (!rows[0] || rows[0].status !== 'ACTIVE') throw new SourceRevokedError()
      const credentials = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "IntegrationCredential" WHERE "sourceId" = ${sourceId}::uuid AND "organizationId" = ${orgId}::uuid AND "secretHash" = ${credentialHash} AND ("expiresAt" IS NULL OR "expiresAt" > clock_timestamp()) LIMIT 1`
      if (!credentialHash || (!credentials.length && rows[0].secretHash !== credentialHash)) throw new SourceRevokedError()
    }
    await lockIngestionMeters(tx, orgId, ids)
    const result = await tx.meterReading.createMany({ data, skipDuplicates: true })
    if (result.count) {
      await enqueueReadingRollups(tx, orgId, data.map(row => ({ meterId: row.meterId, timestamp: new Date(row.timestamp) })))
      await promoteFreshMeters(tx, orgId, readings.map(row => ({ meterId: row.meterId, timestamp: new Date(row.timestamp), quality: row.quality })), actorId)
      await evaluateAlerts(tx, orgId, ids, actorId)
    }
    await tx.auditLog.create({ data: { organizationId: orgId, userId: actorId, action: 'READINGS_INGESTED', entity: 'MeterReading', details: { accepted: result.count, duplicates: data.length - result.count, sourceId: sourceId || null } } })
    return result.count
  }, { timeout: 30_000 })
  return { accepted, duplicates: data.length - accepted, rejected: 0 }
}
api.param('id', (req, res, next, id) => z.string().uuid().safeParse(id).success ? next() : fail(res, 404, 'NOT_FOUND', 'Data tidak ditemukan.'))
api.post('/auth/login', loginRateLimit, wrap(async (req, res) => {
  const input = z.object({ email: z.string().trim().email().transform(s => s.toLowerCase()), password: z.string().max(200) }).parse(req.body)
  const user = await db.user.findUnique({ where: { email: input.email } })
  if (!user?.active || Buffer.byteLength(input.password, 'utf8') > 72 || !(await bcrypt.compare(input.password, user.passwordHash))) return fail(res, 401, 'INVALID_CREDENTIALS', 'Email atau kata sandi salah.')
  const membership = await db.organizationMembership.findFirst({ where: { userId: user.id, organizationId: user.organizationId, status: 'ACTIVE', roleDefinition: { is: { active: true } } } })
    ?? await db.organizationMembership.findFirst({ where: { userId: user.id, status: 'ACTIVE', roleDefinition: { is: { active: true } } }, orderBy: [{ organizationId: 'asc' }] })
  const isPlatformAdmin = !!(await db.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "PlatformAdmin" WHERE "userId" = ${user.id}::uuid`)[0]
  if (!membership && !isPlatformAdmin) return fail(res, 401, 'INVALID_CREDENTIALS', 'Email atau kata sandi salah.')
  await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()))
  req.session.userId = user.id; if (membership) req.session.organizationId = membership.organizationId; else delete req.session.organizationId; req.session.csrf = randomBytes(32).toString('hex')
  await new Promise<void>((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()))
  return ok(res, { csrfToken: req.session.csrf })
}))
api.post('/auth/forgot-password', rateLimit({ windowMs: 15 * 60_000, limit: 5 }), wrap(async (req, res) => {
  const input = z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()) }).strict().parse(req.body)
  const token = `pr_${randomBytes(32).toString('hex')}`, user = await db.user.findUnique({ where: { email: input.email }, select: { id: true, email: true, fullName: true, organizationId: true, active: true } })
  if (user?.active) {
    const tokenHash = createHash('sha256').update(token).digest('hex'), expiresAt = new Date(Date.now() + 30 * 60_000)
    await db.$transaction(async tx => {
      await tx.passwordResetToken.updateMany({ where: { organizationId: user.organizationId, userId: user.id, usedAt: null }, data: { usedAt: new Date() } })
      await tx.passwordResetToken.create({ data: { organizationId: user.organizationId, userId: user.id, tokenHash, expiresAt } })
      await tx.auditLog.create({ data: { organizationId: user.organizationId, userId: user.id, action: 'PASSWORD_RESET_REQUESTED', entity: 'User', entityId: user.id } })
    })
    if (emailDeliveryConfigured()) {
      const appUrl = process.env.APP_PUBLIC_URL || 'http://127.0.0.1:5173'
      try { await deliverEmail({ to: user.email, subject: 'Reset kata sandi EnergiTrack', text: `Halo ${user.fullName}, gunakan tautan berikut dalam 30 menit untuk membuat kata sandi baru: ${new URL(`/reset-password?token=${encodeURIComponent(token)}`, appUrl).toString()}` }) }
      catch (error) {
        logEvent('error', 'password_reset_email_delivery_failed', { error })
        await db.passwordResetToken.updateMany({ where: { tokenHash, usedAt: null }, data: { usedAt: new Date() } })
      }
    }
  }
  res.setHeader('Cache-Control', 'no-store')
  return ok(res, { message: 'Jika akun aktif cocok, instruksi reset akan dikirim.', ...(process.env.NODE_ENV !== 'production' ? { developmentToken: token } : {}) }, 202)
}))
api.post('/auth/reset-password', rateLimit({ windowMs: 15 * 60_000, limit: 10 }), wrap(async (req, res) => {
  const input = z.object({ token: z.string().regex(/^pr_[a-f0-9]{64}$/), password: passwordSchema }).strict().parse(req.body)
  const tokenHash = createHash('sha256').update(input.token).digest('hex'), passwordHash = await bcrypt.hash(input.password, 12)
  const changed = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string; organizationId: string; userId: string; expiresAt: Date; usedAt: Date | null }[]>`SELECT "id", "organizationId", "userId", "expiresAt", "usedAt" FROM "PasswordResetToken" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`
    const reset = rows[0]
    if (!reset || reset.usedAt || reset.expiresAt.getTime() <= Date.now()) return null
    const user = await tx.user.findFirst({ where: { id: reset.userId, organizationId: reset.organizationId, active: true } })
    if (!user) return null
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } })
    await tx.passwordResetToken.updateMany({ where: { organizationId: user.organizationId, userId: user.id, usedAt: null }, data: { usedAt: new Date() } })
    await tx.$executeRaw`DELETE FROM "session" WHERE "sess"::jsonb ->> 'userId' = ${user.id}`
    await tx.auditLog.create({ data: { organizationId: user.organizationId, userId: user.id, action: 'PASSWORD_RESET_COMPLETED', entity: 'User', entityId: user.id } })
    return true
  })
  return changed ? res.status(204).end() : fail(res, 410, 'PASSWORD_RESET_INVALID', 'Tautan reset tidak valid, kedaluwarsa, atau telah digunakan.')
}))
api.get('/auth/me', auth, wrap(async (req, res) => {
  const u = res.locals.user
  const assignments = ['ORGANIZATION', 'PLATFORM'].includes(u.scope) ? [] : await db.$queryRaw<{ siteId: string }[]>`SELECT "siteId" FROM "SiteAssignment" WHERE "organizationId" = ${u.organizationId}::uuid AND "userId" = ${u.id}::uuid`
  const memberships = await db.organizationMembership.findMany({ where: { userId: u.id, status: 'ACTIVE', roleDefinition: { active: true } }, include: { organization: { select: { id: true, code: true, name: true } }, roleDefinition: { select: { id: true, code: true, name: true } } }, orderBy: { createdAt: 'asc' } })
  return ok(res, { id: u.id, email: u.email, fullName: u.fullName, role: u.role, roleId: u.roleId, organization: u.organization, memberships: memberships.map(item => ({ organizationId: item.organizationId, organization: item.organization, roleId: item.roleId, role: item.roleDefinition })), scope: u.scope, siteIds: assignments.map(item => item.siteId), permissions: u.permissions, csrfToken: req.session.csrf })
}))
api.post('/auth/switch-organization', auth, csrf, wrap(async (req, res) => {
  const input = z.object({ organizationId: z.string().uuid() }).strict().parse(req.body), user = res.locals.user
  if (user.scope === 'PLATFORM') return fail(res, 403, 'PLATFORM_SCOPE_ONLY', 'Platform Admin tidak dapat memakai konteks organisasi.')
  const membership = await db.organizationMembership.findFirst({ where: { userId: user.id, organizationId: input.organizationId, status: 'ACTIVE' }, include: { organization: { select: { id: true, code: true, name: true } } } })
  if (!membership) return fail(res, 404, 'NOT_FOUND', 'Organisasi tidak ditemukan pada akun ini.')
  await db.auditLog.create({ data: { organizationId: user.organizationId, userId: user.id, action: 'ORGANIZATION_CONTEXT_SWITCHED', entity: 'OrganizationMembership', entityId: membership.id, details: { fromOrganizationId: user.organizationId, toOrganizationId: input.organizationId } } })
  req.session.organizationId = membership.organizationId
  req.session.csrf = randomBytes(32).toString('hex')
  return ok(res, { organizationId: membership.organizationId, organization: membership.organization, role: membership.role, csrfToken: req.session.csrf })
}))
api.patch('/auth/profile', auth, csrf, wrap(async (req, res) => {
  const input = z.object({ fullName: z.string().trim().min(2).max(150) }).strict().parse(req.body), user = res.locals.user
  const updated = await db.$transaction(async tx => {
    const member = await tx.user.update({ where: { id: user.id }, data: { fullName: input.fullName }, select: { id: true, email: true, fullName: true } })
    await tx.auditLog.create({ data: { organizationId: user.organizationId, userId: user.id, action: 'PROFILE_UPDATED', entity: 'User', entityId: user.id } })
    return member
  })
  return ok(res, updated)
}))
api.post('/auth/change-password', auth, csrf, rateLimit({ windowMs: 15 * 60_000, limit: 10 }), wrap(async (req, res) => {
  const input = z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }).strict().parse(req.body), user = res.locals.user
  if (Buffer.byteLength(input.currentPassword, 'utf8') > 72 || !await bcrypt.compare(input.currentPassword, user.passwordHash)) return fail(res, 403, 'INVALID_CREDENTIALS', 'Kata sandi saat ini tidak sesuai.')
  const passwordHash = await bcrypt.hash(input.newPassword, 12)
  const changed = await db.$transaction(async tx => {
    const updated = await tx.user.updateMany({ where: { id: user.id, active: true, passwordHash: user.passwordHash }, data: { passwordHash } })
    if (!updated.count) return false
    await tx.$executeRaw`DELETE FROM "session" WHERE "sess"::jsonb ->> 'userId' = ${user.id}`
    await tx.auditLog.create({ data: { organizationId: user.organizationId, userId: user.id, action: 'PASSWORD_CHANGED', entity: 'User', entityId: user.id } })
    return true
  })
  if (!changed) return fail(res, 409, 'CONFLICT', 'Kata sandi telah berubah. Silakan masuk kembali.')
  await new Promise<void>((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve()))
  return res.status(204).end()
}))
api.post('/auth/logout', auth, csrf, (req, res, next) => req.session.destroy(err => err ? next(err) : res.status(204).end()))
api.post('/auth/accept-invitation', rateLimit({ windowMs: 15 * 60_000, limit: 10 }), wrap(async (req, res) => {
  const input = z.object({ token: z.string().regex(/^inv_[a-f0-9]{64}$/), password: passwordSchema.optional() }).parse(req.body)
  const tokenHash = createHash('sha256').update(input.token).digest('hex')
  const lookup = await db.$queryRaw<{ organizationId: string }[]>`SELECT "organizationId" FROM "Invitation" WHERE "tokenHash" = ${tokenHash}`
  if (!lookup[0]) throw new InvitationError()
  const result = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${lookup[0].organizationId}::uuid FOR UPDATE`
    const rows = await tx.$queryRaw<{ id: string; organizationId: string; email: string; fullName: string; role: string; roleId: string; siteIds: unknown; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }[]>`SELECT "id", "organizationId", "email", "fullName", "role", "roleId", "siteIds", "expiresAt", "acceptedAt", "revokedAt" FROM "Invitation" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`
    const invitation = rows[0]
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt.getTime() <= Date.now() || !Array.isArray(invitation.siteIds)) throw new InvitationError()
    const roleDefinition = await tx.role.findFirst({ where: { id: invitation.roleId, organizationId: invitation.organizationId, active: true } })
    if (!roleDefinition) throw new InvitationError()
    let member = await tx.user.findUnique({ where: { email: invitation.email } })
    const existingMembership = member && await tx.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId: invitation.organizationId, userId: member.id } } })
    if (existingMembership) throw new InvitationError()
    if (member) {
      if (req.session.userId !== member.id) throw new ExistingAccountAuthenticationError()
    } else {
      if (!input.password) throw new InvitationError()
      const passwordHash = await bcrypt.hash(input.password, 12)
      member = await tx.user.create({ data: { email: invitation.email, fullName: invitation.fullName, role: roleDefinition.code, passwordHash, organizationId: invitation.organizationId } })
    }
    await tx.organizationMembership.create({ data: { organizationId: invitation.organizationId, userId: member.id, role: roleDefinition.code, roleId: roleDefinition.id, status: 'ACTIVE' } })
    for (const siteId of invitation.siteIds) {
      if (typeof siteId !== 'string' || !z.string().uuid().safeParse(siteId).success) throw new InvitationError()
      const site = await tx.site.findFirst({ where: { id: siteId, organizationId: invitation.organizationId } })
      if (!site) throw new InvitationError()
      await tx.$executeRaw`INSERT INTO "SiteAssignment" ("id", "organizationId", "userId", "siteId") VALUES (${randomUUID()}::uuid, ${invitation.organizationId}::uuid, ${member.id}::uuid, ${siteId}::uuid)`
    }
    await tx.$executeRaw`UPDATE "Invitation" SET "acceptedAt" = CURRENT_TIMESTAMP WHERE "id" = ${invitation.id}::uuid`
    await tx.auditLog.create({ data: { organizationId: invitation.organizationId, userId: member.id, action: 'INVITATION_ACCEPTED', entity: 'Invitation', entityId: invitation.id } })
    return { email: member.email }
  })
  return ok(res, result, 201)
}))
api.post('/ingestion/device-readings', rateLimit({ windowMs: 60_000, limit: 60 }), wrap(async (req, res) => {
  const token = (req.get('Authorization') || '').match(/^Bearer (et_[a-f0-9]{64})$/)?.[1]
  if (!token) return fail(res, 401, 'INVALID_SOURCE', 'Kunci sumber tidak valid.')
  const secretHash = createHash('sha256').update(token).digest('hex')
  const sources = await db.$queryRaw<{ id: string; organizationId: string; allowedMeterIds: Prisma.JsonValue; allowedIpAddresses: Prisma.JsonValue }[]>`SELECT s."id", s."organizationId", s."allowedMeterIds", s."allowedIpAddresses" FROM "IntegrationSource" s WHERE s."status" = 'ACTIVE' AND s."type" = 'API' AND (s."secretHash" = ${secretHash} OR EXISTS (SELECT 1 FROM "IntegrationCredential" c WHERE c."sourceId" = s."id" AND c."organizationId" = s."organizationId" AND c."secretHash" = ${secretHash} AND (c."expiresAt" IS NULL OR c."expiresAt" > clock_timestamp()))) LIMIT 1`
  const source = sources[0]
  if (!source) return fail(res, 401, 'INVALID_SOURCE', 'Kunci sumber tidak valid.')
  const allowlist = Array.isArray(source.allowedIpAddresses) ? source.allowedIpAddresses : []
  const remoteIp = req.socket.remoteAddress?.replace(/^::ffff:/, '')
  if (allowlist.length && (!remoteIp || !allowlist.includes(remoteIp))) return fail(res, 403, 'SOURCE_IP_DENIED', 'Alamat IP tidak diizinkan untuk sumber ini.')
  const rate = await db.$queryRaw<{ allowed: boolean }[]>`UPDATE "IntegrationSource" SET "rateWindowCount" = CASE WHEN "rateWindowStartedAt" IS NULL OR "rateWindowStartedAt" < date_trunc('minute', clock_timestamp()) THEN 1 ELSE "rateWindowCount" + 1 END, "rateWindowStartedAt" = CASE WHEN "rateWindowStartedAt" IS NULL OR "rateWindowStartedAt" < date_trunc('minute', clock_timestamp()) THEN date_trunc('minute', clock_timestamp()) ELSE "rateWindowStartedAt" END WHERE "id" = ${source.id}::uuid AND "organizationId" = ${source.organizationId}::uuid AND "status" = 'ACTIVE' RETURNING "rateWindowCount" <= "rateLimitPerMinute" AS allowed`
  if (!rate[0]?.allowed) return fail(res, 429, 'SOURCE_RATE_LIMITED', 'Batas permintaan sumber terlampaui.')
  const rawReadings = (req.body as { readings?: unknown })?.readings
  if (!Array.isArray(rawReadings) || !rawReadings.length) return fail(res, 422, 'VALIDATION_ERROR', 'readings harus berisi sedikitnya satu bacaan.')
  if (rawReadings.length > 5000) return fail(res, 413, 'PAYLOAD_TOO_COMPLEX', 'Maksimum 5.000 bacaan per permintaan.')
  const allowed = Array.isArray(source.allowedMeterIds) ? source.allowedMeterIds : []
  const parsedRows: { rowNumber: number; raw: unknown; parsed: ReadingInput[number] }[] = [], rejectedRows: { payload: Prisma.InputJsonObject; reason: string }[] = []
  for (const [index, raw] of rawReadings.entries()) {
    const parsed = readingRowSchema.safeParse(raw)
    if (!parsed.success) { rejectedRows.push({ payload: { rowNumber: index + 1, sourceId: source.id, values: raw as Prisma.InputJsonValue }, reason: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 1000) }); continue }
    if (!allowed.includes(parsed.data.meterId)) return fail(res, 403, 'FORBIDDEN', 'Meter tidak diizinkan untuk sumber ini.')
    parsedRows.push({ rowNumber: index + 1, raw, parsed: parsed.data })
  }
  const meterIds = [...new Set(parsedRows.map(row => row.parsed.meterId))]
  const meters = await db.meter.findMany({ where: { organizationId: source.organizationId, id: { in: meterIds } }, include: { site: { select: { status: true } }, configurationVersions: { select: { effectiveFrom: true, effectiveTo: true, multiplier: true } } } }), meterById = new Map(meters.map(meter => [meter.id, meter]))
  const validReadings: ReadingInput = []
  for (const item of parsedRows) {
    const meter = meterById.get(item.parsed.meterId)
    let reason = ''
    if (!meter || meter.status === 'RETIRED' || meter.site.status === 'ARCHIVED') reason = 'Meter tidak ditemukan, retired, atau site diarsipkan.'
    else if (meter.unit !== item.parsed.unit || (item.parsed.metric && meter.metric !== item.parsed.metric)) reason = 'Metric atau unit tidak sesuai konfigurasi meter.'
    else if (item.parsed.quality === 'INVALID') reason = 'Quality INVALID harus diperiksa sebelum digunakan.'
    else if (new Prisma.Decimal(item.parsed.value).mul(multiplierAt(new Date(item.parsed.timestamp), meter.configurationVersions, meter.multiplier)).gte('100000000000000')) reason = 'Nilai terlalu besar setelah multiplier.'
    if (reason) rejectedRows.push({ payload: { rowNumber: item.rowNumber, sourceId: source.id, externalReadingId: item.parsed.externalReadingId ?? null, values: item.raw as Prisma.InputJsonValue }, reason })
    else validReadings.push(item.parsed)
  }
  const ingested = validReadings.length ? await ingestBatch(source.organizationId, validReadings, null, source.id, secretHash) : { accepted: 0, duplicates: 0, rejected: 0 }
  let quarantineJobId: string | null = null
  if (rejectedRows.length) {
    const job = await db.$transaction(async tx => {
      const createdRows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "ImportJob" ("id", "organizationId", "fileName", "mode", "status", "accepted", "rejected", "completedAt") VALUES (gen_random_uuid(), ${source.organizationId}::uuid, ${`device-${source.id}.json`}, 'API_QUARANTINE', 'COMPLETED', ${ingested.accepted}, ${rejectedRows.length}, CURRENT_TIMESTAMP) RETURNING "id"`
      const created = createdRows[0]
      await tx.$executeRaw`INSERT INTO "QuarantinedReading" ("id", "organizationId", "importJobId", "payload", "reason") SELECT gen_random_uuid(), ${source.organizationId}::uuid, ${created.id}::uuid, item."payload", item."reason" FROM jsonb_to_recordset(${JSON.stringify(rejectedRows)}::jsonb) AS item("payload" jsonb, "reason" text)`
      await tx.auditLog.create({ data: { organizationId: source.organizationId, action: 'DEVICE_READINGS_QUARANTINED', entity: 'ImportJob', entityId: created.id, details: { sourceId: source.id, accepted: ingested.accepted, rejected: rejectedRows.length } } })
      return created
    })
    quarantineJobId = job.id
  }
  return ok(res, { ...ingested, rejected: rejectedRows.length, quarantineJobId })
}))
// Fail closed for non-admin roles until each operation has an explicit scoped policy.
api.use(auth, (req, res, next) => {
  void (async () => {
    const user = res.locals.user
    if (user.scope === 'PLATFORM') {
      if ((req.path === '/platform/organizations' && ['GET', 'POST'].includes(req.method) && hasPermission(user, 'tenant.provision')) || (['/platform/config', '/platform/permissions', '/platform/audit-logs'].includes(req.path) && req.method === 'GET' && hasPermission(user, 'platform.config'))) return next()
      return fail(res, 403, 'PLATFORM_SCOPE_ONLY', 'Platform Admin hanya dapat mengakses metadata platform.')
    }
    if (req.path.startsWith('/platform/')) return fail(res, 403, 'FORBIDDEN', 'Permission platform hanya dapat diberikan kepada Platform Admin.')
    if (hasPermission(user, '*')) return next()
    if (/^\/data-sources(?:\/[^/]+)?$/.test(req.path)) {
      const permitted = req.method === 'GET' ? hasPermission(user, 'reading.import') || hasPermission(user, 'integrations.manage') : hasPermission(user, 'integrations.manage')
      return permitted ? next() : fail(res, 403, 'FORBIDDEN', 'Akses sumber data tidak tersedia.')
    }
    const roleCatalog = ['/roles', '/permissions'].includes(req.path) || /^\/roles\/[^/]+$/.test(req.path)
    if (roleCatalog && hasPermission(user, 'roles.manage')) return next()
    if (/^\/(?:users|invitations|site-assignments)(?:\/|$)/.test(req.path) && hasPermission(user, 'users.manage')) return next()
    if (req.path === '/organization' && hasPermission(user, 'org.manage')) return next()
    if (/^\/(?:integration-sources|webhooks)(?:\/|$)/.test(req.path) && hasPermission(user, 'integrations.manage')) return next()
    const alertTransition = req.method === 'POST' && /^\/alerts\/[^/]+\/transition$/.test(req.path) && ((req.body?.status === 'ACKNOWLEDGED' && hasPermission(user, 'alert.acknowledge')) || (req.body?.status === 'INVESTIGATING' && hasPermission(user, 'alert.investigate')))
    const notificationSelfService = (req.method === 'GET' && ['/notification-preferences', '/notification-deliveries'].includes(req.path)) || (req.method === 'PATCH' && req.path === '/notification-preferences')
    const canUseMaintenance = ['meter.maintain', 'maintenance.manage', 'maintenance.assigned'].some(permission => hasPermission(user, permission))
    const maintenanceWrite = canUseMaintenance && ((req.method === 'POST' && (/^\/meters\/[^/]+\/maintenance$/.test(req.path) || /^\/meter-maintenance\/[^/]+\/evidence$/.test(req.path))) || (req.method === 'PATCH' && /^\/meter-maintenance\/[^/]+\/status$/.test(req.path)))
    const maintenanceEvidenceRead = req.method === 'GET' && /^\/meter-maintenance\/[^/]+\/evidence\/[^/]+$/.test(req.path)
    const reportWrite = req.method === 'POST' && req.path === '/reports' && (hasPermission(user, 'report.generate') || hasPermission(user, 'report.export'))
    const forecastWrite = req.method === 'POST' && ['/analytics/forecast-runs', '/forecast-drivers', '/forecast-drivers/weather-sync'].includes(req.path) && hasPermission(user, 'forecast.run')
    const auditorWrite = req.method === 'POST' && hasPermission(user, 'audit.submit') && /^\/audits\/[^/]+\/(?:findings|transition)$/.test(req.path)
    const auditEvidenceAccess = /^\/audits\/[^/]+\/evidence(?:\/[^/]+)?$/.test(req.path) && (hasPermission(user, 'audit.evidence.manage') || hasPermission(user, 'audit.approve')) && (req.method === 'GET' || req.method === 'POST')
    const facilityWrite = ((req.method === 'POST' && ['/buildings', '/assets'].includes(req.path) && hasPermission(user, 'asset.manage')) || (req.method === 'POST' && req.path === '/meters' && (hasPermission(user, 'meter.configure') || hasPermission(user, 'meter.manage'))) || (req.method === 'POST' && req.path === '/reading-imports' && hasPermission(user, 'reading.import')) || (req.method === 'PATCH' && /^\/(?:buildings|assets)\/[^/]+$/.test(req.path) && hasPermission(user, 'asset.manage')) || (req.method === 'PATCH' && /^\/meters\/[^/]+\/(?:configuration-versions|status)$/.test(req.path) && hasPermission(user, 'meter.configure')))
    const siteWrite = ['POST', 'PATCH'].includes(req.method) && /^\/sites(?:\/[^/]+(?:\/archive)?)?$/.test(req.path) && hasPermission(user, 'sites.manage')
    const readingAdminWrite = hasPermission(user, 'reading.import') && ((req.method === 'POST' && ['/ingestion/readings', '/quarantined-readings'].includes(req.path)) || (req.method === 'POST' && /^\/quarantined-readings\/[^/]+\/release$/.test(req.path)) || (req.method === 'POST' && /^\/meters\/[^/]+\/readings\/[^/]+\/revisions$/.test(req.path)))
    const organizationConfigWrite = (req.method === 'POST' && req.path === '/alert-rules' && hasPermission(user, 'alert.manage')) || (req.method === 'POST' && req.path === '/emission-factors' && hasPermission(user, 'emissions.manage'))
    const energyWrite = (req.method === 'POST' && (['/tariffs', '/tariff-assignments'].includes(req.path) && hasPermission(user, 'tariff.manage') || ['/baselines', '/targets'].includes(req.path) && hasPermission(user, 'baseline.manage') || req.path === '/audits' && hasPermission(user, 'audit.approve'))) || (req.method === 'POST' && /^\/baselines\/[^/]+\/(?:approve|revisions)$/.test(req.path) && hasPermission(user, 'baseline.manage')) || (req.method === 'POST' && /^\/audits\/[^/]+\/(?:findings|transition)$/.test(req.path) && hasPermission(user, 'audit.approve')) || (req.method === 'POST' && /^\/audit-findings\/[^/]+\/actions$/.test(req.path) && hasPermission(user, 'audit.approve')) || (req.method === 'POST' && /^\/corrective-actions\/[^/]+\/close$/.test(req.path) && hasPermission(user, 'audit.approve'))
    if (notificationSelfService) return next()
    if (maintenanceEvidenceRead) {
      if (!canUseMaintenance) return fail(res, 403, 'FORBIDDEN', 'Akses bukti pemeliharaan tidak tersedia.')
      const [, maintenanceId, evidenceId] = req.path.match(/^\/meter-maintenance\/([^/]+)\/evidence\/([^/]+)$/) ?? []
      const evidence = z.string().uuid().safeParse(evidenceId).success && z.string().uuid().safeParse(maintenanceId).success
        ? await db.maintenanceEvidence.findFirst({ where: { id: evidenceId, maintenanceId, organizationId: user.organizationId, maintenance: { ...(hasExplicitPermission(user, 'maintenance.assigned') ? { assignedTo: user.id } : {}), meter: { site: { assignments: { some: { userId: user.id, organizationId: user.organizationId } } } } } } })
        : null
      if (!evidence) return fail(res, 404, 'NOT_FOUND', 'Bukti pemeliharaan tidak ditemukan.')
      return next()
    }
    if (req.method !== 'GET' && !alertTransition && !maintenanceWrite && !reportWrite && !forecastWrite && !facilityWrite && !siteWrite && !readingAdminWrite && !organizationConfigWrite && !energyWrite && !auditorWrite && !auditEvidenceAccess) return fail(res, 403, 'FORBIDDEN', 'Permission belum tersedia untuk tindakan ini.')
    if (user.scope === 'ORGANIZATION' && ((req.path === '/monitoring/summary' && hasPermission(user, 'dashboard.read')) || (/^\/reports(?:\/[0-9a-f-]+(?:\/(?:download|download-link))?)?$/i.test(req.path) && (hasPermission(user, 'report.read') || hasPermission(user, 'report.export'))))) return next()
    if (!['site.read', 'meter.read', 'meter.configure', 'meter.manage', 'monitor.read', 'asset.manage', 'reading.import', 'tariff.manage', 'baseline.manage', 'audit.read', 'audit.assigned', 'audit.approve', 'audit.submit', 'auditlog.read', 'alert.read', 'alert.manage', 'report.generate', 'report.export', 'forecast.read', 'forecast.run', 'emissions.read', 'cost.read', 'meter.maintain', 'maintenance.manage', 'maintenance.assigned', 'notification.read'].some(permission => hasPermission(user, permission))) return fail(res, 403, 'FORBIDDEN', 'Permission belum tersedia untuk modul ini.')
    const rows = user.scope === 'ORGANIZATION' ? await db.$queryRaw<{ siteId: string }[]>`SELECT "id" AS "siteId" FROM "Site" WHERE "organizationId" = ${user.organizationId}::uuid` : await db.$queryRaw<{ siteId: string }[]>`SELECT "siteId" FROM "SiteAssignment" WHERE "organizationId" = ${user.organizationId}::uuid AND "userId" = ${user.id}::uuid`
    const ids = rows.map(row => row.siteId)
    if (siteWrite) return user.scope === 'ORGANIZATION' ? next() : fail(res, 403, 'FORBIDDEN', 'Pengelolaan site memerlukan scope organisasi.')
    if (organizationConfigWrite) {
      if (req.path === '/alert-rules' && user.scope === 'ASSIGNED_SITES' && !ids.includes(req.body?.scopeId)) return fail(res, 404, 'NOT_FOUND', 'Scope rule tidak ditugaskan kepada user.')
      return next()
    }
    if (readingAdminWrite) {
      const meterIds = req.path === '/ingestion/readings' && Array.isArray(req.body?.readings) ? req.body.readings.map((row: { meterId?: unknown }) => row?.meterId).filter((id: unknown): id is string => typeof id === 'string')
        : typeof req.body?.meterId === 'string' ? [req.body.meterId]
          : req.path.match(/^\/meters\/([^/]+)\//)?.[1] ? [req.path.match(/^\/meters\/([^/]+)\//)![1]] : []
      if (user.scope === 'ASSIGNED_SITES' && (!meterIds.length || await db.meter.count({ where: { organizationId: user.organizationId, id: { in: meterIds }, siteId: { in: ids } } }) !== [...new Set(meterIds)].length)) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan pada scope ini.')
      return next()
    }
    if (auditEvidenceAccess) {
      const auditId = req.path.split('/')[2]
      const audit = z.string().uuid().safeParse(auditId).success && ids.length ? await db.energyAudit.findFirst({ where: { id: auditId, organizationId: user.organizationId, siteId: { in: ids }, ...(!hasPermission(user, 'audit.approve') ? { assignedAuditorId: user.id } : {}) }, select: { id: true } }) : null
      if (!audit) return fail(res, 404, 'NOT_FOUND', 'Audit tidak ditemukan.')
      res.locals.allowedSiteIds = ids
      return next()
    }
    if (auditorWrite) {
      const auditId = req.path.split('/')[2]
      const assigned = z.string().uuid().safeParse(auditId).success && ids.length ? await db.energyAudit.findFirst({ where: { id: auditId, organizationId: user.organizationId, siteId: { in: ids }, assignedAuditorId: user.id }, select: { id: true } }) : null
      return assigned ? next() : fail(res, 404, 'NOT_FOUND', 'Audit yang ditugaskan tidak ditemukan.')
    }
    res.locals.allowedSiteIds = ids
    if (forecastWrite) {
      const siteId = typeof req.body?.siteId === 'string' ? req.body.siteId : ''
      return ids.includes(siteId) ? next() : fail(res, 403, 'FORBIDDEN', 'Forecast harus memilih site yang ditugaskan.')
    }
    if (reportWrite) {
      const siteId = typeof req.body?.siteId === 'string' ? req.body.siteId : ''
      return ids.includes(siteId) ? next() : fail(res, 403, 'FORBIDDEN', 'Laporan analis harus memilih site yang ditugaskan.')
    }
    if (facilityWrite) {
      if (!ids.length) return fail(res, 403, 'FORBIDDEN', 'Penugasan site diperlukan.')
      if (req.path === '/reading-imports') return next()
      const createSite = typeof req.body?.siteId === 'string' ? req.body.siteId : ''
      if (['/buildings', '/assets', '/meters'].includes(req.path)) return ids.includes(createSite) ? next() : fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
      const [, resource, id] = req.path.match(/^\/(buildings|assets|meters)\/([^/]+)/) ?? []
      const scoped = resource === 'buildings'
        ? await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "Building" WHERE "id" = ${id}::uuid AND "organizationId" = ${user.organizationId}::uuid AND "siteId" IN (${Prisma.join(ids.map(siteId => Prisma.sql`${siteId}::uuid`))}) LIMIT 1`)
        : resource === 'assets'
          ? await db.asset.findMany({ where: { id, organizationId: user.organizationId, siteId: { in: ids } }, select: { id: true } })
          : await db.meter.findMany({ where: { id, organizationId: user.organizationId, siteId: { in: ids } }, select: { id: true } })
      return scoped.length ? next() : fail(res, 404, 'NOT_FOUND', 'Data tidak ditemukan.')
    }
    if (energyWrite) {
      if (!ids.length) return fail(res, 403, 'FORBIDDEN', 'Penugasan site diperlukan.')
      if (req.path === '/tariffs') return next()
      if (req.path === '/tariff-assignments') {
        const meterId = typeof req.body?.meterId === 'string' ? req.body.meterId : ''
        const meter = z.string().uuid().safeParse(meterId).success ? await db.meter.findFirst({ where: { id: meterId, organizationId: user.organizationId, siteId: { in: ids }, metric: 'ENERGY_IMPORT' }, select: { id: true } }) : null
        return meter ? next() : fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
      }
      const createSite = typeof req.body?.siteId === 'string' ? req.body.siteId : ''
      if (['/baselines', '/targets', '/audits'].includes(req.path)) return ids.includes(createSite) ? next() : fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
      const baselineMatch = req.path.match(/^\/baselines\/([^/]+)\/(?:approve|revisions)$/)
      if (baselineMatch) {
        const scoped = z.string().uuid().safeParse(baselineMatch[1]).success ? await db.baseline.findFirst({ where: { id: baselineMatch[1], organizationId: user.organizationId, siteId: { in: ids } }, select: { id: true } }) : null
        return scoped ? next() : fail(res, 404, 'NOT_FOUND', 'Baseline tidak ditemukan.')
      }
      const auditMatch = req.path.match(/^\/audits\/([^/]+)\/(?:findings|transition)$/)
      const findingActionMatch = req.path.match(/^\/(?:audit-findings|corrective-actions)\/([^/]+)\/(?:actions|close)$/)
      const auditId = auditMatch?.[1]
      const scopedAudit = auditId
        ? (z.string().uuid().safeParse(auditId).success ? await db.energyAudit.findFirst({ where: { id: auditId, organizationId: user.organizationId, siteId: { in: ids } }, select: { id: true } }) : null)
        : findingActionMatch ? await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT e."id" FROM "EnergyAudit" e JOIN "AuditFinding" f ON f."auditId" = e."id" LEFT JOIN "CorrectiveAction" c ON c."findingId" = f."id" WHERE e."organizationId" = ${user.organizationId}::uuid AND e."siteId" IN (${Prisma.join(ids.map(siteId => Prisma.sql`${siteId}::uuid`))}) AND ${req.path.startsWith('/audit-findings/') ? Prisma.sql`f."id" = ${findingActionMatch[1]}::uuid` : Prisma.sql`c."id" = ${findingActionMatch[1]}::uuid`} LIMIT 1`)
        : null
      return (Array.isArray(scopedAudit) ? scopedAudit.length > 0 : !!scopedAudit) ? next() : fail(res, 404, 'NOT_FOUND', 'Audit tidak ditemukan.')
    }
    if (req.method === 'GET') {
      if (req.path === '/data-quality' && ['monitor.read', 'reading.import', 'meter.maintain'].some(permission => hasPermission(user, permission))) {
        const siteId = typeof req.query.siteId === 'string' ? req.query.siteId : ''
        return user.scope === 'ORGANIZATION' ? next() : ids.includes(siteId) ? next() : fail(res, 403, 'FORBIDDEN', 'Pilih site yang ditugaskan untuk melihat kualitas data.')
      }
      const readPermissions: Record<string, string[]> = {
        '/tariffs': ['tariff.manage'], '/tariff-assignments': ['tariff.manage'], '/baselines': ['baseline.manage'], '/targets': ['baseline.manage'],
        '/audits': ['audit.read', 'audit.assigned', 'audit.approve', 'audit.submit'], '/audit-logs': ['auditlog.read'], '/alert-rules': ['alert.read', 'alert.manage'], '/emission-factors': ['emissions.read', 'emissions.manage'],
        '/reports': ['report.generate', 'report.read', 'report.export'], '/analytics/forecast-runs': ['forecast.read', 'forecast.run'], '/forecast-drivers': ['forecast.read', 'forecast.run'], '/assets': ['asset.manage', 'meter.configure']
      }
      const resourceRead = readPermissions[req.path]
      if (resourceRead?.some(permission => hasPermission(user, permission))) return next()
      if (/^\/emission-factors\/[^/]+$/.test(req.path) && (hasPermission(user, 'emissions.read') || hasPermission(user, 'emissions.manage'))) return next()
      if (/^\/audits\/[^/]+$/.test(req.path) && ['audit.read', 'audit.approve', 'audit.submit'].some(permission => hasPermission(user, permission))) return next()
      if (/^\/reports\/[0-9a-f-]+$/i.test(req.path) && ['report.generate', 'report.read', 'report.export'].some(permission => hasPermission(user, permission))) return next()
      if (user.scope === 'ORGANIZATION' && req.path === '/cost-analysis' && hasPermission(user, 'cost.read')) return next()
      if ((hasPermission(user, 'baseline.manage')) && (/^\/baselines\/[^/]+\/compare$/i.test(req.path) || /^\/targets\/[^/]+\/progress$/i.test(req.path))) {
        const id = req.path.split('/')[2]
        if (!ids.length) return fail(res, 404, 'NOT_FOUND', 'Data tidak ditemukan.')
        const scoped = req.path.startsWith('/baselines/')
          ? await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "Baseline" WHERE "id" = ${id}::uuid AND "organizationId" = ${user.organizationId}::uuid AND "siteId" IN (${Prisma.join(ids.map(siteId => Prisma.sql`${siteId}::uuid`))}) LIMIT 1`)
          : await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "EnergyTarget" WHERE "id" = ${id}::uuid AND "organizationId" = ${user.organizationId}::uuid AND "siteId" IN (${Prisma.join(ids.map(siteId => Prisma.sql`${siteId}::uuid`))}) LIMIT 1`)
        return scoped.length ? next() : fail(res, 404, 'NOT_FOUND', 'Data tidak ditemukan.')
      }
      if ((hasPermission(user, 'cost.read') && req.path === '/cost-analysis') || (hasPermission(user, 'emissions.read') && req.path === '/emissions/estimate')) {
        const siteId = typeof req.query.siteId === 'string' ? req.query.siteId : ''
        return user.scope === 'ORGANIZATION' ? next() : ids.includes(siteId) ? next() : fail(res, 403, 'FORBIDDEN', 'Pilih site yang ditugaskan.')
      }
      const reportResource = req.path.match(/^\/reports\/([^/]+)(?:\/(?:download|download-link))?$/i)
      if (reportResource && ['report.generate', 'report.read', 'report.export'].some(permission => hasPermission(user, permission)) && (user.scope === 'ORGANIZATION' || ids.length) && z.string().uuid().safeParse(reportResource[1]).success) {
        const reports = await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "ReportJob" WHERE "id" = ${reportResource[1]}::uuid AND "organizationId" = ${user.organizationId}::uuid AND "filters"->>'siteId' IN (${Prisma.join(ids.map(siteId => Prisma.sql`${siteId}`))}) LIMIT 1`)
        return reports.length ? next() : fail(res, 404, 'NOT_FOUND', 'Laporan tidak ditemukan.')
      }
      const assetMatch = req.path.match(/^\/assets\/([^/]+)$/)
      if (hasPermission(user, 'asset.manage') && assetMatch) {
        const asset = await db.asset.findFirst({ where: { id: assetMatch[1], organizationId: user.organizationId, siteId: { in: ids } }, select: { id: true } })
        return asset ? next() : fail(res, 404, 'NOT_FOUND', 'Aset tidak ditemukan.')
      }
      if (hasPermission(user, 'audit.approve') && /^\/audits\/[^/]+$/.test(req.path)) {
        const auditId = req.path.split('/')[2]
        const scoped = ids.length ? await db.energyAudit.findFirst({ where: { id: auditId, organizationId: user.organizationId, siteId: { in: ids } }, select: { id: true } }) : null
        return scoped ? next() : fail(res, 404, 'NOT_FOUND', 'Audit tidak ditemukan.')
      }
    }
    if (maintenanceWrite) {
      if (!canUseMaintenance) return fail(res, 403, 'FORBIDDEN', 'Akses pemeliharaan tidak tersedia.')
      const meterMatch = req.path.match(/^\/meters\/([^/]+)\/maintenance$/)
      const maintenanceId = req.path.split('/')[2]
      const rows = meterMatch
        ? (z.string().uuid().safeParse(meterMatch[1]).success && ids.length ? await db.meter.findMany({ where: { id: meterMatch[1], organizationId: user.organizationId, siteId: { in: ids } }, select: { id: true } }) : [])
        : (z.string().uuid().safeParse(maintenanceId).success && ids.length ? await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT mm."id" FROM "MeterMaintenance" mm JOIN "Meter" m ON m."id" = mm."meterId" AND m."organizationId" = mm."organizationId" WHERE mm."id" = ${maintenanceId}::uuid AND mm."organizationId" = ${user.organizationId}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))}) AND (${hasPermission(user, 'meter.configure') || hasPermission(user, 'maintenance.manage')} OR mm."assignedTo" = ${user.id}::uuid) LIMIT 1`) : [])
      return rows.length ? next() : fail(res, 404, 'NOT_FOUND', 'Pemeliharaan tidak ditemukan.')
    }
    if (['alert.read', 'alert.acknowledge', 'alert.investigate'].some(permission => hasPermission(user, permission))) {
      if (req.method === 'GET' && req.path === '/alerts' && hasPermission(user, 'alert.read')) return next()
      const alertMatch = req.path.match(/^\/alerts\/([^/]+)(?:\/transition)?$/)
      if (alertMatch && (req.method === 'GET' || alertTransition)) {
        if (!ids.length || !z.string().uuid().safeParse(alertMatch[1]).success) return fail(res, 404, 'NOT_FOUND', 'Alert tidak ditemukan.')
        const alerts = await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT a."id" FROM "Alert" a JOIN "Meter" m ON m."id" = a."meterId" AND m."organizationId" = a."organizationId" WHERE a."id" = ${alertMatch[1]}::uuid AND a."organizationId" = ${user.organizationId}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))}) LIMIT 1`)
        return alerts.length ? next() : fail(res, 404, 'NOT_FOUND', 'Alert tidak ditemukan.')
      }
    }
    if (req.method !== 'GET') return fail(res, 403, 'FORBIDDEN', 'Permission belum tersedia untuk tindakan ini.')
    if ((hasPermission(user, 'site.read') || hasPermission(user, 'sites.manage')) && req.path === '/sites') return next()
    if ((hasPermission(user, 'meter.read') || hasPermission(user, 'meter.manage')) && req.path === '/meters') return next()
    if ((hasPermission(user, 'site.read') || hasPermission(user, 'asset.manage')) && req.path === '/buildings') return next()
    const buildingMatch = req.path.match(/^\/buildings\/([^/]+)$/)
    if (buildingMatch) {
      if (!hasPermission(user, 'site.read') && !hasPermission(user, 'asset.manage')) return fail(res, 403, 'FORBIDDEN', 'Akses gedung tidak tersedia.')
      if (!ids.length || !z.string().uuid().safeParse(buildingMatch[1]).success) return fail(res, 404, 'NOT_FOUND', 'Gedung tidak ditemukan.')
      const buildings = await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "Building" WHERE "id" = ${buildingMatch[1]}::uuid AND "organizationId" = ${user.organizationId}::uuid AND "siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))}) LIMIT 1`)
      return buildings.length ? next() : fail(res, 404, 'NOT_FOUND', 'Gedung tidak ditemukan.')
    }
    const siteMatch = req.path.match(/^\/sites\/([^/]+)$/)
    if (siteMatch) return (hasPermission(user, 'site.read') || hasPermission(user, 'sites.manage')) && z.string().uuid().safeParse(siteMatch[1]).success && (user.scope === 'ORGANIZATION' || ids.includes(siteMatch[1])) ? next() : fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
    const meterMatch = req.path.match(/^\/meters\/([^/]+)(?:\/(?:readings|maintenance))?$/)
    if (meterMatch) {
      if (!hasPermission(user, 'meter.read') && !hasPermission(user, 'meter.manage')) return fail(res, 403, 'FORBIDDEN', 'Akses meter tidak tersedia.')
      if (!z.string().uuid().safeParse(meterMatch[1]).success) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
      const meter = await db.meter.findFirst({ where: { id: meterMatch[1], organizationId: user.organizationId, siteId: { in: ids } }, select: { id: true } })
      return meter ? next() : fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
    }
    if (['/monitoring/summary', '/monitoring/timeseries', '/analytics/forecast'].includes(req.path) && !hasPermission(user, 'meter.maintain')) {
      if (req.path === '/analytics/forecast' ? !hasPermission(user, 'forecast.read') && !hasPermission(user, 'forecast.run') : !hasPermission(user, 'monitor.read')) return fail(res, 403, 'FORBIDDEN', 'Permission monitoring tidak tersedia.')
      const siteId = typeof req.query.siteId === 'string' ? req.query.siteId : ''
      return user.scope === 'ORGANIZATION' || ids.includes(siteId) ? next() : fail(res, 403, 'FORBIDDEN', 'Pilih site yang ditugaskan.')
    }
    return fail(res, 403, 'FORBIDDEN', 'Permission belum tersedia untuk modul ini.')
  })().catch(next)
})
registerAdministrationRoutes(api, { db, auth, csrf, admin, platformPermission, wrap, ok, fail, pageQuery, pageResult, logEvent })
registerDataSourceRoutes(api, { db, auth, csrf, wrap, ok, fail, pageQuery, pageResult })
api.get('/integration-sources', auth, admin, wrap(async (req, res) => {const query=pageQuery(req,['name','type','status','createdAt'],'createdAt'),where={organizationId:res.locals.user.organizationId,...(query.search?{name:{contains:query.search,mode:'insensitive' as const}}:{})};const [total,rows]=await Promise.all([db.integrationSource.count({where}),db.integrationSource.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,select:{id:true,name:true,type:true,allowedMeterIds:true,allowedIpAddresses:true,rateLimitPerMinute:true,status:true,rotatedAt:true,createdAt:true},orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query))}))
api.post('/integration-sources', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(150), meterIds: z.array(z.string().uuid()).min(1).max(500), ipAllowlist: z.array(z.string().refine(v => isIP(v) > 0, 'Alamat IP tidak valid.')).max(100).default([]), rateLimitPerMinute: z.number().int().min(1).max(6000).default(60) }).strict().parse(req.body)
  const org = res.locals.user.organizationId, ids = [...new Set(input.meterIds)]
  const meters = await db.meter.count({ where: { organizationId: org, id: { in: ids }, status: { not: 'RETIRED' } } })
  if (meters !== ids.length) return fail(res, 422, 'VALIDATION_ERROR', 'Meter tidak aktif atau di luar organisasi.')
  const token = `et_${randomBytes(32).toString('hex')}`, secretHash = createHash('sha256').update(token).digest('hex')
  const source = await db.$transaction(async tx => {
    const item = await tx.integrationSource.create({ data: { organizationId: org, name: input.name, type: 'API', allowedMeterIds: ids, allowedIpAddresses: input.ipAllowlist, rateLimitPerMinute: input.rateLimitPerMinute }, select: { id: true, name: true, type: true, allowedMeterIds: true, allowedIpAddresses: true, rateLimitPerMinute: true, status: true, createdAt: true } })
    await tx.$executeRaw`INSERT INTO "IntegrationCredential" ("id", "organizationId", "sourceId", "secretHash") VALUES (${randomUUID()}::uuid, ${org}::uuid, ${item.id}::uuid, ${secretHash})`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'INTEGRATION_SOURCE_CREATED', entity: 'IntegrationSource', entityId: item.id, details: { meterIds: ids, ipAllowlist: input.ipAllowlist, rateLimitPerMinute: input.rateLimitPerMinute } } })
    return item
  })
  res.setHeader('Cache-Control', 'no-store')
  return ok(res, { ...source, token }, 201)
}))
api.patch('/integration-sources/:id', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ meterIds: z.array(z.string().uuid()).min(1).max(500).optional(), ipAllowlist: z.array(z.string().refine(v => isIP(v) > 0, 'Alamat IP tidak valid.')).max(100).optional(), rateLimitPerMinute: z.number().int().min(1).max(6000).optional() }).strict().refine(v => Object.keys(v).length > 0, 'Tidak ada perubahan.').parse(req.body)
  const org = res.locals.user.organizationId, meterIds = input.meterIds && [...new Set(input.meterIds)]
  if (meterIds && await db.meter.count({ where: { organizationId: org, id: { in: meterIds }, status: { not: 'RETIRED' } } }) !== meterIds.length) return fail(res, 422, 'VALIDATION_ERROR', 'Meter tidak aktif atau di luar organisasi.')
  const item = await db.$transaction(async tx => {
    const updated = await tx.integrationSource.updateMany({ where: { id: req.params.id, organizationId: org, status: 'ACTIVE' }, data: { ...(meterIds ? { allowedMeterIds: meterIds } : {}), ...(input.ipAllowlist ? { allowedIpAddresses: input.ipAllowlist } : {}), ...(input.rateLimitPerMinute ? { rateLimitPerMinute: input.rateLimitPerMinute, rateWindowStartedAt: null, rateWindowCount: 0 } : {}) } })
    if (!updated.count) return null
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'INTEGRATION_SOURCE_UPDATED', entity: 'IntegrationSource', entityId: req.params.id, details: { fields: Object.keys(input) } } })
    return tx.integrationSource.findFirst({ where: { id: req.params.id, organizationId: org }, select: { id: true, name: true, allowedMeterIds: true, allowedIpAddresses: true, rateLimitPerMinute: true, status: true } })
  })
  return item ? ok(res, item) : fail(res, 404, 'NOT_FOUND', 'Sumber aktif tidak ditemukan.')
}))
api.post('/integration-sources/:id/rotate', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ graceMinutes: z.number().int().min(1).max(1440).default(60) }).parse(req.body), org = res.locals.user.organizationId
  const token = `et_${randomBytes(32).toString('hex')}`, secretHash = createHash('sha256').update(token).digest('hex'), expiresAt = new Date(Date.now() + input.graceMinutes * 60_000)
  const rotated = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string; secretHash: string | null }[]>`SELECT "id", "secretHash" FROM "IntegrationSource" WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${org}::uuid AND "status" = 'ACTIVE' AND "type" = 'API' FOR UPDATE`
    if (!rows[0]) return false
    if (rows[0].secretHash) await tx.$executeRaw`INSERT INTO "IntegrationCredential" ("id", "organizationId", "sourceId", "secretHash", "expiresAt") VALUES (${randomUUID()}::uuid, ${org}::uuid, ${rows[0].id}::uuid, ${rows[0].secretHash}, ${expiresAt}) ON CONFLICT ("secretHash") DO NOTHING`
    await tx.$executeRaw`UPDATE "IntegrationCredential" SET "expiresAt" = ${expiresAt} WHERE "organizationId" = ${org}::uuid AND "sourceId" = ${rows[0].id}::uuid AND ("expiresAt" IS NULL OR "expiresAt" > ${expiresAt})`
    await tx.$executeRaw`INSERT INTO "IntegrationCredential" ("id", "organizationId", "sourceId", "secretHash") VALUES (${randomUUID()}::uuid, ${org}::uuid, ${rows[0].id}::uuid, ${secretHash})`
    await tx.integrationSource.update({ where: { id: rows[0].id }, data: { secretHash: null, rotatedAt: new Date() } })
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'INTEGRATION_SOURCE_ROTATED', entity: 'IntegrationSource', entityId: rows[0].id, details: { graceMinutes: input.graceMinutes } } })
    return true
  })
  if (!rotated) return fail(res, 404, 'NOT_FOUND', 'Sumber aktif tidak ditemukan.')
  res.setHeader('Cache-Control', 'no-store')
  return ok(res, { token, previousKeysExpireAt: expiresAt })
}))
api.post('/integration-sources/:id/revoke', auth, csrf, admin, wrap(async (req, res) => {
  const org = res.locals.user.organizationId
  const count = await db.$transaction(async tx => {
    const result = await tx.integrationSource.updateMany({ where: { id: req.params.id, organizationId: org, status: 'ACTIVE' }, data: { status: 'REVOKED', secretHash: null } })
    if (result.count) await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'INTEGRATION_SOURCE_REVOKED', entity: 'IntegrationSource', entityId: req.params.id } })
    return result.count
  })
  return count ? ok(res, { status: 'REVOKED' }) : fail(res, 404, 'NOT_FOUND', 'Sumber aktif tidak ditemukan.')
}))
function webhookSecretKey() { return createHash('sha256').update(process.env.WEBHOOK_ENCRYPTION_KEY || secret!).digest() }
function encryptWebhookSecret(value:string) { const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',webhookSecretKey(),iv),encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}` }
function decryptWebhookSecret(value:string) { const [iv,tag,body]=value.split('.');const decipher=createDecipheriv('aes-256-gcm',webhookSecretKey(),Buffer.from(iv,'base64url'));decipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8') }
function isPublicAddress(address:string) {
  if(isIP(address)===4){const octets=address.split('.').map(Number),a=octets[0],b=octets[1];return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===0||b===168)))}
  const ip=address.toLowerCase();return !(ip==='::'||ip==='::1'||ip.startsWith('fc')||ip.startsWith('fd')||/^fe[89ab]/.test(ip)||ip.startsWith('::ffff:'))
}
async function validateWebhookUrl(value:string) { const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Webhook harus menggunakan HTTPS dan tidak boleh menyertakan kredensial pada URL.');const addresses=await lookup(url.hostname,{all:true,verbatim:true});if(!addresses.length||addresses.some(address=>!isPublicAddress(address.address)))throw new Error('Alamat webhook harus mengarah ke host publik.');return {url,address:addresses[0].address} }
async function sendWebhook(webhook:any,event:string,data:unknown={message:'Uji konektivitas EnergyTrack webhook'},id:string=randomUUID()) {
  const deliveryId=randomUUID(),body=JSON.stringify({id,event,occurredAt:new Date().toISOString(),data}),secretValue=decryptWebhookSecret(webhook.secretEncrypted),signature=createHmac('sha256',secretValue).update(body).digest('hex')
  let status='FAILED',responseCode:number|null=null,error:string|null=null
  try { const {url:target,address}=await validateWebhookUrl(webhook.url);responseCode=await new Promise<number>((resolve,reject)=>{const request=httpsRequest({hostname:target.hostname,port:target.port||443,path:`${target.pathname}${target.search}`,method:'POST',servername:target.hostname,headers:{'content-type':'application/json','x-energytrack-event':event,'x-energytrack-delivery':id,'x-energytrack-signature':`sha256=${signature}`},lookup:((_host:string,options:any,callback:any)=>options?.all?callback(null,[{address,family:isIP(address)}]):callback(null,address,isIP(address))) as any},response=>{response.resume();response.on('end',()=>resolve(response.statusCode||0))});request.setTimeout(5_000,()=>request.destroy(new Error('Timeout setelah 5 detik.')));request.on('error',reject);request.end(body)});if(responseCode<200||responseCode>=300)throw new Error(`Webhook merespons HTTP ${responseCode}.`);status='DELIVERED' } catch(e) {error=(e as Error).message.slice(0,500)}
  await db.$transaction(async tx=>{await tx.webhookDelivery.create({data:{id:deliveryId,webhookId:webhook.id,event,status,responseCode,error}});if(status==='DELIVERED')await tx.integrationWebhook.update({where:{id:webhook.id},data:{lastDeliveredAt:new Date()}});await tx.auditLog.create({data:{organizationId:webhook.organizationId,userId:null,action:`WEBHOOK_${status}`,entity:'IntegrationWebhook',entityId:webhook.id,details:{event,eventId:id,deliveryId,responseCode,error}}})})
  return {id,status,responseCode,error}
}
async function processOneWebhookEvent() {
  const event=await db.$transaction(async tx=>{await tx.$executeRaw`UPDATE "WebhookOutbox" SET "status"='PENDING',"lockedAt"=NULL WHERE "status"='PROCESSING' AND "lockedAt"<CURRENT_TIMESTAMP-INTERVAL '5 minutes'`;const rows=await tx.$queryRaw<{id:string;organizationId:string;event:string;payload:Prisma.JsonValue;attempts:number}[]>`WITH candidate AS (SELECT "id" FROM "WebhookOutbox" WHERE "status"='PENDING' AND "nextAttemptAt"<=CURRENT_TIMESTAMP ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE "WebhookOutbox" o SET "status"='PROCESSING',"lockedAt"=CURRENT_TIMESTAMP,"attempts"="attempts"+1 FROM candidate WHERE o."id"=candidate."id" RETURNING o."id",o."organizationId",o."event",o."payload",o."attempts"`;return rows[0]??null})
  if(!event)return false
  const hooks=await db.integrationWebhook.findMany({where:{organizationId:event.organizationId,status:'ACTIVE',events:{has:event.event}}});let failures=0
  for(const hook of hooks){const result=await sendWebhook(hook,event.event,event.payload,event.id);if(result.status!=='DELIVERED')failures++}
  if(failures&&event.attempts<5){const delay=Math.min(3600,15*2**(event.attempts-1));await db.webhookOutbox.update({where:{id:event.id},data:{status:'PENDING',lockedAt:null,nextAttemptAt:new Date(Date.now()+delay*1000),lastError:`${failures} endpoint(s) gagal; retry ${event.attempts}/5.`}})}else await db.webhookOutbox.update({where:{id:event.id},data:{status:failures?'FAILED':'DELIVERED',lockedAt:null,deliveredAt:failures?null:new Date(),lastError:failures?`${failures} endpoint(s) tetap gagal setelah lima percobaan.`:null}})
  return true
}
api.get('/webhooks',auth,admin,wrap(async(req,res)=>{const query=pageQuery(req,['name','status','createdAt','updatedAt'],'createdAt'),where={organizationId:res.locals.user.organizationId,...(query.search?{name:{contains:query.search,mode:'insensitive' as const}}:{})};const [total,rows]=await Promise.all([db.integrationWebhook.count({where}),db.integrationWebhook.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,select:{id:true,name:true,url:true,events:true,status:true,createdAt:true,updatedAt:true,lastDeliveredAt:true,_count:{select:{deliveries:true}}},orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query))}))
api.get('/webhooks/:id/deliveries',auth,admin,wrap(async(req,res)=>{const query=pageQuery(req,['createdAt','event','status','responseCode'],'createdAt'),where={webhook:{id:req.params.id,organizationId:res.locals.user.organizationId},...(query.search?{event:{contains:query.search,mode:'insensitive' as const}}:{})};const [total,rows]=await Promise.all([db.webhookDelivery.count({where}),db.webhookDelivery.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:50,select:{id:true,event:true,status:true,responseCode:true,error:true,createdAt:true},orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query))}))
api.post('/webhooks',auth,csrf,admin,wrap(async(req,res)=>{const input=z.object({name:z.string().trim().min(2).max(120),url:z.string().url().max(2000),events:z.array(z.enum(['alert.created','alert.updated','reading.import.completed','report.completed'])).min(1).max(10)}).strict().parse(req.body),validated=await validateWebhookUrl(input.url),url=validated.url.toString(),webhookSecret=`whsec_${randomBytes(32).toString('hex')}`,org=res.locals.user.organizationId;const item=await db.$transaction(async tx=>{const row=await tx.integrationWebhook.create({data:{organizationId:org,name:input.name,url,events:input.events,secretEncrypted:encryptWebhookSecret(webhookSecret)}});await tx.auditLog.create({data:{organizationId:org,userId:res.locals.user.id,action:'WEBHOOK_CREATED',entity:'IntegrationWebhook',entityId:row.id,details:{url,events:input.events}}});return row});res.setHeader('Cache-Control','no-store');return ok(res,{id:item.id,name:item.name,url:item.url,events:item.events,status:item.status,secret:webhookSecret},201)}))
api.post('/webhooks/:id/rotate',auth,csrf,admin,wrap(async(req,res)=>{const org=res.locals.user.organizationId,webhookSecret=`whsec_${randomBytes(32).toString('hex')}`,updated=await db.$transaction(async tx=>{const count=await tx.integrationWebhook.updateMany({where:{id:req.params.id,organizationId:org,status:'ACTIVE'},data:{secretEncrypted:encryptWebhookSecret(webhookSecret)}});if(count.count)await tx.auditLog.create({data:{organizationId:org,userId:res.locals.user.id,action:'WEBHOOK_SECRET_ROTATED',entity:'IntegrationWebhook',entityId:req.params.id}});return count.count});if(!updated)return fail(res,404,'NOT_FOUND','Webhook aktif tidak ditemukan.');res.setHeader('Cache-Control','no-store');return ok(res,{secret:webhookSecret})}))
api.post('/webhooks/:id/revoke',auth,csrf,admin,wrap(async(req,res)=>{const org=res.locals.user.organizationId,count=await db.$transaction(async tx=>{const changed=await tx.integrationWebhook.updateMany({where:{id:req.params.id,organizationId:org,status:'ACTIVE'},data:{status:'REVOKED'}});if(changed.count)await tx.auditLog.create({data:{organizationId:org,userId:res.locals.user.id,action:'WEBHOOK_REVOKED',entity:'IntegrationWebhook',entityId:req.params.id}});return changed.count});return count?ok(res,{status:'REVOKED'}):fail(res,404,'NOT_FOUND','Webhook aktif tidak ditemukan.')}))
api.post('/webhooks/:id/test',auth,csrf,admin,wrap(async(req,res)=>{const webhook=await db.integrationWebhook.findFirst({where:{id:req.params.id,organizationId:res.locals.user.organizationId,status:'ACTIVE'}});if(!webhook)return fail(res,404,'NOT_FOUND','Webhook aktif tidak ditemukan.');return ok(res,await sendWebhook(webhook,'webhook.test',{message:'Uji konektivitas EnergyTrack webhook'}))}))
api.get('/site-assignments', auth, admin, wrap(async (req, res) => {const query=pageQuery(req,['createdAt','userId','siteId'],'createdAt'),org=res.locals.user.organizationId,search=query.search?Prisma.sql`AND EXISTS (SELECT 1 FROM "User" u JOIN "Site" s ON s."id"="SiteAssignment"."siteId" WHERE u."id"="SiteAssignment"."userId" AND (u."email" ILIKE ${`%${query.search}%`} OR s."name" ILIKE ${`%${query.search}%`}))`:Prisma.empty,where=Prisma.sql`FROM "SiteAssignment" WHERE "organizationId"=${org}::uuid ${search}`;const [counts,rows]=await Promise.all([db.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*)::bigint ${where}`),db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`SELECT "id","userId","siteId","createdAt" ${where} ORDER BY ${Prisma.raw(`"${query.sort}" ${query.direction.toUpperCase()}`)} LIMIT ${query.requested?query.pageSize:1000} OFFSET ${query.requested?(query.page-1)*query.pageSize:0}`)]);return ok(res,pageResult(rows,Number(counts[0]?.count||0),query))}))
api.post('/site-assignments', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ userId: z.string().uuid(), siteId: z.string().uuid() }).parse(req.body), org = res.locals.user.organizationId
  const [member, site] = await Promise.all([db.organizationMembership.findFirst({ where: { userId: input.userId, organizationId: org, status: 'ACTIVE', user: { active: true } }, select: { id: true } }), db.site.findFirst({ where: { id: input.siteId, organizationId: org, status: { not: 'ARCHIVED' } } })])
  if (!member || !site) return fail(res, 404, 'NOT_FOUND', 'Pengguna aktif atau site tidak ditemukan.')
  const assignment = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "SiteAssignment" ("id", "organizationId", "userId", "siteId") VALUES (${randomUUID()}::uuid, ${org}::uuid, ${input.userId}::uuid, ${input.siteId}::uuid) ON CONFLICT ("userId", "siteId") DO NOTHING RETURNING "id"`
    if (rows[0]) await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'SITE_ASSIGNMENT_CREATED', entity: 'SiteAssignment', entityId: rows[0].id, details: input } })
    return rows[0]
  })
  return assignment ? ok(res, assignment, 201) : fail(res, 409, 'CONFLICT', 'Penugasan sudah ada.')
}))
api.delete('/site-assignments/:id', auth, csrf, admin, wrap(async (req, res) => {
  const org = res.locals.user.organizationId
  const removed = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string }[]>`DELETE FROM "SiteAssignment" WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${org}::uuid RETURNING "id"`
    if (rows[0]) await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'SITE_ASSIGNMENT_REMOVED', entity: 'SiteAssignment', entityId: rows[0].id } })
    return rows[0]
  })
  return removed ? res.status(204).end() : fail(res, 404, 'NOT_FOUND', 'Penugasan tidak ditemukan.')
}))
const operatingScheduleSchema = z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict()).max(21).superRefine((slots, ctx) => {
  const byDay = new Map<number, { start: string; end: string; index: number }[]>()
  slots.forEach((slot, index) => { if (slot.start >= slot.end) ctx.addIssue({ code: 'custom', path: [index, 'end'], message: 'Jam selesai harus setelah jam mulai.' }); byDay.set(slot.dayOfWeek, [...(byDay.get(slot.dayOfWeek) ?? []), { ...slot, index }]) })
  for (const daySlots of byDay.values()) { daySlots.sort((a, b) => a.start.localeCompare(b.start)); for (let i = 1; i < daySlots.length; i++) if (daySlots[i].start < daySlots[i - 1].end) ctx.addIssue({ code: 'custom', path: [daySlots[i].index], message: 'Jadwal pada hari yang sama tidak boleh bertumpang tindih.' }) }
})
const siteBaseSchema = z.object({ code: z.string().regex(/^[A-Z0-9-]+$/), name: z.string().trim().min(2).max(200), type: z.enum(['FACTORY', 'OFFICE', 'COMMERCIAL', 'WAREHOUSE', 'OTHER']), address: z.string().trim().min(10).max(500), timezone: z.string().refine(s => { try { Intl.DateTimeFormat('en', { timeZone: s }); return true } catch { return false } }), latitude: z.coerce.number().min(-90).max(90).nullable().optional(), longitude: z.coerce.number().min(-180).max(180).nullable().optional(), operatingSchedule: operatingScheduleSchema.nullable().optional(), managerId: z.string().uuid().nullable().optional(), emissionRegion: z.string().trim().min(2).max(150).nullable().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE') })
const siteSchema = siteBaseSchema.refine(v => (v.latitude === null || v.latitude === undefined) === (v.longitude === null || v.longitude === undefined), { message: 'Latitude dan longitude harus diisi bersama.', path: ['longitude'] })
api.get('/sites', auth, wrap(async (req, res) => { const query=pageQuery(req,['name','code','status','type'],'name'),where={organizationId:res.locals.user.organizationId,...(res.locals.allowedSiteIds?{id:{in:res.locals.allowedSiteIds}}:{}),...(query.search?{OR:[{name:{contains:query.search,mode:'insensitive' as const}},{code:{contains:query.search,mode:'insensitive' as const}},{address:{contains:query.search,mode:'insensitive' as const}}]}:{})};const [total,rows]=await Promise.all([db.site.count({where}),db.site.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,include:{manager:{select:{id:true,fullName:true}},_count:{select:{meters:true,buildings:true}}},orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query)) }))
const buildingSiteScope = (ids?: string[]) => !ids ? Prisma.empty : ids.length ? Prisma.sql`AND "siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})` : Prisma.sql`AND FALSE`
api.get('/buildings', auth, wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid().optional() }).parse(req.query), ids: string[] | undefined = res.locals.allowedSiteIds, query=pageQuery(req,['name','code','status'],'name')
  if (input.siteId && ids && !ids.includes(input.siteId)) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  const filter = input.siteId ? Prisma.sql`AND "siteId" = ${input.siteId}::uuid` : Prisma.empty
  const search=query.search?Prisma.sql`AND ("name" ILIKE ${`%${query.search}%`} OR "code" ILIKE ${`%${query.search}%`})`:Prisma.empty,org=res.locals.user.organizationId
  const count=await db.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "Building" WHERE "organizationId"=${org}::uuid ${buildingSiteScope(ids)} ${filter} ${search}`)
  const rows=await db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`SELECT * FROM "Building" WHERE "organizationId"=${org}::uuid ${buildingSiteScope(ids)} ${filter} ${search} ORDER BY ${Prisma.raw(`"${query.sort}" ${query.direction.toUpperCase()}`)} LIMIT ${query.requested?query.pageSize:2147483647} OFFSET ${query.requested?(query.page-1)*query.pageSize:0}`)
  return ok(res,pageResult(rows,Number(count[0]?.count||0),query))
}))
api.get('/buildings/:id', auth, wrap(async (req, res) => {
  const rows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT * FROM "Building" WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${res.locals.user.organizationId}::uuid ${buildingSiteScope(res.locals.allowedSiteIds)}`)
  return rows[0] ? ok(res, rows[0]) : fail(res, 404, 'NOT_FOUND', 'Gedung tidak ditemukan.')
}))
api.post('/buildings', auth, csrf, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid(), code: z.string().trim().regex(/^[A-Z0-9-]{1,100}$/), name: z.string().trim().min(2).max(200), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE') }).parse(req.body)
  const org = res.locals.user.organizationId
  if (!await db.site.findFirst({ where: { id: input.siteId, organizationId: org, status: { not: 'ARCHIVED' } } })) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan atau sudah diarsipkan.')
  const id = randomUUID()
  await db.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO "Building" ("id", "organizationId", "siteId", "code", "name", "status") VALUES (${id}::uuid, ${org}::uuid, ${input.siteId}::uuid, ${input.code}, ${input.name}, ${input.status})`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'BUILDING_CREATED', entity: 'Building', entityId: id, details: { siteId: input.siteId } } })
  })
  return ok(res, { id, ...input }, 201)
}))
api.patch('/buildings/:id', auth, csrf, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ code: z.string().trim().regex(/^[A-Z0-9-]{1,100}$/).optional(), name: z.string().trim().min(2).max(200).optional(), status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional() }).strict().parse(req.body), org = res.locals.user.organizationId
  if (!Object.keys(input).length) return fail(res, 422, 'VALIDATION_ERROR', 'Tidak ada perubahan.')
  const rows = await db.$transaction(async tx => {
    const existing = await tx.$queryRaw<{ status: string }[]>`SELECT b."status" FROM "Building" b JOIN "Site" s ON s."id" = b."siteId" AND s."organizationId" = b."organizationId" WHERE b."id" = ${req.params.id}::uuid AND b."organizationId" = ${org}::uuid AND s."status" <> 'ARCHIVED' FOR UPDATE OF b`
    if (!existing[0] || (existing[0].status === 'ARCHIVED' && input.status !== 'ARCHIVED')) return []
    const result = await tx.$queryRaw<Record<string, unknown>[]>`UPDATE "Building" SET "code" = COALESCE(${input.code ?? null}, "code"), "name" = COALESCE(${input.name ?? null}, "name"), "status" = COALESCE(${input.status ?? null}, "status") WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${org}::uuid RETURNING *`
    if (result[0]) await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'BUILDING_UPDATED', entity: 'Building', entityId: req.params.id, details: { fields: Object.keys(input) } } })
    return result
  })
  return rows[0] ? ok(res, rows[0]) : fail(res, 404, 'NOT_FOUND', 'Gedung tidak ditemukan.')
}))
api.post('/sites', auth, csrf, admin, wrap(async (req, res) => {
  const input = siteSchema.parse(req.body), orgId = res.locals.user.organizationId
  if (input.managerId && !await db.organizationMembership.findFirst({ where: { userId: input.managerId, organizationId: orgId, status: 'ACTIVE', user: { active: true } } })) return fail(res, 422, 'VALIDATION_ERROR', 'Pengelola harus anggota aktif organisasi ini.')
  const site = await db.$transaction(async tx => {
    const created = await tx.site.create({ data: { ...input, operatingSchedule: input.operatingSchedule === null ? Prisma.DbNull : input.operatingSchedule as Prisma.InputJsonValue | undefined, organizationId: orgId } })
    await tx.auditLog.create({ data: { organizationId: orgId, userId: res.locals.user.id, action: 'SITE_CREATED', entity: 'Site', entityId: created.id } })
    return created
  })
  return ok(res, site, 201)
}))
api.post('/sites/:id/archive', auth, csrf, admin, wrap(async (req, res) => {
  const orgId = res.locals.user.organizationId
  const site = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "Site" WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${orgId}::uuid FOR UPDATE`
    if (!rows[0]) return 'NOT_FOUND' as const
    if (rows[0].status === 'ARCHIVED') return 'ARCHIVED' as const
    const updated = await tx.site.update({ where: { id: rows[0].id }, data: { status: 'ARCHIVED' } })
    await tx.auditLog.create({ data: { organizationId: orgId, userId: res.locals.user.id, action: 'SITE_ARCHIVED', entity: 'Site', entityId: updated.id } })
    return updated
  })
  if (site === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  if (site === 'ARCHIVED') return fail(res, 409, 'INVALID_STATE', 'Site sudah diarsipkan.')
  return ok(res, site)
}))
api.get('/meters', auth, wrap(async (req, res) => { const query=pageQuery(req,['code','status','metric','meterType'],'code'),filter=z.object({siteId:z.string().uuid().optional(),status:z.string().max(30).optional()}).parse(req.query),ids:string[]|undefined=res.locals.allowedSiteIds;if(filter.siteId&&ids&&!ids.includes(filter.siteId))return ok(res,pageResult([],0,query));const where={organizationId:res.locals.user.organizationId,...(filter.siteId?{siteId:filter.siteId}:ids?{siteId:{in:ids}}:{}),...(filter.status?{status:filter.status}:{}),...(query.search?{OR:[{code:{contains:query.search,mode:'insensitive' as const}},{serialNumber:{contains:query.search,mode:'insensitive' as const}}]}:{})};const [total,rows]=await Promise.all([db.meter.count({where}),db.meter.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,include:{site:true,readings:{orderBy:{timestamp:'desc'},take:1,select:{timestamp:true,value:true,unit:true,quality:true}}},orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query)) }))
const rolloverValueSchema = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/).refine(value => new Prisma.Decimal(value).gt(0), 'Nilai rollover harus lebih dari nol.')
const meterSchema = z.object({ code: z.string().trim().min(1).max(100), siteId: z.string().uuid(), assetId: z.string().uuid().optional(), serialNumber: z.string().trim().min(1).max(150).optional(), installedAt: z.string().datetime({ offset: true }).optional(), decommissionedAt: z.string().datetime({ offset: true }).optional(), meterType: z.enum(['CUMULATIVE', 'INTERVAL']), metric: z.enum(['ENERGY_IMPORT', 'POWER_DEMAND']), unit: z.enum(['kWh', 'kW']), sourceType: z.enum(['MANUAL', 'CSV', 'API', 'SIMULATOR', 'MQTT']), intervalMinutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]), multiplier: z.coerce.number().positive(), rolloverValue: rolloverValueSchema.optional(), status: z.literal('PENDING').default('PENDING') }).refine(v => (v.metric === 'ENERGY_IMPORT' && v.unit === 'kWh') || (v.metric === 'POWER_DEMAND' && v.unit === 'kW'), { message: 'Unit tidak sesuai dengan metrik.', path: ['unit'] }).refine(v => !v.rolloverValue || (v.meterType === 'CUMULATIVE' && v.metric === 'ENERGY_IMPORT'), { message: 'Nilai rollover hanya berlaku untuk meter energi kumulatif.', path: ['rolloverValue'] }).refine(v => !v.installedAt || !v.decommissionedAt || new Date(v.installedAt) <= new Date(v.decommissionedAt), { message: 'Tanggal pelepasan harus setelah pemasangan.', path: ['decommissionedAt'] })
api.post('/meters', auth, csrf, (_req, res, next) => ['meter.configure', 'meter.manage'].some(permission => hasPermission(res.locals.user, permission)) ? next() : fail(res, 403, 'FORBIDDEN', 'Akses konfigurasi meter tidak tersedia.'), wrap(async (req, res) => {
  const input = meterSchema.parse(req.body), org = res.locals.user.organizationId
  const site = await db.site.findFirst({ where: { id: input.siteId, organizationId: org, status: { not: 'ARCHIVED' } } })
  if (!site) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  if (input.assetId && !await db.asset.findFirst({ where: { id: input.assetId, organizationId: org, siteId: input.siteId, status: 'ACTIVE' } })) return fail(res, 422, 'VALIDATION_ERROR', 'Aset harus aktif dan berada pada site yang dipilih.')
  const { assetId, serialNumber, installedAt, decommissionedAt, rolloverValue, ...base } = input
  const meter = await db.$transaction(async tx => {
    const created = await tx.meter.create({ data: { ...base, organizationId: org } })
    await tx.$executeRaw`UPDATE "Meter" SET "assetId" = ${assetId ?? null}::uuid, "serialNumber" = ${serialNumber ?? null}, "installedAt" = ${installedAt ? new Date(installedAt) : null}, "decommissionedAt" = ${decommissionedAt ? new Date(decommissionedAt) : null}, "rolloverValue" = ${rolloverValue ?? null}::numeric WHERE "id" = ${created.id}::uuid AND "organizationId" = ${org}::uuid`
    const versionRows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "MeterConfigVersion" ("id", "organizationId", "meterId", "meterType", "metric", "unit", "sourceType", "intervalMinutes", "multiplier", "rolloverValue", "effectiveFrom", "createdBy", "reason") VALUES (gen_random_uuid(), ${org}::uuid, ${created.id}::uuid, ${created.meterType}, ${created.metric}, ${created.unit}, ${created.sourceType}, ${created.intervalMinutes}, ${created.multiplier}, ${rolloverValue ?? null}::numeric, ${installedAt ? new Date(installedAt) : created.createdAt}, ${res.locals.user.id}::uuid, 'Konfigurasi awal meter') RETURNING "id"`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'METER_CREATED', entity: 'Meter', entityId: created.id, details: { assetId: assetId ?? null } } })
    return { ...created, assetId: assetId ?? null, serialNumber: serialNumber ?? null, installedAt: installedAt ?? null, decommissionedAt: decommissionedAt ?? null, rolloverValue: rolloverValue ?? null, configurationVersionId: versionRows[0].id }
  })
  return ok(res, meter, 201)
}))
api.post('/ingestion/readings', auth, csrf, admin, wrap(async (req, res) => {
  const input = readingsSchema.parse(req.body)
  return ok(res, await ingestBatch(res.locals.user.organizationId, input.readings, res.locals.user.id))
}))
api.get('/meters/:id/readings', auth, wrap(async (req, res) => {
  const meter = await db.meter.findFirst({ where: { id: req.params.id, organizationId: res.locals.user.organizationId, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}) } })
  if (!meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  const input = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().uuid().optional() }).parse(req.query)
  const cursor = input.cursor ? await db.meterReading.findFirst({ where: { id: input.cursor, meterId: meter.id, organizationId: res.locals.user.organizationId }, select: { id: true } }) : null
  if (input.cursor && !cursor) return fail(res, 422, 'INVALID_CURSOR', 'Cursor bacaan tidak valid untuk meter ini.')
  const rows = await db.meterReading.findMany({ where: { meterId: meter.id, organizationId: res.locals.user.organizationId }, include: { revisions: { orderBy: { createdAt: 'desc' }, include: { actor: { select: { id: true, fullName: true } } } } }, orderBy: [{ timestamp: 'desc' }, { id: 'desc' }], take: input.limit + 1, ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}) })
  const hasMore = rows.length > input.limit, readings = hasMore ? rows.slice(0, input.limit) : rows
  return ok(res, { items: readings, nextCursor: hasMore ? readings.at(-1)?.id ?? null : null, hasMore })
}))
api.get('/data-quality', auth, allowRoles('ADMIN', 'ENERGY_MANAGER', 'FACILITY_MANAGER', 'ANALYST', 'TECHNICIAN'), wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid().optional(), meterId: z.string().uuid().optional(), days: z.coerce.number().int().min(1).max(366).default(30), periodStart: z.string().datetime({ offset: true }).optional(), periodEnd: z.string().datetime({ offset: true }).optional() }).refine(v => (!!v.periodStart === !!v.periodEnd), { path: ['periodEnd'], message: 'periodStart dan periodEnd harus digunakan bersama.' }).refine(v => !v.periodStart || new Date(v.periodEnd!).getTime() - new Date(v.periodStart).getTime() <= 366 * 86400000, { path: ['periodEnd'], message: 'Periode maksimum 366 hari.' }).parse(req.query)
  const orgId = res.locals.user.organizationId, end = input.periodEnd ? new Date(input.periodEnd) : new Date(), start = input.periodStart ? new Date(input.periodStart) : new Date(end.getTime() - input.days * 86400000)
  if (end <= start) return fail(res, 422, 'VALIDATION_ERROR', 'Periode harus lebih dari nol.')
  if (res.locals.user.scope !== 'ORGANIZATION' && !input.siteId) return fail(res, 403, 'FORBIDDEN', 'Site diperlukan untuk melihat kualitas data.')
  if (input.siteId && !await siteForOrg(input.siteId, orgId)) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  if (input.meterId && !await db.meter.findFirst({ where: { id: input.meterId, organizationId: orgId, ...(input.siteId ? { siteId: input.siteId } : {}) } })) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  const meterScope = { organizationId: orgId, ...(input.siteId ? { siteId: input.siteId } : {}), ...(input.meterId ? { id: input.meterId } : {}) }
  const readingWhere = { organizationId: orgId, meter: { ...meterScope } }
  const meterInclude = { meter: { select: { code: true, meterType: true, metric: true, unit: true, intervalMinutes: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } } } } }
  const [readings, prior] = await Promise.all([
    db.meterReading.findMany({ where: { ...readingWhere, timestamp: { gte: start, lt: end } }, include: meterInclude, orderBy: [{ meterId: 'asc' }, { timestamp: 'asc' }], take: 20_001 }),
    db.meterReading.findMany({ where: { ...readingWhere, timestamp: { lt: start } }, distinct: ['meterId'], include: meterInclude, orderBy: [{ meterId: 'asc' }, { timestamp: 'desc' }] })
  ])
  if (readings.length > 20_000) return fail(res, 422, 'PERIOD_TOO_LARGE', 'Persempit periode atau pilih satu meter; batas pemeriksaan adalah 20.000 bacaan.')
  const issues = detectReadingIssues(readings, prior, start, end)
  const counts = Object.fromEntries(['CRITICAL', 'WARNING', 'INFO'].map(severity => [severity, issues.filter(issue => issue.severity === severity).length]))
  return ok(res, { periodStart: start.toISOString(), periodEnd: end.toISOString(), siteId: input.siteId ?? null, meterId: input.meterId ?? null, readingCount: readings.length, issueCount: issues.length, counts, issues })
}))
api.post('/meters/:id/readings/:readingId/revisions', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ value: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/), quality: z.enum(['VALID', 'ESTIMATED', 'SUSPECT', 'INVALID']).default('VALID'), reason: z.string().trim().min(2).max(1000) }).strict().parse(req.body)
  const org = res.locals.user.organizationId
  const meter = await db.meter.findFirst({ where: { id: req.params.id, organizationId: org } })
  if (!meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  const reading = await db.meterReading.findFirst({ where: { id: req.params.readingId, meterId: meter.id, organizationId: org } })
  if (!reading) return fail(res, 404, 'NOT_FOUND', 'Bacaan tidak ditemukan.')
  const versions = await db.meterConfigVersion.findMany({ where: { organizationId: org, meterId: meter.id }, orderBy: { effectiveFrom: 'desc' }, select: { multiplier: true, effectiveFrom: true, effectiveTo: true } })
  const corrected = new Prisma.Decimal(input.value).mul(multiplierAt(reading.timestamp, versions, meter.multiplier))
  if (corrected.gte('100000000000000')) return fail(res, 422, 'VALIDATION_ERROR', 'Nilai setelah multiplier terlalu besar.')
  const revised = await db.$transaction(async tx => {
    const locked = await tx.$queryRaw<{ value: Prisma.Decimal }[]>`SELECT "value" FROM "MeterReading" WHERE "id" = ${reading.id}::uuid AND "organizationId" = ${org}::uuid FOR UPDATE`
    if (!locked[0]) return null
    const revision = await tx.readingRevision.create({ data: { organizationId: org, readingId: reading.id, previousValue: locked[0].value, correctedValue: corrected, quality: input.quality, reason: input.reason, createdBy: res.locals.user.id } })
    const updated = await tx.meterReading.update({ where: { id: reading.id }, data: { value: corrected, quality: input.quality } })
    await enqueueReadingRollups(tx, org, [{ meterId: meter.id, timestamp: reading.timestamp }])
    await evaluateAlerts(tx, org, [meter.id], res.locals.user.id)
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'READING_CORRECTED', entity: 'MeterReading', entityId: reading.id, details: { revisionId: revision.id, reason: input.reason, previousValue: String(locked[0].value), correctedValue: corrected.toFixed(6), quality: input.quality } } })
    return { ...updated, revision }
  })
  return revised ? ok(res, revised, 201) : fail(res, 404, 'NOT_FOUND', 'Bacaan tidak ditemukan.')
}))
api.get('/reading-imports', auth, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
  const user = res.locals.user, ids: string[] | undefined = res.locals.allowedSiteIds
  const query=pageQuery(req,['createdAt','fileName','status','accepted','rejected'],'createdAt'),scope = ids ? { OR: [{ createdBy: user.id }, { readings: { some: { meter: { siteId: { in: ids } } } } }] } : {},where={organizationId:user.organizationId,...scope,...(query.search?{fileName:{contains:query.search,mode:'insensitive' as const}}:{})}
  const [total,jobs]=await Promise.all([db.importJob.count({where}),db.importJob.findMany({where,orderBy:{[query.sort]:query.direction},skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:100})]);return ok(res,pageResult(jobs.map(({previewCsv:_previewCsv,...job})=>({...job,errors:job.status==='QUEUED'||job.status==='PROCESSING'?null:job.errors})),total,query))
}))
api.get('/reading-imports/:id', auth, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
  const user = res.locals.user, ids: string[] | undefined = res.locals.allowedSiteIds
  const scope = ids ? { OR: [{ createdBy: user.id }, { readings: { some: { meter: { siteId: { in: ids } } } } }] } : {}
  const job = await db.importJob.findFirst({ where: { id: req.params.id, organizationId: user.organizationId, ...scope } })
  if (!job) return fail(res, 404, 'NOT_FOUND', 'Impor tidak ditemukan.')
  const { previewCsv: _previewCsv, ...safeJob } = job
  return ok(res, { ...safeJob, errors: job.status === 'QUEUED' || job.status === 'PROCESSING' ? null : job.errors })
}))
api.get('/quarantined-readings', auth, admin, wrap(async (req, res) => {
  const status = z.enum(['OPEN', 'RELEASED', 'DISCARDED']).optional().parse(req.query.status),query=pageQuery(req,['createdAt','status','reason'],'createdAt'),search=query.search?Prisma.sql`AND (q."reason" ILIKE ${`%${query.search}%`} OR j."fileName" ILIKE ${`%${query.search}%`})`:Prisma.empty,where=Prisma.sql`FROM "QuarantinedReading" q JOIN "ImportJob" j ON j."id"=q."importJobId" AND j."organizationId"=q."organizationId" WHERE q."organizationId"=${res.locals.user.organizationId}::uuid ${status?Prisma.sql`AND q."status"=${status}`:Prisma.empty} ${search}`
  const [counts,rows]=await Promise.all([db.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*)::bigint ${where}`),db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`SELECT q.*,j."fileName" ${where} ORDER BY ${Prisma.raw(`q."${query.sort}" ${query.direction.toUpperCase()}`)} LIMIT ${query.requested?query.pageSize:100} OFFSET ${query.requested?(query.page-1)*query.pageSize:0}`)])
  return ok(res,pageResult(rows,Number(counts[0]?.count||0),query))
}))
api.post('/quarantined-readings/:id/release', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ meterId: z.string().uuid(), timestamp: z.string().datetime({ offset: true }), value: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/), unit: z.enum(['kWh', 'kW']) }).strict().parse(req.body), org = res.locals.user.organizationId
  const quarantineRows = await db.$queryRaw<{ id: string; status: string; importJobId: string; mode: string; payload: Prisma.JsonValue }[]>`SELECT q."id", q."status", q."importJobId", j."mode", q."payload" FROM "QuarantinedReading" q JOIN "ImportJob" j ON j."id" = q."importJobId" AND j."organizationId" = q."organizationId" WHERE q."id" = ${req.params.id}::uuid AND q."organizationId" = ${org}::uuid`
  const quarantine = quarantineRows[0]
  if (!quarantine) return fail(res, 404, 'NOT_FOUND', 'Baris karantina tidak ditemukan.')
  if (quarantine.status !== 'OPEN') return fail(res, 409, 'INVALID_STATE', 'Baris karantina sudah diproses.')
  const quarantinePayload = quarantine.payload && typeof quarantine.payload === 'object' && !Array.isArray(quarantine.payload) ? quarantine.payload as Record<string, Prisma.JsonValue> : {}
  const sourceId = quarantine.mode === 'API_QUARANTINE' && typeof quarantinePayload.sourceId === 'string' ? quarantinePayload.sourceId : null
  if (sourceId) {
    const source = await db.integrationSource.findFirst({ where: { id: sourceId, organizationId: org }, select: { allowedMeterIds: true } })
    const allowedMeterIds = Array.isArray(source?.allowedMeterIds) ? source.allowedMeterIds : []
    if (!source || !allowedMeterIds.includes(input.meterId)) return fail(res, 422, 'VALIDATION_ERROR', 'Meter tujuan tidak termasuk cakupan sumber asal.')
  }
  const meter = await db.meter.findFirst({ where: { id: input.meterId, organizationId: org, status: { not: 'RETIRED' }, site: { status: { not: 'ARCHIVED' } } }, include: { configurationVersions: { select: { effectiveFrom: true, effectiveTo: true, multiplier: true } } } })
  if (!meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan atau sudah tidak operasional.')
  if (meter.unit !== input.unit || (meter.metric === 'ENERGY_IMPORT' && input.unit !== 'kWh') || (meter.metric === 'POWER_DEMAND' && input.unit !== 'kW')) return fail(res, 422, 'VALIDATION_ERROR', 'Unit tidak sesuai dengan konfigurasi meter.')
  const rawValue = new Prisma.Decimal(input.value), timestamp = new Date(input.timestamp), value = rawValue.mul(multiplierAt(timestamp, meter.configurationVersions, meter.multiplier))
  if (value.gte('100000000000000')) return fail(res, 422, 'VALIDATION_ERROR', 'Nilai terlalu besar setelah multiplier.')
  const released = await db.$transaction(async tx => {
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "QuarantinedReading" WHERE "id" = ${quarantine.id}::uuid AND "organizationId" = ${org}::uuid FOR UPDATE`
    if (!locked[0] || locked[0].status !== 'OPEN') return 'CONFLICT' as const
    await lockIngestionMeters(tx, org, [meter.id])
    const values = quarantinePayload.values && typeof quarantinePayload.values === 'object' && !Array.isArray(quarantinePayload.values) ? quarantinePayload.values as Record<string, Prisma.JsonValue> : {}, suppliedExternalId = typeof values.externalReadingId === 'string' ? values.externalReadingId : null
    const externalId = sourceId && suppliedExternalId ? `source:${sourceId}:${suppliedExternalId}` : readingIdentity(meter.id, timestamp, rawValue.toString(), meter.unit, sourceId ? 'csv' : 'quarantine')
    const inserted = await tx.meterReading.createMany({ data: [{ organizationId: org, meterId: meter.id, externalId, timestamp, rawValue, value, unit: meter.unit, quality: 'VALID', sourceType: sourceId ? 'API' : 'CSV', sourceId, importJobId: quarantine.importJobId }], skipDuplicates: true })
    const resolved = await tx.$queryRaw<Record<string, unknown>[]>`UPDATE "QuarantinedReading" SET "status" = 'RELEASED', "resolvedAt" = CURRENT_TIMESTAMP, "resolvedBy" = ${res.locals.user.id}::uuid WHERE "id" = ${quarantine.id}::uuid AND "organizationId" = ${org}::uuid RETURNING *`
    if (inserted.count) {
      await enqueueReadingRollups(tx, org, [{ meterId: meter.id, timestamp }])
      await promoteFreshMeters(tx, org, [{ meterId: meter.id, timestamp, quality: 'VALID' }], res.locals.user.id)
      await evaluateAlerts(tx, org, [meter.id], res.locals.user.id)
    }
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'QUARANTINED_READING_RELEASED', entity: 'QuarantinedReading', entityId: quarantine.id, details: { meterId: meter.id, duplicate: inserted.count === 0 } } })
    return { ...resolved[0], duplicate: inserted.count === 0 }
  })
  if (released === 'CONFLICT') return fail(res, 409, 'INVALID_STATE', 'Baris karantina telah diproses oleh permintaan lain.')
  return ok(res, released)
}))
api.post('/simulator/readings', auth, csrf, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ meterId: z.string().uuid(), startAt: z.string().datetime({ offset: true }), count: z.number().int().min(1).max(5000), intervalMinutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).optional(), baseValue: z.coerce.number().finite().min(0).max(1_000_000_000), amplitude: z.coerce.number().finite().min(0).max(1_000_000).default(0) }).strict().parse(req.body)
  const orgId = res.locals.user.organizationId, startAt = new Date(input.startAt)
  const meter = await db.meter.findFirst({ where: { id: input.meterId, organizationId: orgId, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}) }, include: { site: { select: { status: true } }, configurationVersions: { select: { effectiveFrom: true, effectiveTo: true, multiplier: true } } } })
  if (!meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  if (meter.site.status !== 'ACTIVE' || ['RETIRED', 'MAINTENANCE'].includes(meter.status)) return fail(res, 409, 'INVALID_STATE', 'Simulator hanya dapat menulis ke meter pada site aktif yang tidak retired atau maintenance.')
  const intervalMinutes = input.intervalMinutes ?? meter.intervalMinutes
  if (intervalMinutes !== meter.intervalMinutes) return fail(res, 422, 'VALIDATION_ERROR', 'Interval simulasi harus sama dengan konfigurasi meter.')
  if (meter.meterType === 'CUMULATIVE' && meter.metric !== 'ENERGY_IMPORT') return fail(res, 422, 'INCOMPATIBLE_METER_TYPE', 'Simulator cumulative hanya mendukung energi kWh.')
  const intervalMs = intervalMinutes * 60_000, lastAt = startAt.getTime() + (input.count - 1) * intervalMs
  if (lastAt > Date.now() + 5 * 60_000) return fail(res, 422, 'VALIDATION_ERROR', 'Waktu simulasi tidak boleh lebih dari lima menit di masa depan.')
  const rows = Array.from({ length: input.count }, (_, index) => {
    const increment = meter.meterType === 'CUMULATIVE' ? Math.max(0.000001, input.amplitude || input.baseValue * 0.01) : 0
    const raw = meter.meterType === 'CUMULATIVE' ? input.baseValue + index * increment : Math.max(0, input.baseValue + Math.sin(index * Math.PI / 6) * input.amplitude)
    const rawValue = new Prisma.Decimal(raw.toFixed(6)), timestamp = new Date(startAt.getTime() + index * intervalMs)
    return { organizationId: orgId, meterId: meter.id, externalId: readingIdentity(meter.id, timestamp, rawValue.toString(), meter.unit, 'sim'), sourceType: 'SIMULATOR', sourceId: null, importJobId: null as string | null, timestamp, rawValue, value: rawValue.mul(multiplierAt(timestamp, meter.configurationVersions, meter.multiplier)), unit: meter.unit, quality: 'VALID' }
  })
  const job = await db.$transaction(async tx => {
    const created = await tx.importJob.create({ data: { organizationId: orgId, fileName: `simulator-${meter.code}-${startAt.toISOString()}.csv`, mode: 'SIMULATOR', status: 'PROCESSING', createdBy: res.locals.user.id } })
    const toInsert = rows.map(row => ({ ...row, importJobId: created.id }))
    const result = await tx.meterReading.createMany({ data: toInsert, skipDuplicates: true })
    if (result.count) {
      await enqueueReadingRollups(tx, orgId, rows.map(row => ({ meterId: row.meterId, timestamp: row.timestamp })))
      await promoteFreshMeters(tx, orgId, rows.map(row => ({ meterId: row.meterId, timestamp: row.timestamp, quality: 'VALID' })), res.locals.user.id)
      await evaluateAlerts(tx, orgId, [meter.id], res.locals.user.id)
    }
    const completed = await tx.importJob.update({ where: { id: created.id }, data: { status: 'COMPLETED', accepted: result.count, rejected: 0, errors: { duplicates: rows.length - result.count }, completedAt: new Date() } })
    await tx.auditLog.create({ data: { organizationId: orgId, userId: res.locals.user.id, action: 'SIMULATOR_RUN_COMPLETED', entity: 'ImportJob', entityId: completed.id, details: { meterId: meter.id, generated: rows.length, accepted: result.count, duplicates: rows.length - result.count, intervalMinutes } } })
    return completed
  }, { timeout: 30_000 })
  return ok(res, job, 201)
}))
registerReadingPreviewRoutes(api, { db, auth, csrf, allowRoles, wrap, ok, fail })
api.post('/reading-imports', auth, csrf, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ fileName: z.string().min(1).max(255), csv: z.string().min(1).max(10_000_000), mode: z.enum(['VALIDATE_ONLY', 'COMMIT']), sourceId: z.string().uuid().optional() }).parse(req.body)
  if (input.sourceId && !await db.integrationSource.findFirst({ where: { id: input.sourceId, organizationId: res.locals.user.organizationId, type: 'CSV', status: 'ACTIVE' }, select: { id: true } })) return fail(res, 422, 'VALIDATION_ERROR', 'Sumber CSV tidak tersedia atau tidak aktif.')
  if (Buffer.byteLength(input.csv, 'utf8') > 10_000_000) return fail(res, 422, 'VALIDATION_ERROR', 'Ukuran CSV maksimum 10 MB.')
  let rows: Record<string, string>[]
  try { rows = parse(input.csv, { columns: (headers: string[]) => {
    if (new Set(headers).size !== headers.length || (headers.includes('value') && headers.includes('rawValue')) || !['meterCode', 'timestamp', 'unit'].every(key => headers.includes(key)) || !headers.some(key => key === 'value' || key === 'rawValue')) throw new Error('INVALID_HEADERS')
    return headers
  }, skip_empty_lines: true, bom: true, trim: true, relax_column_count: false }) }
  catch { return fail(res, 422, 'INVALID_CSV', 'Format CSV tidak valid. Gunakan header meterCode,timestamp,rawValue,unit,metric,externalReadingId.') }
  if (!rows.length || rows.length > 5000) return fail(res, 422, 'VALIDATION_ERROR', 'CSV harus berisi 1–5000 baris.')
  const orgId = res.locals.user.organizationId
  const meters = await db.meter.findMany({ where: { organizationId: orgId, code: { in: [...new Set(rows.map(r => r.meterCode).filter(Boolean))] }, status: { not: 'RETIRED' }, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}) }, include: { configurationVersions: { select: { effectiveFrom: true, effectiveTo: true, multiplier: true } } } })
  const byCode = new Map(meters.map(m => [m.code, m]))
  const errors: { row: number; message: string }[] = [], rejectedRows: { payload: Prisma.InputJsonObject; reason: string }[] = []
  const rejectRow = (rowNumber: number, row: Record<string, string>, message: string) => { errors.push({ row: rowNumber, message }); rejectedRows.push({ payload: { rowNumber, values: row }, reason: message }) }
  const valid: { meterId: string; externalId: string; timestamp: Date; rawValue: string; value: Prisma.Decimal; unit: string }[] = []
  rows.forEach((row, index) => {
    const meter = byCode.get(row.meterCode)
    const timestamp = z.string().datetime({ offset: true }).safeParse(row.timestamp)
    if (!meter) { rejectRow(index + 2, row, 'Meter tidak ditemukan atau sudah retired.'); return }
    if (!timestamp.success) { rejectRow(index + 2, row, 'Timestamp harus ISO 8601 dengan zona waktu.'); return }
    const rawValue = row.rawValue ?? row.value
    if (!/^\d{1,14}(\.\d{1,6})?$/.test(rawValue || '')) { rejectRow(index + 2, row, 'Nilai harus non-negatif dengan maksimal 14 digit bulat dan 6 desimal.'); return }
    if (row.metric && row.metric !== meter.metric) { rejectRow(index + 2, row, 'Metrik tidak sesuai konfigurasi meter.'); return }
    if (row.unit !== meter.unit) { rejectRow(index + 2, row, 'Unit tidak sesuai konfigurasi meter.'); return }
    const time = new Date(row.timestamp)
    const suppliedId = row.externalReadingId?.trim()
    const externalId = suppliedId ? (input.sourceId ? `source:${input.sourceId}:${suppliedId}` : suppliedId) : readingIdentity(meter.id, time, rawValue, row.unit, input.sourceId || undefined)
    if (externalId.length > 200) { rejectRow(index + 2, row, 'External ID terlalu panjang.'); return }
    const value = new Prisma.Decimal(rawValue).mul(multiplierAt(time, meter.configurationVersions, meter.multiplier))
    if (value.gte('100000000000000')) { rejectRow(index + 2, row, 'Nilai setelah multiplier terlalu besar.'); return }
    valid.push({ meterId: meter.id, externalId, timestamp: time, rawValue, value, unit: row.unit })
  })
  if (input.mode === 'VALIDATE_ONLY') return ok(res, { total: rows.length, valid: valid.length, rejected: errors.length, errors })
  const queue = {
    sourceId: input.sourceId || null,
    valid: valid.map(row => ({ meterId: row.meterId, externalId: row.externalId, timestamp: row.timestamp.toISOString(), rawValue: row.rawValue, value: row.value.toString(), unit: row.unit })),
    rejectedRows,
    errors
  }
  const job = await db.$transaction(async tx => {
    if (input.sourceId) {
      const source = await tx.$queryRaw<{id:string}[]>`SELECT "id" FROM "IntegrationSource" WHERE "id" = ${input.sourceId}::uuid AND "organizationId" = ${orgId}::uuid AND "type" = 'CSV' AND "status" = 'ACTIVE' FOR UPDATE`
      if (!source.length) return null
    }
    const created = await tx.importJob.create({ data: { organizationId: orgId, fileName: input.fileName, mode: input.mode, status: 'QUEUED', createdBy: res.locals.user.id, rejected: errors.length, errors: { queue } as Prisma.InputJsonValue } })
    if (input.sourceId) await tx.$executeRaw`UPDATE "ImportJob" SET "sourceId" = ${input.sourceId}::uuid WHERE "id" = ${created.id}::uuid AND "organizationId" = ${orgId}::uuid`
    return created
  })
  if (!job) return fail(res, 422, 'VALIDATION_ERROR', 'Sumber CSV tidak tersedia atau tidak aktif.')
  return ok(res, { ...job, errors: null }, 202)
}))
async function processNextImportJob() {
  const staleBefore = new Date(Date.now() - 5 * 60_000)
  await db.importJob.updateMany({ where: { status: 'PROCESSING', createdAt: { lt: staleBefore } }, data: { status: 'QUEUED' } })
  const candidate = await db.importJob.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' } })
  if (!candidate) return
  const claimed = await db.importJob.updateMany({ where: { id: candidate.id, organizationId: candidate.organizationId, status: 'QUEUED' }, data: { status: 'PROCESSING' } })
  if (!claimed.count) return
  try {
    const stored = candidate.errors && typeof candidate.errors === 'object' && !Array.isArray(candidate.errors) ? candidate.errors as Record<string, Prisma.JsonValue> : {}
    const queue = stored.queue && typeof stored.queue === 'object' && !Array.isArray(stored.queue) ? stored.queue as Record<string, Prisma.JsonValue> : {}
    const valid = Array.isArray(queue.valid) ? queue.valid as unknown as { meterId: string; externalId: string; timestamp: string; rawValue: string; value?: string; unit: string }[] : []
    const rejectedRows = Array.isArray(queue.rejectedRows) ? queue.rejectedRows as unknown as { payload: Prisma.InputJsonObject; reason: string }[] : []
    const errors = Array.isArray(queue.errors) ? queue.errors as unknown as { row: number; message: string }[] : []
    const result = await db.$transaction(async tx => {
      await lockIngestionMeters(tx, candidate.organizationId, valid.map(row => row.meterId))
      const sourceId = typeof queue.sourceId === 'string' ? queue.sourceId : null
      const meterConfigs = await tx.meter.findMany({ where: { organizationId: candidate.organizationId, id: { in: [...new Set(valid.map(row => row.meterId))] } }, select: { id: true, multiplier: true, configurationVersions: { select: { effectiveFrom: true, effectiveTo: true, multiplier: true } } } })
      const meterConfigById = new Map(meterConfigs.map(meter => [meter.id, meter]))
      const persistedRows = valid.map(row => {
        const meter = meterConfigById.get(row.meterId)
        if (!meter) throw new IngestionError('Meter impor tidak ditemukan dalam organisasi.')
        const timestamp = new Date(row.timestamp), multiplier = multiplierAt(timestamp, meter.configurationVersions, meter.multiplier), value = new Prisma.Decimal(row.rawValue).mul(multiplier)
        if (value.gte('100000000000000')) throw new IngestionError('Nilai impor terlalu besar setelah multiplier.')
        return { meterId: row.meterId, externalId: row.externalId, timestamp, rawValue: row.rawValue, value, unit: row.unit, organizationId: candidate.organizationId, quality: 'VALID' as const, sourceType: 'CSV' as const, sourceId, importJobId: candidate.id }
      })
      const inserted = await tx.meterReading.createMany({ data: persistedRows, skipDuplicates: true })
      if (inserted.count) {
        await enqueueReadingRollups(tx, candidate.organizationId, valid.map(row => ({ meterId: row.meterId, timestamp: new Date(row.timestamp) })))
        await promoteFreshMeters(tx, candidate.organizationId, valid.map(row => ({ meterId: row.meterId, timestamp: new Date(row.timestamp), quality: 'VALID' })), candidate.createdBy)
        await evaluateAlerts(tx, candidate.organizationId, valid.map(row => row.meterId), candidate.createdBy)
      }
      if (rejectedRows.length) await tx.$executeRaw`INSERT INTO "QuarantinedReading" ("id", "organizationId", "importJobId", "payload", "reason") SELECT gen_random_uuid(), ${candidate.organizationId}::uuid, ${candidate.id}::uuid, item."payload", item."reason" FROM jsonb_to_recordset(${JSON.stringify(rejectedRows)}::jsonb) AS item("payload" jsonb, "reason" text)`
      const completed = await tx.importJob.update({ where: { id: candidate.id }, data: { status: 'COMPLETED', accepted: inserted.count, rejected: errors.length, errors: { rows: errors, duplicates: valid.length - inserted.count }, completedAt: new Date() } })
      await tx.auditLog.create({ data: { organizationId: candidate.organizationId, userId: candidate.createdBy, action: 'READING_IMPORT_COMPLETED', entity: 'ImportJob', entityId: completed.id, details: { accepted: inserted.count, rejected: errors.length, duplicates: valid.length - inserted.count } } })
      await tx.webhookOutbox.create({ data: { organizationId: candidate.organizationId, event: 'reading.import.completed', payload: { importJobId: completed.id, fileName: completed.fileName, status: completed.status, accepted: completed.accepted, rejected: completed.rejected, completedAt: completed.completedAt?.toISOString() } } })
      return completed
    }, { timeout: 30_000 })
    logEvent('info', 'reading_import_completed', { jobId: result.id, organizationId: candidate.organizationId, accepted: result.accepted, rejected: result.rejected })
  } catch (error) {
    await db.importJob.update({ where: { id: candidate.id }, data: { status: 'FAILED', errors: { message: error instanceof Error ? error.message.slice(0, 500) : 'Import worker failed.' }, completedAt: new Date() } }).catch(() => undefined)
    logEvent('error', 'reading_import_failed', { jobId: candidate.id, organizationId: candidate.organizationId, error })
  }
}

api.get('/assets', auth, wrap(async (req, res) => { const query=pageQuery(req,['code','name','type','status'],'code'),where={organizationId:res.locals.user.organizationId,...(res.locals.allowedSiteIds?{siteId:{in:res.locals.allowedSiteIds}}:{}),...(query.search?{OR:[{code:{contains:query.search,mode:'insensitive' as const}},{name:{contains:query.search,mode:'insensitive' as const}},{type:{contains:query.search,mode:'insensitive' as const}}]}:{})};const [total,rows]=await Promise.all([db.asset.count({where}),db.asset.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,include:{building:true,meters:{select:{id:true,code:true,status:true,metric:true,unit:true}}},orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query)) }))
api.get('/sites/:id', auth, wrap(async (req, res) => {
  const site = await db.site.findFirst({ where: { id: req.params.id, organizationId: res.locals.user.organizationId, ...(res.locals.allowedSiteIds ? { AND: [{ id: { in: res.locals.allowedSiteIds } }] } : {}) }, include: { meters: { include: { asset: true } }, buildings: { include: { assets: true } }, manager: { select: { id: true, fullName: true, email: true } } } })
  return site ? ok(res, site) : fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
}))
api.patch('/sites/:id', auth, csrf, admin, wrap(async (req, res) => {
  const input = siteBaseSchema.partial().refine(v => !(Object.hasOwn(v, 'latitude') || Object.hasOwn(v, 'longitude')) || (Object.hasOwn(v, 'latitude') && Object.hasOwn(v, 'longitude') && (v.latitude === null) === (v.longitude === null)), { message: 'Latitude dan longitude harus diubah bersama.', path: ['longitude'] }).parse(req.body), org = res.locals.user.organizationId
  if (!Object.keys(input).length) return fail(res, 422, 'VALIDATION_ERROR', 'Tidak ada perubahan.')
  const site = await db.site.findFirst({ where: { id: req.params.id, organizationId: org } })
  if (!site) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  if (input.managerId && !await db.organizationMembership.findFirst({ where: { userId: input.managerId, organizationId: org, status: 'ACTIVE', user: { active: true } } })) return fail(res, 422, 'VALIDATION_ERROR', 'Pengelola harus anggota aktif organisasi ini.')
  const updated = await db.$transaction(async tx => {
    const item = await tx.site.update({ where: { id: site.id }, data: { ...input, operatingSchedule: input.operatingSchedule === null ? Prisma.DbNull : input.operatingSchedule as Prisma.InputJsonValue | undefined } })
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'SITE_UPDATED', entity: 'Site', entityId: item.id, details: { fields: Object.keys(input) } } })
    return item
  })
  return ok(res, updated)
}))
api.get('/meters/:id', auth, wrap(async (req, res) => {
  const meter = await db.meter.findFirst({ where: { id: req.params.id, organizationId: res.locals.user.organizationId, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}) }, include: { site: true, asset: true, configurationVersions: { orderBy: { effectiveFrom: 'desc' } } } })
  return meter ? ok(res, meter) : fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
}))
api.get('/meters/:id/configuration-history', auth, wrap(async (req, res) => {
  const org = res.locals.user.organizationId
  const meter = await db.meter.findFirst({ where: { id: req.params.id, organizationId: org, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}) }, select: { id: true } })
  if (!meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  const query=pageQuery(req,['effectiveFrom','createdAt'],'effectiveFrom'),where={organizationId:org,meterId:meter.id,...(query.search?{reason:{contains:query.search,mode:'insensitive' as const}}:{})},[total,rows]=await Promise.all([db.meterConfigVersion.count({where}),db.meterConfigVersion.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,include:{actor:{select:{id:true,fullName:true}}},orderBy:{[query.sort]:query.direction}})])
  return ok(res,pageResult(rows,total,query))
}))
const maintenanceInput = z.object({ category: z.enum(['PREVENTIVE', 'CORRECTIVE', 'CALIBRATION', 'INSPECTION']), title: z.string().trim().min(2).max(200), scheduledAt: z.string().datetime({ offset: true }).optional(), assignedTo: z.string().uuid().optional() }).strict()
api.get('/meters/:id/maintenance', auth, maintenanceRole, wrap(async (req, res) => {
  const org = res.locals.user.organizationId, meter = await db.meter.findFirst({ where: { id: req.params.id, organizationId: org, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}) }, select: { id: true } })
  if (!meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  const query=pageQuery(req,['createdAt','scheduledAt','status','title'],'scheduledAt'),where={organizationId:org,meterId:meter.id,...(hasExplicitPermission(res.locals.user,'maintenance.assigned')?{assignedTo:res.locals.user.id}:{}),...(query.search?{title:{contains:query.search,mode:'insensitive' as const}}:{})},[total,rows]=await Promise.all([db.meterMaintenance.count({where}),db.meterMaintenance.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,include:{evidence:{select:{id:true,fileName:true,contentType:true,sizeBytes:true,sha256:true,scanProvider:true,scannedAt:true,createdAt:true,uploadedBy:true}}},orderBy:{[query.sort]:query.direction}})])
  return ok(res,pageResult(rows,total,query))
}))
api.post('/meters/:id/maintenance', auth, csrf, maintenanceRole, wrap(async (req, res) => {
  const input = maintenanceInput.parse(req.body), org = res.locals.user.organizationId
  const meter = await db.meter.findFirst({ where: { id: req.params.id, organizationId: org, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}) }, select: { id: true, siteId: true, status: true } })
  if (!meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  if (meter.status === 'RETIRED') return fail(res, 409, 'INVALID_STATE', 'Meter retired tidak dapat dijadwalkan untuk pemeliharaan.')
  if (hasExplicitPermission(res.locals.user, 'maintenance.assigned') && input.assignedTo && input.assignedTo !== res.locals.user.id) return fail(res, 403, 'FORBIDDEN', 'Teknisi hanya dapat menjadwalkan pekerjaan untuk dirinya sendiri.')
  const assignedTo = input.assignedTo ?? (hasExplicitPermission(res.locals.user, 'maintenance.assigned') ? res.locals.user.id : null)
  if (assignedTo) {
    const technician = await db.organizationMembership.findFirst({ where: { userId: assignedTo, organizationId: org, status: 'ACTIVE', roleDefinition: { active: true, permissions: { some: { permission: { code: 'maintenance.assigned' } } } }, user: { active: true, siteAssignments: { some: { siteId: meter.siteId, organizationId: org } } } }, select: { id: true } })
    if (!technician) return fail(res, 422, 'VALIDATION_ERROR', 'Teknisi harus aktif dan ditugaskan pada site meter.')
  }
  const event = await db.$transaction(async tx => {
    const created = await tx.meterMaintenance.create({ data: { organizationId: org, meterId: meter.id, category: input.category, title: input.title, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, assignedTo, createdBy: res.locals.user.id } })
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'METER_MAINTENANCE_SCHEDULED', entity: 'MeterMaintenance', entityId: created.id, details: { meterId: meter.id, category: input.category } } })
    return created
  })
  return ok(res, event, 201)
}))
api.patch('/meter-maintenance/:id/status', auth, csrf, maintenanceRole, wrap(async (req, res) => {
  const input = z.object({ status: z.enum(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']), workNotes: z.string().trim().min(2).max(4000).optional(), outcome: z.string().trim().min(2).max(4000).optional() }).strict().refine(v => v.status !== 'COMPLETED' || !!v.outcome, { path: ['outcome'], message: 'Hasil pekerjaan wajib diisi saat menyelesaikan pemeliharaan.' }).parse(req.body)
  const org = res.locals.user.organizationId
  if (hasExplicitPermission(res.locals.user, 'maintenance.assigned') && !await db.meterMaintenance.findFirst({ where: { id: req.params.id, organizationId: org, assignedTo: res.locals.user.id }, select: { id: true } })) return fail(res, 404, 'NOT_FOUND', 'Pemeliharaan tidak ditugaskan kepada teknisi ini.')
  const updated = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string; meterId: string; status: string; meterStatus: string }[]>`SELECT mm."id", mm."meterId", mm."status", m."status" AS "meterStatus" FROM "MeterMaintenance" mm JOIN "Meter" m ON m."id" = mm."meterId" AND m."organizationId" = mm."organizationId" WHERE mm."id" = ${req.params.id}::uuid AND mm."organizationId" = ${org}::uuid FOR UPDATE OF mm, m`
    const item = rows[0]
    if (!item) return 'NOT_FOUND' as const
    const allowed: Record<string, string[]> = { SCHEDULED: ['IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['COMPLETED'] }
    if (!allowed[item.status]?.includes(input.status)) return 'CONFLICT' as const
    if (input.status === 'IN_PROGRESS' && !['ONLINE', 'OFFLINE'].includes(item.meterStatus)) return 'METER_STATE' as const
    if (input.status === 'COMPLETED' && item.meterStatus !== 'MAINTENANCE') return 'METER_STATE' as const
    const timestamp = new Date()
    const event = await tx.meterMaintenance.update({ where: { id: item.id }, data: { status: input.status, ...(input.status === 'IN_PROGRESS' ? { startedAt: timestamp } : {}), ...(input.status === 'COMPLETED' || input.status === 'CANCELLED' ? { completedAt: timestamp } : {}), workNotes: input.workNotes ?? undefined, outcome: input.outcome ?? undefined } })
    if (input.status === 'IN_PROGRESS') await tx.meter.update({ where: { id: item.meterId }, data: { status: 'MAINTENANCE' } })
    if (input.status === 'COMPLETED') await tx.meter.update({ where: { id: item.meterId }, data: { status: 'TESTING' } })
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'METER_MAINTENANCE_STATUS_CHANGED', entity: 'MeterMaintenance', entityId: event.id, details: { from: item.status, to: event.status, meterId: item.meterId, outcome: input.outcome ?? null } } })
    return event
  })
  if (updated === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Pemeliharaan tidak ditemukan.')
  if (updated === 'CONFLICT') return fail(res, 409, 'INVALID_STATE', 'Transisi pemeliharaan tidak diizinkan.')
  if (updated === 'METER_STATE') return fail(res, 409, 'INVALID_STATE', 'Status meter tidak cocok untuk transisi pemeliharaan.')
  return ok(res, updated)
}))
function maintenanceEvidencePath(organizationId: string, maintenanceId: string, evidenceId: string, extension: string) {
  const root = resolve(process.env.MAINTENANCE_EVIDENCE_STORAGE_DIR || process.env.AUDIT_EVIDENCE_STORAGE_DIR || 'private/maintenance-evidence')
  const file = resolve(root, organizationId, maintenanceId, `${evidenceId}.${extension}`)
  const rel = relative(root, file)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('INVALID_EVIDENCE_PATH')
  return file
}
api.post('/meter-maintenance/:id/evidence', auth, csrf, maintenanceRole, wrap(async (req, res) => {
  const input = z.object({ fileName: z.string().trim().min(1).max(180), contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']), contentBase64: z.string().min(4).max(7_000_000) }).strict().safeParse(req.body)
  if (!input.success) return fail(res, 422, 'VALIDATION_ERROR', 'Nama file, MIME type, atau isi file tidak valid.')
  const normalizedName = basename(input.data.fileName).normalize('NFC')
  if (normalizedName !== input.data.fileName.trim() || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,159}$/u.test(normalizedName) || normalizedName.includes('..')) return fail(res, 422, 'VALIDATION_ERROR', 'Nama file tidak valid.')
  const content = Buffer.from(input.data.contentBase64, 'base64')
  if (!content.length || content.length > 5 * 1024 * 1024 || content.toString('base64') !== input.data.contentBase64 || !evidenceBytesMatch(input.data.contentType, content)) return fail(res, 422, 'VALIDATION_ERROR', 'Ukuran atau signature file tidak valid.')
  const org = res.locals.user.organizationId
  const maintenance = await db.meterMaintenance.findFirst({ where: { id: req.params.id, organizationId: org, ...(res.locals.allowedSiteIds ? { meter: { siteId: { in: res.locals.allowedSiteIds } } } : {}), ...(hasExplicitPermission(res.locals.user, 'maintenance.assigned') ? { assignedTo: res.locals.user.id } : {}) }, select: { id: true, status: true } })
  if (!maintenance) return fail(res, 404, 'NOT_FOUND', 'Pemeliharaan tidak ditemukan.')
  if (!['IN_PROGRESS', 'COMPLETED'].includes(maintenance.status)) return fail(res, 409, 'INVALID_STATE', 'Bukti hanya dapat dilampirkan pada pemeliharaan yang dimulai atau selesai.')
  let scan: { provider: string; scanId: string | null }
  try { scan = await scanEvidence({ fileName: normalizedName, contentType: input.data.contentType, content }) }
  catch (error) {
    const code = error instanceof Error ? error.message : 'EVIDENCE_SCANNER_UNAVAILABLE'
    if (code === 'EVIDENCE_MALWARE_DETECTED') return fail(res, 422, code, 'Pemindai menolak file karena terdeteksi malware.')
    return fail(res, 503, code === 'EVIDENCE_SCANNER_NOT_CONFIGURED' ? code : 'EVIDENCE_SCANNER_UNAVAILABLE', 'Pemindai bukti tidak tersedia atau belum dikonfigurasi.')
  }
  const id = randomUUID(), extension = evidenceExtension(input.data.contentType), storageKey = `${org}/${maintenance.id}/${id}.${extension}`, file = maintenanceEvidencePath(org, maintenance.id, id, extension), temp = maintenanceEvidencePath(org, maintenance.id, `${id}.${randomUUID()}`, 'tmp')
  if (objectStorageConfigured) await objectStorage.put(storageKey, content, input.data.contentType)
  else { await mkdir(dirname(file), { recursive: true }); await writeFile(temp, content, { flag: 'wx', mode: 0o600 }); try { await rename(temp, file) } catch (error) { await unlink(temp).catch(() => undefined); throw error } }
  try {
    const result = await db.$transaction(async tx => {
      const evidence = await tx.maintenanceEvidence.create({ data: { id, organizationId: org, maintenanceId: maintenance.id, uploadedBy: res.locals.user.id, fileName: normalizedName, contentType: input.data.contentType, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), storageKey: `${objectStorageConfigured ? 's3:' : ''}${storageKey}`, scanProvider: scan.provider, scanId: scan.scanId, scannedAt: new Date() }, select: { id: true, maintenanceId: true, fileName: true, contentType: true, sizeBytes: true, sha256: true, scanProvider: true, scannedAt: true, createdAt: true, uploadedBy: true } })
      await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'MAINTENANCE_EVIDENCE_UPLOADED', entity: 'MaintenanceEvidence', entityId: evidence.id, details: { maintenanceId: maintenance.id, fileName: normalizedName, contentType: input.data.contentType, sizeBytes: content.length, sha256: evidence.sha256, scanProvider: scan.provider, scanId: scan.scanId } } })
      return evidence
    })
    return ok(res, result, 201)
  } catch (error) { if (objectStorageConfigured) await objectStorage.delete(storageKey).catch(() => undefined); else await unlink(file).catch(() => undefined); throw error }
}))
api.get('/meter-maintenance/:id/evidence/:evidenceId', auth, maintenanceRole, wrap(async (req, res) => {
  const org = res.locals.user.organizationId
  const evidence = await db.maintenanceEvidence.findFirst({ where: { id: req.params.evidenceId, maintenanceId: req.params.id, organizationId: org, ...(hasExplicitPermission(res.locals.user, 'maintenance.assigned') ? { maintenance: { assignedTo: res.locals.user.id } } : {}) } })
  if (!evidence) return fail(res, 404, 'NOT_FOUND', 'Bukti pemeliharaan tidak ditemukan.')
  const file = maintenanceEvidencePath(org, evidence.maintenanceId, evidence.id, evidenceExtension(evidence.contentType)), content = evidence.storageKey.startsWith('s3:') ? await objectStorage.get(evidence.storageKey.slice(3)) : await readFile(file)
  res.setHeader('Content-Type', evidence.contentType); res.setHeader('Content-Length', content.length); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(evidence.fileName)}`); res.setHeader('X-Content-Type-Options', 'nosniff')
  return res.status(200).send(content)
}))
api.post('/meters/:id/configuration-versions', auth, csrf, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ sourceType: z.enum(['MANUAL', 'CSV', 'API', 'SIMULATOR', 'MQTT']), intervalMinutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]), multiplier: z.coerce.number().positive().max(1_000_000), rolloverValue: rolloverValueSchema.nullable().optional(), effectiveFrom: z.string().datetime({ offset: true }), reason: z.string().trim().min(2).max(1000) }).strict().parse(req.body)
  const org = res.locals.user.organizationId, effectiveFrom = new Date(input.effectiveFrom)
  if (effectiveFrom > new Date()) return fail(res, 422, 'VALIDATION_ERROR', 'Perubahan konfigurasi harus berlaku sekarang atau pada waktu sebelumnya.')
  const result = await db.$transaction(async tx => {
    const meters = await tx.$queryRaw<{ id: string; meterType: string; metric: string; unit: string; status: string; multiplier: Prisma.Decimal; rolloverValue: Prisma.Decimal | null }[]>`SELECT "id", "meterType", "metric", "unit", "status", "multiplier", "rolloverValue" FROM "Meter" WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${org}::uuid FOR UPDATE`
    const meter = meters[0]
    if (!meter) return 'NOT_FOUND' as const
    if (meter.status === 'RETIRED') return 'RETIRED' as const
    const latest = await tx.meterConfigVersion.findFirst({ where: { organizationId: org, meterId: meter.id }, orderBy: { effectiveFrom: 'desc' } })
    if (latest && effectiveFrom <= latest.effectiveFrom) return 'CONFLICT' as const
    if (latest) await tx.meterConfigVersion.update({ where: { id: latest.id }, data: { effectiveTo: new Date(effectiveFrom.getTime() - 1) } })
    const rolloverValue = input.rolloverValue === undefined ? meter.rolloverValue : input.rolloverValue
    if (rolloverValue !== null && !(meter.meterType === 'CUMULATIVE' && meter.metric === 'ENERGY_IMPORT')) return 'ROLLOVER_NOT_SUPPORTED' as const
    const versions = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "MeterConfigVersion" ("id", "organizationId", "meterId", "meterType", "metric", "unit", "sourceType", "intervalMinutes", "multiplier", "rolloverValue", "effectiveFrom", "createdBy", "reason") VALUES (gen_random_uuid(), ${org}::uuid, ${meter.id}::uuid, ${meter.meterType}, ${meter.metric}, ${meter.unit}, ${input.sourceType}, ${input.intervalMinutes}, ${input.multiplier}, ${rolloverValue}::numeric, ${effectiveFrom}, ${res.locals.user.id}::uuid, ${input.reason}) RETURNING "id"`
    await tx.$executeRaw`UPDATE "Meter" SET "sourceType" = ${input.sourceType}, "intervalMinutes" = ${input.intervalMinutes}, "multiplier" = ${input.multiplier}, "rolloverValue" = ${rolloverValue}::numeric WHERE "id" = ${meter.id}::uuid AND "organizationId" = ${org}::uuid`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'METER_CONFIGURATION_CHANGED', entity: 'MeterConfigVersion', entityId: versions[0].id, details: { meterId: meter.id, effectiveFrom: effectiveFrom.toISOString(), reason: input.reason, rolloverValue: rolloverValue?.toString() ?? null } } })
    return { id: versions[0].id, meterId: meter.id, effectiveFrom, reason: input.reason, rolloverValue: rolloverValue?.toString() ?? null }
  })
  if (result === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  if (result === 'RETIRED') return fail(res, 409, 'INVALID_STATE', 'Meter retired tidak dapat dikonfigurasi.')
  if (result === 'CONFLICT') return fail(res, 409, 'CONFLICT', 'Waktu efektif harus lebih baru dari konfigurasi terakhir.')
  if (result === 'ROLLOVER_NOT_SUPPORTED') return fail(res, 422, 'VALIDATION_ERROR', 'Rollover hanya dapat dipakai untuk meter energi kumulatif.')
  return ok(res, result, 201)
}))
api.patch('/meters/:id/status', auth, csrf, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ status: z.enum(['PENDING', 'TESTING', 'ONLINE', 'OFFLINE', 'MAINTENANCE', 'RETIRED']) }).parse(req.body)
  const org = res.locals.user.organizationId
  const meter = await db.meter.findFirst({ where: { id: req.params.id, organizationId: org } })
  if (!meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  // ONLINE/OFFLINE must be derived from ingestion health, not a manual status change.
  const allowed: Record<string, string[]> = { PENDING: ['TESTING'], TESTING: ['PENDING'], ONLINE: ['MAINTENANCE', 'RETIRED'], OFFLINE: ['MAINTENANCE', 'RETIRED'], MAINTENANCE: ['TESTING'] }
  if (!allowed[meter.status]?.includes(input.status)) return fail(res, 409, 'INVALID_STATE', 'Perubahan status meter tidak diizinkan atau memerlukan pemeriksaan otomatis.')
  const count = await db.$transaction(async tx => {
    const result = await tx.meter.updateMany({ where: { id: meter.id, organizationId: org, status: meter.status }, data: { status: input.status } })
    if (result.count) await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'METER_STATUS_CHANGED', entity: 'Meter', entityId: meter.id, details: { from: meter.status, to: input.status } } })
    return result.count
  })
  if (!count) return fail(res, 409, 'INVALID_STATE', 'Status meter telah berubah. Muat ulang.')
  return ok(res, await db.meter.findUnique({ where: { id: meter.id }, include: { site: true } }))
}))
api.get('/assets/:id', auth, wrap(async (req, res) => {
  const asset = await db.asset.findFirst({ where: { id: req.params.id, organizationId: res.locals.user.organizationId, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}) }, include: { building: true, meters: { include: { site: { select: { name: true, timezone: true } }, readings: { where: { quality: 'VALID' }, orderBy: { timestamp: 'desc' }, take: 1, select: { timestamp: true, value: true, unit: true, quality: true } } } } } })
  if (!asset) return fail(res, 404, 'NOT_FOUND', 'Aset tidak ditemukan.')
  const site = await db.site.findFirst({ where: { id: asset.siteId, organizationId: asset.organizationId }, select: { id: true, name: true, timezone: true, status: true } })
  return ok(res, { ...asset, site })
}))
const assetSchema = z.object({ siteId: z.string().uuid(), buildingId: z.string().uuid().optional(), code: z.string().trim().min(1).max(100), name: z.string().trim().min(2).max(200), type: z.string().trim().min(2).max(100), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE') })
api.post('/assets', auth, csrf, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
  const input = assetSchema.parse(req.body), orgId = res.locals.user.organizationId
  const site = await db.site.findFirst({ where: { id: input.siteId, organizationId: orgId, status: { not: 'ARCHIVED' } } })
  if (!site) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  if (input.buildingId) {
    const building = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Building" WHERE "id" = ${input.buildingId}::uuid AND "organizationId" = ${orgId}::uuid AND "siteId" = ${input.siteId}::uuid AND "status" = 'ACTIVE'`
    if (!building.length) return fail(res, 422, 'VALIDATION_ERROR', 'Gedung harus aktif dan berada pada site yang dipilih.')
  }
  const { buildingId, ...base } = input
  const asset = await db.$transaction(async tx => {
    const created = await tx.asset.create({ data: { ...base, organizationId: orgId } })
    await tx.$executeRaw`UPDATE "Asset" SET "buildingId" = ${buildingId ?? null}::uuid WHERE "id" = ${created.id}::uuid AND "organizationId" = ${orgId}::uuid`
    await tx.auditLog.create({ data: { organizationId: orgId, userId: res.locals.user.id, action: 'ASSET_CREATED', entity: 'Asset', entityId: created.id, details: { buildingId: buildingId ?? null } } })
    return { ...created, buildingId: buildingId ?? null }
  })
  return ok(res, asset, 201)
}))
api.patch('/assets/:id', auth, csrf, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(200).optional(), type: z.string().trim().min(2).max(100).optional(), status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(), buildingId: z.string().uuid().nullable().optional() }).strict().parse(req.body), org = res.locals.user.organizationId
  if (!Object.keys(input).length) return fail(res, 422, 'VALIDATION_ERROR', 'Tidak ada perubahan.')
  const result = await db.$transaction(async tx => {
    const assets = await tx.$queryRaw<{ id: string; siteId: string; status: string }[]>`SELECT a."id", a."siteId", a."status" FROM "Asset" a JOIN "Site" s ON s."id" = a."siteId" AND s."organizationId" = a."organizationId" WHERE a."id" = ${req.params.id}::uuid AND a."organizationId" = ${org}::uuid AND s."status" <> 'ARCHIVED' FOR UPDATE OF a`
    if (!assets[0]) return 'NOT_FOUND' as const
    if (assets[0].status === 'ARCHIVED' && input.status !== 'ARCHIVED') return 'ARCHIVED' as const
    if (input.buildingId) {
      const building = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Building" WHERE "id" = ${input.buildingId}::uuid AND "organizationId" = ${org}::uuid AND "siteId" = ${assets[0].siteId}::uuid AND "status" = 'ACTIVE'`
      if (!building.length) return 'INVALID_BUILDING' as const
    }
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`UPDATE "Asset" SET "name" = COALESCE(${input.name ?? null}, "name"), "type" = COALESCE(${input.type ?? null}, "type"), "status" = COALESCE(${input.status ?? null}, "status"), "buildingId" = CASE WHEN ${Object.hasOwn(input, 'buildingId')} THEN ${input.buildingId ?? null}::uuid ELSE "buildingId" END WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${org}::uuid RETURNING *`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'ASSET_UPDATED', entity: 'Asset', entityId: req.params.id, details: { fields: Object.keys(input) } } })
    return rows[0]
  })
  if (result === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Aset tidak ditemukan.')
  if (result === 'ARCHIVED') return fail(res, 409, 'INVALID_STATE', 'Aset yang diarsipkan tidak dapat diubah kembali.')
  if (result === 'INVALID_BUILDING') return fail(res, 422, 'VALIDATION_ERROR', 'Gedung harus aktif dan berada pada site aset.')
  return ok(res, result)
}))
const alertSiteScope = (ids?: string[]) => !ids ? Prisma.empty : ids.length ? Prisma.sql`AND EXISTS (SELECT 1 FROM "Meter" m WHERE m."id" = a."meterId" AND m."organizationId" = a."organizationId" AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))}))` : Prisma.sql`AND FALSE`
api.get('/alerts', auth, wrap(async (req, res) => {const query=pageQuery(req,['triggeredAt','status'],'triggeredAt'),filter=z.object({status:z.enum(['OPEN','ACKNOWLEDGED','INVESTIGATING','RESOLVED','FALSE_POSITIVE']).optional(),severity:z.enum(['LOW','MEDIUM','HIGH','CRITICAL']).optional()}).parse(req.query),org=res.locals.user.organizationId,search=query.search?Prisma.sql`AND (a."message" ILIKE ${`%${query.search}%`} OR a."status" ILIKE ${`%${query.search}%`})`:Prisma.empty,status=filter.status?Prisma.sql`AND a."status"=${filter.status}`:Prisma.empty,severity=filter.severity?Prisma.sql`AND r."severity"=${filter.severity}`:Prisma.empty,where=Prisma.sql`FROM "Alert" a JOIN "AlertRule" r ON r."id"=a."ruleId" AND r."organizationId"=a."organizationId" WHERE a."organizationId"=${org}::uuid ${alertSiteScope(res.locals.allowedSiteIds)} ${search} ${status} ${severity}`;const [counts,rows]=await Promise.all([db.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*)::bigint ${where}`),db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`SELECT a.*,to_jsonb(r) AS "rule" ${where} ORDER BY ${Prisma.raw(`a."${query.sort}" ${query.direction.toUpperCase()}`)} LIMIT ${query.requested?query.pageSize:1000} OFFSET ${query.requested?(query.page-1)*query.pageSize:0}`)]);return ok(res,pageResult(rows,Number(counts[0]?.count||0),query))}))
api.get('/alerts/:id', auth, wrap(async (req, res) => {
  const rows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT a.*, to_jsonb(r) AS "rule" FROM "Alert" a JOIN "AlertRule" r ON r."id" = a."ruleId" AND r."organizationId" = a."organizationId" WHERE a."id" = ${req.params.id}::uuid AND a."organizationId" = ${res.locals.user.organizationId}::uuid ${alertSiteScope(res.locals.allowedSiteIds)}`)
  const alert = rows[0]
  if (!alert) return fail(res, 404, 'NOT_FOUND', 'Alert tidak ditemukan.')
  const events = await db.auditLog.findMany({ where: { organizationId: res.locals.user.organizationId, entity: 'Alert', entityId: req.params.id }, orderBy: { createdAt: 'asc' } })
  return ok(res, { ...alert, events })
}))
api.post('/alerts/:id/transition', auth, csrf, wrap(async (req, res) => {
  const input = z.object({ status: z.enum(['ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE']), note: z.string().trim().max(2000).optional() }).refine(v => !['RESOLVED', 'FALSE_POSITIVE'].includes(v.status) || !!v.note, { path: ['note'], message: 'Catatan penyelesaian diperlukan.' }).parse(req.body)
  if ((input.status === 'ACKNOWLEDGED' && !hasPermission(res.locals.user, 'alert.acknowledge')) || (input.status === 'INVESTIGATING' && !hasPermission(res.locals.user, 'alert.investigate')) || (['RESOLVED', 'FALSE_POSITIVE'].includes(input.status) && !hasPermission(res.locals.user, 'alert.acknowledge'))) return fail(res, 403, 'FORBIDDEN', 'Permission tidak cukup untuk perubahan ini.')
  const org = res.locals.user.organizationId
  const alert = await db.alert.findFirst({ where: { id: req.params.id, organizationId: org } })
  if (!alert) return fail(res, 404, 'NOT_FOUND', 'Alert tidak ditemukan.')
  const transitions: Record<string, string[]> = { OPEN: ['ACKNOWLEDGED'], ACKNOWLEDGED: ['INVESTIGATING'], INVESTIGATING: ['RESOLVED', 'FALSE_POSITIVE'] }
  if (!transitions[alert.status]?.includes(input.status)) return fail(res, 409, 'INVALID_STATE', 'Perubahan status tidak diizinkan.')
  const updated = await db.$transaction(async tx => {
    if (res.locals.user.scope !== 'ORGANIZATION') {
      const assignment = await tx.$queryRaw<{ id: string }[]>`SELECT sa."id" FROM "SiteAssignment" sa JOIN "Meter" m ON m."siteId" = sa."siteId" AND m."organizationId" = sa."organizationId" JOIN "Alert" a ON a."meterId" = m."id" AND a."organizationId" = m."organizationId" WHERE sa."organizationId" = ${org}::uuid AND sa."userId" = ${res.locals.user.id}::uuid AND a."id" = ${alert.id}::uuid FOR SHARE OF sa`
      if (!assignment.length) return -1
    }
    const result = await tx.alert.updateMany({ where: { id: alert.id, organizationId: org, status: alert.status }, data: { status: input.status, resolvedAt: ['RESOLVED', 'FALSE_POSITIVE'].includes(input.status) ? new Date() : null } })
    if (result.count) { await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'ALERT_STATUS_CHANGED', entity: 'Alert', entityId: alert.id, details: { from: alert.status, to: input.status, note: input.note || null } } }); await tx.webhookOutbox.create({data:{organizationId:org,event:'alert.updated',payload:{alertId:alert.id,from:alert.status,to:input.status,note:input.note||null,updatedAt:new Date().toISOString()}}}) }
    return result.count
  })
  if (updated === -1) return fail(res, 404, 'NOT_FOUND', 'Alert tidak ditemukan.')
  if (!updated) return fail(res, 409, 'INVALID_STATE', 'Status alert telah berubah. Muat ulang.')
  return ok(res, await db.alert.findUnique({ where: { id: alert.id } }))
}))
api.get('/notification-preferences', auth, wrap(async (_req, res) => {
  const user = res.locals.user
  const preference = await db.notificationPreference.findUnique({ where: { userId: user.id }, select: { inAppEnabled: true, emailEnabled: true, updatedAt: true } })
  return ok(res, preference ?? { inAppEnabled: true, emailEnabled: false, updatedAt: null })
}))
api.patch('/notification-preferences', auth, csrf, wrap(async (req, res) => {
  const input = z.object({ inAppEnabled: z.boolean().optional(), emailEnabled: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0, 'Atur setidaknya satu preferensi.').parse(req.body)
  const user = res.locals.user
  const preference = await db.$transaction(async tx => {
    const saved = await tx.notificationPreference.upsert({ where: { userId: user.id }, create: { organizationId: user.organizationId, userId: user.id, ...input }, update: input, select: { inAppEnabled: true, emailEnabled: true, updatedAt: true } })
    await tx.auditLog.create({ data: { organizationId: user.organizationId, userId: user.id, action: 'NOTIFICATION_PREFERENCES_UPDATED', entity: 'User', entityId: user.id, details: input } })
    return saved
  })
  return ok(res, preference)
}))
api.get('/notification-deliveries', auth, wrap(async (req, res) => {
  const query=pageQuery(req,['createdAt','status','channel'],'createdAt'),user = res.locals.user,where={organizationId:user.organizationId,userId:user.id,...(query.search?{status:{contains:query.search,mode:'insensitive' as const}}:{})}
  const [total,rows]=await Promise.all([db.notificationDelivery.count({where}),db.notificationDelivery.findMany({where,orderBy:{[query.sort]:query.direction},skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:100,include:{alert:{select:{id:true,message:true,status:true,triggeredAt:true,meterId:true}}}})])
  return ok(res,pageResult(rows,total,query))
}))
api.get('/alert-rules', auth, wrap(async (req, res) => {
  const query=pageQuery(req,['createdAt','name','metric','severity','active'],'createdAt'),org=res.locals.user.organizationId,ids:string[]|undefined=res.locals.allowedSiteIds
  const scope=ids?(ids.length?Prisma.sql`AND ("scopeType"='ORGANIZATION' OR ("scopeType"='SITE' AND "scopeId" IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))})) OR ("scopeType"='METER' AND EXISTS (SELECT 1 FROM "Meter" m WHERE m."id"="AlertRule"."scopeId" AND m."organizationId"="AlertRule"."organizationId" AND m."siteId" IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}))))`:Prisma.sql`AND "scopeType"='ORGANIZATION'`):Prisma.empty
  const search=query.search?Prisma.sql`AND ("name" ILIKE ${`%${query.search}%`} OR "metric" ILIKE ${`%${query.search}%`} OR "severity" ILIKE ${`%${query.search}%`})`:Prisma.empty,where=Prisma.sql`FROM "AlertRule" WHERE "organizationId"=${org}::uuid ${scope} ${search}`
  const counts=await db.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*)::bigint ${where}`),rows=await db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`SELECT * ${where} ORDER BY ${Prisma.raw(`"${query.sort}" ${query.direction.toUpperCase()}`)} LIMIT ${query.requested?query.pageSize:1000} OFFSET ${query.requested?(query.page-1)*query.pageSize:0}`)
  return ok(res,pageResult(rows,Number(counts[0]?.count||0),query))
}))
api.post('/alert-rules', auth, csrf, admin, wrap(async (req, res) => {
  const decimal = z.union([z.string(), z.number()]).transform(String).refine(v => /^\d{1,14}(\.\d{1,4})?$/.test(v), 'Nilai ambang tidak valid.')
  const input = z.object({ name: z.string().trim().min(2).max(150), scopeType: z.enum(['SITE', 'METER']), scopeId: z.string().uuid(), metric: z.enum(['ENERGY_IMPORT', 'POWER_DEMAND']), operator: z.enum(['GT', 'LT', 'OUTSIDE_RANGE']), threshold: decimal, thresholdMax: decimal.optional(), windowMinutes: z.number().int().min(1).max(1440), cooldownMinutes: z.number().int().min(0).max(10080), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), channels: z.array(z.enum(['IN_APP', 'EMAIL'])).min(1).max(2).refine(values => new Set(values).size === values.length, 'Kanal notifikasi tidak boleh duplikat.'), assigneeId: z.string().uuid().optional() }).refine(v => v.operator !== 'OUTSIDE_RANGE' || (v.thresholdMax !== undefined && new Prisma.Decimal(v.thresholdMax).gt(v.threshold)), { path: ['thresholdMax'], message: 'Ambang maksimum harus lebih besar dari minimum.' }).parse(req.body)
  const org = res.locals.user.organizationId
  const scope = input.scopeType === 'SITE' ? await db.site.findFirst({ where: { id: input.scopeId, organizationId: org }, select: { id: true } }) : await db.meter.findFirst({ where: { id: input.scopeId, organizationId: org, metric: input.metric }, select: { siteId: true } })
  if (!scope) return fail(res, 404, 'NOT_FOUND', 'Site atau meter dengan metrik tersebut tidak ditemukan.')
  const siteId = 'siteId' in scope ? scope.siteId : scope.id
  if (input.assigneeId) {
    const assignee = await db.organizationMembership.findFirst({ where: { userId: input.assigneeId, organizationId: org, status: 'ACTIVE', user: { active: true } }, include: { roleDefinition: true } })
    if (!assignee) return fail(res, 422, 'VALIDATION_ERROR', 'Penanggung jawab tidak valid.')
    if (assignee.roleDefinition.scope !== 'ORGANIZATION') {
      const assigned = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "SiteAssignment" WHERE "organizationId" = ${org}::uuid AND "userId" = ${assignee.userId}::uuid AND "siteId" = ${siteId}::uuid LIMIT 1`
      if (!assigned.length) return fail(res, 422, 'VALIDATION_ERROR', 'Penanggung jawab tidak ditugaskan ke site.')
    }
  }
  const id = randomUUID()
  await db.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO "AlertRule" ("id", "organizationId", "name", "metric", "threshold", "severity", "scopeType", "scopeId", "operator", "thresholdMax", "windowMinutes", "cooldownMinutes", "channels", "assigneeId") VALUES (${id}::uuid, ${org}::uuid, ${input.name}, ${input.metric}, ${input.threshold}::numeric, ${input.severity}, ${input.scopeType}, ${input.scopeId}::uuid, ${input.operator}, ${input.thresholdMax ?? null}::numeric, ${input.windowMinutes}, ${input.cooldownMinutes}, ${JSON.stringify(input.channels)}::jsonb, ${input.assigneeId ?? null}::uuid)`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'ALERT_RULE_CREATED', entity: 'AlertRule', entityId: id, details: { scopeType: input.scopeType, scopeId: input.scopeId, metric: input.metric } } })
  })
  return ok(res, { id, ...input }, 201)
}))
api.get('/audit-logs', auth, allowRoles('ADMIN', 'AUDITOR'), wrap(async (req, res) => {
  const query=pageQuery(req,['createdAt','action','entity','userId'],'createdAt'),org = res.locals.user.organizationId, ids: string[] | undefined = res.locals.allowedSiteIds
  const scoped = ids ? (ids.length ? Prisma.sql`AND EXISTS (
    SELECT 1 FROM (
      SELECT 'Site'::text AS "entity", s."id"::text AS "entityId" FROM "Site" s WHERE s."organizationId" = ${org}::uuid AND s."id" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'Building', b."id"::text FROM "Building" b WHERE b."organizationId" = ${org}::uuid AND b."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'Asset', x."id"::text FROM "Asset" x WHERE x."organizationId" = ${org}::uuid AND x."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'Meter', m."id"::text FROM "Meter" m WHERE m."organizationId" = ${org}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'MeterReading', r."id"::text FROM "MeterReading" r JOIN "Meter" m ON m."id" = r."meterId" AND m."organizationId" = r."organizationId" WHERE r."organizationId" = ${org}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'MeterConfigVersion', v."id"::text FROM "MeterConfigVersion" v JOIN "Meter" m ON m."id" = v."meterId" AND m."organizationId" = v."organizationId" WHERE v."organizationId" = ${org}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'MeterMaintenance', mm."id"::text FROM "MeterMaintenance" mm JOIN "Meter" m ON m."id" = mm."meterId" AND m."organizationId" = mm."organizationId" WHERE mm."organizationId" = ${org}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'MaintenanceEvidence', me."id"::text FROM "MaintenanceEvidence" me JOIN "MeterMaintenance" mm ON mm."id" = me."maintenanceId" AND mm."organizationId" = me."organizationId" JOIN "Meter" m ON m."id" = mm."meterId" AND m."organizationId" = mm."organizationId" WHERE me."organizationId" = ${org}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'EnergyAudit', e."id"::text FROM "EnergyAudit" e WHERE e."organizationId" = ${org}::uuid AND e."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'AuditEvidence', ae."id"::text FROM "AuditEvidence" ae JOIN "EnergyAudit" e ON e."id" = ae."auditId" AND e."organizationId" = ae."organizationId" WHERE ae."organizationId" = ${org}::uuid AND e."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'AuditFinding', f."id"::text FROM "AuditFinding" f JOIN "EnergyAudit" e ON e."id" = f."auditId" WHERE e."organizationId" = ${org}::uuid AND e."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'CorrectiveAction', ca."id"::text FROM "CorrectiveAction" ca JOIN "AuditFinding" f ON f."id" = ca."findingId" JOIN "EnergyAudit" e ON e."id" = f."auditId" WHERE e."organizationId" = ${org}::uuid AND e."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'ReadingRevision', rr."id"::text FROM "ReadingRevision" rr JOIN "MeterReading" r ON r."id" = rr."readingId" AND r."organizationId" = rr."organizationId" JOIN "Meter" m ON m."id" = r."meterId" AND m."organizationId" = r."organizationId" WHERE rr."organizationId" = ${org}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'TariffAssignment', ta."id"::text FROM "TariffAssignment" ta JOIN "Meter" m ON m."id" = ta."meterId" AND m."organizationId" = ta."organizationId" WHERE ta."organizationId" = ${org}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'Baseline', b."id"::text FROM "Baseline" b WHERE b."organizationId" = ${org}::uuid AND b."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'EnergyTarget', t."id"::text FROM "EnergyTarget" t WHERE t."organizationId" = ${org}::uuid AND t."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'ForecastRun', fr."id"::text FROM "ForecastRun" fr WHERE fr."organizationId" = ${org}::uuid AND fr."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'AlertRule', ar."id"::text FROM "AlertRule" ar WHERE ar."organizationId" = ${org}::uuid AND ((ar."scopeType" = 'SITE' AND ar."scopeId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})) OR (ar."scopeType" = 'METER' AND ar."scopeId" IN (SELECT m."id" FROM "Meter" m WHERE m."organizationId" = ${org}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))}))))
      UNION ALL SELECT 'NotificationDelivery', nd."id"::text FROM "NotificationDelivery" nd JOIN "Alert" al ON al."id" = nd."alertId" AND al."organizationId" = nd."organizationId" JOIN "Meter" m ON m."id" = al."meterId" AND m."organizationId" = al."organizationId" WHERE nd."organizationId" = ${org}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'Alert', al."id"::text FROM "Alert" al JOIN "Meter" m ON m."id" = al."meterId" AND m."organizationId" = al."organizationId" WHERE al."organizationId" = ${org}::uuid AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION ALL SELECT 'ReportJob', rj."id"::text FROM "ReportJob" rj WHERE rj."organizationId" = ${org}::uuid AND rj."filters"->>'siteId' IN (${Prisma.join(ids.map(id => Prisma.sql`${id}`))})
    ) scoped WHERE scoped."entity" = a."entity" AND scoped."entityId" = a."entityId"
  )` : Prisma.sql`AND FALSE`) : Prisma.empty
  const search=query.search?Prisma.sql`AND (a."action" ILIKE ${`%${query.search}%`} OR a."entity" ILIKE ${`%${query.search}%`} OR a."userId"::text ILIKE ${`%${query.search}%`} OR a."details"::text ILIKE ${`%${query.search}%`})`:Prisma.empty,where=Prisma.sql`FROM "AuditLog" a WHERE a."organizationId"=${org}::uuid ${scoped} ${search}`
  const counts=await db.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count ${where}`),rows=await db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`SELECT a.* ${where} ORDER BY ${Prisma.raw(`a."${query.sort}" ${query.direction.toUpperCase()}`)} LIMIT ${query.requested?query.pageSize:25} OFFSET ${query.requested?(query.page-1)*query.pageSize:0}`)
  return ok(res,pageResult(rows,Number(counts[0]?.count||0),query))
}))
const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const parsed = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s
}, 'Tanggal tidak valid.').transform(s => new Date(`${s}T00:00:00Z`))
const getTariffAssignments = (org: string, siteId?: string, client: Prisma.TransactionClient | PrismaClient = db) => client.$queryRaw<{ meterId: string; tariffId: string; tariffName: string; unitRate: Prisma.Decimal; tariffType: string; fixedCharge: Prisma.Decimal; taxPercent: Prisma.Decimal; rates: { startMinute: number; endMinute: number; unitRate: string }[]; timezone: string; effectiveFrom: Date; effectiveTo: Date | null }[]>`SELECT a."meterId", t."id" AS "tariffId", t."name" AS "tariffName", t."unitRate", t."tariffType", t."fixedCharge", t."taxPercent", COALESCE((SELECT jsonb_agg(jsonb_build_object('startMinute', r."startMinute", 'endMinute', r."endMinute", 'unitRate', r."unitRate") ORDER BY r."startMinute") FROM "TariffRate" r WHERE r."organizationId" = a."organizationId" AND r."tariffId" = t."id"), '[]'::jsonb) AS "rates", s."timezone", a."effectiveFrom", a."effectiveTo" FROM "TariffAssignment" a JOIN "Tariff" t ON t."id" = a."tariffId" AND t."organizationId" = a."organizationId" JOIN "Meter" m ON m."id" = a."meterId" AND m."organizationId" = a."organizationId" JOIN "Site" s ON s."id" = m."siteId" AND s."organizationId" = m."organizationId" WHERE a."organizationId" = ${org}::uuid AND (${siteId ?? null}::uuid IS NULL OR m."siteId" = ${siteId ?? null}::uuid)`
const siteForOrg = (siteId: string, organizationId: string) => db.site.findFirst({ where: { id: siteId, organizationId } })
async function emissionFactorsForSite(organizationId: string, site: { id: string; emissionRegion: string | null; timezone: string }, start: Date, end: Date, factorId?: string, client: PrismaClient | Prisma.TransactionClient = db) {
  const localStart = siteDate(start, site.timezone), localEnd = siteDate(new Date(end.getTime() - 1), site.timezone)
  const firstYear = Number(localStart.slice(0, 4)), lastYear = Number(localEnd.slice(0, 4))
  const localStartUtc = new Date(`${localStart}T00:00:00.000Z`), localEndUtc = new Date(`${localEnd}T00:00:00.000Z`)
  if (factorId) {
    const factor = await client.emissionFactor.findFirst({ where: { id: factorId, organizationId } })
    if (!factor || factor.energySource !== 'ELECTRICITY' || (site.emissionRegion && factor.region !== site.emissionRegion)) return []
    return factor.applicableYear >= firstYear && factor.applicableYear <= lastYear && factor.effectiveFrom <= localEndUtc && (!factor.effectiveTo || factor.effectiveTo >= localStartUtc) ? [factor] : []
  }
  if (!site.emissionRegion) return []
  return client.emissionFactor.findMany({ where: { organizationId, region: site.emissionRegion, energySource: 'ELECTRICITY', applicableYear: { gte: firstYear, lte: lastYear }, effectiveFrom: { lte: localEndUtc }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: localStartUtc } }] }, orderBy: { applicableYear: 'asc' } })
}
async function auditCreated(organizationId: string, userId: string, entity: string, entityId: string) {
  await db.auditLog.create({ data: { organizationId, userId, action: `${entity.toUpperCase()}_CREATED`, entity, entityId } })
}
const baselineValues = z.object({ startDate: dateInput, endDate: dateInput, value: z.coerce.number().nonnegative(), denominator: z.coerce.number().nonnegative().optional(), denominatorUnit: z.string().trim().min(1).optional(), approvalNotes: z.string().max(2000).optional() }).refine(v => v.startDate <= v.endDate, { message: 'Periode tidak valid.', path: ['endDate'] }).refine(v => v.denominator === undefined || !!v.denominatorUnit, { message: 'Unit normalisasi diperlukan.', path: ['denominatorUnit'] })
api.get('/baselines', auth, wrap(async (req, res) => {const query=pageQuery(req,['createdAt','startDate','endDate','value','status'],'createdAt'),where={organizationId:res.locals.user.organizationId,...(res.locals.allowedSiteIds?{siteId:{in:res.locals.allowedSiteIds}}:{}),...(query.search?{site:{name:{contains:query.search,mode:'insensitive' as const}}}:{})};const [total,rows]=await Promise.all([db.baseline.count({where}),db.baseline.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query))}))
api.post('/baselines', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid(), metric: z.literal('ENERGY_IMPORT') }).and(baselineValues).parse(req.body)
  const org = res.locals.user.organizationId
  if (!await siteForOrg(input.siteId, org)) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  const id = randomUUID()
  await db.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO "Baseline" ("id", "organizationId", "groupId", "siteId", "metric", "startDate", "endDate", "value", "denominator", "denominatorUnit", "approvalNotes") VALUES (${id}::uuid, ${org}::uuid, ${id}::uuid, ${input.siteId}::uuid, ${input.metric}, ${input.startDate}::date, ${input.endDate}::date, ${input.value}::numeric, ${input.denominator ?? null}::numeric, ${input.denominatorUnit ?? null}, ${input.approvalNotes ?? null})`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'BASELINE_CREATED', entity: 'Baseline', entityId: id } })
  })
  return ok(res, { id, groupId: id, version: 1, status: 'DRAFT' }, 201)
}))
api.post('/baselines/:id/approve', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ notes: z.string().trim().min(2).max(2000) }).parse(req.body), org = res.locals.user.organizationId
  const result = await db.$transaction(async tx => {
    const found = await tx.$queryRaw<{ groupId: string }[]>`SELECT "groupId" FROM "Baseline" WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${org}::uuid`
    if (!found[0]) return 'NOT_FOUND' as const
    await tx.$queryRaw`SELECT "id" FROM "Baseline" WHERE "id" = ${found[0].groupId}::uuid AND "organizationId" = ${org}::uuid FOR UPDATE`
    const rows = await tx.$queryRaw<{ id: string; version: number; status: string }[]>`SELECT "id", "version", "status" FROM "Baseline" WHERE "organizationId" = ${org}::uuid AND "groupId" = ${found[0].groupId}::uuid ORDER BY "version" DESC LIMIT 1`
    if (!rows[0] || rows[0].id !== req.params.id || rows[0].status !== 'DRAFT') return 'CONFLICT' as const
    await tx.$executeRaw`UPDATE "Baseline" SET "status" = 'APPROVED', "approvalNotes" = ${input.notes}, "approvedBy" = ${res.locals.user.id}::uuid, "approvedAt" = CURRENT_TIMESTAMP WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${org}::uuid`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'BASELINE_APPROVED', entity: 'Baseline', entityId: req.params.id, details: { version: rows[0].version } } })
    return { id: rows[0].id, version: rows[0].version, status: 'APPROVED' }
  })
  if (result === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Baseline tidak ditemukan.')
  if (result === 'CONFLICT') return fail(res, 409, 'INVALID_STATE', 'Hanya versi draft terbaru dapat disetujui.')
  return ok(res, result)
}))
api.post('/baselines/:id/revisions', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const input = baselineValues.parse(req.body), org = res.locals.user.organizationId
  const result = await db.$transaction(async tx => {
    const found = await tx.$queryRaw<{ groupId: string }[]>`SELECT "groupId" FROM "Baseline" WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${org}::uuid`
    if (!found[0]) return 'NOT_FOUND' as const
    await tx.$queryRaw`SELECT "id" FROM "Baseline" WHERE "id" = ${found[0].groupId}::uuid AND "organizationId" = ${org}::uuid FOR UPDATE`
    const rows = await tx.$queryRaw<{ id: string; siteId: string; metric: string; version: number; status: string }[]>`SELECT "id", "siteId", "metric", "version", "status" FROM "Baseline" WHERE "organizationId" = ${org}::uuid AND "groupId" = ${found[0].groupId}::uuid ORDER BY "version" DESC LIMIT 1`
    const previous = rows[0]
    if (!previous || previous.id !== req.params.id || previous.status !== 'APPROVED') return 'CONFLICT' as const
    const id = randomUUID(), version = previous.version + 1
    await tx.$executeRaw`INSERT INTO "Baseline" ("id", "organizationId", "groupId", "supersedesId", "siteId", "metric", "startDate", "endDate", "value", "denominator", "denominatorUnit", "approvalNotes", "version") VALUES (${id}::uuid, ${org}::uuid, ${found[0].groupId}::uuid, ${previous.id}::uuid, ${previous.siteId}::uuid, ${previous.metric}, ${input.startDate}::date, ${input.endDate}::date, ${input.value}::numeric, ${input.denominator ?? null}::numeric, ${input.denominatorUnit ?? null}, ${input.approvalNotes ?? null}, ${version})`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'BASELINE_REVISION_CREATED', entity: 'Baseline', entityId: id, details: { previousId: previous.id, version } } })
    return { id, groupId: found[0].groupId, supersedesId: previous.id, version, status: 'DRAFT' }
  })
  if (result === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Baseline tidak ditemukan.')
  if (result === 'CONFLICT') return fail(res, 409, 'INVALID_STATE', 'Revisi harus dibuat dari versi terbaru yang disetujui.')
  return ok(res, result, 201)
}))
async function actualEnergyForSite(organizationId: string, siteId: string, start: Date, end: Date, client: PrismaClient | Prisma.TransactionClient = db) {
  const scope = { organizationId, quality: 'VALID', meter: { siteId } }
  const [readings, prior] = await Promise.all([
    client.meterReading.findMany({ where: { ...scope, timestamp: { gte: start, lt: end }, unit: 'kWh', meter: { siteId, metric: 'ENERGY_IMPORT' } }, include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } } } } }, orderBy: { timestamp: 'asc' } }),
    client.meterReading.findMany({ where: { ...scope, timestamp: { lt: start }, unit: 'kWh', meter: { siteId, metric: 'ENERGY_IMPORT' } }, distinct: ['meterId'], include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } } } } }, orderBy: { timestamp: 'desc' } })
  ])
  const buckets = energyByUtcDay(readings, prior)
  return { energyKwh: buckets.length ? buckets.reduce((sum, item) => sum + item.kwh, 0) : null, buckets }
}
api.get('/baselines/:id/compare', auth, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ periodStart: dateInput.optional(), periodEnd: dateInput.optional() }).refine(v => !!v.periodStart === !!v.periodEnd, { message: 'periodStart dan periodEnd harus digunakan bersama.' }).parse(req.query), org = res.locals.user.organizationId
  const baseline = await db.baseline.findFirst({ where: { id: req.params.id, organizationId: org, status: 'APPROVED', ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}) } })
  if (!baseline) return fail(res, 404, 'NOT_FOUND', 'Baseline yang disetujui tidak ditemukan.')
  const start = input.periodStart ?? baseline.startDate, endDate = input.periodEnd ?? baseline.endDate
  if (start > endDate || endDate.getTime() - start.getTime() > 366 * 86400000) return fail(res, 422, 'VALIDATION_ERROR', 'Periode pembanding tidak valid atau melebihi 366 hari.')
  const baselineDays = Math.round((baseline.endDate.getTime() - baseline.startDate.getTime()) / 86400000) + 1, comparisonDays = Math.round((endDate.getTime() - start.getTime()) / 86400000) + 1
  if (baselineDays !== comparisonDays) return fail(res, 422, 'INCOMPARABLE_PERIOD', 'Periode pembanding harus memiliki durasi kalender yang sama dengan baseline.')
  const site = await siteForOrg(baseline.siteId, org)
  if (!site) return fail(res, 404, 'NOT_FOUND', 'Site baseline tidak ditemukan.')
  const startDate = start.toISOString().slice(0, 10), endDateLocal = endDate.toISOString().slice(0, 10)
  const actual = await actualEnergyForSite(org, baseline.siteId, localDateStartUtc(startDate, site.timezone), localDateStartUtc(nextLocalDate(endDateLocal), site.timezone))
  const reference = new Prisma.Decimal(baseline.value), actualValue = actual.energyKwh === null ? null : new Prisma.Decimal(actual.energyKwh)
  const baselineIntensity = baseline.denominator && !new Prisma.Decimal(baseline.denominator).isZero() ? reference.div(baseline.denominator).toDecimalPlaces(6).toString() : null
  const denominator = baseline.denominator ? new Prisma.Decimal(baseline.denominator) : null
  const actualIntensity = actualValue !== null && denominator && !denominator.isZero() ? actualValue.div(denominator).toDecimalPlaces(6).toString() : null
  const variancePercent = actualValue && !reference.isZero() ? actualValue.sub(reference).div(reference).mul(100).toDecimalPlaces(2).toString() : null
  return ok(res, { baselineId: baseline.id, baselineVersion: baseline.version, siteId: baseline.siteId, metric: baseline.metric, periodStart: startDate, periodEnd: endDateLocal, baselineKwh: reference.toString(), actualKwh: actualValue?.toString() ?? null, variancePercent, denominator: baseline.denominator?.toString() ?? null, denominatorUnit: baseline.denominatorUnit, baselineIntensity, actualIntensity, unit: 'kWh', timezone: site.timezone, note: actualValue === null ? 'Tidak ada delta energi tervalidasi yang dapat dibandingkan.' : 'Perbandingan memakai hari kalender lokal site; hari tanpa bacaan tidak dianggap nol.' })
}))
api.get('/targets', auth, wrap(async (req, res) => {const query=pageQuery(req,['createdAt','startDate','endDate','targetValue'],'createdAt'),where={organizationId:res.locals.user.organizationId,...(res.locals.allowedSiteIds?{siteId:{in:res.locals.allowedSiteIds}}:{}),...(query.search?{site:{name:{contains:query.search,mode:'insensitive' as const}}}:{})};const [total,rows]=await Promise.all([db.energyTarget.count({where}),db.energyTarget.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query))}))
api.post('/targets', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid(), metric: z.literal('ENERGY_IMPORT'), startDate: dateInput, endDate: dateInput, targetValue: z.coerce.number().nonnegative(), unit: z.literal('kWh') }).refine(v => v.startDate <= v.endDate, { message: 'Periode tidak valid.', path: ['endDate'] }).parse(req.body)
  const org = res.locals.user.organizationId
  if (!await siteForOrg(input.siteId, org)) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  const item = await db.energyTarget.create({ data: { ...input, organizationId: org } }); await auditCreated(org, res.locals.user.id, 'Target', item.id); return ok(res, item, 201)
}))
api.get('/targets/:id/progress', auth, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const org = res.locals.user.organizationId
  const target = await db.energyTarget.findFirst({ where: { id: req.params.id, organizationId: org, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}) } })
  if (!target) return fail(res, 404, 'NOT_FOUND', 'Target tidak ditemukan.')
  const startDate = target.startDate.toISOString().slice(0, 10), endDate = target.endDate.toISOString().slice(0, 10), site = await siteForOrg(target.siteId, org)
  if (!site) return fail(res, 404, 'NOT_FOUND', 'Site target tidak ditemukan.')
  const actual = await actualEnergyForSite(org, target.siteId, localDateStartUtc(startDate, site.timezone), localDateStartUtc(nextLocalDate(endDate), site.timezone))
  const targetValue = new Prisma.Decimal(target.targetValue), actualValue = actual.energyKwh === null ? null : new Prisma.Decimal(actual.energyKwh)
  const completionPercent = actualValue && !targetValue.isZero() ? actualValue.div(targetValue).mul(100).toDecimalPlaces(2).toString() : null
  return ok(res, { targetId: target.id, siteId: target.siteId, periodStart: startDate, periodEnd: endDate, targetKwh: targetValue.toString(), actualKwh: actualValue?.toString() ?? null, remainingKwh: actualValue ? targetValue.sub(actualValue).toDecimalPlaces(2).toString() : null, completionPercent, unit: target.unit, timezone: site.timezone, note: 'Kemajuan memakai hari kalender lokal dan bacaan tervalidasi; hari tanpa data tidak dianggap nol.' })
}))
api.get('/emission-factors', auth, wrap(async (req, res) => {const query=pageQuery(req,['applicableYear','region','effectiveFrom','createdAt'],'applicableYear'),where={organizationId:res.locals.user.organizationId,...(query.search?{OR:[{region:{contains:query.search,mode:'insensitive' as const}},{publicationSource:{contains:query.search,mode:'insensitive' as const}}]}:{})};const [total,rows]=await Promise.all([db.emissionFactor.count({where}),db.emissionFactor.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query))}))
api.get('/emission-factors/:id', auth, allowRoles('ADMIN', 'ENERGY_MANAGER', 'ANALYST'), wrap(async (req, res) => {
  const factor = await db.emissionFactor.findFirst({ where: { id: req.params.id, organizationId: res.locals.user.organizationId } })
  return factor ? ok(res, factor) : fail(res, 404, 'NOT_FOUND', 'Versi faktor emisi tidak ditemukan.')
}))
api.post('/emission-factors', auth, csrf, admin, wrap(async (req, res) => {
  const input = z.object({ region: z.string().trim().min(2).max(150), energySource: z.enum(['ELECTRICITY', 'NATURAL_GAS', 'DIESEL', 'GASOLINE', 'STEAM', 'OTHER']).default('ELECTRICITY'), factor: z.coerce.number().nonnegative(), unit: z.literal('kgCO2e/kWh'), publicationSource: z.string().trim().min(2).max(500), applicableYear: z.coerce.number().int().min(1900).max(2200), sourceUrl: z.string().url().refine(v => /^https?:\/\//i.test(v), 'URL harus menggunakan HTTP atau HTTPS.'), effectiveFrom: dateInput, effectiveTo: dateInput.optional() }).refine(v => !v.effectiveTo || v.effectiveFrom <= v.effectiveTo, { message: 'Periode tidak valid.', path: ['effectiveTo'] }).parse(req.body)
  const org = res.locals.user.organizationId
  const item = await db.$transaction(async tx => {
    const lockKey = `${org}:${input.region.toLocaleLowerCase('en-US')}:${input.energySource}:${input.applicableYear}`
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint) IS NULL AS locked`
    const conflict = await tx.emissionFactor.findFirst({ where: { organizationId: org, region: input.region, energySource: input.energySource, applicableYear: input.applicableYear, effectiveFrom: { lte: input.effectiveTo ?? new Date('9999-12-31') }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.effectiveFrom } }] } })
    if (conflict) return null
    const created = await tx.emissionFactor.create({ data: { ...input, organizationId: org } })
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'EMISSION_FACTOR_CREATED', entity: 'EmissionFactor', entityId: created.id, details: { region: created.region, energySource: created.energySource, factor: String(created.factor), unit: created.unit, publicationSource: created.publicationSource, applicableYear: created.applicableYear, effectiveFrom: created.effectiveFrom.toISOString().slice(0, 10), effectiveTo: created.effectiveTo?.toISOString().slice(0, 10) ?? null, sourceUrl: created.sourceUrl } } })
    return created
  })
  return item ? ok(res, item, 201) : fail(res, 409, 'CONFLICT', 'Periode faktor emisi untuk wilayah/tahun tersebut bertumpang tindih.')
}))
api.get('/emissions/estimate', auth, allowRoles('ADMIN', 'ANALYST'), wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid(), factorId: z.string().uuid().optional(), periodStart: z.string().datetime({ offset: true }), periodEnd: z.string().datetime({ offset: true }) }).refine(v => new Date(v.periodEnd) > new Date(v.periodStart) && new Date(v.periodEnd).getTime() - new Date(v.periodStart).getTime() <= 366 * 86400000, { path: ['periodEnd'], message: 'Periode harus positif dan maksimum 366 hari.' }).parse(req.query)
  const org = res.locals.user.organizationId, start = new Date(input.periodStart), end = new Date(input.periodEnd)
  const site = await siteForOrg(input.siteId, org)
  if (!site) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  if (!input.factorId && !site.emissionRegion) return fail(res, 422, 'EMISSION_REGION_REQUIRED', 'Atur wilayah emisi pada profil site atau pilih faktor emisi secara manual.')
  const factors = await emissionFactorsForSite(org, site, start, end, input.factorId)
  if (input.factorId && !factors.length) {
    const factorExists = await db.emissionFactor.findFirst({ where: { id: input.factorId, organizationId: org }, select: { id: true } })
    return factorExists ? fail(res, 422, 'INCOMPATIBLE_EMISSION_FACTOR', 'Faktor tidak cocok dengan wilayah, tahun, atau tanggal efektif untuk periode ini.') : fail(res, 404, 'NOT_FOUND', 'Faktor emisi tidak ditemukan.')
  }
  if (!input.factorId && !factors.length) return fail(res, 422, 'EMISSION_FACTOR_UNAVAILABLE', 'Tidak ada faktor yang berlaku untuk wilayah dan tahun site.')
  if (factors.some(factor => factor.unit !== 'kgCO2e/kWh')) return fail(res, 422, 'INCOMPATIBLE_FACTOR_UNIT', 'Faktor harus menggunakan kgCO2e/kWh.')
  const scope = { organizationId: org, quality: 'VALID', meter: { siteId: input.siteId } }
  const [readings, prior] = await Promise.all([
    db.meterReading.findMany({ where: { ...scope, timestamp: { gte: start, lt: end } }, include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'asc' } }),
    db.meterReading.findMany({ where: { ...scope, timestamp: { lt: start } }, distinct: ['meterId'], include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'desc' } })
  ])
  const estimate = input.factorId ? estimateEmissions(readings, prior, factors[0]) : estimateEmissionsByYear(readings, prior, factors)
  return ok(res, { ...estimate, siteId: input.siteId, periodStart: start.toISOString(), periodEnd: end.toISOString(), region: site.emissionRegion, timezone: site.timezone })
}))
api.get('/tariffs', auth, wrap(async (req, res) => { const query=pageQuery(req,['createdAt','name','effectiveFrom','effectiveTo','tariffType'],'effectiveFrom'),where={organizationId:res.locals.user.organizationId,...(query.search?{name:{contains:query.search,mode:'insensitive' as const}}:{})};const [total,rows]=await Promise.all([db.tariff.count({where}),db.tariff.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,include:{rates:{orderBy:{startMinute:'asc'}}},orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query)) }))
api.post('/tariffs', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const tariffInput = z.object({ name: z.string().trim().min(2).max(150), currency: z.literal('IDR').default('IDR'), tariffType: z.enum(['FLAT', 'TOU']).default('FLAT'), unitRate: z.coerce.number().nonnegative().default(0), fixedCharge: z.coerce.number().nonnegative().default(0), taxPercent: z.coerce.number().min(0).max(100).default(0), rates: z.array(z.object({ startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440), unitRate: z.coerce.number().nonnegative() }).strict()).max(24).optional(), effectiveFrom: dateInput, effectiveTo: dateInput.optional() }).strict().refine(v => !v.effectiveTo || v.effectiveFrom <= v.effectiveTo, { message: 'Periode tidak valid.', path: ['effectiveTo'] }).superRefine((v, ctx) => {
    const rates = [...(v.rates ?? [])].sort((a, b) => a.startMinute - b.startMinute)
    if (v.tariffType === 'FLAT' && rates.length) ctx.addIssue({ code: 'custom', path: ['rates'], message: 'Tarif FLAT tidak menggunakan jadwal waktu.' })
    if (v.tariffType === 'TOU') {
      if (!rates.length || rates[0].startMinute !== 0 || rates.at(-1)!.endMinute !== 1440) ctx.addIssue({ code: 'custom', path: ['rates'], message: 'Jadwal TOU harus mencakup 00:00–24:00.' })
      for (let i = 0; i < rates.length; i++) {
        if (rates[i].startMinute >= rates[i].endMinute || (i > 0 && rates[i - 1].endMinute !== rates[i].startMinute)) ctx.addIssue({ code: 'custom', path: ['rates', i], message: 'Jadwal tidak boleh bertumpang tindih atau menyisakan celah.' })
      }
    }
  })
  const input = tariffInput.parse(req.body)
  const org = res.locals.user.organizationId
  const conflict = await db.tariff.findFirst({ where: { organizationId: org, name: input.name, effectiveFrom: { lte: input.effectiveTo ?? new Date('9999-12-31') }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.effectiveFrom } }] } })
  if (conflict) return fail(res, 409, 'CONFLICT', 'Periode tarif dengan nama yang sama bertumpang tindih.')
  const { rates, ...tariff } = input
  const item = await db.$transaction(async tx => {
    const created = await tx.tariff.create({ data: { ...tariff, organizationId: org } })
    if (rates?.length) await tx.tariffRate.createMany({ data: rates.map(rate => ({ ...rate, tariffId: created.id, organizationId: org })) })
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'TARIFF_CREATED', entity: 'Tariff', entityId: created.id, details: { tariffType: tariff.tariffType, taxPercent: tariff.taxPercent, rateCount: rates?.length ?? 0 } } })
    return { ...created, rates: rates ?? [] }
  })
  return ok(res, item, 201)
}))
api.get('/tariff-assignments', auth, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const org = res.locals.user.organizationId, ids: string[] | undefined = res.locals.allowedSiteIds
  const query=pageQuery(req,['effectiveFrom','name','unitRate'],'effectiveFrom'),where=Prisma.sql`WHERE a."organizationId" = ${org}::uuid ${ids ? (ids.length ? Prisma.sql`AND m."siteId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})` : Prisma.sql`AND FALSE`) : Prisma.empty} ${query.search?Prisma.sql`AND (t."name" ILIKE ${`%${query.search}%`} OR a."meterId"::text ILIKE ${`%${query.search}%`})`:Prisma.empty}`,order=({effectiveFrom:Prisma.sql`a."effectiveFrom"`,name:Prisma.sql`t."name"`,unitRate:Prisma.sql`t."unitRate"`})[query.sort]||Prisma.sql`a."effectiveFrom"`,direction=query.direction==='asc'?Prisma.sql`ASC`:Prisma.sql`DESC`,offset=query.requested?(query.page-1)*query.pageSize:0,take=query.requested?query.pageSize:25
  const [assignments,count]=await Promise.all([db.$queryRaw<any[]>(Prisma.sql`SELECT a."id", a."meterId", a."tariffId", a."effectiveFrom", a."effectiveTo", t."name", t."unitRate" FROM "TariffAssignment" a JOIN "Tariff" t ON t."id" = a."tariffId" AND t."organizationId" = a."organizationId" JOIN "Meter" m ON m."id" = a."meterId" AND m."organizationId" = a."organizationId" ${where} ORDER BY ${order} ${direction} LIMIT ${take} OFFSET ${offset}`),db.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "TariffAssignment" a JOIN "Tariff" t ON t."id" = a."tariffId" AND t."organizationId" = a."organizationId" JOIN "Meter" m ON m."id" = a."meterId" AND m."organizationId" = a."organizationId" ${where}`)])
  return ok(res, pageResult(assignments,Number(count[0]?.count??0),query))
}))
api.post('/tariff-assignments', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ meterId: z.string().uuid(), tariffId: z.string().uuid(), effectiveFrom: dateInput, effectiveTo: dateInput.optional() }).refine(v => !v.effectiveTo || v.effectiveFrom <= v.effectiveTo, { path: ['effectiveTo'], message: 'Periode tidak valid.' }).parse(req.body)
  const org = res.locals.user.organizationId
  const assignment = await db.$transaction(async tx => {
    const meters = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Meter" WHERE "id" = ${input.meterId}::uuid AND "organizationId" = ${org}::uuid AND "metric" = 'ENERGY_IMPORT' FOR UPDATE`
    if (!meters[0]) return 'NOT_FOUND' as const
    const tariff = await tx.tariff.findFirst({ where: { id: input.tariffId, organizationId: org } })
    if (!tariff) return 'NOT_FOUND' as const
    if (input.effectiveFrom < tariff.effectiveFrom || (tariff.effectiveTo && (!input.effectiveTo || input.effectiveTo > tariff.effectiveTo))) return 'INVALID_PERIOD' as const
    const overlaps = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "TariffAssignment" WHERE "organizationId" = ${org}::uuid AND "meterId" = ${input.meterId}::uuid AND ("effectiveTo" IS NULL OR "effectiveTo" >= ${input.effectiveFrom}::date) AND (${input.effectiveTo ?? null}::date IS NULL OR "effectiveFrom" <= ${input.effectiveTo ?? null}::date) LIMIT 1`
    if (overlaps.length) return 'OVERLAP' as const
    const id = randomUUID()
    await tx.$executeRaw`INSERT INTO "TariffAssignment" ("id", "organizationId", "meterId", "tariffId", "effectiveFrom", "effectiveTo") VALUES (${id}::uuid, ${org}::uuid, ${input.meterId}::uuid, ${input.tariffId}::uuid, ${input.effectiveFrom}::date, ${input.effectiveTo ?? null}::date)`
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'TARIFF_ASSIGNED', entity: 'TariffAssignment', entityId: id, details: { meterId: input.meterId, tariffId: input.tariffId, effectiveFrom: input.effectiveFrom.toISOString(), effectiveTo: input.effectiveTo?.toISOString() ?? null } } })
    return { id }
  })
  if (assignment === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Meter energi atau tarif tidak ditemukan.')
  if (assignment === 'INVALID_PERIOD') return fail(res, 422, 'VALIDATION_ERROR', 'Periode penugasan harus berada dalam periode tarif.')
  if (assignment === 'OVERLAP') return fail(res, 409, 'CONFLICT', 'Periode penugasan tarif meter bertumpang tindih.')
  return ok(res, assignment, 201)
}))
api.get('/cost-analysis', auth, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ periodStart: z.string().datetime({ offset: true }), periodEnd: z.string().datetime({ offset: true }), siteId: z.string().uuid().optional() }).refine(v => new Date(v.periodEnd) > new Date(v.periodStart) && new Date(v.periodEnd).getTime() - new Date(v.periodStart).getTime() <= 366 * 86400000, { path: ['periodEnd'], message: 'Periode harus positif dan maksimum 366 hari.' }).parse(req.query)
  const org = res.locals.user.organizationId, start = new Date(input.periodStart), end = new Date(input.periodEnd)
  if (input.siteId && !await siteForOrg(input.siteId, org)) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  const scope = { organizationId: org, quality: 'VALID', ...(input.siteId ? { meter: { siteId: input.siteId } } : {}) }
  const [meters, readings, prior, assignments] = await Promise.all([
    db.meter.findMany({ where: { organizationId: org, metric: 'ENERGY_IMPORT', status: { not: 'RETIRED' }, ...(input.siteId ? { siteId: input.siteId } : {}) }, select: { id: true, intervalMinutes: true, installedAt: true, decommissionedAt: true } }),
    db.meterReading.findMany({ where: { ...scope, timestamp: { gte: start, lt: end } }, include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'asc' } }),
    db.meterReading.findMany({ where: { ...scope, timestamp: { lt: start } }, distinct: ['meterId'], include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'desc' } }),
    getTariffAssignments(org, input.siteId)
  ])
  const estimate = estimateFlatCost(readings, prior, assignments)
  const expectedReadings = meters.reduce((total, meter) => {
    const from = meter.installedAt && meter.installedAt > start ? meter.installedAt : start
    const to = meter.decommissionedAt && meter.decommissionedAt < end ? meter.decommissionedAt : end
    return total + (to > from ? Math.floor((to.getTime() - from.getTime()) / (meter.intervalMinutes * 60_000)) : 0)
  }, 0)
  const observedReadings = new Set(readings.map(reading => `${reading.meterId}:${reading.timestamp.toISOString()}`)).size
  const completenessPercent = expectedReadings ? Number((Math.min(observedReadings, expectedReadings) * 100 / expectedReadings).toFixed(2)) : null
  const fixed = estimateFixedCharges(assignments, start, end), fixedCost = new Prisma.Decimal(fixed.fixedChargeIdr)
  const pricedCostIdr = estimate.pricedCostIdr === null ? null : new Prisma.Decimal(estimate.pricedCostIdr).add(fixedCost).toDecimalPlaces(2).toFixed(2)
  const estimatedCostIdr = estimate.estimatedCostIdr === null ? null : new Prisma.Decimal(estimate.estimatedCostIdr).add(fixedCost).toDecimalPlaces(2).toFixed(2)
  return ok(res, { ...estimate, ...fixed, estimatedCostIdr, pricedCostIdr, completenessPercent, expectedReadings, observedReadings, isComplete: completenessPercent === null ? false : completenessPercent === 100, periodStart: start.toISOString(), periodEnd: end.toISOString(), siteId: input.siteId || null, note: 'Estimasi energi FLAT/TOU, prorata biaya tetap bulanan dan pajak sesuai konfigurasi; delta kumulatif dialokasikan berdasarkan waktu lokal bacaan akhir. Biaya parsial tetap ditampilkan bersama indikator completeness dan bukan tagihan resmi.' })
}))
api.get('/audits', auth, allowRoles('ADMIN', 'ENERGY_MANAGER', 'AUDITOR'), wrap(async (req, res) => {const query=pageQuery(req,['createdAt','title','status','scheduledAt'],'createdAt'),where={organizationId:res.locals.user.organizationId,...(res.locals.allowedSiteIds?{siteId:{in:res.locals.allowedSiteIds}}:{}),...(hasExplicitPermission(res.locals.user,'audit.assigned')?{assignedAuditorId:res.locals.user.id}:{}),...(query.search?{title:{contains:query.search,mode:'insensitive' as const}}:{})};const [total,rows]=await Promise.all([db.energyAudit.count({where}),db.energyAudit.findMany({where,skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:undefined,include:{assignedAuditorUser:{select:{id:true,fullName:true,email:true}}},orderBy:{[query.sort]:query.direction}})]);return ok(res,pageResult(rows,total,query))}))
api.get('/audits/:id', auth, wrap(async (req, res) => {
  const item = await db.energyAudit.findFirst({ where: { id: req.params.id, organizationId: res.locals.user.organizationId, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}), ...(hasExplicitPermission(res.locals.user, 'audit.assigned') ? { assignedAuditorId: res.locals.user.id } : {}) }, include: { findings: { include: { actions: true } }, evidence: { select: { id: true, fileName: true, contentType: true, sizeBytes: true, sha256: true, scanProvider: true, scannedAt: true, createdAt: true, uploadedBy: true } }, assignedAuditorUser: { select: { id: true, fullName: true, email: true } } } })
  return item ? ok(res, item) : fail(res, 404, 'NOT_FOUND', 'Audit tidak ditemukan.')
}))
function auditEvidencePath(organizationId: string, auditId: string, evidenceId: string, extension: string) {
  const root = resolve(process.env.AUDIT_EVIDENCE_STORAGE_DIR || 'private/audit-evidence')
  const file = resolve(root, organizationId, auditId, `${evidenceId}.${extension}`)
  const rel = relative(root, file)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('INVALID_EVIDENCE_PATH')
  return file
}
function evidenceExtension(contentType: string) { return contentType === 'application/pdf' ? 'pdf' : contentType === 'image/jpeg' ? 'jpg' : 'png' }
function evidenceBytesMatch(contentType: string, content: Buffer) {
  if (contentType === 'application/pdf') return content.subarray(0, 5).toString('ascii') === '%PDF-'
  if (contentType === 'image/jpeg') return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
  return content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
}
api.post('/audits/:id/evidence', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER', 'AUDITOR'), wrap(async (req, res) => {
  if (!['audit.evidence.manage', 'audit.submit', 'audit.approve'].some(permission => hasPermission(res.locals.user, permission))) return fail(res, 403, 'FORBIDDEN', 'Permission untuk mengunggah bukti audit tidak tersedia.')
  const input = z.object({ fileName: z.string().trim().min(1).max(180), contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']), contentBase64: z.string().min(4).max(7_000_000) }).strict().safeParse(req.body)
  if (!input.success) return fail(res, 422, 'VALIDATION_ERROR', 'Nama file, MIME type, atau isi file tidak valid.')
  const normalizedName = basename(input.data.fileName).normalize('NFC')
  if (normalizedName !== input.data.fileName.trim() || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,159}$/u.test(normalizedName) || normalizedName.includes('..')) return fail(res, 422, 'VALIDATION_ERROR', 'Nama file tidak valid.')
  const content = Buffer.from(input.data.contentBase64, 'base64')
  if (!content.length || content.length > 5 * 1024 * 1024 || content.toString('base64') !== input.data.contentBase64 || !evidenceBytesMatch(input.data.contentType, content)) return fail(res, 422, 'VALIDATION_ERROR', 'Ukuran atau signature file tidak valid.')
  const org = res.locals.user.organizationId, auditId = req.params.id
  const audit = await db.energyAudit.findFirst({ where: { id: auditId, organizationId: org, ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}), ...(hasExplicitPermission(res.locals.user, 'audit.assigned') ? { assignedAuditorId: res.locals.user.id } : {}) }, select: { id: true, status: true } })
  if (!audit) return fail(res, 404, 'NOT_FOUND', 'Audit tidak ditemukan.')
  if (!['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(audit.status)) return fail(res, 409, 'INVALID_STATE', 'Bukti tidak dapat ditambahkan pada status audit ini.')
  let scan: { provider: string; scanId: string | null }
  try { scan = await scanEvidence({ fileName: normalizedName, contentType: input.data.contentType, content }) }
  catch (error) {
    const code = error instanceof Error ? error.message : 'EVIDENCE_SCANNER_UNAVAILABLE'
    if (code === 'EVIDENCE_MALWARE_DETECTED') return fail(res, 422, code, 'Pemindai menolak file karena terdeteksi malware.')
    return fail(res, 503, code === 'EVIDENCE_SCANNER_NOT_CONFIGURED' ? code : 'EVIDENCE_SCANNER_UNAVAILABLE', 'Pemindai bukti audit tidak tersedia atau belum dikonfigurasi.')
  }
  const id = randomUUID(), extension = evidenceExtension(input.data.contentType), storageKey = `${org}/${audit.id}/${id}.${extension}`, file = auditEvidencePath(org, audit.id, id, extension), temp = auditEvidencePath(org, audit.id, `${id}.${randomUUID()}`, 'tmp')
  if (objectStorageConfigured) await objectStorage.put(storageKey, content, input.data.contentType)
  else { await mkdir(dirname(file), { recursive: true }); await writeFile(temp, content, { flag: 'wx', mode: 0o600 }); try { await rename(temp, file) } catch (error) { await unlink(temp).catch(() => undefined); throw error } }
  try {
    const result = await db.$transaction(async tx => {
      const evidence = await tx.auditEvidence.create({ data: { id, organizationId: org, auditId: audit.id, uploadedBy: res.locals.user.id, fileName: normalizedName, contentType: input.data.contentType, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), storageKey: `${objectStorageConfigured ? 's3:' : ''}${storageKey}`, scanProvider: scan.provider, scanId: scan.scanId, scannedAt: new Date() }, select: { id: true, auditId: true, fileName: true, contentType: true, sizeBytes: true, sha256: true, scanProvider: true, scannedAt: true, createdAt: true, uploadedBy: true } })
      await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'AUDIT_EVIDENCE_UPLOADED', entity: 'AuditEvidence', entityId: evidence.id, details: { auditId: audit.id, fileName: normalizedName, contentType: input.data.contentType, sizeBytes: content.length, sha256: evidence.sha256, scanProvider: scan.provider, scanId: scan.scanId } } })
      return evidence
    })
    return ok(res, result, 201)
  } catch (error) { if (objectStorageConfigured) await objectStorage.delete(storageKey).catch(() => undefined); else await unlink(file).catch(() => undefined); throw error }
}))
api.get('/audits/:id/evidence/:evidenceId', auth, wrap(async (req, res) => {
  const org = res.locals.user.organizationId
  const evidence = await db.auditEvidence.findFirst({ where: { id: req.params.evidenceId, auditId: req.params.id, organizationId: org, audit: { ...(res.locals.allowedSiteIds ? { siteId: { in: res.locals.allowedSiteIds } } : {}), ...(hasExplicitPermission(res.locals.user, 'audit.assigned') ? { assignedAuditorId: res.locals.user.id } : {}) } } })
  if (!evidence) return fail(res, 404, 'NOT_FOUND', 'Bukti audit tidak ditemukan.')
  const file = auditEvidencePath(org, evidence.auditId, evidence.id, evidenceExtension(evidence.contentType))
  const content = evidence.storageKey.startsWith('s3:') ? await objectStorage.get(evidence.storageKey.slice(3)) : await readFile(file)
  res.setHeader('Content-Type', evidence.contentType); res.setHeader('Content-Length', content.length); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(evidence.fileName)}`); res.setHeader('X-Content-Type-Options', 'nosniff')
  return res.status(200).send(content)
}))
api.post('/audits', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid(), title: z.string().trim().min(2).max(200), assignedAuditorId: z.string().uuid(), scheduledAt: dateInput.optional() }).parse(req.body)
  const org = res.locals.user.organizationId
  if (!await siteForOrg(input.siteId, org)) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  const assignedAuditor = await db.organizationMembership.findFirst({ where: { userId: input.assignedAuditorId, organizationId: org, status: 'ACTIVE', roleDefinition: { active: true, permissions: { some: { permission: { code: 'audit.assigned' } } } }, user: { active: true } }, select: { userId: true } })
  if (!assignedAuditor || !await db.siteAssignment.findFirst({ where: { organizationId: org, userId: input.assignedAuditorId, siteId: input.siteId }, select: { id: true } })) return fail(res, 422, 'VALIDATION_ERROR', 'Auditor harus aktif, memiliki permission audit.assigned, dan ditugaskan pada site ini.')
  const item = await db.energyAudit.create({ data: { siteId: input.siteId, title: input.title, scheduledAt: input.scheduledAt, assignedAuditorId: assignedAuditor.userId, organizationId: org, createdBy: res.locals.user.id }, include: { assignedAuditorUser: { select: { id: true, fullName: true, email: true } } } }); await auditCreated(org, res.locals.user.id, 'EnergyAudit', item.id); return ok(res, item, 201)
}))
api.post('/audits/:id/findings', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER', 'AUDITOR'), wrap(async (req, res) => {
  const input = z.object({ severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), observation: z.string().trim().min(2).max(4000), recommendation: z.string().trim().min(2).max(4000) }).parse(req.body)
  if (!['audit.submit', 'audit.approve'].some(permission => hasPermission(res.locals.user, permission))) return fail(res, 403, 'FORBIDDEN', 'Permission untuk menambahkan temuan tidak tersedia.')
  const org = res.locals.user.organizationId
  const audit = await db.energyAudit.findFirst({ where: { id: req.params.id, organizationId: org } })
  if (!audit) return fail(res, 404, 'NOT_FOUND', 'Audit tidak ditemukan.')
  if (hasExplicitPermission(res.locals.user, 'audit.assigned') && audit.assignedAuditorId !== res.locals.user.id) return fail(res, 404, 'NOT_FOUND', 'Audit tidak ditugaskan kepada auditor ini.')
  if (!['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(audit.status)) return fail(res, 409, 'INVALID_STATE', 'Temuan tidak dapat ditambahkan pada status ini.')
  const finding = await db.$transaction(async tx => {
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "EnergyAudit" WHERE "id" = ${audit.id}::uuid AND "organizationId" = ${org}::uuid FOR UPDATE`
    if (!locked[0] || !['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(locked[0].status)) return null
    const item = await tx.auditFinding.create({ data: { ...input, auditId: audit.id } })
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'AUDIT_FINDING_CREATED', entity: 'AuditFinding', entityId: item.id, details: { auditId: audit.id } } })
    return item
  })
  if (!finding) return fail(res, 409, 'INVALID_STATE', 'Status audit telah berubah. Muat ulang.')
  return ok(res, finding, 201)
}))
api.post('/audit-findings/:id/actions', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ ownerId: z.string().uuid(), dueDate: dateInput }).parse(req.body)
  const org = res.locals.user.organizationId
  const finding = await db.auditFinding.findFirst({ where: { id: req.params.id, audit: { organizationId: org, status: { not: 'CLOSED' } } } })
  if (!finding) return fail(res, 404, 'NOT_FOUND', 'Temuan tidak ditemukan atau audit ditutup.')
  const owner = await db.organizationMembership.findFirst({ where: { userId: input.ownerId, organizationId: org, status: 'ACTIVE', user: { active: true } } })
  if (!owner) return fail(res, 422, 'VALIDATION_ERROR', 'Penanggung jawab harus pengguna aktif organisasi ini.')
  const action = await db.$transaction(async tx => {
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "EnergyAudit" WHERE "id" = ${finding.auditId}::uuid AND "organizationId" = ${org}::uuid FOR UPDATE`
    if (!locked[0] || locked[0].status === 'CLOSED') return null
    const created = await tx.correctiveAction.create({ data: { findingId: finding.id, ownerId: owner.id, dueDate: input.dueDate } })
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'CORRECTIVE_ACTION_CREATED', entity: 'CorrectiveAction', entityId: created.id, details: { findingId: finding.id } } })
    return created
  })
  if (!action) return fail(res, 409, 'INVALID_STATE', 'Audit telah ditutup.')
  return ok(res, action, 201)
}))
api.post('/corrective-actions/:id/close', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER'), wrap(async (req, res) => {
  const input = z.object({ outcome: z.string().trim().min(2).max(4000), evidenceUrl: z.string().url().max(2000).refine(s => /^https?:\/\//i.test(s), 'URL harus menggunakan HTTP atau HTTPS.') }).parse(req.body)
  const org = res.locals.user.organizationId
  const action = await db.correctiveAction.findFirst({ where: { id: req.params.id, finding: { audit: { organizationId: org, status: { not: 'CLOSED' } } } }, include: { finding: { select: { auditId: true } } } })
  if (!action) return fail(res, 404, 'NOT_FOUND', 'Tindakan tidak ditemukan atau audit ditutup.')
  const count = await db.$transaction(async tx => {
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "EnergyAudit" WHERE "id" = ${action.finding.auditId}::uuid AND "organizationId" = ${org}::uuid FOR UPDATE`
    if (!locked[0] || locked[0].status === 'CLOSED') return 0
    const updated = await tx.correctiveAction.updateMany({ where: { id: action.id, status: 'OPEN' }, data: { ...input, status: 'CLOSED' } })
    if (updated.count) await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'CORRECTIVE_ACTION_CLOSED', entity: 'CorrectiveAction', entityId: action.id, details: { outcome: input.outcome, evidenceUrl: input.evidenceUrl } } })
    return updated.count
  })
  if (!count) return fail(res, 409, 'INVALID_STATE', 'Tindakan sudah ditutup.')
  return ok(res, await db.correctiveAction.findUnique({ where: { id: action.id } }))
}))
api.post('/audits/:id/transition', auth, csrf, allowRoles('ADMIN', 'ENERGY_MANAGER', 'AUDITOR'), wrap(async (req, res) => {
  const input = z.object({ status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REVISION_REQUIRED', 'CLOSED']), comments: z.string().trim().max(2000).optional() }).parse(req.body)
  const org = res.locals.user.organizationId, actor = res.locals.user.id
  const assignedAuditorTransition = ['IN_PROGRESS', 'SUBMITTED'].includes(input.status)
  if (assignedAuditorTransition ? !hasPermission(res.locals.user, 'audit.submit') : !hasPermission(res.locals.user, 'audit.approve')) return fail(res, 403, 'FORBIDDEN', 'Permission untuk transisi audit ini tidak tersedia.')
  const audit = await db.energyAudit.findFirst({ where: { id: req.params.id, organizationId: org } })
  if (!audit) return fail(res, 404, 'NOT_FOUND', 'Audit tidak ditemukan.')
  if (hasExplicitPermission(res.locals.user, 'audit.assigned') && !['IN_PROGRESS', 'SUBMITTED'].includes(input.status)) return fail(res, 403, 'FORBIDDEN', 'Auditor hanya dapat memulai audit yang ditugaskan atau mengirim hasilnya.')
  if (hasExplicitPermission(res.locals.user, 'audit.assigned') && audit.assignedAuditorId !== actor) return fail(res, 404, 'NOT_FOUND', 'Audit tidak ditugaskan kepada auditor ini.')
  const transitions: Record<string, string[]> = { DRAFT: ['SCHEDULED'], SCHEDULED: ['IN_PROGRESS'], IN_PROGRESS: ['SUBMITTED'], SUBMITTED: ['APPROVED', 'REVISION_REQUIRED'], REVISION_REQUIRED: ['IN_PROGRESS'], APPROVED: ['CLOSED'] }
  if (!transitions[audit.status]?.includes(input.status)) return fail(res, 409, 'INVALID_STATE', 'Perubahan status tidak diizinkan.')
  if (['APPROVED', 'REVISION_REQUIRED'].includes(input.status) && audit.createdBy === actor && (await db.organization.findUnique({ where: { id: org }, select: { auditApprovalSoD: true } }))?.auditApprovalSoD !== false) return fail(res, 403, 'FORBIDDEN', 'Pembuat audit tidak dapat menyetujui atau meminta revisi auditnya sendiri.')
  if (input.status === 'REVISION_REQUIRED' && !input.comments) return fail(res, 422, 'VALIDATION_ERROR', 'Alasan revisi diperlukan.')
  const changed = await db.$transaction(async tx => {
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "EnergyAudit" WHERE "id" = ${audit.id}::uuid AND "organizationId" = ${org}::uuid FOR UPDATE`
    if (!locked[0] || locked[0].status !== audit.status) return 0
    if (input.status === 'CLOSED') {
      const unresolved = await tx.auditFinding.count({ where: { auditId: audit.id, OR: [{ actions: { none: {} } }, { actions: { some: { status: { not: 'CLOSED' } } } }] } })
      if (unresolved) return -1
    }
    const updated = await tx.energyAudit.updateMany({ where: { id: audit.id, organizationId: org, status: audit.status }, data: { status: input.status, approvalComments: input.comments } })
    if (updated.count) await tx.auditLog.create({ data: { organizationId: org, userId: actor, action: 'AUDIT_STATUS_CHANGED', entity: 'EnergyAudit', entityId: audit.id, details: { from: audit.status, to: input.status, comments: input.comments || null } } })
    return updated.count
  })
  if (changed === -1) return fail(res, 409, 'INVALID_STATE', 'Semua temuan harus memiliki tindakan korektif yang ditutup.')
  if (!changed) return fail(res, 409, 'INVALID_STATE', 'Status audit telah berubah. Muat ulang.')
  return ok(res, await db.energyAudit.findUnique({ where: { id: audit.id } }))
}))
const reportInputSchema = z.object({ type: z.enum(['ENERGY', 'COST', 'QUALITY', 'ALERTS', 'AUDIT', 'EMISSIONS']).default('ENERGY'), periodStart: z.string().datetime({ offset: true }), periodEnd: z.string().datetime({ offset: true }), siteId: z.string().uuid().optional(), buildingId: z.string().uuid().optional(), meterId: z.string().uuid().optional(), timezone: z.string().refine(value => { try { Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }).optional(), granularity: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH']).default('DAY'), emissionFactorId: z.string().uuid().optional(), format: z.enum(['CSV', 'XLSX', 'PDF']).default('CSV') }).refine(v => new Date(v.periodEnd) > new Date(v.periodStart) && new Date(v.periodEnd).getTime() - new Date(v.periodStart).getTime() <= 366 * 86400000, { message: 'Periode harus positif dan maksimum 366 hari.', path: ['periodEnd'] }).refine(v => !v.emissionFactorId || !!v.siteId, { message: 'Site diperlukan untuk estimasi emisi.', path: ['siteId'] }).refine(v => v.type !== 'EMISSIONS' || !!v.siteId, { message: 'Site diperlukan untuk laporan emisi.', path: ['siteId'] }).refine(v => !v.meterId || !!v.siteId, { message: 'Site diperlukan ketika laporan difilter berdasarkan meter.', path: ['siteId'] }).refine(v => !v.buildingId || !!v.siteId, { message: 'Site diperlukan ketika laporan difilter berdasarkan gedung.', path: ['siteId'] })
type ReportInput = z.infer<typeof reportInputSchema>
type ReportFilters = { type?: ReportInput['type']; periodStart: string; periodEnd: string; timezone?: string; granularity?: 'HOUR' | 'DAY' | 'WEEK' | 'MONTH'; snapshotAt?: string; factorIds?: string[]; tariffAssignments?: unknown; snapshot?: Record<string, unknown>[]; costEstimate?: { estimatedCostIdr: string | null; tariffs: { tariffId: string }[] }; emissionsEstimate?: { estimatedTco2e: string | null; factor?: { id: string; energySource?: string; publicationSource: string; sourceUrl: string }; factors?: { id: string; energySource?: string; publicationSource: string; sourceUrl: string }[] } | null }
type ReportRecord = { id: string; organizationId: string; type: string; format: string; createdAt: Date; requestedBy: string; filters: Prisma.JsonValue; filePath?: string | null; attemptCount?: number }
const reportStorageRoot = resolve(process.env.REPORT_STORAGE_DIR || 'private/reports')
const reportExtension = (format: string) => format === 'XLSX' ? 'xlsx' : format === 'PDF' ? 'pdf' : 'csv'
function reportArtifactPath(organizationId: string, reportId: string, format: string) {
  const target = resolve(reportStorageRoot, organizationId, `${reportId}.${reportExtension(format)}`), rel = relative(reportStorageRoot, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('INVALID_REPORT_STORAGE_PATH')
  return target
}
function renderReportArtifact(report: ReportRecord) {
  const filters = report.filters as ReportFilters
  if (!Array.isArray(filters.snapshot)) throw new Error('REPORT_SNAPSHOT_MISSING')
  const factors = filters.emissionsEstimate?.factor ? [filters.emissionsEstimate.factor] : filters.emissionsEstimate?.factors ?? []
  const generatedAt = filters.snapshotAt ?? report.createdAt.toISOString()
  const reportType = filters.type ?? 'ENERGY'
  const shared = { title: `EnergiTrack ${reportType} Report`, generatedAt, generatedBy: report.requestedBy, periodStart: filters.periodStart, periodEnd: filters.periodEnd, timezone: filters.timezone, granularity: filters.granularity ?? 'DAY', rows: filters.snapshot, estimatedCostIdr: filters.costEstimate?.estimatedCostIdr, estimatedTco2e: filters.emissionsEstimate?.estimatedTco2e, tariffIds: filters.costEstimate?.tariffs.map(tariff => tariff.tariffId), factorIds: factors.map(factor => factor.id), energySources: factors.map(factor => factor.energySource ?? 'ELECTRICITY'), factorSources: factors.map(factor => factor.publicationSource), factorUrls: factors.map(factor => factor.sourceUrl) }
  if (report.format === 'XLSX') return { buffer: createXlsxReport(shared), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  if (report.format === 'PDF') return { buffer: createPdfReport(shared), type: 'application/pdf' }
  if (report.format !== 'CSV') throw new Error('UNSUPPORTED_REPORT_FORMAT')
  const csvCell = (value: string) => { const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value; return `"${safe.replace(/"/g, '""')}"` }
  const rows = filters.snapshot
  const cell = (value: unknown) => csvCell(value instanceof Date ? value.toISOString() : String(value ?? ''))
  const metadata: Record<string, unknown> = { report_type: reportType, timezone: filters.timezone ?? 'UTC', granularity: filters.granularity ?? 'DAY', period_start_utc: filters.periodStart, period_end_utc: filters.periodEnd, generated_at_utc: generatedAt, generated_by: report.requestedBy, estimated_cost_idr: filters.costEstimate?.estimatedCostIdr ?? '', tariff_version_ids: filters.costEstimate?.tariffs.map(item => item.tariffId).join(';') ?? '', estimated_tco2e: filters.emissionsEstimate?.estimatedTco2e ?? '', emission_factor_ids: factors.map(factor => factor.id).join(';'), emission_energy_sources: factors.map(factor => factor.energySource ?? 'ELECTRICITY').join(';'), emission_sources: factors.map(factor => factor.publicationSource).join(';'), emission_source_urls: factors.map(factor => factor.sourceUrl).join(';') }
  const columns = reportColumns([...rows, metadata])
  const csv = [columns.map(cell).join(','), ...(rows.length ? rows.map(row => columns.map(column => cell(row[column] ?? metadata[column as keyof typeof metadata])).join(',')) : [columns.map(column => cell(metadata[column as keyof typeof metadata])).join(',')])].join('\r\n') + '\r\n'
  return { buffer: Buffer.from(csv, 'utf8'), type: 'text/csv; charset=utf-8' }
}
async function writeReportArtifact(report: ReportRecord) {
  const artifact = renderReportArtifact(report), file = reportArtifactPath(report.organizationId, report.id, report.format)
  if (objectStorageConfigured) { const key = `reports/${report.organizationId}/${report.id}.${reportExtension(report.format)}`; await objectStorage.put(key, artifact.buffer, artifact.type); return `s3:${key}` }
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${randomUUID()}`
  await writeFile(temp, artifact.buffer, { flag: 'wx' })
  await rename(temp, file)
  return relative(reportStorageRoot, file)
}
async function readReportArtifact(report: ReportRecord) {
  return report.filePath?.startsWith('s3:') ? objectStorage.get(report.filePath.slice(3)) : readFile(reportArtifactPath(report.organizationId, report.id, report.format))
}
async function reportRows(tx: Prisma.TransactionClient, type: ReportInput['type'], organizationId: string, start: Date, end: Date, meterFilter: Prisma.MeterWhereInput, siteId: string | undefined, timezone: string, granularity: ReportInput['granularity'], readings: EnergyReading[], prior: EnergyReading[]) {
  if (type === 'QUALITY') {
    const grouped = await tx.meterReading.groupBy({ by: ['meterId', 'quality'], where: { organizationId, timestamp: { gte: start, lt: end }, meter: meterFilter }, _count: { _all: true } })
    return grouped.map(row => ({ meterId: row.meterId, quality: row.quality, readingCount: row._count._all }))
  }
  if (type === 'ALERTS') {
    const alerts = await tx.alert.findMany({ where: { organizationId, triggeredAt: { gte: start, lt: end }, meter: meterFilter }, select: { id: true, meterId: true, status: true, message: true, triggeredAt: true, resolvedAt: true, rule: { select: { severity: true, name: true } } }, orderBy: { triggeredAt: 'asc' } })
    return alerts.map(({ rule, ...alert }) => ({ ...alert, severity: rule.severity, ruleName: rule.name }))
  }
  if (type === 'AUDIT') {
    const audits = await tx.energyAudit.findMany({ where: { organizationId, ...(siteId ? { siteId } : {}), scheduledAt: { gte: start, lt: end } }, select: { id: true, siteId: true, title: true, status: true, assignedAuditorId: true, scheduledAt: true, _count: { select: { findings: true } } }, orderBy: { scheduledAt: 'asc' } })
    return audits.map(({ _count, ...audit }) => ({ ...audit, findingCount: _count.findings }))
  }
  return energyByTimezoneBucket(readings, prior, timezone, granularity)
}
type ReportTariffAssignment = Awaited<ReturnType<typeof getTariffAssignments>>[number]
function restoreTariffAssignments(value: unknown): ReportTariffAssignment[] {
  if (!Array.isArray(value)) throw new Error('REPORT_TARIFF_SNAPSHOT_MISSING')
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('REPORT_TARIFF_SNAPSHOT_INVALID')
    const row = entry as Record<string, unknown>
    if (typeof row.meterId !== 'string' || typeof row.tariffId !== 'string' || typeof row.tariffName !== 'string' || typeof row.effectiveFrom !== 'string' || !Array.isArray(row.rates)) throw new Error('REPORT_TARIFF_SNAPSHOT_INVALID')
    return { meterId: row.meterId, tariffId: row.tariffId, tariffName: row.tariffName, unitRate: new Prisma.Decimal(String(row.unitRate)), tariffType: String(row.tariffType), fixedCharge: new Prisma.Decimal(String(row.fixedCharge)), taxPercent: new Prisma.Decimal(String(row.taxPercent)), timezone: String(row.timezone), effectiveFrom: new Date(row.effectiveFrom), effectiveTo: typeof row.effectiveTo === 'string' ? new Date(row.effectiveTo) : null, rates: row.rates.map((rate: unknown) => {
      if (!rate || typeof rate !== 'object' || Array.isArray(rate)) throw new Error('REPORT_TARIFF_SNAPSHOT_INVALID')
      return rate as { startMinute: number; endMinute: number; unitRate: string }
    }) }
  })
}
async function materializeReportSnapshot(report: ReportRecord): Promise<ReportRecord> {
  const filters = report.filters as ReportFilters, input = reportInputSchema.parse(filters)
  if (!Array.isArray(filters.factorIds)) throw new Error('REPORT_SNAPSHOT_PARAMETERS_MISSING')
  const org = report.organizationId, start = new Date(input.periodStart), requestedEnd = new Date(input.periodEnd), requestedSnapshotAt = filters.snapshotAt ? new Date(filters.snapshotAt) : null
  if (requestedSnapshotAt && Number.isNaN(requestedSnapshotAt.getTime())) throw new Error('REPORT_SNAPSHOT_TIME_INVALID')
  const meterFilter = { organizationId: org, ...(input.siteId ? { siteId: input.siteId } : {}), ...(input.buildingId ? { asset: { buildingId: input.buildingId } } : {}), ...(input.meterId ? { id: input.meterId } : {}) }
  const factors = filters.factorIds.length ? await db.emissionFactor.findMany({ where: { organizationId: org, id: { in: filters.factorIds } } }) : []
  const assignments = restoreTariffAssignments(filters.tariffAssignments)
  const materialized = await db.$transaction(async tx => {
    const snapshotRows = requestedSnapshotAt ? [] : await tx.$queryRaw<{ snapshotAt: Date }[]>`SELECT transaction_timestamp() AS "snapshotAt"`
    const snapshotAt = requestedSnapshotAt ?? snapshotRows[0]?.snapshotAt
    if (!snapshotAt) throw new Error('REPORT_SNAPSHOT_TIME_UNAVAILABLE')
    const end = requestedEnd < snapshotAt ? requestedEnd : snapshotAt
    const scope = { organizationId: org, quality: 'VALID', meter: meterFilter }
    const [readings, prior, meters] = await Promise.all([
      tx.meterReading.findMany({ where: { ...scope, createdAt: { lte: snapshotAt }, timestamp: { gte: start, lt: end } }, include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { where: { createdAt: { lte: snapshotAt } }, select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'asc' } }),
      tx.meterReading.findMany({ where: { ...scope, createdAt: { lte: snapshotAt }, timestamp: { lt: start } }, distinct: ['meterId'], include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { where: { createdAt: { lte: snapshotAt } }, select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'desc' } }),
      tx.meter.findMany({ where: meterFilter, select: { id: true } })
    ])
    const meterIds = new Set(meters.map(meter => meter.id)), scopedAssignments = assignments.filter((assignment: { meterId: string }) => meterIds.has(assignment.meterId))
    const snapshot = await reportRows(tx, input.type, org, start, end, meterFilter, input.siteId, filters.timezone ?? 'UTC', input.granularity, readings, prior)
    const baseCost = estimateFlatCost(readings, prior, scopedAssignments), fixed = estimateFixedCharges(scopedAssignments, start, requestedEnd), fixedCost = new Prisma.Decimal(fixed.fixedChargeIdr)
    const costEstimate = { ...baseCost, ...fixed, pricedCostIdr: baseCost.pricedCostIdr === null ? null : new Prisma.Decimal(baseCost.pricedCostIdr).add(fixedCost).toDecimalPlaces(2).toFixed(2), estimatedCostIdr: baseCost.estimatedCostIdr === null ? null : new Prisma.Decimal(baseCost.estimatedCostIdr).add(fixedCost).toDecimalPlaces(2).toFixed(2) }
    const emissionsEstimate = factors.length ? input.emissionFactorId ? estimateEmissions(readings, prior, factors[0]) : estimateEmissionsByYear(readings, prior, factors) : null
    return { snapshotAt, snapshot, costEstimate, emissionsEstimate }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  const updatedFilters = { ...filters, snapshotAt: materialized.snapshotAt.toISOString(), snapshot: materialized.snapshot, costEstimate: materialized.costEstimate, emissionsEstimate: materialized.emissionsEstimate }
  await db.reportJob.updateMany({ where: { id: report.id, organizationId: org, status: 'PROCESSING' }, data: { filters: updatedFilters as Prisma.InputJsonObject } })
  return { ...report, filters: updatedFilters as Prisma.JsonValue }
}
async function processOneReportJob() {
  const report = await db.$transaction(async tx => {
    await tx.$executeRaw`UPDATE "ReportJob" SET "status" = 'QUEUED', "processingAt" = NULL WHERE "status" = 'PROCESSING' AND "processingAt" < CURRENT_TIMESTAMP - INTERVAL '10 minutes'`
    const claimed = await tx.$queryRaw<ReportRecord[]>`WITH candidate AS (SELECT "id" FROM "ReportJob" WHERE "status" = 'QUEUED' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= CURRENT_TIMESTAMP) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE "ReportJob" r SET "status" = 'PROCESSING', "processingAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1 FROM candidate WHERE r."id" = candidate."id" RETURNING r.*`
    return claimed[0] ?? null
  })
  if (!report) return false
  try {
    const filters = report.filters as ReportFilters
    const materialized = Array.isArray(filters.snapshot) ? report : await materializeReportSnapshot(report)
    const filePath = await writeReportArtifact(materialized)
    await db.$transaction(async tx => {
      const retentionDays = Math.max(1, Math.min(3650, Number(process.env.REPORT_RETENTION_DAYS) || 365))
      const updated = await tx.$executeRaw`UPDATE "ReportJob" SET "filePath" = ${filePath}, "status" = 'COMPLETED', "processingAt" = NULL, "nextAttemptAt" = NULL, "completedAt" = CURRENT_TIMESTAMP, "expiresAt" = CURRENT_TIMESTAMP + (${retentionDays} * INTERVAL '1 day'), "failureReason" = NULL WHERE "id" = ${report.id}::uuid AND "organizationId" = ${report.organizationId}::uuid AND "status" = 'PROCESSING'`
      if (updated) { await tx.auditLog.create({ data: { organizationId: report.organizationId, userId: report.requestedBy, action: 'REPORT_FILE_READY', entity: 'ReportJob', entityId: report.id, details: { format: report.format, storage: objectStorageConfigured ? 'S3_COMPATIBLE' : 'TENANT_LOCAL' } } }); await tx.webhookOutbox.create({ data: { organizationId: report.organizationId, event: 'report.completed', payload: { reportId: report.id, format: report.format, status: 'COMPLETED', completedAt: new Date().toISOString() } } }) }
    })
  } catch (error) {
    logEvent('error', 'report_export_job_failed', { reportId: report.id, error })
    const attemptCount = report.attemptCount ?? 1
    const retry = reportRetry(attemptCount), willRetry = retry.retry
    const delaySeconds = Math.ceil(retry.delayMs / 1000)
    await db.$transaction(async tx => {
      const updated = await tx.$executeRaw`UPDATE "ReportJob" SET "status" = ${willRetry ? 'QUEUED' : 'FAILED'}, "processingAt" = NULL, "nextAttemptAt" = ${willRetry ? new Date(Date.now() + delaySeconds * 1000) : null}, "failureReason" = ${willRetry ? `Artifact gagal dibuat; percobaan ${attemptCount}/3, retry dalam ${delaySeconds} detik.` : 'Artifact gagal dibuat setelah tiga percobaan.'} WHERE "id" = ${report.id}::uuid AND "organizationId" = ${report.organizationId}::uuid AND "status" = 'PROCESSING'`
      if (updated) await tx.auditLog.create({ data: { organizationId: report.organizationId, userId: report.requestedBy, action: willRetry ? 'REPORT_EXPORT_RETRY_SCHEDULED' : 'REPORT_EXPORT_FAILED', entity: 'ReportJob', entityId: report.id, details: { attemptCount, retryInSeconds: willRetry ? delaySeconds : null } } })
    })
  }
  return true
}
async function expireReportArtifacts() {
  const expired = await db.reportJob.findMany({ where: { status: 'COMPLETED', expiresAt: { lte: new Date() }, filePath: { not: null } }, orderBy: { expiresAt: 'asc' }, take: 100, select: { id: true, organizationId: true, format: true, filePath: true, requestedBy: true } })
  for (const report of expired) {
    if (report.filePath!.startsWith('s3:')) await objectStorage.delete(report.filePath!.slice(3))
    else await unlink(reportArtifactPath(report.organizationId, report.id, report.format)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    await db.$transaction(async tx => {
      const updated = await tx.reportJob.updateMany({ where: { id: report.id, organizationId: report.organizationId, status: 'COMPLETED', filePath: report.filePath }, data: { status: 'EXPIRED', filePath: null } })
      if (updated.count) await tx.auditLog.create({ data: { organizationId: report.organizationId, userId: report.requestedBy, action: 'REPORT_ARTIFACT_EXPIRED', entity: 'ReportJob', entityId: report.id, details: { retentionDays: Number(process.env.REPORT_RETENTION_DAYS) || 365 } } })
    })
  }
  return expired.length
}
api.get('/reports', auth, wrap(async (req, res) => {
  const org = res.locals.user.organizationId, ids: string[] | undefined = res.locals.allowedSiteIds
  const query=pageQuery(req,['createdAt','status','format','type'],'createdAt'),scope=ids?(ids.length?Prisma.sql`AND "filters"->>'siteId' IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}`))})`:Prisma.sql`AND FALSE`):Prisma.empty,search=query.search?Prisma.sql`AND ("type" ILIKE ${`%${query.search}%`} OR "format" ILIKE ${`%${query.search}%`} OR "status" ILIKE ${`%${query.search}%`})`:Prisma.empty
  const counts=await db.$queryRaw<{count:bigint}[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "ReportJob" WHERE "organizationId"=${org}::uuid ${scope} ${search}`)
  const reports=await db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`SELECT * FROM "ReportJob" WHERE "organizationId"=${org}::uuid ${scope} ${search} ORDER BY ${Prisma.raw(`"${query.sort}" ${query.direction.toUpperCase()}`)} LIMIT ${query.requested?query.pageSize:100} OFFSET ${query.requested?(query.page-1)*query.pageSize:0}`)
  return ok(res,pageResult(reports,Number(counts[0]?.count||0),query))
}))
api.get('/reports/:id', auth, wrap(async (req, res) => {
  const org = res.locals.user.organizationId, ids: string[] | undefined = res.locals.allowedSiteIds
  const reports = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT * FROM "ReportJob" WHERE "id" = ${req.params.id}::uuid AND "organizationId" = ${org}::uuid ${ids ? (ids.length ? Prisma.sql`AND "filters"->>'siteId' IN (${Prisma.join(ids.map(id => Prisma.sql`${id}`))})` : Prisma.sql`AND FALSE`) : Prisma.empty} LIMIT 1`)
  return reports[0] ? ok(res, reports[0]) : fail(res, 404, 'NOT_FOUND', 'Laporan tidak ditemukan.')
}))
api.post('/reports', auth, csrf, allowRoles('ADMIN', 'ANALYST'), wrap(async (req, res) => {
  const input = reportInputSchema.parse(req.body)
  const org = res.locals.user.organizationId, start = new Date(input.periodStart), end = new Date(input.periodEnd)
  const rawKey = req.get('Idempotency-Key'), idempotencyKey = rawKey?.trim()
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey))) return fail(res, 422, 'VALIDATION_ERROR', 'Idempotency-Key harus 8–200 karakter yang valid.')
  const requestHash = idempotencyKey ? createHash('sha256').update(JSON.stringify(input)).digest('hex') : null
  if (idempotencyKey) {
    const existing = await db.reportJob.findFirst({ where: { organizationId: org, idempotencyKey } })
    if (existing) return existing.requestHash === requestHash ? ok(res, existing) : fail(res, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key telah digunakan untuk parameter laporan berbeda.')
  }
  const site = input.siteId ? await siteForOrg(input.siteId, org) : null
  if (input.siteId && !site) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  const building = input.buildingId ? await db.building.findFirst({ where: { id: input.buildingId, organizationId: org, siteId: input.siteId!, status: 'ACTIVE' } }) : null
  if (input.buildingId && !building) return fail(res, 404, 'NOT_FOUND', 'Gedung tidak ditemukan pada site laporan.')
  const meter = input.meterId ? await db.meter.findFirst({ where: { id: input.meterId, organizationId: org, siteId: input.siteId, ...(input.buildingId ? { asset: { buildingId: input.buildingId } } : {}) } }) : null
  if (input.meterId && !meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan pada site laporan.')
  const timezone = input.timezone ?? site?.timezone ?? 'UTC'
  const factors = site ? await emissionFactorsForSite(org, site, start, end, input.emissionFactorId) : []
  if (input.emissionFactorId && !factors.length) {
    const factorExists = await db.emissionFactor.findFirst({ where: { id: input.emissionFactorId, organizationId: org }, select: { id: true } })
    return factorExists ? fail(res, 422, 'INCOMPATIBLE_EMISSION_FACTOR', 'Faktor tidak cocok dengan wilayah, tahun, atau tanggal efektif untuk periode ini.') : fail(res, 404, 'NOT_FOUND', 'Faktor emisi tidak ditemukan.')
  }
  if (factors.some(factor => factor.unit !== 'kgCO2e/kWh')) return fail(res, 422, 'INCOMPATIBLE_FACTOR_UNIT', 'Faktor harus menggunakan kgCO2e/kWh.')
  const meterFilter = { organizationId: org, ...(input.siteId ? { siteId: input.siteId } : {}), ...(input.buildingId ? { asset: { buildingId: input.buildingId } } : {}), ...(input.meterId ? { id: input.meterId } : {}) }
  const scope = { organizationId: org, quality: 'VALID', meter: meterFilter }
  const bucketMs = input.granularity === 'HOUR' ? 3_600_000 : input.granularity === 'DAY' ? 86_400_000 : input.granularity === 'WEEK' ? 7 * 86_400_000 : 28 * 86_400_000
  const expectedBuckets = Math.ceil((end.getTime() - start.getTime()) / bucketMs) + 2
  if (expectedBuckets > 90) {
    const [allAssignments, meters] = await Promise.all([getTariffAssignments(org, input.siteId), db.meter.findMany({ where: meterFilter, select: { id: true } })])
    const meterIds = new Set(meters.map(item => item.id))
    const tariffAssignments = allAssignments.filter(item => meterIds.has(item.meterId)).map(item => ({ ...item, unitRate: String(item.unitRate), fixedCharge: String(item.fixedCharge), taxPercent: String(item.taxPercent), rates: item.rates.map(rate => ({ ...rate, unitRate: String(rate.unitRate) })), effectiveFrom: item.effectiveFrom.toISOString(), effectiveTo: item.effectiveTo?.toISOString() ?? null }))
    const factorIds = factors.map(factor => factor.id)
    const queued = await db.$transaction(async tx => {
      const item = await tx.reportJob.create({ data: { organizationId: org, type: input.type, format: input.format, filters: { ...input, timezone, factorIds, tariffAssignments }, status: 'QUEUED', requestedBy: res.locals.user.id, idempotencyKey, requestHash } })
      await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'REPORT_CREATED', entity: 'ReportJob', entityId: item.id, details: { calculation: 'ASYNC', granularity: input.granularity } } })
      return item
    })
    return ok(res, queued, 202)
  }
  const report = await db.$transaction(async tx => {
    const [readings, prior, assignments, meters] = await Promise.all([
      tx.meterReading.findMany({ where: { ...scope, timestamp: { gte: start, lt: end } }, include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'asc' } }),
      tx.meterReading.findMany({ where: { ...scope, timestamp: { lt: start } }, distinct: ['meterId'], include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'desc' } }),
      getTariffAssignments(org, input.siteId, tx),
      tx.meter.findMany({ where: meterFilter, select: { id: true } })
    ])
    const selectedMeterIds = new Set(meters.map(meter => meter.id)), scopedAssignments = assignments.filter(assignment => selectedMeterIds.has(assignment.meterId))
    const snapshot = await reportRows(tx, input.type, org, start, end, meterFilter, input.siteId, timezone, input.granularity, readings, prior), baseCost = estimateFlatCost(readings, prior, scopedAssignments), fixed = estimateFixedCharges(scopedAssignments, start, end), fixedCost = new Prisma.Decimal(fixed.fixedChargeIdr)
    const costEstimate = { ...baseCost, ...fixed, pricedCostIdr: baseCost.pricedCostIdr === null ? null : new Prisma.Decimal(baseCost.pricedCostIdr).add(fixedCost).toDecimalPlaces(2).toFixed(2), estimatedCostIdr: baseCost.estimatedCostIdr === null ? null : new Prisma.Decimal(baseCost.estimatedCostIdr).add(fixedCost).toDecimalPlaces(2).toFixed(2) }
    const emissionsEstimate = factors.length ? input.emissionFactorId ? estimateEmissions(readings, prior, factors[0]) : estimateEmissionsByYear(readings, prior, factors) : null
    const isLargeExport = snapshot.length > 90
    const item = await tx.reportJob.create({ data: { organizationId: org, type: input.type, format: input.format, filters: { ...input, timezone, snapshot, costEstimate, emissionsEstimate }, status: isLargeExport ? 'QUEUED' : 'COMPLETED', requestedBy: res.locals.user.id, idempotencyKey, requestHash, completedAt: isLargeExport ? null : new Date() } })
    await tx.auditLog.create({ data: { organizationId: org, userId: res.locals.user.id, action: 'REPORT_CREATED', entity: 'ReportJob', entityId: item.id } })
    return item
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  return ok(res, report, report.status === 'QUEUED' ? 202 : 201)
}))
api.get('/reports/:id/download-link', auth, allowRoles('ADMIN', 'ENERGY_MANAGER', 'ANALYST', 'EXECUTIVE'), wrap(async (req, res) => {
  const report = await db.reportJob.findFirst({ where: { id: req.params.id, organizationId: res.locals.user.organizationId, status: 'COMPLETED' }, select: { id: true, organizationId: true } })
  if (!report) return fail(res, 404, 'NOT_FOUND', 'Laporan siap diunduh tidak ditemukan.')
  const expires = Math.floor(Date.now() / 1000) + 15 * 60, signature = createHmac('sha256', secret!).update(`${report.id}.${report.organizationId}.${expires}`).digest('hex')
  const origin = process.env.API_PUBLIC_URL || (req.get('Origin') && allowedOrigins.has(req.get('Origin')!) ? req.get('Origin')! : `http://127.0.0.1:${Number(process.env.PORT || 3000)}`)
  await db.auditLog.create({ data: { organizationId: report.organizationId, userId: res.locals.user.id, action: 'REPORT_DOWNLOAD_LINK_CREATED', entity: 'ReportJob', entityId: report.id, details: { expiresAt: new Date(expires * 1000).toISOString() } } })
  return ok(res, { url: `${origin}/api/v1/reports/${report.id}/signed-download?expires=${expires}&signature=${signature}`, expiresAt: new Date(expires * 1000).toISOString() })
}))
api.get('/reports/:id/download', auth, allowRoles('ADMIN', 'ENERGY_MANAGER', 'ANALYST', 'EXECUTIVE'), wrap(async (req, res) => {
  const report = await db.reportJob.findFirst({ where: { id: req.params.id, organizationId: res.locals.user.organizationId, status: 'COMPLETED' } })
  if (!report) return fail(res, 404, 'NOT_FOUND', 'Laporan tidak ditemukan.')
  const artifact = report.filePath ? { buffer: await readReportArtifact(report), type: renderReportArtifact(report).type } : renderReportArtifact(report)
  await db.auditLog.create({ data: { organizationId: res.locals.user.organizationId, userId: res.locals.user.id, action: 'REPORT_DOWNLOADED', entity: 'ReportJob', entityId: report.id } })
  res.setHeader('Content-Disposition', `attachment; filename="energy-${report.id}.${reportExtension(report.format)}"`)
  return res.type(artifact.type).send(artifact.buffer)
}))
api.get('/monitoring/summary', auth, wrap(async (req, res) => {
  const orgId = res.locals.user.organizationId
  const input = z.object({ siteId: z.string().uuid().optional(), buildingId: z.string().uuid().optional(), meterId: z.string().uuid().optional(), metric: z.enum(['ENERGY_IMPORT', 'POWER_DEMAND']).default('ENERGY_IMPORT'), periodStart: z.string().datetime({ offset: true }).optional(), periodEnd: z.string().datetime({ offset: true }).optional(), days: z.coerce.number().int().min(1).max(365).default(30), comparePrevious: z.enum(['true', 'false']).transform(value => value === 'true').default('false') }).refine(v => (!!v.periodStart === !!v.periodEnd), { message: 'periodStart dan periodEnd harus digunakan bersama.' }).refine(v => !v.periodStart || new Date(v.periodEnd!) > new Date(v.periodStart), { path: ['periodEnd'], message: 'Periode tidak valid.' }).refine(v => !v.periodStart || new Date(v.periodEnd!).getTime() - new Date(v.periodStart).getTime() <= 366 * 86400000, { path: ['periodEnd'], message: 'Periode maksimum 366 hari.' }).parse(req.query)
  if (input.siteId && !await siteForOrg(input.siteId, orgId)) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  const building = input.buildingId ? await db.building.findFirst({ where: { id: input.buildingId, organizationId: orgId, ...(input.siteId ? { siteId: input.siteId } : {}) } }) : null
  if (input.buildingId && !building) return fail(res, 404, 'NOT_FOUND', 'Gedung tidak ditemukan.')
  const meter = input.meterId ? await db.meter.findFirst({ where: { id: input.meterId, organizationId: orgId, ...(input.siteId ? { siteId: input.siteId } : {}), ...(building ? { asset: { buildingId: building.id } } : {}) } }) : null
  if (input.meterId && !meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  const siteId = input.siteId ?? building?.siteId ?? meter?.siteId
  const now = input.periodEnd ? new Date(input.periodEnd) : new Date(), since = input.periodStart ? new Date(input.periodStart) : new Date(now.getTime() - input.days * 86400000)
  const whereMeters = { organizationId: orgId, status: { not: 'RETIRED' }, metric: input.metric, ...(siteId ? { siteId } : {}), ...(input.meterId ? { id: input.meterId } : {}), ...(building ? { asset: { buildingId: building.id } } : {}) }
  const meters = await db.meter.findMany({ where: whereMeters, include: { site: { select: { timezone: true } } } })
  const meterIds = meters.map(item => item.id)
  const idsFilter = { meterId: { in: meterIds } }
  const [siteCount, readings, prior, peakReadings, openAlerts, allAssignments] = await Promise.all([
    db.site.count({ where: { organizationId: orgId, status: 'ACTIVE', ...(siteId ? { id: siteId } : {}) } }),
    db.meterReading.findMany({ where: { organizationId: orgId, quality: 'VALID', timestamp: { gte: since, lte: now }, ...idsFilter, unit: 'kWh', meter: { metric: 'ENERGY_IMPORT' } }, include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { id: true, name: true, timezone: true } } } } }, orderBy: { timestamp: 'asc' } }),
    db.meterReading.findMany({ where: { organizationId: orgId, quality: 'VALID', timestamp: { lt: since }, ...idsFilter, unit: 'kWh', meter: { metric: 'ENERGY_IMPORT' } }, distinct: ['meterId'], include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { id: true, name: true, timezone: true } } } } }, orderBy: { timestamp: 'desc' } }),
    db.meterReading.findMany({ where: { organizationId: orgId, quality: 'VALID', timestamp: { gte: since, lte: now }, ...idsFilter, unit: 'kW', meter: { metric: 'POWER_DEMAND' } }, select: { meterId: true, timestamp: true, value: true } }),
    db.alert.count({ where: { organizationId: orgId, status: { in: ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'] }, ...(siteId ? { meter: { siteId } } : {}), ...(input.meterId ? { meterId: input.meterId } : {}), ...(building ? { meter: { asset: { buildingId: building.id } } } : {}) } }),
    getTariffAssignments(orgId, siteId)
  ])
  const assignments = allAssignments.filter(item => meterIds.includes(item.meterId))
  const buckets = energyByLocalDay(readings, prior)
  const energy = buckets.reduce((sum, bucket) => sum + bucket.kwh, 0)
  const expected = meters.reduce((total, item) => {
    const from = item.installedAt && item.installedAt > since ? item.installedAt : since
    const to = item.decommissionedAt && item.decommissionedAt < now ? item.decommissionedAt : now
    return total + (to > from ? Math.floor((to.getTime() - from.getTime()) / (item.intervalMinutes * 60_000)) : 0)
  }, 0)
  const observed = new Set((input.metric === 'ENERGY_IMPORT' ? readings : peakReadings).map(item => `${item.meterId}:${item.timestamp.toISOString()}`)).size
  const cost = input.metric === 'ENERGY_IMPORT' ? estimateFlatCost(readings, prior, assignments) : null, fixed = input.metric === 'ENERGY_IMPORT' ? estimateFixedCharges(assignments, since, now) : { fixedChargeIdr: '0.00' }
  const costIdr = cost?.estimatedCostIdr === null || !cost ? null : new Prisma.Decimal(cost.estimatedCostIdr).add(fixed.fixedChargeIdr).toDecimalPlaces(2).toFixed(2)
  const timezone = siteId ? (await db.site.findFirst({ where: { id: siteId, organizationId: orgId }, select: { timezone: true } }))?.timezone ?? 'UTC' : 'UTC'
  const peakDemandKw = peakReadings.reduce<Prisma.Decimal | null>((max, item) => !max || item.value.gt(max) ? item.value : max, null)
  const rankingGroups = new Map<string, { name: string; readings: typeof readings; prior: typeof prior }>()
  if (input.metric === 'ENERGY_IMPORT') {
    for (const item of [...readings, ...prior]) {
      let group = rankingGroups.get(item.meter.site.id)
      if (!group) { group = { name: item.meter.site.name, readings: [], prior: [] }; rankingGroups.set(item.meter.site.id, group) }
      if (item.timestamp < since) group.prior.push(item)
      else group.readings.push(item)
      rankingGroups.set(item.meter.site.id, group)
    }
  }
  const siteRanking = [...rankingGroups].map(([rankedSiteId, group]) => ({ siteId: rankedSiteId, siteName: group.name, energyKwh: Number(energyByLocalDay(group.readings, group.prior).reduce((sum, bucket) => sum + bucket.kwh, 0).toFixed(2)) })).sort((a, b) => b.energyKwh - a.energyKwh)
  let comparison: Record<string, unknown> | null = null
  if (input.comparePrevious) {
    const duration = now.getTime() - since.getTime(), previousStart = new Date(since.getTime() - duration), previousEnd = since
    const [previousReadings, previousPrior, previousPeakReadings] = await Promise.all([
      db.meterReading.findMany({ where: { organizationId: orgId, quality: 'VALID', timestamp: { gte: previousStart, lt: previousEnd }, ...idsFilter, unit: 'kWh', meter: { metric: 'ENERGY_IMPORT' } }, include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'asc' } }),
      db.meterReading.findMany({ where: { organizationId: orgId, quality: 'VALID', timestamp: { lt: previousStart }, ...idsFilter, unit: 'kWh', meter: { metric: 'ENERGY_IMPORT' } }, distinct: ['meterId'], include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'desc' } }),
      db.meterReading.findMany({ where: { organizationId: orgId, quality: 'VALID', timestamp: { gte: previousStart, lt: previousEnd }, ...idsFilter, unit: 'kW', meter: { metric: 'POWER_DEMAND' } }, select: { meterId: true, timestamp: true, value: true } })
    ])
    const previousBuckets = energyByLocalDay(previousReadings, previousPrior), previousEnergy = previousBuckets.reduce((sum, bucket) => sum + bucket.kwh, 0)
    const previousPeak = previousPeakReadings.reduce<Prisma.Decimal | null>((max, item) => !max || item.value.gt(max) ? item.value : max, null)
    const previousExpected = meters.reduce((total, item) => {
      const from = item.installedAt && item.installedAt > previousStart ? item.installedAt : previousStart
      const to = item.decommissionedAt && item.decommissionedAt < previousEnd ? item.decommissionedAt : previousEnd
      return total + (to > from ? Math.floor((to.getTime() - from.getTime()) / (item.intervalMinutes * 60_000)) : 0)
    }, 0)
    const previousObserved = new Set((input.metric === 'ENERGY_IMPORT' ? previousReadings : previousPeakReadings).map(item => `${item.meterId}:${item.timestamp.toISOString()}`)).size
    const previousCost = input.metric === 'ENERGY_IMPORT' ? estimateFlatCost(previousReadings, previousPrior, assignments) : null
    const previousFixed = input.metric === 'ENERGY_IMPORT' ? estimateFixedCharges(assignments, previousStart, previousEnd) : { fixedChargeIdr: '0.00' }
    const previousCostIdr = !previousCost || previousCost.estimatedCostIdr === null ? null : new Prisma.Decimal(previousCost.estimatedCostIdr).add(previousFixed.fixedChargeIdr).toDecimalPlaces(2).toFixed(2)
    const currentMetric = input.metric === 'ENERGY_IMPORT' ? (buckets.length ? energy : null) : (peakDemandKw?.toNumber() ?? null)
    const previousMetric = input.metric === 'ENERGY_IMPORT' ? (previousBuckets.length ? previousEnergy : null) : (previousPeak?.toNumber() ?? null)
    comparison = {
      periodStart: previousStart.toISOString(), periodEnd: previousEnd.toISOString(), durationMs: duration,
      energyKwh: previousBuckets.length ? Number(previousEnergy.toFixed(2)) : null,
      peakDemandKw: previousPeak?.toString() ?? null,
      estimatedCostIdr: previousCostIdr,
      completenessPercent: previousExpected ? Number((Math.min(previousObserved, previousExpected) * 100 / previousExpected).toFixed(2)) : null,
      expectedReadings: previousExpected, observedReadings: previousObserved,
      metricChangePercent: currentMetric !== null && previousMetric !== null && previousMetric !== 0 ? Number(((currentMetric - previousMetric) * 100 / Math.abs(previousMetric)).toFixed(2)) : null,
      costChangePercent: costIdr !== null && previousCostIdr !== null && Number(previousCostIdr) !== 0 ? Number(((Number(costIdr) - Number(previousCostIdr)) * 100 / Math.abs(Number(previousCostIdr))).toFixed(2)) : null
    }
  }
  const result = { siteCount, meterCount: meters.length, openAlerts, metric: input.metric, energyKwh: input.metric === 'ENERGY_IMPORT' && buckets.length ? Number(energy.toFixed(2)) : null, peakDemandKw: input.metric === 'POWER_DEMAND' ? peakDemandKw?.toString() ?? null : null, siteRanking, estimatedCostIdr: costIdr, completenessPercent: expected ? Number((Math.min(observed, expected) * 100 / expected).toFixed(2)) : null, expectedReadings: expected, observedReadings: observed, periodDays: Number(((now.getTime() - since.getTime()) / 86400000).toFixed(2)), periodStart: since.toISOString(), periodEnd: now.toISOString(), timezone, comparison, note: 'Energi menggunakan bacaan tervalidasi; periode hilang tetap menjadi gap. Perbandingan memakai durasi UTC yang sama dan menghitung perubahan hanya jika kedua periode memiliki data. Kelengkapan dibandingkan dengan interval konfigurasi meter. Biaya/emisi adalah estimasi konfigurasi.' }
  return ok(res, result)
}))
api.get('/monitoring/timeseries', auth, wrap(async (req, res) => {
  const orgId = res.locals.user.organizationId
  const input = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), siteId: z.string().uuid().optional(), buildingId: z.string().uuid().optional(), meterId: z.string().uuid().optional(), metric: z.enum(['ENERGY_IMPORT', 'POWER_DEMAND']).default('ENERGY_IMPORT'), bucket: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH']).default('DAY'), periodStart: z.string().datetime({ offset: true }).optional(), periodEnd: z.string().datetime({ offset: true }).optional() }).refine(v => (!!v.periodStart === !!v.periodEnd), { message: 'periodStart dan periodEnd harus digunakan bersama.' }).refine(v => !v.periodStart || new Date(v.periodEnd!) > new Date(v.periodStart), { path: ['periodEnd'], message: 'Periode tidak valid.' }).refine(v => !v.periodStart || new Date(v.periodEnd!).getTime() - new Date(v.periodStart).getTime() <= 366 * 86400000, { path: ['periodEnd'], message: 'Periode maksimum 366 hari.' }).refine(v => !v.buildingId || !!v.siteId, { path: ['siteId'], message: 'Site diperlukan jika memilih gedung.' }).parse(req.query)
  const { siteId } = input
  if (siteId && !await siteForOrg(siteId, orgId)) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  const timezone = siteId ? (await db.site.findFirst({ where: { id: siteId, organizationId: orgId }, select: { timezone: true } }))!.timezone : 'UTC'
  const building = input.buildingId ? await db.building.findFirst({ where: { id: input.buildingId, organizationId: orgId, siteId: siteId!, status: 'ACTIVE' }, select: { id: true } }) : null
  if (input.buildingId && !building) return fail(res, 404, 'NOT_FOUND', 'Gedung tidak ditemukan.')
  const meter = input.meterId ? await db.meter.findFirst({ where: { id: input.meterId, organizationId: orgId, metric: input.metric, ...(siteId ? { siteId } : {}), ...(input.buildingId ? { asset: { buildingId: input.buildingId } } : {}) }, select: { id: true } }) : null
  if (input.meterId && !meter) return fail(res, 404, 'NOT_FOUND', 'Meter tidak ditemukan.')
  const now = input.periodEnd ? new Date(input.periodEnd) : new Date(), since = input.periodStart ? new Date(input.periodStart) : new Date(now.getTime() - input.days * 86400000)
  const scope = { ...(siteId ? { siteId } : {}), ...(building ? { asset: { buildingId: building.id } } : {}), ...(input.meterId ? { id: input.meterId } : {}), metric: input.metric }
  if (input.metric === 'ENERGY_IMPORT' && input.bucket !== 'WEEK' && siteId) {
    const localClock = (instant: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(instant)
    const firstDate = siteDate(since, timezone), clockIsBoundary = localClock(since) === '00:00:00' && localClock(now) === '00:00:00'
    const fullBuckets = input.bucket === 'HOUR'
      ? localClock(since).endsWith(':00:00') && localClock(now).endsWith(':00:00')
      : input.bucket === 'DAY' ? clockIsBoundary
      : clockIsBoundary && firstDate.endsWith('-01') && siteDate(now, timezone).endsWith('-01')
    if (fullBuckets) {
      const pendingScope = Prisma.sql`AND m."siteId" = ${siteId}::uuid ${input.meterId ? Prisma.sql`AND m."id" = ${input.meterId}::uuid` : Prisma.empty} ${input.buildingId ? Prisma.sql`AND m."assetId" IN (SELECT "id" FROM "Asset" WHERE "buildingId" = ${input.buildingId}::uuid)` : Prisma.empty}`
      const [meterIdsWithReadings, rows, pendingRows] = await Promise.all([
        db.meterReading.findMany({ where: { organizationId: orgId, quality: 'VALID', unit: 'kWh', timestamp: { gte: since, lt: now }, meter: scope }, distinct: ['meterId'], select: { meterId: true } }),
        db.meterEnergyAggregate.findMany({ where: { organizationId: orgId, meter: scope, granularity: input.bucket, bucketStart: { gte: since, lt: now } }, select: { meterId: true, bucketKey: true, localDate: true, bucketStart: true, energyKwh: true, quality: true, readingCount: true, expectedReadingCount: true, completenessPercent: true, resetCount: true, rolloverCount: true, version: true } }),
        db.$queryRaw<{count:number}[]>(Prisma.sql`SELECT COUNT(*)::int AS count FROM "MeterRollupTask" t JOIN "Meter" m ON m."organizationId"=t."organizationId" AND m."id"=t."meterId" WHERE t."organizationId"=${orgId}::uuid AND (t."status" <> 'COMPLETED' OR t."generation" > t."processedGeneration") ${pendingScope}`)
      ])
      const expectedIds = new Set(meterIdsWithReadings.map(row => row.meterId)), rollupIds = new Set(rows.map(row => row.meterId))
      if (Number(pendingRows[0]?.count ?? 0) === 0 && [...expectedIds].every(id => rollupIds.has(id))) {
        const buckets = new Map<string, { energy: Prisma.Decimal; readings: number; expected: number; resets: number; rollovers: number; quality: Set<string>; version: number }>()
        for (const row of rows) {
          const date = input.bucket === 'HOUR' || input.bucket === 'MONTH' ? row.bucketKey : row.localDate
          const bucket = buckets.get(date) ?? { energy: new Prisma.Decimal(0), readings: 0, expected: 0, resets: 0, rollovers: 0, quality: new Set<string>(), version: 1 }
          bucket.energy = bucket.energy.add(row.energyKwh); bucket.readings += row.readingCount; bucket.expected += row.expectedReadingCount; bucket.resets += row.resetCount; bucket.rollovers += row.rolloverCount; bucket.quality.add(row.quality); bucket.version = Math.max(bucket.version, row.version); buckets.set(date, bucket)
        }
        return ok(res, [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([date, bucket]) => ({ date, kwh: Number(bucket.energy.toFixed(2)), unit: 'kWh', quality: bucket.quality.size === 1 ? [...bucket.quality][0] : 'REVIEW_REQUIRED', readingCount: bucket.readings, expectedReadingCount: bucket.expected, completenessPercent: bucket.expected ? Number((Math.min(bucket.readings, bucket.expected) * 100 / bucket.expected).toFixed(2)) : null, resetCount: bucket.resets, rolloverCount: bucket.rollovers, aggregateVersion: bucket.version, source: 'PERSISTENT_ROLLUP' })))
      }
    }
  }
  if (input.metric === 'POWER_DEMAND') {
    const readings = await db.meterReading.findMany({ where: { organizationId: orgId, quality: 'VALID', unit: 'kW', timestamp: { gte: since, lt: now }, meter: scope }, include: { meter: { select: { site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'asc' } })
    const buckets = new Map<string, Prisma.Decimal>()
    for (const reading of readings) {
      const key = localBucketKey(reading.timestamp, timezone, input.bucket)
      const value = new Prisma.Decimal(reading.value)
      if (!buckets.has(key) || value.gt(buckets.get(key)!)) buckets.set(key, value)
    }
    const result = [...buckets].map(([date, value]) => ({ date, kwh: Number(value.toFixed(2)), unit: 'kW', quality: 'VALIDATED' }))
    return ok(res, result)
  }
  const [readings, prior] = await Promise.all([
    db.meterReading.findMany({ where: { organizationId: orgId, quality: 'VALID', unit: 'kWh', timestamp: { gte: since, lt: now }, meter: scope }, include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'asc' } }),
    db.meterReading.findMany({ where: { organizationId: orgId, quality: 'VALID', unit: 'kWh', timestamp: { lt: since }, meter: scope }, distinct: ['meterId'], include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'desc' } })
  ])
  const result = energyByTimezoneBucket(readings, prior, timezone, input.bucket)
  return ok(res, result)
}))
registerForecastRoutes(api, { db, auth, csrf, wrap, ok, fail, pageQuery, pageResult, siteForOrg })
app.get('/api/v1/reports/:id/signed-download', wrap(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return fail(res, 404, 'NOT_FOUND', 'Laporan tidak ditemukan.')
  const expires = typeof req.query.expires === 'string' && /^\d{10}$/.test(req.query.expires) ? Number(req.query.expires) : 0
  const signature = typeof req.query.signature === 'string' && /^[a-f0-9]{64}$/.test(req.query.signature) ? req.query.signature : ''
  const report = await db.reportJob.findFirst({ where: { id: req.params.id, status: 'COMPLETED' } })
  if (!report) return fail(res, 404, 'NOT_FOUND', 'Laporan siap diunduh tidak ditemukan.')
  const expected = createHmac('sha256', secret!).update(`${report.id}.${report.organizationId}.${expires}`).digest('hex')
  if (!expires || expires <= Math.floor(Date.now() / 1000) || !signature || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return fail(res, 401, 'SIGNED_LINK_INVALID', 'Tautan unduhan tidak valid atau kedaluwarsa.')
  const artifact = report.filePath ? { buffer: await readReportArtifact(report), type: renderReportArtifact(report).type } : renderReportArtifact(report)
  await db.auditLog.create({ data: { organizationId: report.organizationId, userId: report.requestedBy, action: 'REPORT_DOWNLOADED', entity: 'ReportJob', entityId: report.id, details: { method: 'SIGNED_LINK' } } })
  res.setHeader('Content-Disposition', `attachment; filename="energy-${report.id}.${reportExtension(report.format)}"`)
  return res.type(artifact.type).send(artifact.buffer)
}))
api.get('/events', auth, (req, res) => {
  const user = res.locals.user
  if (!hasPermission(user, 'notification.read') && !hasPermission(user, 'alert.read') && !hasPermission(user, 'monitor.read')) return fail(res, 403, 'FORBIDDEN', 'Permission event stream tidak tersedia.')
  res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  res.write('event: ready\ndata: {}\n\n')
  let cursor = new Date(), polling = false
  const timer = setInterval(() => {
    if (polling || res.writableEnded) return
    polling = true
    void (async () => {
      const [alerts, deliveries] = await Promise.all([
        hasPermission(user, 'alert.read') ? db.alert.findMany({ where: { organizationId: user.organizationId, triggeredAt: { gt: cursor }, ...(res.locals.allowedSiteIds ? { meter: { siteId: { in: res.locals.allowedSiteIds } } } : {}) }, orderBy: { triggeredAt: 'asc' }, take: 100, include: { meter: { select: { code: true, siteId: true } }, rule: { select: { name: true, severity: true } } } }) : [],
        hasPermission(user, 'notification.read') ? db.notificationDelivery.findMany({ where: { organizationId: user.organizationId, userId: user.id, createdAt: { gt: cursor } }, orderBy: { createdAt: 'asc' }, take: 100, include: { alert: { select: { id: true, message: true, status: true, triggeredAt: true, meterId: true } } } }) : []
      ])
      cursor = new Date()
      if (!res.writableEnded) res.write(`event: updates\ndata: ${JSON.stringify({ alerts, deliveries, occurredAt: cursor.toISOString() })}\n\n`)
    })().catch(error => logEvent('error', 'event_stream_poll_failed', { error, userId: user.id })).finally(() => { polling = false })
  }, 10_000)
  timer.unref()
  req.on('close', () => clearInterval(timer))
})
api.use((_req, res) => fail(res, 404, 'NOT_FOUND', 'Rute API tidak ditemukan.'))
app.use('/api/v1', api)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => { if (err instanceof ExistingAccountAuthenticationError) return fail(res, 409, 'LOGIN_REQUIRED', 'Masuk ke akun ini sebelum menerima undangan organisasi tambahan.'); if (err instanceof InvitationConflictError) return fail(res, 409, 'CONFLICT', 'Undangan tidak dapat dibuat untuk email ini.'); if (err instanceof InvalidRoleError) return fail(res, 422, 'INVALID_ROLE', 'Role tidak aktif atau bukan milik organisasi ini.'); if (err instanceof LastAdminError) return fail(res, 409, 'LAST_ADMIN', 'Organisasi harus memiliki setidaknya satu admin aktif.'); if (err instanceof AssignmentRequiredError) return fail(res, 422, 'SITE_ASSIGNMENT_REQUIRED', 'Peran ini memerlukan setidaknya satu site.'); if (err instanceof InvitationError) return fail(res, 410, 'INVITATION_INVALID', 'Undangan tidak valid, telah digunakan, dicabut, atau kedaluwarsa.'); if (err instanceof SourceRevokedError) return fail(res, 401, 'INVALID_SOURCE', 'Kunci sumber tidak valid.'); if (err instanceof IngestionError) return fail(res, 422, 'VALIDATION_ERROR', err.message); if (err instanceof ZodError) return res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Periksa kembali data.', fields: err.flatten().fieldErrors } }); if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2002' || (err.code === 'P2010' && err.meta?.code === '23505'))) return fail(res, 409, 'CONFLICT', 'Kode sudah digunakan.'); logEvent('error', 'unhandled_api_error', { error: err }); return fail(res, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan pada server.') })
if (backgroundWorkersEnabled) {
  // Recurring background jobs. Driven by BullMQ + Redis when REDIS_URL is set (per FSD section 2),
  // otherwise by in-process interval polling. Each task is idempotent and DB claim-locked.
  void startScheduler([
    { name: 'reading_import_queue', everyMs: 1_000, run: () => processNextImportJob() },
    { name: 'meter_health_sweep', everyMs: 60_000, run: () => sweepMeterHealth(db) },
    { name: 'scheduled_alert_evaluation', everyMs: 60_000, run: () => evaluateScheduledAlerts(db) },
    { name: 'report_export_worker', everyMs: 5_000, run: () => processOneReportJob() },
    { name: 'report_retention', everyMs: 6 * 60 * 60 * 1000, run: () => expireReportArtifacts(), runOnStart: true },
    { name: 'notification_delivery_worker', everyMs: 5_000, run: () => deliverOneAlertEmail(db) },
    { name: 'webhook_outbox_worker', everyMs: 1_000, run: () => processOneWebhookEvent() },
    { name: 'meter_rollup_worker', everyMs: 1_000, run: () => processOneMeterRollup(db) }
  ], logEvent).catch(error => logEvent('error', 'scheduler_start_failed', { error }))
}
if (process.env.WORKER_ONLY !== '1') app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => logEvent('info', 'api_ready', { host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3000) }))
