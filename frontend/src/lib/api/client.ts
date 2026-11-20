// Central typed API client. Wraps fetch with CSRF header injection, JSON handling, and the
// project's error-field flattening. All feature data access goes through this module so the
// request contract (prefix, credentials, error shape) lives in one place.

const FIELD_LABELS: Record<string, string> = {
  code: 'Kode site', name: 'Nama', type: 'Tipe', address: 'Alamat', timezone: 'Zona waktu',
  latitude: 'Latitude', longitude: 'Longitude', managerId: 'Site manager', emissionRegion: 'Wilayah emisi'
}

// The CSRF token is read lazily so callers can keep it on the session store without this module
// importing the store (avoids a circular dependency: store -> client -> store).
let csrfTokenProvider: () => string | undefined = () => undefined
export function setCsrfTokenProvider(provider: () => string | undefined) { csrfTokenProvider = provider }

function flattenError(json: { error?: { message?: string; fields?: Record<string, unknown> } }): string {
  const fields = json.error?.fields
  const details = fields
    ? Object.entries(fields).flatMap(([field, messages]) =>
        (Array.isArray(messages) ? messages : [messages]).map(message =>
          `${FIELD_LABELS[field] || field}: ${message === 'Invalid' ? 'format tidak valid.' : message}`)).join(' ')
    : ''
  return details || json.error?.message || 'Permintaan gagal.'
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const csrf = csrfTokenProvider()
  if (csrf) headers.set('X-CSRF-Token', csrf)
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: 'same-origin' })
  if (response.status === 204) return undefined as T
  const json = await response.json()
  if (!response.ok) throw new Error(flattenError(json))
  return json.data as T
}

// Fetches a paginated catalogue and always returns an array, whether the endpoint returns a bare
// list or a { items, pagination } envelope.
export async function listRequest<T = unknown>(path: string): Promise<T[]> {
  const separator = path.includes('?') ? '&' : '?'
  const data = await request<unknown>(`${path}${separator}page=1&pageSize=100`)
  if (Array.isArray(data)) return data as T[]
  const items = (data as { items?: unknown }).items
  return Array.isArray(items) ? items as T[] : []
}
