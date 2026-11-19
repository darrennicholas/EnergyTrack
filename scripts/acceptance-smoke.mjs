import assert from 'node:assert/strict'

const origin = (process.env.API_ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/, '')
const email = process.env.ACCEPTANCE_EMAIL
const password = process.env.ACCEPTANCE_PASSWORD
if (!email || !password) throw new Error('Set ACCEPTANCE_EMAIL dan ACCEPTANCE_PASSWORD untuk akun admin staging; kredensial tidak dicetak.')
let cookie = '', csrf = ''
async function call(path, options = {}) {
  const headers = new Headers(options.headers)
  if (cookie) headers.set('Cookie', cookie)
  if (options.body) headers.set('Content-Type', 'application/json')
  if (csrf && options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrf)
  const response = await fetch(`${origin}/api/v1${path}`, { ...options, headers, redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';', 1)[0]
  const raw = response.status === 204 ? '' : await response.text()
  let payload = null
  if (raw) {
    try { payload = JSON.parse(raw) }
    catch { throw new Error(`${options.method || 'GET'} ${path} returned non-JSON HTTP ${response.status}; check API routing/proxy configuration.`) }
  }
  return { response, payload }
}
for (const path of ['/health/live', '/health/ready']) {
  const { response, payload } = await call(path)
  assert.equal(response.status, 200, `${path} must return HTTP 200`)
  assert.equal(payload.data.status, path.endsWith('live') ? 'LIVE' : 'READY')
}
let result = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
assert.equal(result.response.status, 200, 'staging admin login must succeed')
result = await call('/auth/me')
assert.equal(result.response.status, 200, 'session must restore')
assert.ok(result.payload.data.permissions.includes('integrations.manage'), 'acceptance account must exercise integration administration')
csrf = result.payload.data.csrfToken
for (const path of ['/sites', '/buildings', '/meters', '/monitoring/summary?days=7', '/alerts', '/reports', '/webhooks']) {
  const { response, payload } = await call(path)
  assert.equal(response.status, 200, `${path} must be available to staging admin`)
  assert.equal(payload.success, true, `${path} must return the API envelope`)
}
const sitesForForecast = await call('/sites?page=1&pageSize=25')
assert.equal(sitesForForecast.response.status, 200, 'site catalog must load for forecast pagination')
const forecastSiteId = sitesForForecast.payload.data.items[0]?.id
assert.ok(forecastSiteId, 'a site is required to verify forecast pagination')
for (const path of ['/sites', '/meters', '/buildings', '/assets', '/reading-imports', '/baselines', '/targets', '/alert-rules', '/audits', '/emission-factors', '/reports', '/audit-logs', '/users', '/roles', '/tariffs', '/tariff-assignments', '/alerts', '/data-sources', `/forecast-drivers?siteId=${encodeURIComponent(forecastSiteId)}`, '/integration-sources', '/webhooks', '/notification-deliveries', '/analytics/forecast-runs', '/invitations', '/site-assignments', '/quarantined-readings']) {
  for (const pageSize of [25, 50, 100]) {
    const { response, payload } = await call(`${path}${path.includes('?') ? '&' : '?'}page=1&pageSize=${pageSize}&sortBy=createdAt&sortOrder=desc`)
    assert.equal(response.status, 200, `${path} page size ${pageSize} must be accepted`)
    assert.ok(Array.isArray(payload.data.items), `${path} must return a paginated item list`)
    assert.equal(payload.data.pagination.page, 1, `${path} must report the current page`)
    assert.equal(payload.data.pagination.pageSize, pageSize, `${path} must enforce the requested page size`)
    assert.equal(payload.data.pagination.sortOrder, 'desc', `${path} must echo the canonical sort order`)
    assert.equal(typeof payload.data.pagination.sortBy, 'string', `${path} must echo the canonical sort field`)
    assert.ok(Number.isInteger(payload.data.pagination.total), `${path} must return a total count`)
  }
}
const legacyPage = await call('/sites?page=1&pageSize=25&sort=name&direction=asc')
assert.equal(legacyPage.response.status, 200, 'legacy pagination parameters must remain compatible')
assert.equal(legacyPage.payload.data.pagination.sortBy, 'name')
assert.equal(legacyPage.payload.data.pagination.sortOrder, 'asc')
for (const bucket of ['HOUR', 'DAY', 'WEEK', 'MONTH']) {
  for (const metric of ['ENERGY_IMPORT', 'POWER_DEMAND']) {
    const { response, payload } = await call(`/monitoring/timeseries?days=7&bucket=${bucket}&metric=${metric}`)
    assert.equal(response.status, 200, `monitoring ${metric}/${bucket} must succeed`)
    assert.ok(Array.isArray(payload.data), `monitoring ${metric}/${bucket} must return a series`)
    assert.ok(payload.data.every(point => typeof point.date === 'string' && Number.isFinite(point.kwh)), `monitoring ${metric}/${bucket} values must be finite and dated`)
  }
}
const monitoringSites = await call('/sites?page=1&pageSize=100')
const monitoringMeters = await call('/meters?page=1&pageSize=100')
const firstSite = monitoringSites.payload.data.items[0], firstMeter = monitoringMeters.payload.data.items[0]
const filterCases = [firstSite && `siteId=${firstSite.id}`, firstMeter && `meterId=${firstMeter.id}`].filter(Boolean)
for (const filters of filterCases) for (const bucket of ['HOUR', 'DAY', 'WEEK', 'MONTH']) {
  const { response, payload } = await call(`/monitoring/timeseries?days=7&bucket=${bucket}&${filters}`)
  assert.equal(response.status, 200, `monitoring filter ${filters} at ${bucket} must reconcile`)
  assert.ok(Array.isArray(payload.data), `monitoring filter ${filters} must return a series`)
}
const meterList = await call('/meters')
const meterWithReadings = meterList.payload.data.find(meter => meter.readings?.length)
if (meterWithReadings) {
  const firstPage = await call(`/meters/${meterWithReadings.id}/readings?limit=1`)
  assert.equal(firstPage.response.status, 200, 'meter reading cursor page must load')
  assert.ok(Array.isArray(firstPage.payload.data.items), 'meter readings must expose page items')
  if (firstPage.payload.data.hasMore) {
    const secondPage = await call(`/meters/${meterWithReadings.id}/readings?limit=1&cursor=${firstPage.payload.data.nextCursor}`)
    assert.equal(secondPage.response.status, 200, 'meter reading cursor must advance')
    assert.notEqual(secondPage.payload.data.items[0]?.id, firstPage.payload.data.items[0]?.id, 'cursor page must not repeat the prior reading')
  }
}
const removedGenericEndpoint = await call('/workspace/buildings')
assert.equal(removedGenericEndpoint.response.status, 404, 'generic workspace CRUD routes must not be exposed')
result = await call('/auth/logout', { method: 'POST', body: '{}' })
assert.equal(result.response.status, 204, 'logout must revoke the session')
console.log('EnergyTrack staging API smoke acceptance passed (health, identity, facilities, monitoring, reports, integrations, logout).')
