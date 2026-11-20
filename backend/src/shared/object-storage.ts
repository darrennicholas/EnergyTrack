import { createHash, createHmac } from 'node:crypto'

const endpoint = process.env.OBJECT_STORAGE_ENDPOINT
const bucket = process.env.OBJECT_STORAGE_BUCKET
const accessKey = process.env.OBJECT_STORAGE_ACCESS_KEY
const secretKey = process.env.OBJECT_STORAGE_SECRET_KEY
const region = process.env.OBJECT_STORAGE_REGION || 'us-east-1'
export const objectStorageConfigured = Boolean(endpoint && bucket && accessKey && secretKey && process.env.OBJECT_STORAGE_REGION)

function keyUrl(key: string) {
  if (!objectStorageConfigured || !endpoint || !bucket) throw new Error('OBJECT_STORAGE_NOT_CONFIGURED')
  if (!key || key.startsWith('/') || key.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error('INVALID_OBJECT_KEY')
  const base = new URL(endpoint)
  if (base.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('OBJECT_STORAGE_TLS_REQUIRED')
  base.pathname = `${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
  base.search = ''; base.hash = ''
  return base
}
function hmac(key: Buffer | string, value: string) { return createHmac('sha256', key).update(value).digest() }
function sha(value: Buffer) { return createHash('sha256').update(value).digest('hex') }

export function createSignedObjectRequest(method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer, contentType?: string, now = new Date()) {
  const url = keyUrl(key), amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), date = amzDate.slice(0, 8), payloadHash = sha(body ?? Buffer.alloc(0))
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  if (contentType) headers['content-type'] = contentType
  const signedNames = Object.keys(headers).sort(), signedHeaders = signedNames.join(';'), canonicalHeaders = signedNames.map(name => `${name}:${headers[name].trim()}\n`).join('')
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${date}/${region}/s3/aws4_request`, stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha(Buffer.from(canonicalRequest))}`
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), 's3'), 'aws4_request')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign).toString('hex')}`
  return { url, headers }
}
async function request(method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer, contentType?: string) {
  const { url, headers } = createSignedObjectRequest(method, key, body, contentType)
  const response = await fetch(url, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) })
  if (!response.ok && !(method === 'DELETE' && response.status === 404)) throw new Error(`OBJECT_STORAGE_HTTP_${response.status}`)
  if (method === 'GET') return Buffer.from(await response.arrayBuffer())
  return null
}
export const objectStorage = {
  put: (key: string, body: Buffer, contentType: string) => request('PUT', key, body, contentType),
  get: (key: string) => request('GET', key) as Promise<Buffer>,
  delete: (key: string) => request('DELETE', key),
}
