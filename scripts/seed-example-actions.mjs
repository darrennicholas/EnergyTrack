import assert from 'node:assert/strict'
const origin = 'http://127.0.0.1:3000/api/v1'
let cookie = '', csrf = ''
async function request(path, options = {}) {
  const headers = new Headers(options.headers)
  if (cookie) headers.set('Cookie', cookie)
  if (options.body) headers.set('Content-Type', 'application/json')
  if (csrf && options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrf)
  const response = await fetch(origin + path, {...options, headers})
  const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0]
  const json = response.status === 204 ? null : await response.json()
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(json?.error)}`)
  return json?.data
}
await request('/auth/login', {method:'POST',body:JSON.stringify({email:'admin@energitrack.local',password:process.env.ACCEPTANCE_PASSWORD})})
csrf = (await request('/auth/me')).csrfToken
const sites = (await request('/sites?page=1&pageSize=100')).items.filter(s => /^CONTOH-SITE-[1-5]$/.test(s.code))
assert.equal(sites.length, 5, 'Lima site contoh wajib tersedia')
const reports = (await request('/reports?page=1&pageSize=100')).items
const runs = (await request('/analytics/forecast-runs?page=1&pageSize=100')).items
for (const site of sites) {
  const key = `example-report-${site.code}`
  if (!reports.some(r => r.idempotencyKey === key)) {
    const end = new Date(), start = new Date(end.getTime()-29*86400000)
    await request('/reports',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({type:'ENERGY',siteId:site.id,periodStart:start.toISOString(),periodEnd:end.toISOString(),granularity:'DAY',format:'CSV'})})
    console.log(`Laporan dibuat: ${site.code}`)
  }
  if (!runs.some(r => r.siteId === site.id)) {
    try { await request('/analytics/forecast-runs',{method:'POST',body:JSON.stringify({siteId:site.id,days:14,horizon:7,model:'MOVING_AVERAGE'})}); console.log(`Forecast dibuat: ${site.code}`) }
    catch (error) { console.error(`Forecast ${site.code}: ${error.message}`); process.exitCode = 1 }
  }
}
await request('/auth/logout',{method:'POST',body:'{}'})
