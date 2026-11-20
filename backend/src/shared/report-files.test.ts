import { describe, expect, it } from 'vitest'
import { createPdfReport, createXlsxReport } from './report-files.js'

const input = {
  title: 'EnergiTrack QUALITY Report', generatedAt: '2026-11-19T00:00:00.000Z', generatedBy: 'user-1',
  periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-11-02T00:00:00.000Z',
  rows: [{ quality: 'INVALID', readingCount: 2 }, { quality: 'VALID', readingCount: 18 }],
}

describe('domain report export rows', () => {
  it('includes dynamic fields and every row in XLSX and PDF', () => {
    const workbook = createXlsxReport(input).toString('utf8')
    expect(workbook.startsWith('PK')).toBe(true)
    expect(workbook).toContain('quality')
    expect(workbook).toContain('INVALID')
    expect(workbook).toContain('readingCount')

    const pdf = createPdfReport(input).toString('latin1')
    expect(pdf).toContain('EnergiTrack QUALITY Report')
    expect(pdf).toContain('INVALID')
    expect(pdf).toContain('18')
  })
})
