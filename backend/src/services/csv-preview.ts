import { Prisma, PrismaClient } from '@prisma/client'
import { parse } from 'csv-parse/sync'
import { z } from 'zod'
import { readingIdentity } from '../reading-identity.js'

export type CsvPreviewRow = { meterId: string; externalId: string; timestamp: Date; rawValue: string; value: Prisma.Decimal; unit: string }

export async function validateCsvPreview(db: PrismaClient, csv: string, orgId: string, allowedSiteIds: string[] | undefined, sourceId: string) {
  let rows: Record<string, string>[]
  try {
    rows = parse(csv, { columns: (headers: string[]) => {
      if (new Set(headers).size !== headers.length || (headers.includes('value') && headers.includes('rawValue')) || !['meterCode', 'timestamp', 'unit'].every(key => headers.includes(key)) || !headers.some(key => key === 'value' || key === 'rawValue')) throw new Error('INVALID_HEADERS')
      return headers
    }, skip_empty_lines: true, bom: true, trim: true, relax_column_count: false })
  } catch {
    return { error: 'Format CSV tidak valid. Gunakan header meterCode,timestamp,rawValue,unit,metric,externalReadingId.' } as const
  }
  if (!rows.length || rows.length > 5000) return { error: 'CSV harus berisi 1–5000 baris.' } as const
  const meters = await db.meter.findMany({ where: { organizationId: orgId, code: { in: [...new Set(rows.map(row => row.meterCode).filter(Boolean))] }, status: { not: 'RETIRED' }, ...(allowedSiteIds ? { siteId: { in: allowedSiteIds } } : {}) } })
  const byCode = new Map(meters.map(meter => [meter.code, meter]))
  const errors: { row: number; message: string }[] = [], rejectedRows: { payload: Prisma.InputJsonObject; reason: string }[] = [], valid: CsvPreviewRow[] = []
  const rejectRow = (rowNumber: number, row: Record<string, string>, message: string) => { errors.push({ row: rowNumber, message }); rejectedRows.push({ payload: { rowNumber, values: row }, reason: message }) }
  rows.forEach((row, index) => {
    const meter = byCode.get(row.meterCode), timestamp = z.string().datetime({ offset: true }).safeParse(row.timestamp), rawValue = row.rawValue ?? row.value
    if (!meter) { rejectRow(index + 2, row, 'Meter tidak ditemukan atau sudah retired.'); return }
    if (!timestamp.success) { rejectRow(index + 2, row, 'Timestamp harus ISO 8601 dengan zona waktu.'); return }
    if (!/^\d{1,14}(\.\d{1,6})?$/.test(rawValue || '')) { rejectRow(index + 2, row, 'Nilai harus non-negatif dengan maksimal 14 digit bulat dan 6 desimal.'); return }
    if (row.metric && row.metric !== meter.metric) { rejectRow(index + 2, row, 'Metrik tidak sesuai konfigurasi meter.'); return }
    if (row.unit !== meter.unit) { rejectRow(index + 2, row, 'Unit tidak sesuai konfigurasi meter.'); return }
    const time = new Date(row.timestamp), suppliedId = row.externalReadingId?.trim(), externalId = suppliedId ? `source:${sourceId}:${suppliedId}` : readingIdentity(meter.id, time, rawValue, row.unit, sourceId)
    if (externalId.length > 200) { rejectRow(index + 2, row, 'External ID terlalu panjang.'); return }
    const value = new Prisma.Decimal(rawValue).mul(meter.multiplier)
    if (value.gte('100000000000000')) { rejectRow(index + 2, row, 'Nilai setelah multiplier terlalu besar.'); return }
    valid.push({ meterId: meter.id, externalId, timestamp: time, rawValue, value, unit: row.unit })
  })
  return { total: rows.length, valid, errors, rejectedRows }
}
