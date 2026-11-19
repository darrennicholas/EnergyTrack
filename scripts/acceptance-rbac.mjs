import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'

const origin = (process.env.API_ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/, '')
const platformEmail = process.env.ACCEPTANCE_EMAIL
const password = process.env.ACCEPTANCE_PASSWORD
if (!platformEmail || !password || process.env.ACCEPTANCE_RBAC_RUN !== '1') throw new Error('This fixture-creating suite is restricted to ephemeral CI databases; set ACCEPTANCE_EMAIL, ACCEPTANCE_PASSWORD, and ACCEPTANCE_RBAC_RUN=1.')

class ApiClient {
  cookie = ''
  csrf = ''
  async call(path, options = {}) {
    const headers = new Headers(options.headers)
    if (this.cookie) headers.set('Cookie', this.cookie)
    if (options.body) headers.set('Content-Type', 'application/json')
    if (this.csrf && options.method && options.method !== 'GET') headers.set('X-CSRF-Token', this.csrf)
    const response = await fetch(`${origin}/api/v1${path}`, { ...options, headers })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) this.cookie = setCookie.split(';', 1)[0]
    const payload = response.status === 204 ? null : await response.json()
    return { response, payload }
  }
  async login(email) {
    const result = await this.call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
    assert.equal(result.response.status, 200, `login for ${email} must succeed`)
    const me = await this.call('/auth/me')
    assert.equal(me.response.status, 200)
    this.csrf = me.payload.data.csrfToken
    return me.payload.data
  }
}

const db = new PrismaClient()
try {
  const root = await db.user.findUnique({ where: { email: platformEmail.toLowerCase() }, select: { id: true, active: true } })
  assert.ok(root?.active, 'CI platform fixture user must exist and be active')
  await db.platformAdmin.upsert({ where: { userId: root.id }, update: {}, create: { userId: root.id, reason: 'Ephemeral CI acceptance fixture' } })
} finally { await db.$disconnect() }

const platform = new ApiClient()
const platformUser = await platform.login(platformEmail)
assert.ok(platformUser.permissions.includes('tenant.provision'), 'platform fixture must have tenant provisioning permission')

async function provisionTenant(suffix) {
  const code = `CI-${Date.now().toString(36).toUpperCase()}-${suffix}`
  const adminEmail = `acceptance-${code.toLowerCase()}@example.test`
  const provision = await platform.call('/platform/organizations', { method: 'POST', body: JSON.stringify({ code, name: `Acceptance ${suffix}`, adminEmail, adminFullName: `Acceptance ${suffix} Admin` }) })
  assert.equal(provision.response.status, 201, `tenant ${suffix} must be provisioned`)
  assert.ok(provision.payload.data.token, 'development acceptance fixture must return a one-time invitation token')
  const unauthenticated = new ApiClient()
  const accepted = await unauthenticated.call('/auth/accept-invitation', { method: 'POST', body: JSON.stringify({ token: provision.payload.data.token, password }) })
  assert.equal(accepted.response.status, 201, `tenant ${suffix} invitation must be accepted`)
  const client = new ApiClient()
  const me = await client.login(adminEmail)
  assert.equal(me.scope, 'ORGANIZATION')
  assert.ok(me.permissions.includes('org.manage'))
  return { client, adminEmail }
}

const tenantA = await provisionTenant('A')
const tenantB = await provisionTenant('B')
async function createSite(client, code, name) {
  const result = await client.call('/sites', { method: 'POST', body: JSON.stringify({ code, name, type: 'OFFICE', address: 'Acceptance Test Facility, Jakarta', timezone: 'Asia/Jakarta' }) })
  assert.equal(result.response.status, 201, `site ${code} must be created`)
  return result.payload.data
}
const siteA1 = await createSite(tenantA.client, 'CI-SITE-A1', 'CI Site A1')
const siteA2 = await createSite(tenantA.client, 'CI-SITE-A2', 'CI Site A2')
const foreignSite = await createSite(tenantB.client, 'CI-SITE-B1', 'CI Site B1')
const createAsset = async (client, siteId, code) => {
  const result = await client.call('/assets', { method: 'POST', body: JSON.stringify({ siteId, code, name: code, type: 'PUMP' }) })
  assert.equal(result.response.status, 201)
  return result.payload.data
}
const assignedAsset = await createAsset(tenantA.client, siteA1.id, 'CI-ASSET-A1')
const unassignedAsset = await createAsset(tenantA.client, siteA2.id, 'CI-ASSET-A2')
const foreignAsset = await createAsset(tenantB.client, foreignSite.id, 'CI-ASSET-B1')
const meterRole = await tenantA.client.call('/roles', { method: 'POST', body: JSON.stringify({ name: 'CI Meter Configurator', scope: 'ASSIGNED_SITES', permissionCodes: ['site.read', 'meter.read', 'meter.configure'] }) })
assert.equal(meterRole.response.status, 201)
const meterEmail = `acceptance-meter-${Date.now()}@example.test`
const meterInvite = await tenantA.client.call('/invitations', { method: 'POST', body: JSON.stringify({ email: meterEmail, fullName: 'Acceptance Meter Configurator', roleId: meterRole.payload.data.id, siteIds: [siteA1.id] }) })
assert.equal(meterInvite.response.status, 201)
assert.equal((await new ApiClient().call('/auth/accept-invitation', { method: 'POST', body: JSON.stringify({ token: meterInvite.payload.data.token, password }) })).response.status, 201)
const meterClient = new ApiClient()
await meterClient.login(meterEmail)
const visibleAssets = await meterClient.call('/assets')
assert.equal(visibleAssets.response.status, 200)
assert.deepEqual(visibleAssets.payload.data.map(asset => asset.id), [assignedAsset.id], 'meter configurator must only see assets from assigned sites')
const meterInput = { code: 'CI-METER-ASSIGNED', siteId: siteA1.id, assetId: assignedAsset.id, meterType: 'INTERVAL', metric: 'ENERGY_IMPORT', unit: 'kWh', sourceType: 'MANUAL', intervalMinutes: 15, multiplier: 1 }
assert.equal((await meterClient.call('/meters', { method: 'POST', body: JSON.stringify(meterInput) })).response.status, 201)
for (const assetId of [unassignedAsset.id, foreignAsset.id]) assert.equal((await meterClient.call('/meters', { method: 'POST', body: JSON.stringify({ ...meterInput, code: `CI-BLOCK-${assetId}`, assetId }) })).response.status, 422, 'meter cannot reference an asset outside its site')
assert.equal((await meterClient.call('/meters', { method: 'POST', body: JSON.stringify({ ...meterInput, code: 'CI-BLOCK-SITE', siteId: siteA2.id, assetId: unassignedAsset.id }) })).response.status, 404)
assert.equal((await meterClient.call('/assets', { method: 'POST', body: JSON.stringify({ siteId: siteA1.id, code: 'CI-DENIED', name: 'Denied', type: 'PUMP' }) })).response.status, 403)

const roleList = await tenantA.client.call('/roles')
assert.equal(roleList.response.status, 200, 'tenant admin must list role definitions')
const roles = roleList.payload.data
const expectedRoles = ['ADMIN', 'ENERGY_MANAGER', 'FACILITY_MANAGER', 'ANALYST', 'TECHNICIAN', 'EXECUTIVE', 'AUDITOR']
for (const code of expectedRoles) assert.ok(roles.some(role => role.code === code), `provisioned tenant must contain ${code}`)

for (const role of roles.filter(item => expectedRoles.includes(item.code) && item.code !== 'ADMIN')) {
  const email = `acceptance-${role.code.toLowerCase()}-${Date.now()}@example.test`
  const invite = await tenantA.client.call('/invitations', { method: 'POST', body: JSON.stringify({ email, fullName: `Acceptance ${role.code}`, roleId: role.id, siteIds: role.scope === 'ASSIGNED_SITES' ? [siteA1.id] : [] }) })
  assert.equal(invite.response.status, 201, `${role.code} invitation must be accepted by the admin`)
  const unauthenticated = new ApiClient()
  const accepted = await unauthenticated.call('/auth/accept-invitation', { method: 'POST', body: JSON.stringify({ token: invite.payload.data.token, password }) })
  assert.equal(accepted.response.status, 201, `${role.code} invitation must create a membership`)
  const client = new ApiClient(), me = await client.login(email)
  assert.equal(me.role, role.code)
  assert.deepEqual([...me.permissions].sort(), role.permissions.map(item => item.permission.code).sort(), `${role.code} permissions must match its role definition`)
  assert.deepEqual(me.siteIds.sort(), (role.scope === 'ASSIGNED_SITES' ? [siteA1.id] : []).sort(), `${role.code} assignments must match scope`)
  if (role.code === 'EXECUTIVE') {
    assert.equal((await client.call('/monitoring/summary?days=7')).response.status, 200, 'executive must be able to load the organization dashboard summary')
    assert.equal((await client.call('/monitoring/timeseries?days=7')).response.status, 403, 'executive without monitoring permission must not access detailed timeseries')
  }
  const sites = await client.call('/sites')
  if (me.permissions.includes('site.read')) {
    assert.equal(sites.response.status, 200, `${role.code} site reader must have list access`)
    assert.equal(sites.payload.data.length, role.scope === 'ORGANIZATION' ? 2 : 1, `${role.code} site list must obey scope`)
  } else assert.equal(sites.response.status, 403, `${role.code} without site.read must be denied`)
  const deniedRoles = await client.call('/roles')
  assert.equal(deniedRoles.response.status, 403, `${role.code} must not administer role definitions`)
  for (const path of ['/roles', '/invitations', '/integration-sources', '/webhooks', '/sites']) {
    const denied = await client.call(path, { method: 'POST', body: '{}' })
    assert.equal(denied.response.status, 403, `${role.code} must not perform unauthorized POST ${path}`)
  }
  const crossTenant = await client.call(`/sites/${foreignSite.id}`)
  assert.equal(crossTenant.response.status, 404, `${role.code} must not discover a different tenant's site`)
  if (role.scope === 'ASSIGNED_SITES' && me.permissions.includes('site.read')) {
    const unassigned = await client.call(`/sites/${siteA2.id}`)
    assert.equal(unassigned.response.status, 404, `${role.code} must not discover an unassigned site`)
  }
}

const customRole = await tenantA.client.call('/roles', { method: 'POST', body: JSON.stringify({ name: 'CI Site Reader', description: 'Acceptance-only least privilege role', scope: 'ASSIGNED_SITES', permissionCodes: ['site.read'] }) })
assert.equal(customRole.response.status, 201, 'custom site-reader role must be creatable')
const customEmail = `acceptance-custom-${Date.now()}@example.test`
const customInvite = await tenantA.client.call('/invitations', { method: 'POST', body: JSON.stringify({ email: customEmail, fullName: 'Acceptance Custom Reader', roleId: customRole.payload.data.id, siteIds: [siteA1.id] }) })
assert.equal(customInvite.response.status, 201)
const customAccept = await new ApiClient().call('/auth/accept-invitation', { method: 'POST', body: JSON.stringify({ token: customInvite.payload.data.token, password }) })
assert.equal(customAccept.response.status, 201)
const customClient = new ApiClient(), customMe = await customClient.login(customEmail)
assert.deepEqual(customMe.permissions, ['site.read'])
assert.equal((await customClient.call('/sites')).payload.data.length, 1, 'custom role must only see assigned sites')
assert.equal((await customClient.call(`/sites/${foreignSite.id}`)).response.status, 404, 'custom role must not cross tenant boundaries')
const member = (await tenantA.client.call('/users')).payload.data.find(item => item.email === customEmail)
assert.ok(member?.id, 'custom-role member must be available to administrator')
const noAccessRole = await tenantA.client.call('/roles', { method: 'POST', body: JSON.stringify({ name: 'CI Suspended Reader', scope: 'ASSIGNED_SITES', permissionCodes: [] }) })
assert.equal(noAccessRole.response.status, 201)
const changed = await tenantA.client.call(`/users/${member.id}`, { method: 'PATCH', body: JSON.stringify({ roleId: noAccessRole.payload.data.id, siteIds: [siteA1.id] }) })
assert.equal(changed.response.status, 200, "administrator must be able to change assigned user's role")
assert.equal((await customClient.call('/sites')).response.status, 403, 'permission revocation must apply to an existing session immediately')

console.log('EnergyTrack RBAC acceptance passed: built-in roles, custom role, assignment scope, tenant isolation, and live permission changes.')
