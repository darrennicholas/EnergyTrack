export type EvidenceScannerEnvironment = { EVIDENCE_SCAN_URL?: string; EVIDENCE_SCAN_TOKEN?: string; EVIDENCE_SCAN_PROVIDER?: string; AUDIT_EVIDENCE_SCAN_URL?: string; AUDIT_EVIDENCE_SCAN_TOKEN?: string; NODE_ENV?: string }

export async function scanEvidence(file: { fileName: string; contentType: string; content: Buffer }, env: EvidenceScannerEnvironment = process.env) {
  const endpoint = env.EVIDENCE_SCAN_URL || env.AUDIT_EVIDENCE_SCAN_URL, token = env.EVIDENCE_SCAN_TOKEN || env.AUDIT_EVIDENCE_SCAN_TOKEN
  if (!endpoint || !token) throw new Error('EVIDENCE_SCANNER_NOT_CONFIGURED')
  const url = new URL(endpoint)
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('EVIDENCE_SCANNER_REQUIRES_HTTPS')
  const cloudmersive = env.EVIDENCE_SCAN_PROVIDER === 'cloudmersive'
  if (env.EVIDENCE_SCAN_PROVIDER && !['cloudmersive', 'gateway'].includes(env.EVIDENCE_SCAN_PROVIDER)) throw new Error('EVIDENCE_SCANNER_UNKNOWN_PROVIDER')
  let response: Response
  try {
    const form = new FormData()
    if (cloudmersive) form.append('inputFile', new Blob([new Uint8Array(file.content)], { type: file.contentType }), file.fileName)
    response = await fetch(url, {
      method: 'POST',
      headers: cloudmersive ? { Apikey: token } : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: cloudmersive ? form : JSON.stringify({ fileName: file.fileName, contentType: file.contentType, contentBase64: file.content.toString('base64') }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('EVIDENCE_SCANNER_UNAVAILABLE')
  }
  if (!response.ok) throw new Error('EVIDENCE_SCANNER_UNAVAILABLE')
  let result: { clean?: unknown; engine?: unknown; scanId?: unknown; CleanResult?: unknown }
  try { result = await response.json() as typeof result } catch { throw new Error('EVIDENCE_SCANNER_INVALID_RESPONSE') }
  if (cloudmersive ? result.CleanResult !== true : result.clean !== true) throw new Error('EVIDENCE_MALWARE_DETECTED')
  if (cloudmersive) return { provider: 'Cloudmersive', scanId: null }
  return { provider: typeof result.engine === 'string' ? result.engine.slice(0, 100) : 'configured-scanner', scanId: typeof result.scanId === 'string' ? result.scanId.slice(0, 200) : null }
}

export const scanAuditEvidence = scanEvidence
