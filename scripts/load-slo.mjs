import assert from 'node:assert/strict'

const origin = (process.env.API_ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/, '')
const email = process.env.ACCEPTANCE_EMAIL, password = process.env.ACCEPTANCE_PASSWORD
if (!email || !password) throw new Error('ACCEPTANCE_EMAIL dan ACCEPTANCE_PASSWORD diperlukan untuk load SLO.')
const concurrency = Math.max(1, Math.min(50, Number(process.env.SLO_CONCURRENCY) || 10))
const iterations = Math.max(1, Math.min(1000, Number(process.env.SLO_ITERATIONS) || 20))
const p95Limit = Math.max(1, Number(process.env.SLO_P95_LIMIT_MS) || 500)
let cookie = ''
const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
assert.equal(login.status, 200, 'SLO load test account must log in')
cookie = login.headers.get('set-cookie')?.split(';', 1)[0] || ''
assert.ok(cookie, 'SLO test requires a session cookie')
const sitesResponse = await fetch(`${origin}/api/v1/sites`, { headers: { Cookie: cookie } })
assert.equal(sitesResponse.status, 200, 'SLO account must have access to at least one site')
const sites = await sitesResponse.json()
const siteId = sites.data?.items?.[0]?.id || sites.data?.[0]?.id
assert.ok(siteId, 'SLO test needs an organization or assigned site')
const requests = Array.from({ length: iterations }, (_, i) => i % 2 === 0 ? `/monitoring/summary?siteId=${encodeURIComponent(siteId)}&days=7` : `/monitoring/timeseries?siteId=${encodeURIComponent(siteId)}&days=7&bucket=${['HOUR', 'DAY', 'WEEK', 'MONTH'][Math.floor(i / 2) % 4]}`)
const durations = [], failures = []
let cursor = 0
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < requests.length) {
    const index = cursor++, path = requests[index], start = performance.now()
    try {
      const response = await fetch(`${origin}/api/v1${path}`, { headers: { Cookie: cookie } })
      if (!response.ok) failures.push(`${path}: HTTP ${response.status}`)
      else { const payload = await response.json(); if (!payload.success) failures.push(`${path}: unsuccessful envelope`) }
      durations[index] = performance.now() - start
    } catch (error) { failures.push(`${path}: ${error instanceof Error ? error.message : 'network error'}`) }
  }
}))
const sorted = durations.filter(Number.isFinite).sort((a, b) => a - b), p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)] : Infinity
console.log(JSON.stringify({ requests: iterations, concurrency, failures: failures.length, p50Ms: Number(sorted[Math.floor(sorted.length * .5)]?.toFixed(1)), p95Ms: Number(p95.toFixed(1)), p95LimitMs: p95Limit }))
if (failures.length || sorted.length !== iterations || p95 > p95Limit) { for (const failure of failures.slice(0, 20)) console.error(failure); process.exitCode = 1 }
