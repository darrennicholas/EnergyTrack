type Entry = { value: unknown; expiresAt: number }

/** Small process-local cache keyed by tenant, role/site scope and normalized filters. */
export class MonitoringCache {
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly ttlMs = 5_000, private readonly maxEntries = 500, private readonly now = () => Date.now()) {}

  get(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: unknown) {
    const expiresAt = this.now() + this.ttlMs
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt })
    for (const [existingKey, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(existingKey)
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!)
  }
}

export function monitoringCacheKey(organizationId: string, role: string, allowedSiteIds: string[] | undefined, filters: unknown) {
  return JSON.stringify([organizationId, role, allowedSiteIds === undefined ? '*' : [...allowedSiteIds].sort(), filters])
}
