// Uses an isolated, temporary tenant against the locally running development API.
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { createHmac, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const base = process.env.TEST_API_URL || 'http://127.0.0.1:3000'
const db = new PrismaClient()
async function waitForRollup(meterId) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const task = await db.meterRollupTask.findUnique({ where: { organizationId_meterId: { organizationId: org.id, meterId } } })
    if (task?.status === 'COMPLETED' && task.generation === task.processedGeneration) return task
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Persistent rollup did not finish for meter ${meterId}`)
}
const id = randomUUID(), code = `SMOKE-${id}`, password = `test-${randomUUID()}`
const createMember = async data => {
  const user = await db.user.create({ data })
  const roleDefinition = await db.role.findFirst({ where: { organizationId: data.organizationId, code: data.role } })
  assert(roleDefinition, `Missing seeded role ${data.role} for tenant ${data.organizationId}`)
  await db.organizationMembership.create({ data: { organizationId: data.organizationId, userId: user.id, role: data.role, roleId: roleDefinition.id, status: data.active === false ? 'SUSPENDED' : 'ACTIVE' } })
  return user
}
const createTenant = async data => {
  const organization = await db.organization.create({ data })
  const adminTemplate = await db.role.findFirst({ where: { code: 'ADMIN', isSystem: true }, select: { organizationId: true } })
  const templates = adminTemplate ? await db.role.findMany({ where: { organizationId: adminTemplate.organizationId, isSystem: true }, include: { permissions: { include: { permission: true } } } }) : [
    { code: 'ADMIN', name: 'Organization Admin', description: 'Full organization administration', scope: 'ORGANIZATION', permissions: ['*'] },
    { code: 'ENERGY_MANAGER', name: 'Energy Manager', description: 'Energy and audit operations', scope: 'ASSIGNED_SITES', permissions: ['site.read','meter.read','monitor.read','alert.read','tariff.manage','cost.read','baseline.manage','audit.approve','report.export','forecast.read','forecast.run'] },
    { code: 'FACILITY_MANAGER', name: 'Facility Manager', description: 'Facility operations', scope: 'ASSIGNED_SITES', permissions: ['site.read','asset.manage','meter.read','meter.configure','reading.import','meter.maintain','maintenance.manage'] },
    { code: 'ANALYST', name: 'Energy Analyst', description: 'Energy analysis', scope: 'ASSIGNED_SITES', permissions: ['site.read','meter.read','monitor.read','alert.read','alert.acknowledge','report.generate','emissions.read','forecast.read','forecast.run'] },
    { code: 'TECHNICIAN', name: 'Technician', description: 'Assigned maintenance', scope: 'ASSIGNED_SITES', permissions: ['site.read','meter.read','meter.maintain','maintenance.assigned','alert.read','alert.investigate'] },
    { code: 'EXECUTIVE', name: 'Executive', description: 'Organization dashboard', scope: 'ORGANIZATION', permissions: ['dashboard.read','report.read'] },
    { code: 'AUDITOR', name: 'Auditor', description: 'Assigned audits', scope: 'ASSIGNED_SITES', permissions: ['audit.read','audit.submit','audit.evidence.manage','auditlog.read','audit.assigned'] },
  ].map(template => ({ ...template, isSystem: true }))
  for (const template of templates) {
    const role = await db.role.create({ data: { organizationId: organization.id, code: template.code, name: template.name, description: template.description, scope: template.scope, isSystem: true } })
    const codes = template.permissions.map(permission => typeof permission === 'string' ? permission : permission.permission.code)
    const permissions = await db.permission.findMany({ where: { code: { in: codes } }, select: { id: true } })
    if (permissions.length) await db.rolePermission.createMany({ data: permissions.map(permission => ({ roleId: role.id, permissionId: permission.id })) })
  }
  return organization
}
let org, otherOrg, provisionedOrg, platformUser
try {
  let health = await fetch(`${base}/api/v1/health/live`); assert.equal(health.status, 200); assert.equal((await health.json()).data.status, 'LIVE')
  health = await fetch(`${base}/api/v1/health/ready`); assert.equal(health.status, 200); assert.equal((await health.json()).data.status, 'READY')
  org = await createTenant({ code, name: 'Temporary smoke test' })
  const user = await createMember({ email: `${id}@example.invalid`, fullName: 'Smoke Test', passwordHash: await bcrypt.hash(password, 10), role: 'ADMIN', organizationId: org.id })
  platformUser = await db.user.create({ data: { email: `platform-${id}@example.invalid`, fullName: 'Platform Smoke Test', passwordHash: await bcrypt.hash(password, 10), role: 'ADMIN', organizationId: org.id } })
  await db.$executeRaw`INSERT INTO "PlatformAdmin" ("userId", "grantedBy", "reason") VALUES (${platformUser.id}::uuid, ${user.id}::uuid, 'Smoke test')`
  const site = await db.site.create({ data: { organizationId: org.id, code: 'SITE-1', name: 'Test site', type: 'FACTORY', address: 'Test address 123', timezone: 'Asia/Jakarta' } })
  const meter = await db.meter.create({ data: { organizationId: org.id, siteId: site.id, code: 'METER-1', meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'CSV', intervalMinutes: 60, multiplier: 1, status: 'PENDING' } })
  const unassignedSite = await db.site.create({ data: { organizationId: org.id, code: 'SITE-2', name: 'Unassigned site', type: 'OFFICE', address: 'Test address 456', timezone: 'Asia/Jakarta' } })
  const unassignedMeter = await db.meter.create({ data: { organizationId: org.id, siteId: unassignedSite.id, code: 'METER-2', meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'CSV', intervalMinutes: 60, multiplier: 1, status: 'PENDING' } })
  const simulatedMeter = await db.meter.create({ data: { organizationId: org.id, siteId: unassignedSite.id, code: 'SIMULATED-1', meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'SIMULATOR', intervalMinutes: 5, multiplier: 1, status: 'PENDING' } })
  const demandMeter = await db.meter.create({ data: { organizationId: org.id, siteId: site.id, code: 'DEMAND-1', meterType: 'INTERVAL', metric: 'POWER_DEMAND', unit: 'kW', sourceType: 'CSV', intervalMinutes: 5, multiplier: 1, status: 'PENDING' } })
  otherOrg = await createTenant({ code: `${code}-OTHER`, name: 'Temporary other tenant' })
  const otherSite = await db.site.create({ data: { organizationId: otherOrg.id, code: 'OTHER-SITE', name: 'Other site', type: 'OFFICE', address: 'Other address 123', timezone: 'Asia/Jakarta' } })
  const otherMeter = await db.meter.create({ data: { organizationId: otherOrg.id, siteId: otherSite.id, code: 'OTHER-METER', meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'CSV', intervalMinutes: 60, multiplier: 1, status: 'PENDING' } })
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).data.csrfToken
  let result
  const ordinaryPlatformProbe = await fetch(`${base}/api/v1/platform/organizations`, { headers: { cookie } }); assert.equal(ordinaryPlatformProbe.status, 403)
  const platformLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: platformUser.email, password }) })
  assert.equal(platformLogin.status, 200)
  const platformCookie = platformLogin.headers.get('set-cookie').split(';')[0], platformCsrf = (await platformLogin.json()).data.csrfToken
  result = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: platformCookie } }); assert.equal(result.status, 200); assert.equal((await result.json()).data.role, 'PLATFORM_ADMIN')
  result = await fetch(`${base}/api/v1/platform/config`, { headers: { cookie: platformCookie } }); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/platform/permissions`, { headers: { cookie: platformCookie } }); assert.equal(result.status, 200); assert.deepEqual((await result.json()).data.map(item => item.code).sort(), ['platform.config', 'tenant.provision'])
  result = await fetch(`${base}/api/v1/sites`, { headers: { cookie: platformCookie } }); assert.equal(result.status, 403)
  const provisionResponse = await fetch(`${base}/api/v1/platform/organizations`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: platformCookie, 'x-csrf-token': platformCsrf }, body: JSON.stringify({ code: `PROV-${id.slice(0, 12).toUpperCase()}`, name: 'Provisioned smoke tenant', adminEmail: `new-admin-${id}@example.invalid`, adminFullName: 'New Tenant Admin' }) })
  assert.equal(provisionResponse.status, 201, await provisionResponse.clone().text())
  const provisionData = (await provisionResponse.json()).data; provisionedOrg = provisionData.organization
  assert.equal(provisionData.emailDelivered, false); assert.match(provisionData.token, /^inv_[a-f0-9]{64}$/)
  assert.equal(await db.role.count({ where: { organizationId: provisionedOrg.id, isSystem: true } }), 7)
  assert.equal(await db.invitation.count({ where: { organizationId: provisionedOrg.id, email: `new-admin-${id}@example.invalid`, role: 'ADMIN', acceptedAt: null } }), 1)
  assert.equal((await db.$queryRaw`SELECT "id" FROM "PlatformAuditLog" WHERE "userId" = ${platformUser.id}::uuid AND "entityId" = ${provisionedOrg.id}`).length, 1)
  result = await fetch(`${base}/api/v1/auth/accept-invitation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: provisionData.token, password: 'new-admin-password-2026' }) }); assert.equal(result.status, 201)
  const provisionedAdmin = await db.user.findUnique({ where: { email: `new-admin-${id}@example.invalid` } }); assert(provisionedAdmin)
  assert.equal(await db.organizationMembership.count({ where: { organizationId: provisionedOrg.id, userId: provisionedAdmin.id, role: 'ADMIN', status: 'ACTIVE' } }), 1)
  result = await fetch(`${base}/api/v1/notification-preferences`, { headers: { cookie } }); assert.equal(result.status, 200); assert.deepEqual(((await result.json()).data), { inAppEnabled: true, emailEnabled: false, updatedAt: null })
  result = await fetch(`${base}/api/v1/notification-preferences`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ inAppEnabled: true, emailEnabled: false }) }); assert.equal(result.status, 200)
  let denied = await fetch(`${base}/api/v1/meters/${otherMeter.id}`, { headers: { cookie } }); assert.equal(denied.status, 404)
  denied = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${otherSite.id}`, { headers: { cookie } }); assert.equal(denied.status, 404)
  const sourceHeaders = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }
  let sourceResponse = await fetch(`${base}/api/v1/data-sources`, { method:'POST', headers:sourceHeaders, body:JSON.stringify({ name:'CSV source', type:'CSV', description:'Import CSV' }) }); assert.equal(sourceResponse.status, 201); const fsdSource = (await sourceResponse.json()).data
  sourceResponse = await fetch(`${base}/api/v1/data-sources`, { method:'POST', headers:sourceHeaders, body:JSON.stringify({ name:'csv source', type:'CSV' }) }); assert.equal(sourceResponse.status, 409)
  sourceResponse = await fetch(`${base}/api/v1/data-sources/${fsdSource.id}`, { method:'PATCH', headers:sourceHeaders, body:JSON.stringify({ status:'INACTIVE', description:'Paused' }) }); assert.equal(sourceResponse.status, 200); assert.equal((await sourceResponse.json()).data.status, 'INACTIVE')
  sourceResponse = await fetch(`${base}/api/v1/data-sources?page=1&pageSize=25&sort=name&direction=asc&search=csv`, { headers:{ cookie } }); assert.equal(sourceResponse.status, 200); const sourcePage = (await sourceResponse.json()).data; assert.ok(sourcePage.items.some(item => item.id === fsdSource.id && item.description === 'Paused')); assert.equal(sourcePage.pagination.pageSize, 25)
  const sourceImport = sourceId => fetch(`${base}/api/v1/reading-imports`, { method:'POST', headers:sourceHeaders, body:JSON.stringify({ fileName:'source.csv', mode:'VALIDATE_ONLY', sourceId, csv:'meterCode,timestamp,metric,rawValue,unit\nMETER-1,2026-11-17T00:00:00Z,ENERGY_IMPORT,1,kWh' }) })
  assert.equal((await sourceImport(fsdSource.id)).status, 422, 'inactive CSV source must not be accepted')
  assert.equal((await fetch(`${base}/api/v1/data-sources/${fsdSource.id}`, { method:'PATCH', headers:sourceHeaders, body:JSON.stringify({ status:'ACTIVE' }) })).status, 200)
  assert.equal((await sourceImport(fsdSource.id)).status, 200, 'active CSV source must be accepted')
  const previewMeter = await db.meter.create({ data: { organizationId: org.id, siteId: unassignedSite.id, code: 'PREVIEW-1', meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'CSV', intervalMinutes: 60, multiplier: 1, status: 'PENDING' } })
  const previewCsv = `meterCode,timestamp,metric,rawValue,unit,externalReadingId\nPREVIEW-1,2026-11-17T00:00:00Z,ENERGY_IMPORT,7,kWh,preview-reading-1`
  const uploadPreview = () => { const form = new FormData(); form.set('file', new Blob([previewCsv], { type: 'text/csv' }), 'preview.csv'); form.set('sourceId', fsdSource.id); return fetch(`${base}/api/v1/reading-imports/preview`, { method:'POST', headers:{ cookie, 'x-csrf-token':csrf }, body:form }) }
  let savedPreviewResponse = await uploadPreview(); assert.equal(savedPreviewResponse.status, 201, await savedPreviewResponse.clone().text())
  let savedPreview = (await savedPreviewResponse.json()).data; assert.equal(savedPreview.status, 'PREVIEW'); assert.equal(savedPreview.valid, 1)
  const storedPreview = await db.importJob.findUnique({ where:{ id:savedPreview.id } }); assert.equal(storedPreview.status, 'PREVIEW'); assert.equal(storedPreview.sourceId, fsdSource.id); assert.equal(storedPreview.previewCsv, previewCsv)
  const safePreviewDetail = await fetch(`${base}/api/v1/reading-imports/${savedPreview.id}`, { headers:{ cookie } }); assert.equal(safePreviewDetail.status, 200); assert.equal(JSON.stringify((await safePreviewDetail.json()).data).includes(previewCsv), false)
  await fetch(`${base}/api/v1/data-sources/${fsdSource.id}`, { method:'PATCH', headers:sourceHeaders, body:JSON.stringify({ status:'INACTIVE' }) })
  assert.equal((await fetch(`${base}/api/v1/reading-imports/${savedPreview.id}/confirm`, { method:'POST', headers:{ cookie, 'x-csrf-token':csrf } })).status, 422, 'inactive source must block confirmation')
  await fetch(`${base}/api/v1/data-sources/${fsdSource.id}`, { method:'PATCH', headers:sourceHeaders, body:JSON.stringify({ status:'ACTIVE' }) })
  let confirmedPreview = await fetch(`${base}/api/v1/reading-imports/${savedPreview.id}/confirm`, { method:'POST', headers:{ cookie, 'x-csrf-token':csrf } }); assert.equal(confirmedPreview.status, 202, await confirmedPreview.clone().text())
  let previewJob = (await confirmedPreview.json()).data, previewDeadline = Date.now() + 15_000
  while (Date.now() < previewDeadline && ['QUEUED', 'PROCESSING'].includes(previewJob.status)) { await new Promise(resolve => setTimeout(resolve, 100)); previewJob = (await (await fetch(`${base}/api/v1/reading-imports/${savedPreview.id}`, { headers:{ cookie } })).json()).data }
  assert.equal(previewJob.status, 'COMPLETED'); assert.equal(previewJob.accepted, 1)
  const previewSourceReading = await db.meterReading.findFirst({ where:{ meterId:previewMeter.id, externalId:`source:${fsdSource.id}:preview-reading-1` } }); assert.ok(previewSourceReading); assert.equal(previewSourceReading.sourceId, fsdSource.id); assert.equal(previewSourceReading.importJobId, savedPreview.id)
  savedPreviewResponse = await uploadPreview(); assert.equal(savedPreviewResponse.status, 201); savedPreview = (await savedPreviewResponse.json()).data
  confirmedPreview = await fetch(`${base}/api/v1/reading-imports/${savedPreview.id}/confirm`, { method:'POST', headers:{ cookie, 'x-csrf-token':csrf } }); assert.equal(confirmedPreview.status, 202)
  previewJob = (await confirmedPreview.json()).data; previewDeadline = Date.now() + 15_000
  while (Date.now() < previewDeadline && ['QUEUED', 'PROCESSING'].includes(previewJob.status)) { await new Promise(resolve => setTimeout(resolve, 100)); previewJob = (await (await fetch(`${base}/api/v1/reading-imports/${savedPreview.id}`, { headers:{ cookie } })).json()).data }
  assert.equal(previewJob.status, 'COMPLETED'); assert.equal(previewJob.accepted, 0); assert.equal((previewJob.errors?.duplicates), 1, 'source reading duplicate is reported')
  const send = (mode, csv) => fetch(`${base}/api/v1/reading-imports`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ fileName: 'test.csv', mode, csv }) })
  const csv = 'meterCode,timestamp,value,unit,externalReadingId\nMETER-1,2026-11-17T00:00:00Z,12,kWh,test-1\nMETER-1,2026-11-17T01:00:00Z,2,kW,test-2'
  let badHeader = await send('VALIDATE_ONLY', 'meterCode,timestamp,value,value,unit\nMETER-1,2026-11-17T00:00:00Z,1,2,kWh'); assert.equal(badHeader.status, 422)
  badHeader = await send('VALIDATE_ONLY', 'meterCode,timestamp,value,rawValue,unit\nMETER-1,2026-11-17T00:00:00Z,1,2,kWh'); assert.equal(badHeader.status, 422)
  const fsdPreview = await send('VALIDATE_ONLY', 'meterCode,timestamp,metric,rawValue,unit,externalReadingId\nMETER-1,2026-11-17T00:00:00Z,ENERGY_IMPORT,12,kWh,fsd-1\nMETER-1,2026-11-17T01:00:00Z,POWER_DEMAND,13,kWh,fsd-2'); assert.equal(fsdPreview.status, 200); const fsdData = (await fsdPreview.json()).data; assert.equal(fsdData.valid, 1); assert.equal(fsdData.rejected, 1); assert.equal(fsdData.errors[0].row, 3)
  result = await send('VALIDATE_ONLY', csv); assert.equal(result.status, 200)
  const preview = (await result.json()).data; assert.equal(preview.valid, 1); assert.equal(preview.rejected, 1)
  assert.equal(await db.meterReading.count({ where: { meterId: meter.id } }), 0)
  result = await send('COMMIT', csv); assert.equal(result.status, 202); let csvImportJob = (await result.json()).data
  const importDeadline = Date.now() + 15_000
  while (Date.now() < importDeadline && ['QUEUED', 'PROCESSING'].includes(csvImportJob.status)) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const statusResponse = await fetch(`${base}/api/v1/reading-imports/${csvImportJob.id}`, { headers: { cookie } })
    assert.equal(statusResponse.status, 200, 'queued import detail must remain accessible')
    csvImportJob = (await statusResponse.json()).data
  }
  assert.equal(csvImportJob.status, 'COMPLETED', `import worker must finish the queued batch (status=${csvImportJob.status})`)
  assert.equal(csvImportJob.accepted, 1); assert.equal(csvImportJob.rejected, 1)
  const csvReading = await db.meterReading.findFirst({ where: { meterId: meter.id, externalId: 'test-1' } }); assert.equal(csvReading.sourceType, 'CSV'); assert.equal(csvReading.importJobId, csvImportJob.id)
  result = await fetch(`${base}/api/v1/quarantined-readings?status=OPEN`, { headers: { cookie } }); assert.equal(result.status, 200); const quarantineItems = (await result.json()).data; assert.equal(quarantineItems.length, 1); assert.equal(quarantineItems[0].importJobId, csvImportJob.id); assert.match(quarantineItems[0].reason, /Unit tidak sesuai/)
  result = await fetch(`${base}/api/v1/quarantined-readings/${quarantineItems[0].id}/release`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ meterId: meter.id, timestamp: '2026-11-15T00:00:00Z', value: '2', unit: 'kWh' }) }); assert.equal(result.status, 200); assert.equal((await result.json()).data.status, 'RELEASED')
  assert.equal(await db.meterReading.count({ where: { meterId: meter.id, importJobId: csvImportJob.id } }), 2)
  result = await fetch(`${base}/api/v1/quarantined-readings/${quarantineItems[0].id}/release`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ meterId: meter.id, timestamp: '2026-11-15T00:00:00Z', value: '2', unit: 'kWh' }) }); assert.equal(result.status, 409)
  result = await send('COMMIT', csv); assert.equal(result.status, 202); let duplicateImportJob = (await result.json()).data
  const duplicateDeadline = Date.now() + 15_000
  while (Date.now() < duplicateDeadline && ['QUEUED', 'PROCESSING'].includes(duplicateImportJob.status)) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const statusResponse = await fetch(`${base}/api/v1/reading-imports/${duplicateImportJob.id}`, { headers: { cookie } })
    assert.equal(statusResponse.status, 200)
    duplicateImportJob = (await statusResponse.json()).data
  }
  assert.equal(duplicateImportJob.status, 'COMPLETED')
  assert.equal(duplicateImportJob.accepted, 0)
  assert.equal(await db.meterReading.count({ where: { meterId: meter.id } }), 2)
  const ingest = rows => fetch(`${base}/api/v1/ingestion/readings`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ readings: rows }) })
  const outOfOrderMeter = await db.meter.create({ data: { organizationId: org.id, siteId: site.id, code: 'OUT-OF-ORDER', meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'API', intervalMinutes: 60, multiplier: 1, status: 'PENDING' } })
  result = await ingest([{ meterId: outOfOrderMeter.id, timestamp: '2026-11-16T01:00:00Z', value: '2', unit: 'kWh' }]); assert.equal(result.status, 200)
  result = await ingest([{ meterId: outOfOrderMeter.id, timestamp: '2026-11-16T00:00:00Z', value: '1', unit: 'kWh' }]); assert.equal(result.status, 200)
  await waitForRollup(outOfOrderMeter.id)
  const persistentRollup = await db.meterEnergyRollup.findFirst({ where: { organizationId: org.id, meterId: outOfOrderMeter.id, localDate: '2026-11-16' } }); assert.equal(persistentRollup.energyKwh.toString(), '3'); assert.equal(persistentRollup.readingCount, 2)
  const dayAggregate = await db.meterEnergyAggregate.findFirst({ where: { organizationId: org.id, meterId: outOfOrderMeter.id, granularity: 'DAY', bucketKey: '2026-11-16' } }); assert.equal(dayAggregate.energyKwh.toString(), '3'); assert.equal(dayAggregate.expectedReadingCount, 24); assert.equal(dayAggregate.completenessPercent.toString(), '8.33'); assert.equal(dayAggregate.version, 1)
  const monthAggregate = await db.meterEnergyAggregate.findFirst({ where: { organizationId: org.id, meterId: outOfOrderMeter.id, granularity: 'MONTH', bucketKey: '2026-11' } }); assert.equal(monthAggregate.energyKwh.toString(), '3'); assert.equal(monthAggregate.expectedReadingCount, 720)
  assert.equal(await db.meterEnergyAggregate.count({ where: { organizationId: org.id, meterId: outOfOrderMeter.id, granularity: 'HOUR' } }), 2)
  result = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${site.id}&meterId=${outOfOrderMeter.id}&bucket=DAY&periodStart=2026-11-15T17%3A00%3A00Z&periodEnd=2026-11-16T17%3A00%3A00Z`, { headers: { cookie } }); assert.equal(result.status, 200); const rollupSeries = (await result.json()).data; assert.equal(rollupSeries[0].source, 'PERSISTENT_ROLLUP'); assert.equal(rollupSeries[0].kwh, 3)
  result = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${site.id}&meterId=${outOfOrderMeter.id}&bucket=HOUR&periodStart=2026-11-16T00%3A00%3A00Z&periodEnd=2026-11-16T02%3A00%3A00Z`, { headers: { cookie } }); assert.equal(result.status, 200); const reorderedSeries = (await result.json()).data; assert.equal(reorderedSeries[0].source, 'PERSISTENT_ROLLUP'); assert.equal(reorderedSeries.reduce((sum, bucket) => sum + bucket.kwh, 0), 3)
  result = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${site.id}&meterId=${outOfOrderMeter.id}&bucket=MONTH&periodStart=2026-10-31T17%3A00%3A00Z&periodEnd=2026-11-30T17%3A00%3A00Z`, { headers: { cookie } }); assert.equal(result.status, 200); const monthlySeries = (await result.json()).data; assert.equal(monthlySeries[0].source, 'PERSISTENT_ROLLUP'); assert.equal(monthlySeries[0].date, '2026-11'); assert.equal(monthlySeries[0].kwh, 3); assert.equal(monthlySeries[0].completenessPercent, 0.28)
  result = await ingest([{ meterId: outOfOrderMeter.id, timestamp: '2026-11-16T02:00:00Z', value: '4', unit: 'kWh' }]); assert.equal(result.status, 200); await waitForRollup(outOfOrderMeter.id)
  const reaggregatedDay = await db.meterEnergyAggregate.findFirst({ where: { organizationId: org.id, meterId: outOfOrderMeter.id, granularity: 'DAY', bucketKey: '2026-11-16' } }); assert.equal(reaggregatedDay.energyKwh.toString(), '7'); assert.equal(reaggregatedDay.version, 2)
  result = await ingest(Array.from({ length: 5001 }, () => ({}))); assert.equal(result.status, 413)
  const row = { meterId: meter.id, timestamp: '2026-01-01T00:00:00Z', value: '11', unit: 'kWh' }
  result = await ingest([row, { ...row, timestamp: '2026-01-01T01:00:00Z', unit: 'kW' }]); assert.equal(result.status, 422)
  assert.equal(await db.meterReading.count({ where: { meterId: meter.id } }), 2)
  result = await ingest([row]); assert.equal(result.status, 200); assert.equal((await result.json()).data.accepted, 1)
  result = await ingest([row]); assert.equal(result.status, 200); assert.equal((await result.json()).data.duplicates, 1)
  const importedReading = await db.meterReading.findFirst({ where: { meterId: meter.id, externalId: 'test-1' } }); assert.ok(importedReading)
  result = await fetch(`${base}/api/v1/meters/${meter.id}/readings/${importedReading.id}/revisions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ value: '13', quality: 'VALID', reason: 'Verified against source log' }) }); assert.equal(result.status, 201)
  const revisedReading = (await result.json()).data; assert.equal(revisedReading.rawValue.toString(), '12'); assert.equal(revisedReading.value.toString(), '13'); assert.equal(revisedReading.revision.previousValue.toString(), '12')
  result = await fetch(`${base}/api/v1/meters/${otherMeter.id}/readings/${importedReading.id}/revisions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ value: '99', reason: 'Cross tenant probe' }) }); assert.equal(result.status, 404)
  result = await fetch(`${base}/api/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: site.id }) })
  assert.equal(result.status, 201)
  const report = (await result.json()).data
  result = await fetch(`${base}/api/v1/reports/${report.id}/download`, { headers: { cookie } })
  assert.equal(result.status, 200)
  const energyCsv = (await result.text()).split(/\r?\n/).slice(0, 2).map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, '')))
  assert.equal(energyCsv[1][energyCsv[0].indexOf('date')], '2026-11-17')
  assert.equal(energyCsv[1][energyCsv[0].indexOf('kwh')], '13')
  for (const type of ['COST', 'QUALITY', 'ALERTS', 'AUDIT', 'EMISSIONS']) {
    result = await fetch(`${base}/api/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ type, periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: site.id }) })
    assert.equal(result.status, 201, `${type} report was not created`)
    const typedReport = (await result.json()).data
    assert.equal(typedReport.type, type)
    result = await fetch(`${base}/api/v1/reports/${typedReport.id}/download`, { headers: { cookie } })
    assert.equal(result.status, 200)
    const csv = await result.text()
    assert.match(csv, /report_type/)
    assert.match(csv, new RegExp(type))
  }
  result = await fetch(`${base}/api/v1/reports/${report.id}/download`)
  assert.equal(result.status, 401)
  const post = (path, body) => fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify(body) })
  const patch = (path, body) => fetch(`${base}/api/v1${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify(body) })
  const simulatorInput = { meterId: simulatedMeter.id, startAt: '2026-11-16T00:00:00Z', count: 3, baseValue: 0.1, amplitude: 0.02 }
  result = await post('/simulator/readings', simulatorInput); assert.equal(result.status, 201); const simulatorJob = (await result.json()).data; assert.equal(simulatorJob.mode, 'SIMULATOR'); assert.equal(simulatorJob.accepted, 3)
  const simulatedRows = await db.meterReading.findMany({ where: { meterId: simulatedMeter.id }, orderBy: { timestamp: 'asc' } }); assert.equal(simulatedRows.length, 3); assert(simulatedRows.every(row => row.sourceType === 'SIMULATOR' && row.importJobId === simulatorJob.id))
  result = await post('/simulator/readings', simulatorInput); assert.equal(result.status, 201); assert.equal((await result.json()).data.accepted, 0)
  result = await post('/simulator/readings', { ...simulatorInput, intervalMinutes: 60 }); assert.equal(result.status, 422)
  result = await fetch(`${base}/api/v1/simulator/readings`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ ...simulatorInput, meterId: otherMeter.id }) }); assert.equal(result.status, 404)
  const longStart = new Date('2026-01-01T00:00:00Z')
  await db.meterReading.createMany({ data: Array.from({ length: 100 }, (_, index) => { const timestamp = new Date(longStart.getTime() + index * 86400000); return { organizationId: org.id, meterId: simulatedMeter.id, externalId: `async-export-${index}`, timestamp, rawValue: '1', value: '1', unit: 'kWh', quality: 'VALID', sourceType: 'SIMULATOR' } }) })
  result = await post('/reports', { periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-04-11T00:00:00Z', siteId: unassignedSite.id, meterId: simulatedMeter.id, format: 'PDF' }); assert.equal(result.status, 202); const queuedReport = (await result.json()).data; assert.equal(queuedReport.status, 'QUEUED'); assert.equal(queuedReport.filters.snapshot, undefined)
  let reportStatus = queuedReport
  for (let attempt = 0; attempt < 60 && reportStatus.status !== 'COMPLETED' && reportStatus.status !== 'FAILED'; attempt++) { await new Promise(resolve => setTimeout(resolve, 250)); result = await fetch(`${base}/api/v1/reports/${queuedReport.id}`, { headers: { cookie } }); assert.equal(result.status, 200); reportStatus = (await result.json()).data }
  assert.equal(reportStatus.status, 'COMPLETED'); assert.ok(reportStatus.filePath); assert.equal(reportStatus.attemptCount, 1); assert.equal(reportStatus.filters.snapshot.length, 100); assert.ok(reportStatus.filters.snapshotAt)
  result = await fetch(`${base}/api/v1/reports/${queuedReport.id}/download-link`, { headers: { cookie } }); assert.equal(result.status, 200); const signedUrl = new URL((await result.json()).data.url)
  result = await fetch(signedUrl); assert.equal(result.status, 200); const asyncPdf = Buffer.from(await result.arrayBuffer()); assert.equal(asyncPdf.subarray(0, 8).toString(), '%PDF-1.4'); assert(asyncPdf.includes(Buffer.from('2026-04-10')))
  signedUrl.searchParams.set('expires', '1'); result = await fetch(signedUrl); assert.equal(result.status, 401)
  result = await fetch(`${base}/api/v1/organization`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, origin: 'https://attacker.invalid' }, body: JSON.stringify({ name: 'Rejected origin' }) }); assert.equal(result.status, 403)
  result = await patch('/organization', { name: 'Updated smoke organization' }); assert.equal(result.status, 200)
  result = await patch(`/sites/${site.id}`, { latitude: -6.2, longitude: 106.8, managerId: user.id, operatingSchedule: [{ dayOfWeek: 1, start: '08:00', end: '17:00' }] }); assert.equal(result.status, 200)
  result = await patch(`/sites/${site.id}`, { latitude: -6.2 }); assert.equal(result.status, 422)
  result = await patch(`/sites/${site.id}`, { operatingSchedule: [{ dayOfWeek: 1, start: '08:00', end: '12:00' }, { dayOfWeek: 1, start: '11:00', end: '17:00' }] }); assert.equal(result.status, 422)
  result = await fetch(`${base}/api/v1/sites`, { headers: { cookie } }); assert.equal((await result.json()).data.find(item => item.id === site.id).manager.id, user.id)
  result = await post('/buildings', { siteId: otherSite.id, code: 'BLD-1', name: 'Other building' }); assert.equal(result.status, 404)
  result = await post('/buildings', { siteId: site.id, code: 'BLD-1', name: 'Assigned building' }); assert.equal(result.status, 201); const building = (await result.json()).data
  result = await post('/buildings', { siteId: site.id, code: 'BLD-1', name: 'Duplicate' }); assert.equal(result.status, 409)
  result = await post('/buildings', { siteId: unassignedSite.id, code: 'BLD-2', name: 'Unassigned building' }); assert.equal(result.status, 201); const unassignedBuilding = (await result.json()).data
  result = await patch(`/buildings/${building.id}`, { name: 'Updated building' }); assert.equal(result.status, 200)
  result = await post('/assets', { siteId: site.id, buildingId: unassignedBuilding.id, code: 'ASSET-1', name: 'Pump', type: 'PUMP' }); assert.equal(result.status, 422)
  result = await post('/assets', { siteId: site.id, buildingId: building.id, code: 'ASSET-1', name: 'Pump', type: 'PUMP' }); assert.equal(result.status, 201); const asset = (await result.json()).data
  result = await patch(`/assets/${asset.id}`, { buildingId: unassignedBuilding.id }); assert.equal(result.status, 422)
  result = await patch(`/assets/${asset.id}`, { name: 'Updated pump' }); assert.equal(result.status, 200)
  const linkedInput = { code: 'LINKED-1', siteId: site.id, assetId: asset.id, serialNumber: 'SERIAL-1', installedAt: '2026-01-01T00:00:00Z', meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'API', intervalMinutes: 15, multiplier: 1 }
  result = await post('/meters', { ...linkedInput, siteId: unassignedSite.id }); assert.equal(result.status, 422)
  result = await post('/meters', { ...linkedInput, installedAt: '2026-03-02T00:00:00Z', decommissionedAt: '2026-03-01T00:00:00Z' }); assert.equal(result.status, 422)
  result = await post('/meters', linkedInput); assert.equal(result.status, 201); const linkedMeter = (await result.json()).data; assert.equal(linkedMeter.assetId, asset.id)
  result = await post(`/meters/${linkedMeter.id}/configuration-versions`, { sourceType: 'API', intervalMinutes: 30, multiplier: 1, effectiveFrom: '2026-11-17T00:00:00Z', reason: 'Verified telemetry schedule' }); assert.equal(result.status, 201)
  result = await fetch(`${base}/api/v1/meters/${linkedMeter.id}/configuration-history`, { headers: { cookie } }); assert.equal(result.status, 200); const configHistory = (await result.json()).data; assert.equal(configHistory.length, 2); assert.equal(configHistory[0].intervalMinutes, 15); assert.equal(configHistory[0].effectiveTo, '2026-11-16T23:59:59.999Z'); assert.equal(configHistory[1].intervalMinutes, 30); assert.equal(configHistory[1].effectiveTo, null)
  result = await post('/meters', { ...linkedInput, code: 'LINKED-2' }); assert.equal(result.status, 409)
  result = await post('/meters', { ...linkedInput, code: 'ROLLOVER-1', siteId: unassignedSite.id, serialNumber: 'SERIAL-ROLLOVER', assetId: undefined, meterType: 'CUMULATIVE', rolloverValue: '10000', sourceType: 'CSV' }); if (result.status !== 201) throw new Error(`Rollover meter create failed: ${result.status} ${await result.text()}`); const rolloverMeter = (await result.json()).data; assert.equal(Number(rolloverMeter.rolloverValue), 10000)
  result = await ingest([{ meterId: rolloverMeter.id, timestamp: '2026-11-17T00:00:00Z', value: '9999.9', unit: 'kWh' }, { meterId: rolloverMeter.id, timestamp: '2026-11-17T00:15:00Z', value: '0.2', unit: 'kWh' }]); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${unassignedSite.id}&meterId=${rolloverMeter.id}&periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z`, { headers: { cookie } }); assert.equal(result.status, 200); assert.deepEqual((await result.json()).data, [{ date: '2026-11-17', kwh: 0.3, unit: 'kWh', quality: 'ROLLOVER_ADJUSTED' }])
  result = await post('/reports', { periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: unassignedSite.id, meterId: rolloverMeter.id, granularity: 'HOUR' }); assert.equal(result.status, 201); const hourlyExport = (await result.json()).data; assert.equal(hourlyExport.filters.granularity, 'HOUR')
  result = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${unassignedSite.id}&meterId=${rolloverMeter.id}&bucket=HOUR&periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z`, { headers: { cookie } }); assert.equal(result.status, 200); const matchingSeries = (await result.json()).data; assert.deepEqual(hourlyExport.filters.snapshot, matchingSeries.map(({ date, kwh, unit, quality }) => ({ date, kwh, unit, quality })))
  result = await fetch(`${base}/api/v1/data-quality?siteId=${unassignedSite.id}&meterId=${rolloverMeter.id}&periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z`, { headers: { cookie } }); assert.equal(result.status, 200); const rolloverQuality = (await result.json()).data; assert.equal(rolloverQuality.issueCount, 1); assert.equal(rolloverQuality.issues[0].type, 'REGISTER_ROLLOVER')
  const baselineValues = { startDate: '2026-01-01', endDate: '2026-03-31', value: 100 }
  result = await post('/baselines', { ...baselineValues, siteId: site.id, metric: 'ENERGY_IMPORT' }); assert.equal(result.status, 201); const baseline = (await result.json()).data
  result = await post(`/baselines/${baseline.id}/approve`, { notes: 'Approved original' }); assert.equal(result.status, 200)
  const revisions = await Promise.all([post(`/baselines/${baseline.id}/revisions`, { ...baselineValues, value: 90 }), post(`/baselines/${baseline.id}/revisions`, { ...baselineValues, value: 90 })]); assert.deepEqual(revisions.map(r => r.status).sort(), [201, 409])
  const revision = (await revisions.find(r => r.status === 201).json()).data
  result = await post(`/baselines/${revision.id}/approve`, { notes: 'Approved revision' }); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/baselines`, { headers: { cookie } }); const baselineHistory = (await result.json()).data.filter(b => b.groupId === baseline.id); assert.equal(baselineHistory.length, 2); assert.equal(Number(baselineHistory.find(b => b.id === baseline.id).value), 100); assert.equal(Number(baselineHistory.find(b => b.id === revision.id).value), 90)
  result = await fetch(`${base}/api/v1/baselines/${revision.id}/compare?periodStart=2026-01-01&periodEnd=2026-03-31`, { headers: { cookie } }); assert.equal(result.status, 200); const baselineComparison = (await result.json()).data; assert.equal(baselineComparison.baselineVersion, 2); assert.equal(baselineComparison.unit, 'kWh'); assert.equal(baselineComparison.timezone, 'Asia/Jakarta')
  result = await fetch(`${base}/api/v1/baselines/${revision.id}/compare?periodStart=2026-01-01&periodEnd=2026-02-28`, { headers: { cookie } }); assert.equal(result.status, 422)
  result = await post('/baselines', { ...baselineValues, siteId: site.id, metric: 'ENERGY_IMPORT', denominator: 0, denominatorUnit: 'm2' }); assert.equal(result.status, 201); const zeroDenominatorBaseline = (await result.json()).data
  result = await post(`/baselines/${zeroDenominatorBaseline.id}/approve`, { notes: 'Zero denominator acceptance' }); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/baselines/${zeroDenominatorBaseline.id}/compare?periodStart=2026-01-01&periodEnd=2026-03-31`, { headers: { cookie } }); assert.equal(result.status, 200); const zeroIntensity = (await result.json()).data; assert.equal(zeroIntensity.baselineIntensity, null); assert.equal(zeroIntensity.actualIntensity, null)
  result = await post('/targets', { siteId: site.id, metric: 'ENERGY_IMPORT', startDate: '2026-11-17', endDate: '2026-11-30', targetValue: 100, unit: 'kWh' }); assert.equal(result.status, 201); const target = (await result.json()).data
  result = await fetch(`${base}/api/v1/targets/${target.id}/progress`, { headers: { cookie } }); assert.equal(result.status, 200); const progress = (await result.json()).data; assert.equal(progress.targetId, target.id); assert.equal(progress.unit, 'kWh'); assert.equal(progress.timezone, 'Asia/Jakarta')
  const alertRule = { name: 'Demand limit', scopeType: 'METER', scopeId: demandMeter.id, metric: 'POWER_DEMAND', operator: 'GT', threshold: '5', windowMinutes: 15, cooldownMinutes: 60, severity: 'HIGH', channels: ['IN_APP'] }
  result = await post('/alert-rules', { ...alertRule, scopeId: otherMeter.id }); assert.equal(result.status, 404)
  result = await post('/alert-rules', alertRule); assert.equal(result.status, 201); const automaticRule = (await result.json()).data
  const demand = offset => ({ meterId: demandMeter.id, timestamp: new Date(Date.now() - offset).toISOString(), value: '10', unit: 'kW' })
  const triggered = await Promise.all([ingest([demand(5000)]), ingest([demand(3000)])]); assert.deepEqual(triggered.map(response => response.status), [200, 200])
  let automaticAlerts = await db.$queryRaw`SELECT "id" FROM "Alert" WHERE "ruleId" = ${automaticRule.id}::uuid AND "meterId" = ${demandMeter.id}::uuid`; assert.equal(automaticAlerts.length, 1)
  let notificationRows = await db.notificationDelivery.findMany({ where: { alertId: automaticAlerts[0].id, userId: user.id, channel: 'IN_APP' } }); assert.equal(notificationRows.length, 1); assert.equal(notificationRows[0].status, 'SENT')
  result = await fetch(`${base}/api/v1/notification-deliveries`, { headers: { cookie } }); assert.equal(result.status, 200); assert((await result.json()).data.some(item => item.id === notificationRows[0].id))
  for (const status of ['ACKNOWLEDGED', 'INVESTIGATING']) { result = await post(`/alerts/${automaticAlerts[0].id}/transition`, { status }); assert.equal(result.status, 200) }
  result = await post(`/alerts/${automaticAlerts[0].id}/transition`, { status: 'RESOLVED', note: 'Handled' }); assert.equal(result.status, 200)
  result = await ingest([demand(1000)]); assert.equal(result.status, 200)
  automaticAlerts = await db.$queryRaw`SELECT "id" FROM "Alert" WHERE "ruleId" = ${automaticRule.id}::uuid AND "meterId" = ${demandMeter.id}::uuid`; assert.equal(automaticAlerts.length, 1)
  result = await post('/tariffs', { name: 'Flat', unitRate: 100, effectiveFrom: '2026-01-01', effectiveTo: '2026-11-16' }); assert.equal(result.status, 201); const oldTariff = (await result.json()).data
  result = await post('/tariffs', { name: 'Flat', unitRate: 200, effectiveFrom: '2026-11-17' }); assert.equal(result.status, 201); const newTariff = (await result.json()).data
  result = await post('/tariff-assignments', { meterId: meter.id, tariffId: oldTariff.id, effectiveFrom: '2026-01-01', effectiveTo: '2026-11-16' }); assert.equal(result.status, 201)
  result = await post('/reports', { periodStart: '2026-11-15T00:00:00Z', periodEnd: '2026-11-16T00:00:00Z', siteId: site.id }); assert.equal(result.status, 201); const historicalRateReport = (await result.json()).data; assert.equal(historicalRateReport.filters.costEstimate.estimatedCostIdr, '200.00'); assert.equal(historicalRateReport.filters.costEstimate.tariffs[0].tariffId, oldTariff.id)
  result = await post('/tariff-assignments', { meterId: meter.id, tariffId: newTariff.id, effectiveFrom: '2026-11-17' }); assert.equal(result.status, 201)
  const unchangedHistoricalReport = await db.reportJob.findUnique({ where: { id: historicalRateReport.id }, select: { filters: true } }); assert.equal(unchangedHistoricalReport.filters.costEstimate.estimatedCostIdr, '200.00'); assert.equal(unchangedHistoricalReport.filters.costEstimate.tariffs[0].tariffId, oldTariff.id)
  result = await post('/tariff-assignments', { meterId: meter.id, tariffId: newTariff.id, effectiveFrom: '2026-11-17' }); assert.equal(result.status, 409)
  result = await fetch(`${base}/api/v1/cost-analysis?periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z&siteId=${site.id}`, { headers: { cookie } }); assert.equal(result.status, 200); const incompleteCost = (await result.json()).data; assert.equal(incompleteCost.estimatedCostIdr, '2600.00'); assert.equal(incompleteCost.isComplete, false); assert(incompleteCost.expectedReadings > incompleteCost.observedReadings)
  result = await post('/tariffs', { name: 'TOU', tariffType: 'TOU', taxPercent: 11, fixedCharge: 310, rates: [{ startMinute: 0, endMinute: 420, unitRate: 100 }, { startMinute: 420, endMinute: 1440, unitRate: 200 }], effectiveFrom: '2026-01-01' }); assert.equal(result.status, 201); const touTariff = (await result.json()).data; assert.equal(touTariff.rates.length, 2)
  result = await post('/tariffs', { name: 'Broken TOU', tariffType: 'TOU', rates: [{ startMinute: 0, endMinute: 420, unitRate: 100 }, { startMinute: 421, endMinute: 1440, unitRate: 200 }], effectiveFrom: '2026-01-01' }); assert.equal(result.status, 422)
  result = await post('/tariff-assignments', { meterId: linkedMeter.id, tariffId: touTariff.id, effectiveFrom: '2026-01-01' }); assert.equal(result.status, 201)
  result = await ingest([{ meterId: linkedMeter.id, timestamp: '2026-11-17T00:30:00Z', value: '10', unit: 'kWh' }]); assert.equal(result.status, 200)
  result = await post('/reports', { periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: site.id, buildingId: building.id, granularity: 'HOUR' }); assert.equal(result.status, 201); const buildingHourlyReport = (await result.json()).data
  result = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${site.id}&buildingId=${building.id}&bucket=HOUR&periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z`, { headers: { cookie } }); assert.equal(result.status, 200); const buildingHourlySeries = (await result.json()).data; assert.deepEqual(buildingHourlyReport.filters.snapshot, buildingHourlySeries.map(({ date, kwh, unit, quality }) => ({ date, kwh, unit, quality })))
  result = await fetch(`${base}/api/v1/cost-analysis?periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z&siteId=${site.id}`, { headers: { cookie } }); assert.equal(result.status, 200); assert.equal((await result.json()).data.estimatedCostIdr, '4842.94')
  result = await post('/emission-factors', { region: 'Test region', factor: 0.8, unit: 'kgCO2e/kWh', publicationSource: 'Test source', applicableYear: 2026, sourceUrl: 'https://example.com/factor', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }); assert.equal(result.status, 201); const factor = (await result.json()).data
  assert.equal(factor.energySource, 'ELECTRICITY')
  const factorAudit = await db.auditLog.findFirst({ where: { organizationId: org.id, entity: 'EmissionFactor', entityId: factor.id, action: 'EMISSION_FACTOR_CREATED' } }); assert.equal(factorAudit.details.publicationSource, 'Test source'); assert.equal(factorAudit.details.sourceUrl, factor.sourceUrl); assert.equal(factorAudit.details.energySource, 'ELECTRICITY')
  const concurrentFactorInput = { region: 'Concurrent region', factor: 0.4, unit: 'kgCO2e/kWh', publicationSource: 'Concurrent test', applicableYear: 2026, sourceUrl: 'https://example.com/concurrent', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }
  const concurrentFactors = await Promise.all([post('/emission-factors', concurrentFactorInput), post('/emission-factors', concurrentFactorInput)]); assert.deepEqual(concurrentFactors.map(response => response.status).sort(), [201, 409])
  result = await fetch(`${base}/api/v1/emission-factors/${factor.id}`, { headers: { cookie } }); assert.equal(result.status, 200); assert.equal((await result.json()).data.sourceUrl, factor.sourceUrl)
  const wrongRegionFactor = await db.emissionFactor.create({ data: { organizationId: org.id, region: 'Other region', factor: '0.7', unit: 'kgCO2e/kWh', publicationSource: 'Other regional source', applicableYear: 2026, sourceUrl: 'https://example.com/other-region', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: new Date('2026-12-31T00:00:00Z') } })
  const oldYearFactor = await db.emissionFactor.create({ data: { organizationId: org.id, region: 'Test region', factor: '0.6', unit: 'kgCO2e/kWh', publicationSource: 'Old year source', applicableYear: 2025, sourceUrl: 'https://example.com/old-year', effectiveFrom: new Date('2025-01-01T00:00:00Z'), effectiveTo: new Date('2025-12-31T00:00:00Z') } })
  const otherOrgFactor = await db.emissionFactor.create({ data: { organizationId: otherOrg.id, region: 'Test region', factor: '0.5', unit: 'kgCO2e/kWh', publicationSource: 'Private other tenant', applicableYear: 2026, sourceUrl: 'https://example.invalid/private-factor', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: new Date('2026-12-31T00:00:00Z') } })
  result = await fetch(`${base}/api/v1/emission-factors/${otherOrgFactor.id}`, { headers: { cookie } }); assert.equal(result.status, 404)
  result = await post('/emission-factors', { region: 'Test region', factor: 0.9, unit: 'kgCO2e/kWh', publicationSource: 'Overlapping source', applicableYear: 2026, sourceUrl: 'https://example.com/other', effectiveFrom: '2026-06-01', effectiveTo: '2026-12-31' }); assert.equal(result.status, 409)
  result = await post('/emission-factors', { region: 'Test region', energySource: 'NATURAL_GAS', factor: 0.3, unit: 'kgCO2e/kWh', publicationSource: 'Gas factor', applicableYear: 2026, sourceUrl: 'https://example.com/gas', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }); assert.equal(result.status, 201); const gasFactor = (await result.json()).data; assert.equal(gasFactor.energySource, 'NATURAL_GAS')
  result = await patch(`/sites/${site.id}`, { emissionRegion: 'Test region' }); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/emissions/estimate?periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z&siteId=${site.id}&factorId=${factor.id}`, { headers: { cookie } }); assert.equal(result.status, 200); const emissions = (await result.json()).data; assert.equal(emissions.estimatedTco2e, '0.018400'); assert.equal(emissions.factor.sourceUrl, 'https://example.com/factor')
  for (const incompatible of [wrongRegionFactor, oldYearFactor]) { result = await fetch(`${base}/api/v1/emissions/estimate?periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z&siteId=${site.id}&factorId=${incompatible.id}`, { headers: { cookie } }); assert.equal(result.status, 422) }
  result = await fetch(`${base}/api/v1/emissions/estimate?periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z&siteId=${site.id}&factorId=${gasFactor.id}`, { headers: { cookie } }); assert.equal(result.status, 422)
  result = await fetch(`${base}/api/v1/emissions/estimate?periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z&siteId=${site.id}`, { headers: { cookie } }); assert.equal(result.status, 200); const automaticEmissions = (await result.json()).data; assert.equal(automaticEmissions.estimatedTco2e, '0.018400'); assert.equal(automaticEmissions.factors[0].id, factor.id)
  result = await post('/reports', { periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: site.id, emissionFactorId: factor.id }); assert.equal(result.status, 201); const pricedReport = (await result.json()).data; assert.equal(pricedReport.filters.costEstimate.estimatedCostIdr, '4842.94'); assert.equal(pricedReport.filters.emissionsEstimate.estimatedTco2e, '0.018400'); assert.equal(pricedReport.filters.timezone, 'Asia/Jakarta')
  result = await fetch(`${base}/api/v1/reports/${pricedReport.id}/download`, { headers: { cookie } }); assert.equal(result.status, 200); const emissionsCsv = await result.text(); assert(emissionsCsv.includes(factor.id)); assert(emissionsCsv.includes('ELECTRICITY')); assert(emissionsCsv.includes('Test source')); assert(emissionsCsv.includes('https://example.com/factor'))
  result = await post('/reports', { periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: site.id, emissionFactorId: wrongRegionFactor.id }); assert.equal(result.status, 422)
  result = await post('/reports', { periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: site.id }); assert.equal(result.status, 201); assert.equal((await result.json()).data.filters.emissionsEstimate.estimatedTco2e, '0.018400')
  for (const format of ['XLSX', 'PDF']) {
    result = await post('/reports', { periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: site.id, emissionFactorId: factor.id, format }); assert.equal(result.status, 201); const fileReport = (await result.json()).data; assert.equal(fileReport.format, format)
    result = await fetch(`${base}/api/v1/reports/${fileReport.id}/download`, { headers: { cookie } }); assert.equal(result.status, 200); const file = Buffer.from(await result.arrayBuffer())
    if (format === 'XLSX') { assert.equal(result.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); assert.equal(file.subarray(0, 2).toString(), 'PK'); assert(file.includes(Buffer.from('xl/worksheets/sheet1.xml'))); assert(file.includes(Buffer.from('https://example.com/factor'))) }
    else { assert.equal(result.headers.get('content-type'), 'application/pdf'); assert.equal(file.subarray(0, 8).toString(), '%PDF-1.4'); assert(file.includes(Buffer.from('2026-11-17'))); assert(file.includes(Buffer.from('https://example.com/factor'))) }
  }
  const idempotentBody = { periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: site.id }
  result = await fetch(`${base}/api/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, 'idempotency-key': `report-${id}` }, body: JSON.stringify(idempotentBody) }); assert.equal(result.status, 201); const idempotentReport = (await result.json()).data
  result = await fetch(`${base}/api/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, 'idempotency-key': `report-${id}` }, body: JSON.stringify(idempotentBody) }); assert.equal(result.status, 200); assert.equal((await result.json()).data.id, idempotentReport.id)
  result = await fetch(`${base}/api/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, 'idempotency-key': `report-${id}` }, body: JSON.stringify({ ...idempotentBody, siteId: unassignedSite.id }) }); assert.equal(result.status, 409)
  result = await ingest([{ meterId: meter.id, timestamp: '2026-11-17T03:00:00Z', value: '3', unit: 'kWh' }]); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/reports/${pricedReport.id}/download`, { headers: { cookie } }); const snapshotCsv = await result.text(); const pricedCsv = snapshotCsv.split(/\r?\n/).slice(0, 2).map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, ''))); assert.equal(pricedCsv[1][pricedCsv[0].indexOf('date')], '2026-11-17'); assert.equal(pricedCsv[1][pricedCsv[0].indexOf('kwh')], '23'); assert.match(snapshotCsv, /4842\.94/); assert.match(snapshotCsv, new RegExp(newTariff.id)); assert.match(snapshotCsv, new RegExp(factor.id))
  const healthMeter = await db.meter.create({ data: { organizationId: org.id, siteId: site.id, code: 'HEALTH-1', meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'API', intervalMinutes: 1, multiplier: 1, status: 'PENDING' } })
  result = await patch(`/meters/${healthMeter.id}/status`, { status: 'ONLINE' }); assert.equal(result.status, 409)
  result = await patch(`/meters/${healthMeter.id}/status`, { status: 'TESTING' }); assert.equal(result.status, 200)
  result = await ingest([{ meterId: healthMeter.id, timestamp: new Date(Date.now() - 1000).toISOString(), value: '1', unit: 'kWh', quality: 'INVALID' }]); assert.equal(result.status, 200)
  assert.equal((await db.meter.findUnique({ where: { id: healthMeter.id } })).status, 'TESTING')
  result = await ingest([{ meterId: healthMeter.id, timestamp: new Date(Date.now() - 2000).toISOString(), value: '2', unit: 'kWh' }]); assert.equal(result.status, 200)
  assert.equal((await db.meter.findUnique({ where: { id: healthMeter.id } })).status, 'ONLINE')
  await db.meterReading.updateMany({ where: { meterId: healthMeter.id }, data: { timestamp: new Date(Date.now() - 10 * 60_000) } })
  const { sweepMeterHealth } = await import('../backend/dist/meter-health.js'); await sweepMeterHealth(db, org.id)
  assert.equal((await db.meter.findUnique({ where: { id: healthMeter.id } })).status, 'OFFLINE')
  result = await ingest([{ meterId: healthMeter.id, timestamp: new Date(Date.now() - 1000).toISOString(), value: '3', unit: 'kWh' }]); assert.equal(result.status, 200)
  assert.equal((await db.meter.findUnique({ where: { id: healthMeter.id } })).status, 'ONLINE')
  result = await fetch(`${base}/api/v1/monitoring/summary?siteId=${site.id}&days=30`, { headers: { cookie } }); assert.equal(result.status, 200); const energySummary = (await result.json()).data; assert.equal(energySummary.metric, 'ENERGY_IMPORT'); assert.ok(energySummary.energyKwh >= 23); assert.ok(energySummary.expectedReadings >= energySummary.observedReadings); assert.equal(typeof energySummary.completenessPercent, 'number')
  result = await fetch(`${base}/api/v1/monitoring/summary?siteId=${site.id}&days=30&comparePrevious=true`, { headers: { cookie } }); assert.equal(result.status, 200); const comparedSummary = (await result.json()).data; assert.equal(comparedSummary.comparison.durationMs, 30 * 86400000); assert.equal(comparedSummary.comparison.periodEnd, comparedSummary.periodStart)
  result = await fetch(`${base}/api/v1/monitoring/summary?days=30`, { headers: { cookie } }); assert.equal(result.status, 200); const organizationSummary = (await result.json()).data; assert.equal(organizationSummary.siteRanking[0].siteId, site.id)
  result = await fetch(`${base}/api/v1/monitoring/summary?siteId=${site.id}&metric=POWER_DEMAND&days=30`, { headers: { cookie } }); assert.equal(result.status, 200); const demandSummary = (await result.json()).data; assert.equal(demandSummary.peakDemandKw, '10'); assert.equal(demandSummary.energyKwh, null)
  result = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${site.id}&bucket=HOUR`, { headers: { cookie } }); assert.equal(result.status, 200); const hourly = (await result.json()).data; assert.ok(hourly.some(point => point.date.includes('T')))
  result = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${site.id}&bucket=WEEK`, { headers: { cookie } }); assert.equal(result.status, 200); const weekly = (await result.json()).data; assert.ok(weekly.some(point => /^\d{4}-W\d{2}$/.test(point.date)))
  result = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${site.id}&bucket=MONTH`, { headers: { cookie } }); assert.equal(result.status, 200); const monthly = (await result.json()).data; assert.ok(monthly.some(point => /^\d{4}-\d{2}$/.test(point.date)))
  result = await fetch(`${base}/api/v1/monitoring/timeseries?siteId=${site.id}&metric=POWER_DEMAND&bucket=HOUR`, { headers: { cookie } }); assert.equal(result.status, 200); const hourlyDemand = (await result.json()).data; assert.ok(hourlyDemand.every(point => point.unit === 'kW'))
  result = await patch(`/users/${user.id}`, { active: false }); assert.equal(result.status, 409)
  const invite = { email: `invite-${id}@example.invalid`, fullName: 'Invited Analyst', role: 'ANALYST', siteIds: [site.id] }
  result = await post('/invitations', { ...invite, siteIds: [otherSite.id] }); assert.equal(result.status, 422)
  result = await post('/invitations', invite); assert.equal(result.status, 201); const oldInvite = (await result.json()).data
  result = await post('/invitations', invite); assert.equal(result.status, 201); const newInvite = (await result.json()).data
  result = await fetch(`${base}/api/v1/invitations`, { headers: { cookie } }); const invitations = (await result.json()).data; assert.equal(JSON.stringify(invitations).includes(newInvite.token), false); assert.equal(JSON.stringify(invitations).includes('tokenHash'), false)
  const accept = (token, invitePassword) => fetch(`${base}/api/v1/auth/accept-invitation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: invitePassword }) })
  result = await accept(oldInvite.token, password); assert.equal(result.status, 410)
  result = await accept(newInvite.token, 'short'); assert.equal(result.status, 422)
  result = await accept(newInvite.token, password); assert.equal(result.status, 201)
  result = await accept(newInvite.token, password); assert.equal(result.status, 410)
  result = await post('/invitations', invite); assert.equal(result.status, 409)
  result = await post('/invitations', { ...invite, email: `expired-${id}@example.invalid` }); assert.equal(result.status, 201); const expiredInvite = (await result.json()).data
  await db.$executeRaw`UPDATE "Invitation" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = ${expiredInvite.id}::uuid`
  result = await accept(expiredInvite.token, password); assert.equal(result.status, 410)
  const invitedLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: invite.email, password }) }); assert.equal(invitedLogin.status, 200)
  const invitedCookie = invitedLogin.headers.get('set-cookie').split(';')[0], invitedCsrf = (await invitedLogin.json()).data.csrfToken
  assert.equal((await db.user.findUnique({ where: { email: invite.email } })).active, true)
  result = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: invitedCookie } }); assert.equal(result.status, 200, 'Invited user session was not restored')
  result = await fetch(`${base}/api/v1/sites`, { headers: { cookie: invitedCookie } }); const invitedSites = await result.json(); assert.equal(result.status, 200, JSON.stringify(invitedSites)); assert.deepEqual(invitedSites.data.map(s => s.id), [site.id])
  result = await fetch(`${base}/api/v1/auth/profile`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: invitedCookie, 'x-csrf-token': invitedCsrf }, body: JSON.stringify({ fullName: 'Updated Analyst' }) }); assert.equal(result.status, 200)
  const secondLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: invite.email, password }) }); assert.equal(secondLogin.status, 200); const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0]
  const changePassword = newPassword => fetch(`${base}/api/v1/auth/change-password`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: invitedCookie, 'x-csrf-token': invitedCsrf }, body: JSON.stringify({ currentPassword: password, newPassword }) })
  result = await changePassword('é'.repeat(40)); assert.equal(result.status, 422)
  const replacementPassword = `new-${randomUUID()}`
  result = await changePassword(replacementPassword); assert.equal(result.status, 204)
  result = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: secondCookie } }); assert.equal(result.status, 401)
  result = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: invite.email, password }) }); assert.equal(result.status, 401)
  result = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: invite.email, password: replacementPassword }) }); assert.equal(result.status, 200)
  result = await post('/integration-sources', { name: 'Smoke source', meterIds: [otherMeter.id] }); assert.equal(result.status, 422)
  result = await post('/integration-sources', { name: 'Smoke source', meterIds: [meter.id], ipAllowlist: ['127.0.0.2'], rateLimitPerMinute: 20 }); assert.equal(result.status, 201)
  const source = (await result.json()).data
  result = await fetch(`${base}/api/v1/integration-sources`, { headers: { cookie } }); const sources = (await result.json()).data; assert.equal(JSON.stringify(sources).includes(source.token), false); assert.equal(JSON.stringify(sources).includes('secretHash'), false)
  const device = (readings, token = source.token) => fetch(`${base}/api/v1/ingestion/device-readings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ readings }) })
  const deviceRow = { meterId: meter.id, timestamp: '2026-01-02T00:00:00Z', value: '4', unit: 'kWh', externalReadingId: 'reading-1' }
  result = await device([deviceRow]); assert.equal(result.status, 403)
  result = await patch(`/integration-sources/${source.id}`, { ipAllowlist: ['127.0.0.1'] }); assert.equal(result.status, 200)
  result = await device([{ ...deviceRow, meterId: unassignedMeter.id }]); assert.equal(result.status, 403)
  result = await device([deviceRow]); assert.equal(result.status, 200); assert.equal((await result.json()).data.accepted, 1)
  const sourceReading = await db.meterReading.findFirst({ where: { meterId: meter.id, externalId: `source:${source.id}:reading-1` } }); assert.equal(sourceReading.sourceId, source.id); assert.equal(sourceReading.sourceType, 'API')
  result = await device([deviceRow]); assert.equal(result.status, 200); assert.equal((await result.json()).data.duplicates, 1)
  const invalidDeviceRow = { meterId: meter.id, timestamp: '2026-01-03T00:00:00Z', value: '5', unit: 'kWh', metric: 'ENERGY_IMPORT', quality: 'INVALID', externalReadingId: 'invalid-source-reading' }
  result = await device([deviceRow, invalidDeviceRow]); assert.equal(result.status, 200); const quarantinedDeviceBatch = (await result.json()).data; assert.equal(quarantinedDeviceBatch.duplicates, 1); assert.equal(quarantinedDeviceBatch.rejected, 1); assert.ok(quarantinedDeviceBatch.quarantineJobId)
  result = await fetch(`${base}/api/v1/quarantined-readings?status=OPEN`, { headers: { cookie } }); const apiQuarantine = (await result.json()).data.find(item => item.importJobId === quarantinedDeviceBatch.quarantineJobId); assert.ok(apiQuarantine); assert.match(apiQuarantine.reason, /INVALID/)
  result = await fetch(`${base}/api/v1/quarantined-readings/${apiQuarantine.id}/release`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ meterId: meter.id, timestamp: invalidDeviceRow.timestamp, value: invalidDeviceRow.value, unit: invalidDeviceRow.unit }) }); assert.equal(result.status, 200)
  const releasedDeviceReading = await db.meterReading.findFirst({ where: { meterId: meter.id, externalId: `source:${source.id}:invalid-source-reading` } }); assert.equal(releasedDeviceReading.sourceId, source.id); assert.equal(releasedDeviceReading.sourceType, 'API'); assert.equal(releasedDeviceReading.importJobId, quarantinedDeviceBatch.quarantineJobId)
  result = await post(`/integration-sources/${source.id}/rotate`, { graceMinutes: 60 }); assert.equal(result.status, 200); const rotated = (await result.json()).data
  result = await device([deviceRow], source.token); assert.equal(result.status, 200)
  result = await device([deviceRow], rotated.token); assert.equal(result.status, 200)
  await db.$executeRaw`UPDATE "IntegrationCredential" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "sourceId" = ${source.id}::uuid AND "expiresAt" IS NOT NULL`
  result = await device([deviceRow], source.token); assert.equal(result.status, 401)
  result = await device([deviceRow], rotated.token); assert.equal(result.status, 200)
  result = await patch(`/integration-sources/${source.id}`, { rateLimitPerMinute: 1 }); assert.equal(result.status, 200)
  result = await device([deviceRow], rotated.token); assert.equal(result.status, 200)
  result = await device([deviceRow], rotated.token); assert.equal(result.status, 429)
  result = await post(`/integration-sources/${source.id}/revoke`, {}); assert.equal(result.status, 200)
  result = await device([deviceRow], rotated.token); assert.equal(result.status, 401)
  const analyst = await createMember({ email: `analyst-${id}@example.invalid`, fullName: 'Analyst', passwordHash: await bcrypt.hash(password, 10), role: 'ANALYST', organizationId: org.id })
  result = await post('/site-assignments', { userId: analyst.id, siteId: otherSite.id }); assert.equal(result.status, 404)
  result = await post('/site-assignments', { userId: analyst.id, siteId: site.id }); assert.equal(result.status, 201)
  const assignment = (await result.json()).data
  const analystLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: analyst.email, password }) }); assert.equal(analystLogin.status, 200)
  const analystCookie = analystLogin.headers.get('set-cookie').split(';')[0]
  let analystCsrf = (await analystLogin.json()).data.csrfToken
  result = await fetch(`${base}/api/v1/permissions`, { headers: { cookie } }); assert.equal(result.status, 200); const permissionCatalog = (await result.json()).data; assert.ok(permissionCatalog.some(permission => permission.code === 'roles.manage'))
  result = await fetch(`${base}/api/v1/roles`, { headers: { cookie } }); assert.equal(result.status, 200); assert.equal((await result.json()).data.length, 7)
  result = await post('/roles', { name: 'Monitoring Operator', scope: 'ASSIGNED_SITES', permissionCodes: ['site.read', 'meter.read', 'monitor.read'] }); assert.equal(result.status, 201); const customRole = (await result.json()).data
  result = await fetch(`${base}/api/v1/roles/${customRole.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ permissionCodes: ['site.read', 'meter.read', 'monitor.read'] }) }); assert.equal(result.status, 200)
  result = await patch(`/users/${analyst.id}`, { roleId: customRole.id }); assert.equal(result.status, 200); assert.equal((await result.json()).data.roleId, customRole.id)
  result = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: analystCookie } }); const customSession = (await result.json()).data; assert.equal(customSession.role, customRole.code); assert.equal(customSession.scope, 'ASSIGNED_SITES'); assert.deepEqual(new Set(customSession.permissions), new Set(['site.read', 'meter.read', 'monitor.read']))
  result = await fetch(`${base}/api/v1/sites`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 200); assert.deepEqual((await result.json()).data.map(item => item.id), [site.id])
  result = await fetch(`${base}/api/v1/sites/${unassignedSite.id}`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 404)
  result = await fetch(`${base}/api/v1/roles`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: analystCookie, 'x-csrf-token': analystCsrf }, body: JSON.stringify({ name: 'Unauthorized Role', scope: 'ASSIGNED_SITES', permissionCodes: [] }) }); assert.equal(result.status, 403)
  result = await patch(`/users/${analyst.id}`, { role: 'ANALYST' }); assert.equal(result.status, 200)
  const otherOrgAdminRole = await db.role.findFirst({ where: { organizationId: otherOrg.id, code: 'ADMIN' } })
  await db.organizationMembership.create({ data: { organizationId: otherOrg.id, userId: user.id, role: 'ADMIN', roleId: otherOrgAdminRole.id } })
  await db.siteAssignment.create({ data: { organizationId: otherOrg.id, userId: user.id, siteId: otherSite.id } })
  const rootSecondLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) }); assert.equal(rootSecondLogin.status, 200)
  const rootSecondCookie = rootSecondLogin.headers.get('set-cookie').split(';')[0], rootSecondCsrfInitial = (await rootSecondLogin.json()).data.csrfToken
  const switchOrganization = (sessionCookie, token, organizationId) => fetch(`${base}/api/v1/auth/switch-organization`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie, 'x-csrf-token': token }, body: JSON.stringify({ organizationId }) })
  result = await switchOrganization(rootSecondCookie, rootSecondCsrfInitial, otherOrg.id); assert.equal(result.status, 200); let rootOtherOrgCsrf = (await result.json()).data.csrfToken
  result = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: rootSecondCookie } }); const rootOtherOrgSession = (await result.json()).data; assert.equal(rootOtherOrgSession.organization.id, otherOrg.id); assert.equal(rootOtherOrgSession.role, 'ADMIN'); assert.equal(rootOtherOrgSession.memberships.length, 2)
  result = await fetch(`${base}/api/v1/sites`, { headers: { cookie: rootSecondCookie } }); assert.deepEqual((await result.json()).data.map(item => item.id), [otherSite.id])
  result = await fetch(`${base}/api/v1/invitations`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: rootSecondCookie, 'x-csrf-token': rootOtherOrgCsrf }, body: JSON.stringify({ email: analyst.email, fullName: analyst.fullName, role: 'ANALYST', siteIds: [otherSite.id] }) }); assert.equal(result.status, 201); const existingAccountInvite = (await result.json()).data
  result = await fetch(`${base}/api/v1/auth/accept-invitation`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: analystCookie }, body: JSON.stringify({ token: existingAccountInvite.token }) }); assert.equal(result.status, 201)
  result = await switchOrganization(analystCookie, analystCsrf, otherOrg.id); assert.equal(result.status, 200); const analystOtherOrgCsrf = (await result.json()).data.csrfToken
  result = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: analystCookie } }); const analystOtherOrgSession = (await result.json()).data; assert.equal(analystOtherOrgSession.organization.id, otherOrg.id); assert.equal(analystOtherOrgSession.role, 'ANALYST'); assert.deepEqual(analystOtherOrgSession.siteIds, [otherSite.id])
  result = await fetch(`${base}/api/v1/sites`, { headers: { cookie: analystCookie } }); assert.deepEqual((await result.json()).data.map(item => item.id), [otherSite.id])
  result = await fetch(`${base}/api/v1/meters/${meter.id}`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 404)
  result = await switchOrganization(analystCookie, analystOtherOrgCsrf, org.id); assert.equal(result.status, 200); analystCsrf = (await result.json()).data.csrfToken
  result = await switchOrganization(rootSecondCookie, rootOtherOrgCsrf, org.id); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/users/${user.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: analystCookie, 'x-csrf-token': analystCsrf }, body: JSON.stringify({ role: 'ADMIN' }) }); assert.equal(result.status, 403)
  result = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: analystCookie } }); const analystSession = (await result.json()).data; assert.deepEqual(analystSession.siteIds, [site.id]); assert(analystSession.permissions.includes('alert.acknowledge'))
  result = await fetch(`${base}/api/v1/data-quality?siteId=${site.id}`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/data-quality?siteId=${unassignedSite.id}`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 403)
  result = await fetch(`${base}/api/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: analystCookie, 'x-csrf-token': analystCsrf }, body: JSON.stringify({ periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: site.id }) }); assert.equal(result.status, 201); const analystReport = (await result.json()).data
  result = await fetch(`${base}/api/v1/reports`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: analystCookie, 'x-csrf-token': analystCsrf }, body: JSON.stringify({ periodStart: '2026-11-17T00:00:00Z', periodEnd: '2026-11-18T00:00:00Z', siteId: unassignedSite.id }) }); assert.equal(result.status, 403)
  result = await fetch(`${base}/api/v1/reports/${analystReport.id}/download`, { headers: { cookie: analystCookie } }); if (result.status !== 200) throw new Error(`Analyst report download failed: ${result.status} ${await result.text()}`)
  const manager = await createMember({ email: `manager-${id}@example.invalid`, fullName: 'Energy Manager', passwordHash: await bcrypt.hash(password, 10), role: 'ENERGY_MANAGER', organizationId: org.id })
  result = await post('/site-assignments', { userId: manager.id, siteId: site.id }); assert.equal(result.status, 201)
  const managerLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: manager.email, password }) }); assert.equal(managerLogin.status, 200)
  const managerCookie = managerLogin.headers.get('set-cookie').split(';')[0], managerCsrf = (await managerLogin.json()).data.csrfToken
  const managerPost = (path, body) => fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: managerCookie, 'x-csrf-token': managerCsrf }, body: JSON.stringify(body) })
  result = await managerPost('/baselines', { ...baselineValues, siteId: site.id, metric: 'ENERGY_IMPORT' }); assert.equal(result.status, 201); const managerBaseline = (await result.json()).data
  result = await managerPost(`/baselines/${managerBaseline.id}/approve`, { notes: 'Energy manager approval' }); assert.equal(result.status, 200)
  result = await managerPost('/baselines', { ...baselineValues, siteId: unassignedSite.id, metric: 'ENERGY_IMPORT' }); assert.equal(result.status, 404)
  result = await managerPost('/targets', { siteId: site.id, metric: 'ENERGY_IMPORT', startDate: '2026-11-17', endDate: '2026-11-30', targetValue: 90, unit: 'kWh' }); assert.equal(result.status, 201)
  result = await fetch(`${base}/api/v1/cost-analysis?periodStart=2026-11-17T00%3A00%3A00Z&periodEnd=2026-11-18T00%3A00%3A00Z&siteId=${site.id}`, { headers: { cookie: managerCookie } }); assert.equal(result.status, 200)
  const facility = await createMember({ email: `facility-${id}@example.invalid`, fullName: 'Facility Manager', passwordHash: await bcrypt.hash(password, 10), role: 'FACILITY_MANAGER', organizationId: org.id })
  result = await post('/site-assignments', { userId: facility.id, siteId: site.id }); assert.equal(result.status, 201)
  const facilityLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: facility.email, password }) }); assert.equal(facilityLogin.status, 200)
  const facilityCookie = facilityLogin.headers.get('set-cookie').split(';')[0], facilityCsrf = (await facilityLogin.json()).data.csrfToken
  const facilityPost = (path, body) => fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: facilityCookie, 'x-csrf-token': facilityCsrf }, body: JSON.stringify(body) })
  const facilityPatch = (path, body) => fetch(`${base}/api/v1${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: facilityCookie, 'x-csrf-token': facilityCsrf }, body: JSON.stringify(body) })
  result = await facilityPost('/assets', { siteId: site.id, code: 'FACILITY-ASSET', name: 'Facility pump', type: 'PUMP' }); assert.equal(result.status, 201); const facilityAsset = (await result.json()).data
  result = await facilityPatch(`/assets/${facilityAsset.id}`, { name: 'Updated facility pump' }); assert.equal(result.status, 200)
  result = await facilityPost('/assets', { siteId: unassignedSite.id, code: 'CROSS-SITE-ASSET', name: 'Blocked pump', type: 'PUMP' }); assert.equal(result.status, 404)
  result = await fetch(`${base}/api/v1/sites`, { headers: { cookie: analystCookie } }); assert.deepEqual((await result.json()).data.map(s => s.id), [site.id])
  result = await fetch(`${base}/api/v1/sites/${unassignedSite.id}`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 404)
  result = await fetch(`${base}/api/v1/buildings`, { headers: { cookie: analystCookie } }); assert.deepEqual((await result.json()).data.map(b => b.id), [building.id])
  result = await fetch(`${base}/api/v1/buildings/${unassignedBuilding.id}`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 404)
  result = await fetch(`${base}/api/v1/meters`, { headers: { cookie: analystCookie } }); assert.deepEqual(new Set((await result.json()).data.map(m => m.id)), new Set([meter.id, demandMeter.id, healthMeter.id, linkedMeter.id, outOfOrderMeter.id]))
  result = await fetch(`${base}/api/v1/meters/${unassignedMeter.id}`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 404)
  result = await fetch(`${base}/api/v1/meters/${unassignedMeter.id}/readings`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 404)
  result = await fetch(`${base}/api/v1/monitoring/summary`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 403)
  result = await fetch(`${base}/api/v1/monitoring/summary?siteId=${site.id}`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/workspace/users`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 403)
  result = await fetch(`${base}/api/v1/sites`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: analystCookie, 'x-csrf-token': analystCsrf }, body: '{}' }); assert.equal(result.status, 403)
  const assignedAlertId = randomUUID(), unassignedAlertId = randomUUID()
  await db.$executeRaw`INSERT INTO "Alert" ("id", "organizationId", "ruleId", "meterId", "message") VALUES (${assignedAlertId}::uuid, ${org.id}::uuid, ${automaticRule.id}::uuid, ${demandMeter.id}::uuid, 'Assigned')`
  await db.$executeRaw`INSERT INTO "Alert" ("id", "organizationId", "ruleId", "meterId", "message") VALUES (${unassignedAlertId}::uuid, ${org.id}::uuid, ${automaticRule.id}::uuid, ${unassignedMeter.id}::uuid, 'Unassigned')`
  result = await fetch(`${base}/api/v1/alerts`, { headers: { cookie: analystCookie } }); const visibleAlerts = (await result.json()).data; assert(visibleAlerts.some(a => a.id === assignedAlertId)); assert(!visibleAlerts.some(a => a.id === unassignedAlertId))
  const analystTransition = (alertId, status) => fetch(`${base}/api/v1/alerts/${alertId}/transition`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: analystCookie, 'x-csrf-token': analystCsrf }, body: JSON.stringify({ status, note: 'Test' }) })
  result = await analystTransition(unassignedAlertId, 'ACKNOWLEDGED'); assert.equal(result.status, 404)
  result = await analystTransition(assignedAlertId, 'RESOLVED'); assert.equal(result.status, 403)
  result = await analystTransition(assignedAlertId, 'ACKNOWLEDGED'); assert.equal(result.status, 200)
  const technician = await createMember({ email: `tech-${id}@example.invalid`, fullName: 'Technician', passwordHash: await bcrypt.hash(password, 10), role: 'TECHNICIAN', organizationId: org.id })
  result = await post('/site-assignments', { userId: technician.id, siteId: site.id }); assert.equal(result.status, 201)
  result = await post('/roles', { name: 'Assigned Maintenance Operator', scope: 'ASSIGNED_SITES', permissionCodes: ['site.read', 'meter.read', 'meter.maintain', 'maintenance.assigned', 'alert.read', 'alert.investigate'] }); assert.equal(result.status, 201); const customTechnicianRole = (await result.json()).data
  result = await patch(`/users/${technician.id}`, { roleId: customTechnicianRole.id }); assert.equal(result.status, 200)
  const technicianLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: technician.email, password }) }); assert.equal(technicianLogin.status, 200)
  const technicianCookie = technicianLogin.headers.get('set-cookie').split(';')[0], technicianCsrf = (await technicianLogin.json()).data.csrfToken
  const maintenancePost = (path, body) => fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: technicianCookie, 'x-csrf-token': technicianCsrf }, body: JSON.stringify(body) })
  result = await maintenancePost(`/meters/${healthMeter.id}/maintenance`, { category: 'CALIBRATION', title: 'Quarterly meter calibration', scheduledAt: new Date().toISOString() }); assert.equal(result.status, 201); const maintenance = (await result.json()).data
  result = await maintenancePost(`/meters/${unassignedMeter.id}/maintenance`, { category: 'INSPECTION', title: 'Unassigned probe' }); assert.equal(result.status, 404)
  result = await fetch(`${base}/api/v1/meters/${healthMeter.id}/maintenance`, { headers: { cookie: technicianCookie } }); assert.equal(result.status, 200); const visibleMaintenance = (await result.json()).data.find(item => item.id === maintenance.id); assert(visibleMaintenance); assert.deepEqual(visibleMaintenance.evidence, [])
  const maintenancePatch = (body) => fetch(`${base}/api/v1/meter-maintenance/${maintenance.id}/status`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: technicianCookie, 'x-csrf-token': technicianCsrf }, body: JSON.stringify(body) })
  result = await maintenancePatch({ status: 'IN_PROGRESS', workNotes: 'Calibration started' }); assert.equal(result.status, 200); assert.equal((await db.meter.findUnique({ where: { id: healthMeter.id } })).status, 'MAINTENANCE')
  const invalidMaintenanceEvidence = await maintenancePost(`/meter-maintenance/${maintenance.id}/evidence`, { fileName: 'fake.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('not a pdf').toString('base64') }); assert.equal(invalidMaintenanceEvidence.status, 422)
  const validMaintenancePdf = Buffer.from('%PDF-1.4\nEnergyTrack maintenance evidence\n%%EOF')
  result = await maintenancePost(`/meter-maintenance/${maintenance.id}/evidence`, { fileName: 'calibration.pdf', contentType: 'application/pdf', contentBase64: validMaintenancePdf.toString('base64') }); assert([201, 503].includes(result.status))
  if (result.status === 201) { const evidence = (await result.json()).data; assert.equal(evidence.maintenanceId, maintenance.id); assert.equal(evidence.sizeBytes, validMaintenancePdf.length); result = await fetch(`${base}/api/v1/meter-maintenance/${maintenance.id}/evidence/${evidence.id}`, { headers: { cookie: technicianCookie } }); assert.equal(result.status, 200); assert.deepEqual(Buffer.from(await result.arrayBuffer()), validMaintenancePdf) }
  else assert.equal((await result.json()).error.code, 'EVIDENCE_SCANNER_NOT_CONFIGURED')
  result = await maintenancePatch({ status: 'COMPLETED' }); assert.equal(result.status, 422)
  result = await maintenancePatch({ status: 'COMPLETED', outcome: 'Readings within tolerance' }); assert.equal(result.status, 200); assert.equal((await db.meter.findUnique({ where: { id: healthMeter.id } })).status, 'TESTING')
  result = await maintenancePatch({ status: 'IN_PROGRESS' }); assert.equal(result.status, 409)
  const auditor = await createMember({ email: `auditor-${id}@example.invalid`, fullName: 'Auditor', passwordHash: await bcrypt.hash(password, 10), role: 'AUDITOR', organizationId: org.id })
  result = await post('/site-assignments', { userId: auditor.id, siteId: site.id }); assert.equal(result.status, 201)
  result = await post('/roles', { name: 'Assigned Audit Operator', scope: 'ASSIGNED_SITES', permissionCodes: ['site.read', 'audit.read', 'audit.assigned', 'audit.submit', 'audit.evidence.manage', 'auditlog.read'] }); assert.equal(result.status, 201); const customAuditorRole = (await result.json()).data
  result = await patch(`/users/${auditor.id}`, { roleId: customAuditorRole.id }); assert.equal(result.status, 200)
  const auditorLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: auditor.email, password }) }); assert.equal(auditorLogin.status, 200)
  const auditorCookie = auditorLogin.headers.get('set-cookie').split(';')[0]
  const auditorMe = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: auditorCookie } }), auditorMeBody = await auditorMe.json();
  const signedSession = decodeURIComponent(auditorCookie.slice(auditorCookie.indexOf('=') + 1)).slice(2), splitAt = signedSession.lastIndexOf('.'), sessionId = signedSession.slice(0, splitAt), signature = signedSession.slice(splitAt + 1)
  assert.equal(signature, createHmac('sha256', process.env.SESSION_SECRET).update(sessionId).digest('base64').replace(/=+$/, ''), 'auditor session cookie must be valid')
  assert.equal(auditorMe.status, 200, JSON.stringify(auditorMeBody)); const auditorCsrf = auditorMeBody.data.csrfToken; const auditorPost = (path, body) => fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: auditorCookie, 'x-csrf-token': auditorCsrf }, body: JSON.stringify(body) })
  result = await fetch(`${base}/api/v1/audits`, { headers: { cookie: auditorCookie } }); if (result.status !== 200) throw new Error(`Auditor audit list failed: ${result.status} ${await result.text()}`)
  result = await fetch(`${base}/api/v1/alerts/${assignedAlertId}/transition`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: technicianCookie, 'x-csrf-token': technicianCsrf }, body: JSON.stringify({ status: 'INVESTIGATING' }) }); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/site-assignments/${assignment.id}`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': csrf } }); assert.equal(result.status, 204)
  result = await fetch(`${base}/api/v1/meters/${meter.id}`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 404)
  result = await patch(`/users/${analyst.id}`, { active: false }); assert.equal(result.status, 200)
  result = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: analystCookie } }); assert.equal(result.status, 401)
  const rule = await db.alertRule.create({ data: { organizationId: org.id, name: 'Smoke rule', metric: 'ENERGY_IMPORT', threshold: 10, severity: 'HIGH' } })
  const alert = await db.alert.create({ data: { organizationId: org.id, ruleId: rule.id, message: 'Smoke alert' } })
  result = await post(`/alerts/${alert.id}/transition`, { status: 'RESOLVED', note: 'Done' }); assert.equal(result.status, 409)
  for (const status of ['ACKNOWLEDGED', 'INVESTIGATING']) { result = await post(`/alerts/${alert.id}/transition`, { status }); assert.equal(result.status, 200) }
  result = await post(`/alerts/${alert.id}/transition`, { status: 'RESOLVED' }); assert.equal(result.status, 422)
  result = await post(`/alerts/${alert.id}/transition`, { status: 'RESOLVED', note: 'Investigated and fixed' }); assert.equal(result.status, 200)
  const otherAuditor = await createMember({ email: `auditor-other-${id}@example.invalid`, fullName: 'Other Auditor', passwordHash: await bcrypt.hash(password, 10), role: 'AUDITOR', organizationId: org.id })
  result = await post('/audits', { siteId: site.id, title: 'Unassigned reviewer audit', assignedAuditorId: otherAuditor.id }); assert.equal(result.status, 422)
  result = await post('/site-assignments', { userId: otherAuditor.id, siteId: site.id }); assert.equal(result.status, 201)
  result = await post('/audits', { siteId: site.id, title: 'Other auditor audit', assignedAuditorId: otherAuditor.id }); assert.equal(result.status, 201); const otherAuditorAudit = (await result.json()).data
  result = await post('/audits', { siteId: site.id, title: 'Smoke audit', assignedAuditorId: auditor.id }); assert.equal(result.status, 201)
  const audit = (await result.json()).data
  assert.equal(audit.assignedAuditorUser.id, auditor.id)
  result = await maintenancePost(`/audits/${audit.id}/transition`, { status: 'APPROVED' }); assert.equal(result.status, 403)
  result = await auditorPost(`/audits/${audit.id}/evidence`, { fileName: 'fake.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('not a PDF').toString('base64') }); assert.equal(result.status, 422)
  result = await fetch(`${base}/api/v1/audits`, { headers: { cookie: auditorCookie } }); assert.equal(result.status, 200); const assignedAudits = (await result.json()).data; assert(assignedAudits.some(item => item.id === audit.id)); assert(!assignedAudits.some(item => item.id === otherAuditorAudit.id))
  result = await fetch(`${base}/api/v1/audits/${otherAuditorAudit.id}`, { headers: { cookie: auditorCookie } }); assert.equal(result.status, 404)
  result = await post(`/audits/${audit.id}/findings`, { severity: 'HIGH', observation: 'Observed issue', recommendation: 'Repair' }); assert.equal(result.status, 201)
  const finding = (await result.json()).data
  result = await fetch(`${base}/api/v1/audit-logs?page=1&pageSize=100&sort=createdAt&direction=desc`, { headers: { cookie: auditorCookie } }); assert.equal(result.status, 200); const scopedAuditLogs = (await result.json()).data.items; assert(scopedAuditLogs.some(log => log.entity === 'MeterMaintenance')); assert(scopedAuditLogs.some(log => log.entity === 'AuditFinding' && log.entityId === finding.id))
  result = await post(`/audit-findings/${finding.id}/actions`, { ownerId: user.id, dueDate: '2026-12-01' }); assert.equal(result.status, 201)
  const action = (await result.json()).data
  result = await post(`/corrective-actions/${action.id}/close`, { outcome: 'Fixed' }); assert.equal(result.status, 422)
  result = await post(`/audits/${audit.id}/transition`, { status: 'SCHEDULED' }); assert.equal(result.status, 200, await result.clone().text())
  result = await auditorPost(`/audits/${audit.id}/transition`, { status: 'IN_PROGRESS' }); assert.equal(result.status, 200)
  result = await auditorPost(`/audits/${audit.id}/transition`, { status: 'SUBMITTED' }); assert.equal(result.status, 200)
  result = await auditorPost(`/audits/${audit.id}/transition`, { status: 'APPROVED' }); assert.equal(result.status, 403)
  result = await post(`/audits/${audit.id}/transition`, { status: 'APPROVED' }); assert.equal(result.status, 403)
  await db.energyAudit.update({ where: { id: otherAuditorAudit.id }, data: { status: 'SUBMITTED' } })
  result = await patch('/organization', { auditApprovalSoD: false }); assert.equal(result.status, 200); assert.equal((await result.json()).data.auditApprovalSoD, false)
  result = await post(`/audits/${otherAuditorAudit.id}/transition`, { status: 'APPROVED' }); assert.equal(result.status, 200)
  result = await patch('/organization', { auditApprovalSoD: true }); assert.equal(result.status, 200); assert.equal((await result.json()).data.auditApprovalSoD, true)
  result = await post(`/audits/${audit.id}/transition`, { status: 'CLOSED' }); assert.equal(result.status, 409)
  const reviewer = await createMember({ email: `review-${id}@example.invalid`, fullName: 'Reviewer', passwordHash: await bcrypt.hash(password, 10), role: 'ADMIN', organizationId: org.id })
  const reviewerLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: reviewer.email, password }) })
  assert.equal(reviewerLogin.status, 200)
  const reviewerCookie = reviewerLogin.headers.get('set-cookie').split(';')[0], reviewerCsrf = (await reviewerLogin.json()).data.csrfToken
  result = await fetch(`${base}/api/v1/audits/${audit.id}/transition`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: reviewerCookie, 'x-csrf-token': reviewerCsrf }, body: JSON.stringify({ status: 'APPROVED' }) }); assert.equal(result.status, 200)
  result = await post(`/audits/${audit.id}/transition`, { status: 'CLOSED' }); assert.equal(result.status, 409)
  result = await post(`/corrective-actions/${action.id}/close`, { outcome: 'Fixed', evidenceUrl: 'https://example.com/evidence' }); assert.equal(result.status, 200)
  result = await post(`/audits/${audit.id}/transition`, { status: 'CLOSED' }); assert.equal(result.status, 200)
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  await db.meterReading.createMany({ data: Array.from({ length: 8 }, (_, i) => { const timestamp = new Date(today.getTime() - (8 - i) * 86400000); return { organizationId: org.id, meterId: linkedMeter.id, externalId: `forecast-${i}`, timestamp, rawValue: '1', value: '1', unit: 'kWh', quality: 'VALID' } }) })
  result = await fetch(`${base}/api/v1/analytics/forecast?siteId=${site.id}&days=8&horizon=2&model=COMPARE`, { headers: { cookie } }); assert.equal(result.status, 200); const comparison = (await result.json()).data; assert.equal(comparison.movingAverage.model, 'MOVING_AVERAGE'); assert.equal(comparison.exponentialSmoothing.model, 'EXPONENTIAL_SMOOTHING'); assert.equal(comparison.comparison.length, 2)
  result = await post('/analytics/forecast-runs', { siteId: site.id, meterId: linkedMeter.id, days: 8, horizon: 2, model: 'COMPARE' }); assert.equal(result.status, 201); const savedForecast = (await result.json()).data; assert.equal(savedForecast.model, 'COMPARE'); assert.equal(savedForecast.meterId, linkedMeter.id); assert.equal(savedForecast.result.comparison.length, 2); assert.equal(savedForecast.result.timezone, 'Asia/Jakarta')
  result = await fetch(`${base}/api/v1/analytics/forecast-runs?siteId=${site.id}&meterId=${linkedMeter.id}`, { headers: { cookie } }); assert.equal(result.status, 200); assert((await result.json()).data.some(run => run.id === savedForecast.id && run.meterId === linkedMeter.id))
  const archivedSite = await db.site.create({ data: { organizationId: org.id, code: 'ARCHIVE-1', name: 'Archived history site', type: 'OFFICE', address: 'Preserve meter history', timezone: 'Asia/Jakarta' } })
  result = await fetch(`${base}/api/v1/analytics/forecast?siteId=${archivedSite.id}&days=8&horizon=2`, { headers: { cookie } }); assert.equal(result.status, 422); assert.equal((await result.json()).error.code, 'INSUFFICIENT_HISTORY')
  const archivedMeter = await db.meter.create({ data: { organizationId: org.id, siteId: archivedSite.id, code: 'ARCHIVE-METER', meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'API', intervalMinutes: 60, multiplier: 1, status: 'ONLINE' } })
  const archivedReading = await db.meterReading.create({ data: { organizationId: org.id, meterId: archivedMeter.id, externalId: 'archive-history-1', timestamp: new Date('2026-11-16T00:00:00Z'), rawValue: '1', value: '1', unit: 'kWh', quality: 'VALID', sourceType: 'API' } })
  result = await post(`/sites/${archivedSite.id}/archive`, {}); assert.equal(result.status, 200); assert.equal((await result.json()).data.status, 'ARCHIVED')
  assert.equal(await db.meterReading.count({ where: { id: archivedReading.id } }), 1)
  result = await post(`/sites/${archivedSite.id}/archive`, {}); assert.equal(result.status, 409)
  result = await ingest([{ meterId: archivedMeter.id, timestamp: '2026-11-17T00:00:00Z', value: '2', unit: 'kWh' }]); assert.equal(result.status, 422)
  const forgot = email => fetch(`${base}/api/v1/auth/forgot-password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
  const forgotKnown = await forgot(user.email), forgotUnknown = await forgot(`unknown-${id}@example.invalid`); assert.equal(forgotKnown.status, 202); assert.equal(forgotUnknown.status, 202)
  const resetToken = (await forgotKnown.json()).data.developmentToken; assert.match(resetToken, /^pr_[a-f0-9]{64}$/)
  result = await fetch(`${base}/api/v1/auth/reset-password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: resetToken, password: 'new-secure-password-2026' }) }); assert.equal(result.status, 204)
  const resetUser = await db.user.findUnique({ where: { id: user.id } }); assert.equal(await bcrypt.compare('new-secure-password-2026', resetUser.passwordHash), true)
  result = await fetch(`${base}/api/v1/auth/reset-password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: resetToken, password: 'new-secure-password-2026' }) }); assert.equal(result.status, 410)
  const oldPasswordLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) }); assert([401, 429].includes(oldPasswordLogin.status), `the previous password must be rejected (HTTP ${oldPasswordLogin.status})`)
  const newPasswordLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'new-secure-password-2026' }) }); if (newPasswordLogin.status !== 200) throw new Error(`Reset password login failed: ${newPasswordLogin.status} ${await newPasswordLogin.text()}`)
  const concurrent = await Promise.all([
    patch(`/users/${reviewer.id}`, { active: false }),
    fetch(`${base}/api/v1/users/${user.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: reviewerCookie, 'x-csrf-token': reviewerCsrf }, body: JSON.stringify({ active: false }) })
  ])
  assert.equal(concurrent.filter(response => response.status === 200).length, 1)
  assert.equal(await db.organizationMembership.count({ where: { organizationId: org.id, role: 'ADMIN', status: 'ACTIVE' } }), 1)
console.log('Tenant isolation and multi-organization memberships, custom role scope/permissions, assigned maintenance/audit behavior, ET-T07/ET-T11 authorization, ET-T08 out-of-order aggregation, ET-12 insufficient-history handling, configurable audit SoD, maintenance evidence validation/scanner policy, CSV/API quarantine, simulator, ingestion corrections, monitoring buckets, tariff estimates, forecasts, CSV/XLSX/PDF reports, alerts and audits smoke tests passed.')
} finally {
  if (provisionedOrg) {
    await db.$executeRaw`DELETE FROM "PlatformAuditLog" WHERE "entityId" = ${provisionedOrg.id}`
    await db.$executeRaw`DELETE FROM "Invitation" WHERE "organizationId" = ${provisionedOrg.id}::uuid`
    await db.auditLog.deleteMany({ where: { organizationId: provisionedOrg.id } })
    await db.organizationMembership.deleteMany({ where: { organizationId: provisionedOrg.id } })
    await db.role.deleteMany({ where: { organizationId: provisionedOrg.id } })
    await db.user.deleteMany({ where: { organizationId: provisionedOrg.id } })
    await db.organization.delete({ where: { id: provisionedOrg.id } })
  }
  if (otherOrg) {
    await db.$executeRaw`DELETE FROM "Invitation" WHERE "organizationId" = ${otherOrg.id}::uuid`
    await db.auditLog.deleteMany({ where: { organizationId: otherOrg.id } })
    await db.$executeRaw`DELETE FROM "QuarantinedReading" WHERE "organizationId" = ${otherOrg.id}::uuid`
    await db.emissionFactor.deleteMany({ where: { organizationId: otherOrg.id } })
    await db.$executeRaw`DELETE FROM "SiteAssignment" WHERE "organizationId" = ${otherOrg.id}::uuid`
    await db.meter.deleteMany({ where: { organizationId: otherOrg.id } })
    await db.site.deleteMany({ where: { organizationId: otherOrg.id } })
    await db.organizationMembership.deleteMany({ where: { organizationId: otherOrg.id } })
    await db.role.deleteMany({ where: { organizationId: otherOrg.id } })
    await db.organization.delete({ where: { id: otherOrg.id } })
  }
  if (org) {
    await db.webhookOutbox.deleteMany({ where: { organizationId: org.id } })
    await db.integrationWebhook.deleteMany({ where: { organizationId: org.id } })
    await db.forecastDriver.deleteMany({ where: { organizationId: org.id } })
    await db.meterEnergyRollup.deleteMany({ where: { organizationId: org.id } })
    await db.meterRollupTask.deleteMany({ where: { organizationId: org.id } })
    await db.$executeRaw`DELETE FROM "QuarantinedReading" WHERE "organizationId" = ${org.id}::uuid`
    await db.auditLog.deleteMany({ where: { organizationId: org.id } })
    await db.$executeRaw`DELETE FROM "Invitation" WHERE "organizationId" = ${org.id}::uuid`
    await db.$executeRaw`DELETE FROM "SiteAssignment" WHERE "organizationId" = ${org.id}::uuid`
    await db.$executeRaw`DELETE FROM "TariffAssignment" WHERE "organizationId" = ${org.id}::uuid`
    await db.tariffRate.deleteMany({ where: { organizationId: org.id } })
    await db.$executeRaw`DELETE FROM "Baseline" WHERE "organizationId" = ${org.id}::uuid AND "supersedesId" IS NOT NULL`
    await db.$executeRaw`DELETE FROM "Baseline" WHERE "organizationId" = ${org.id}::uuid`
    await db.tariff.deleteMany({ where: { organizationId: org.id } })
    await db.emissionFactor.deleteMany({ where: { organizationId: org.id } })
    await db.$executeRaw`DELETE FROM "IntegrationCredential" WHERE "organizationId" = ${org.id}::uuid`
    await db.notificationDelivery.deleteMany({ where: { organizationId: org.id } })
    await db.alert.deleteMany({ where: { organizationId: org.id } })
    await db.alertRule.deleteMany({ where: { organizationId: org.id } })
    await db.reportJob.deleteMany({ where: { organizationId: org.id } })
    await db.forecastRun.deleteMany({ where: { organizationId: org.id } })
    const storageRoot = resolve(process.env.REPORT_STORAGE_DIR || 'private/reports'), tenantStorage = resolve(storageRoot, org.id)
    if (dirname(tenantStorage) === storageRoot) await rm(tenantStorage, { recursive: true, force: true })
    const evidenceRoot = resolve(process.env.AUDIT_EVIDENCE_STORAGE_DIR || 'private/audit-evidence'), tenantEvidence = resolve(evidenceRoot, org.id)
    if (dirname(tenantEvidence) === evidenceRoot) await rm(tenantEvidence, { recursive: true, force: true })
    const maintenanceEvidenceRoot = resolve(process.env.MAINTENANCE_EVIDENCE_STORAGE_DIR || process.env.AUDIT_EVIDENCE_STORAGE_DIR || 'private/maintenance-evidence'), tenantMaintenanceEvidence = resolve(maintenanceEvidenceRoot, org.id)
    if (dirname(tenantMaintenanceEvidence) === maintenanceEvidenceRoot) await rm(tenantMaintenanceEvidence, { recursive: true, force: true })
    const audits = await db.energyAudit.findMany({ where: { organizationId: org.id }, select: { id: true } })
    await db.correctiveAction.deleteMany({ where: { finding: { auditId: { in: audits.map(item => item.id) } } } })
    await db.auditEvidence.deleteMany({ where: { organizationId: org.id } })
    await db.maintenanceEvidence.deleteMany({ where: { organizationId: org.id } })
    await db.auditFinding.deleteMany({ where: { auditId: { in: audits.map(item => item.id) } } })
    await db.energyAudit.deleteMany({ where: { organizationId: org.id } })
    await db.readingRevision.deleteMany({ where: { organizationId: org.id } })
    await db.meterMaintenance.deleteMany({ where: { organizationId: org.id } })
    await db.meterReading.deleteMany({ where: { organizationId: org.id } })
    await db.importJob.deleteMany({ where: { organizationId: org.id } })
    await db.integrationSource.deleteMany({ where: { organizationId: org.id } })
    await db.meterConfigVersion.deleteMany({ where: { organizationId: org.id } })
    await db.meter.deleteMany({ where: { organizationId: org.id } })
    await db.asset.deleteMany({ where: { organizationId: org.id } })
    await db.$executeRaw`DELETE FROM "Building" WHERE "organizationId" = ${org.id}::uuid`
    await db.site.deleteMany({ where: { organizationId: org.id } })
    await db.passwordResetToken.deleteMany({ where: { organizationId: org.id } })
    await db.notificationPreference.deleteMany({ where: { organizationId: org.id } })
    await db.organizationMembership.deleteMany({ where: { organizationId: org.id } })
    await db.role.deleteMany({ where: { organizationId: org.id } })
    if (platformUser) {
      await db.$executeRaw`DELETE FROM "PlatformAdmin" WHERE "userId" = ${platformUser.id}::uuid`
      await db.$executeRaw`DELETE FROM "PlatformAuditLog" WHERE "userId" = ${platformUser.id}::uuid OR "entityId" = ${platformUser.id}`
      await db.user.delete({ where: { id: platformUser.id } })
    }
    await db.user.deleteMany({ where: { organizationId: org.id } })
    await db.organization.delete({ where: { id: org.id } })
  }
  await db.$disconnect()
}
