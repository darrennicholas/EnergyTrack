import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAuditEvidence } from './evidence-scanner.js'

const evidence = { fileName: 'audit.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-test') }
const configured = { AUDIT_EVIDENCE_SCAN_URL: 'https://scanner.example.test/scan', AUDIT_EVIDENCE_SCAN_TOKEN: 'secret' }

afterEach(() => vi.unstubAllGlobals())

describe('audit evidence scanning', () => {
  it('fails closed without a scanner', async () => {
    await expect(scanAuditEvidence(evidence, {})).rejects.toThrow('EVIDENCE_SCANNER_NOT_CONFIGURED')
  })

  it('requires HTTPS in production', async () => {
    await expect(scanAuditEvidence(evidence, { ...configured, AUDIT_EVIDENCE_SCAN_URL: 'http://scanner.example.test/scan', NODE_ENV: 'production' })).rejects.toThrow('EVIDENCE_SCANNER_REQUIRES_HTTPS')
  })

  it('sends a file to Cloudmersive and fails closed on an unsafe result', async () => {
    const env = { EVIDENCE_SCAN_URL: 'https://api.cloudmersive.com/virus/scan/file', EVIDENCE_SCAN_TOKEN: 'secret', EVIDENCE_SCAN_PROVIDER: 'cloudmersive', NODE_ENV: 'production' }
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ CleanResult: true }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ CleanResult: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(scanAuditEvidence(evidence, env)).resolves.toEqual({ provider: 'Cloudmersive', scanId: null })
    const request = fetch.mock.calls[0][1] as RequestInit
    expect((request.headers as Record<string, string>).Apikey).toBe('secret')
    expect((request.body as FormData).get('inputFile')).toBeInstanceOf(Blob)
    await expect(scanAuditEvidence(evidence, env)).rejects.toThrow('EVIDENCE_MALWARE_DETECTED')
  })

  it('accepts a clean scan response and rejects infected or malformed responses', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ clean: true, engine: 'ClamAV', scanId: 'scan-1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(scanAuditEvidence(evidence, configured)).resolves.toEqual({ provider: 'ClamAV', scanId: 'scan-1' })
    expect(fetch).toHaveBeenCalledOnce()
    const request = fetch.mock.calls[0][1] as RequestInit
    expect((request.headers as Record<string, string>).authorization).toBe('Bearer secret')
    expect(JSON.parse(String(request.body))).toMatchObject({ fileName: evidence.fileName, contentType: evidence.contentType, contentBase64: evidence.content.toString('base64') })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ clean: false }), { status: 200 })))
    await expect(scanAuditEvidence(evidence, configured)).rejects.toThrow('EVIDENCE_MALWARE_DETECTED')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('not-json', { status: 200 })))
    await expect(scanAuditEvidence(evidence, configured)).rejects.toThrow('EVIDENCE_SCANNER_INVALID_RESPONSE')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('unavailable', { status: 503 })))
    await expect(scanAuditEvidence(evidence, configured)).rejects.toThrow('EVIDENCE_SCANNER_UNAVAILABLE')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('timeout')))
    await expect(scanAuditEvidence(evidence, configured)).rejects.toThrow('EVIDENCE_SCANNER_UNAVAILABLE')
  })
})
