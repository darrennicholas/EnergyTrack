import { describe, expect, it } from 'vitest'
import { MonitoringCache, monitoringCacheKey } from './monitoring-cache.js'

describe('monitoring response cache', () => {
  it('isolates entries by tenant, role, site scope and normalized filter key', () => {
    const key = monitoringCacheKey('tenant-a', 'ANALYST', ['site-b', 'site-a'], { metric: 'ENERGY_IMPORT' })
    const cache = new MonitoringCache()
    cache.set(key, { energyKwh: 10 })
    expect(cache.get(monitoringCacheKey('tenant-b', 'ANALYST', ['site-a', 'site-b'], { metric: 'ENERGY_IMPORT' }))).toBeUndefined()
    expect(cache.get(monitoringCacheKey('tenant-a', 'ANALYST', ['site-a', 'site-b'], { metric: 'POWER_DEMAND' }))).toBeUndefined()
    expect(cache.get(monitoringCacheKey('tenant-a', 'ANALYST', ['site-a', 'site-b'], { metric: 'ENERGY_IMPORT' }))).toEqual({ energyKwh: 10 })
  })

  it('expires entries and evicts least recently used keys when bounded', () => {
    let now = 0
    const cache = new MonitoringCache(10, 2, () => now)
    cache.set('a', 1); cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    now = 11
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('c')).toBeUndefined()
  })
})
