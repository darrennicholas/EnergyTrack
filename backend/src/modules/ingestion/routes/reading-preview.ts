import express, { type Request, type RequestHandler, type Response, type Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { validateCsvPreview } from '../services/csv-preview.js'

type Dependencies = {
  db: PrismaClient
  auth: RequestHandler
  csrf: RequestHandler
  allowRoles: (...roles: string[]) => RequestHandler
  wrap: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler
  ok: (res: Response, data: unknown, status?: number) => unknown
  fail: (res: Response, status: number, code: string, message: string) => unknown
}

function readCsvMultipart(req: Request) {
  if (!Buffer.isBuffer(req.body)) return null
  const contentType = req.header('content-type') || '', boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean)?.trim()
  if (!boundary) return null
  const parts = req.body.toString('latin1').split(`--${boundary}`)
  let csv: string | null = null, fileName = 'readings.csv', sourceId: string | null = null
  for (const part of parts) {
    const splitAt = part.indexOf('\r\n\r\n')
    if (splitAt < 0) continue
    const headers = part.slice(0, splitAt), disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '', name = disposition.match(/name="([^"]+)"/i)?.[1]
    const value = part.slice(splitAt + 4).replace(/\r\n$/, '').replace(/--$/, '')
    if (name === 'file') { csv = Buffer.from(value, 'latin1').toString('utf8'); fileName = disposition.match(/filename="([^"]*)"/i)?.[1] || fileName }
    if (name === 'sourceId') sourceId = value.trim()
  }
  return csv && sourceId ? { csv, fileName, sourceId } : null
}

export function registerReadingPreviewRoutes(api: Router, { db, auth, csrf, allowRoles, wrap, ok, fail }: Dependencies) {
  api.post('/reading-imports/preview', auth, csrf, allowRoles('ADMIN', 'FACILITY_MANAGER'), express.raw({ type: 'multipart/form-data', limit: '10mb' }), wrap(async (req, res) => {
    const upload = readCsvMultipart(req)
    if (!upload || !z.string().uuid().safeParse(upload.sourceId).success || !upload.fileName.trim() || upload.fileName.length > 255) return fail(res, 422, 'VALIDATION_ERROR', 'Unggah satu file CSV, nama sumber, dan sourceId yang valid.')
    const sourceId = upload.sourceId!
    if (Buffer.byteLength(upload.csv, 'utf8') > 10_000_000) return fail(res, 422, 'VALIDATION_ERROR', 'Ukuran CSV maksimum 10 MB.')
    const orgId = res.locals.user.organizationId, active = await db.integrationSource.findFirst({ where: { id: sourceId, organizationId: orgId, type: 'CSV', status: 'ACTIVE' }, select: { id: true } })
    if (!active) return fail(res, 422, 'VALIDATION_ERROR', 'Sumber CSV tidak tersedia atau tidak aktif.')
    const parsed = await validateCsvPreview(db, upload.csv, orgId, res.locals.allowedSiteIds, active.id)
    if ('error' in parsed && parsed.error) return fail(res, 422, 'INVALID_CSV', parsed.error)
    const job = await db.$transaction(async tx => {
      const source = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "IntegrationSource" WHERE "id" = ${active.id}::uuid AND "organizationId" = ${orgId}::uuid AND "type" = 'CSV' AND "status" = 'ACTIVE' FOR UPDATE`
      if (!source.length) return null
      return tx.importJob.create({ data: { organizationId: orgId, sourceId: active.id, fileName: upload.fileName, mode: 'CSV_PREVIEW', status: 'PREVIEW', rejected: parsed.errors.length, errors: { rows: parsed.errors, duplicates: 0 }, previewCsv: upload.csv, createdBy: res.locals.user.id } })
    })
    if (!job) return fail(res, 422, 'VALIDATION_ERROR', 'Sumber CSV tidak tersedia atau tidak aktif.')
    return ok(res, { id: job.id, status: job.status, fileName: job.fileName, sourceId: active.id, total: parsed.total, valid: parsed.valid.length, rejected: parsed.errors.length, errors: parsed.errors, createdAt: job.createdAt }, 201)
  }))

  api.post('/reading-imports/:id/confirm', auth, csrf, allowRoles('ADMIN', 'FACILITY_MANAGER'), wrap(async (req, res) => {
    const id = req.params.id
    if (!z.string().uuid().safeParse(id).success) return fail(res, 404, 'NOT_FOUND', 'Pratinjau impor tidak ditemukan.')
    const orgId = res.locals.user.organizationId
    const preview = await db.$queryRaw<{ id: string; fileName: string; sourceId: string | null; previewCsv: string | null }[]>`SELECT "id", "fileName", "sourceId", "previewCsv" FROM "ImportJob" WHERE "id" = ${id}::uuid AND "organizationId" = ${orgId}::uuid AND "mode" = 'CSV_PREVIEW' AND "status" = 'PREVIEW'`
    if (!preview[0]?.sourceId || preview[0].previewCsv == null) return fail(res, 404, 'NOT_FOUND', 'Pratinjau impor tidak ditemukan atau sudah diproses.')
    const sourceId = preview[0].sourceId, csv = preview[0].previewCsv
    const sourceActive = await db.integrationSource.findFirst({ where: { id: sourceId, organizationId: orgId, type: 'CSV', status: 'ACTIVE' }, select: { id: true } })
    if (!sourceActive) return fail(res, 422, 'VALIDATION_ERROR', 'Sumber CSV sudah tidak aktif; impor tidak dikonfirmasi.')
    const parsed = await validateCsvPreview(db, csv, orgId, res.locals.allowedSiteIds, sourceId)
    if ('error' in parsed && parsed.error) return fail(res, 422, 'INVALID_CSV', parsed.error)
    const queue = { sourceId, valid: parsed.valid.map(row => ({ meterId: row.meterId, externalId: row.externalId, timestamp: row.timestamp.toISOString(), rawValue: row.rawValue, value: row.value.toString(), unit: row.unit })), rejectedRows: parsed.rejectedRows, errors: parsed.errors }
    const updated = await db.$transaction(async tx => {
      const source = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "IntegrationSource" WHERE "id" = ${sourceId}::uuid AND "organizationId" = ${orgId}::uuid AND "type" = 'CSV' AND "status" = 'ACTIVE' FOR UPDATE`
      if (!source.length) return null
      const claimed = await tx.$queryRaw<{ id: string }[]>`UPDATE "ImportJob" SET "status" = 'QUEUED', "mode" = 'COMMIT', "accepted" = 0, "rejected" = ${parsed.errors.length}, "errors" = ${JSON.stringify({ queue })}::jsonb, "previewCsv" = NULL WHERE "id" = ${id}::uuid AND "organizationId" = ${orgId}::uuid AND "mode" = 'CSV_PREVIEW' AND "status" = 'PREVIEW' RETURNING "id"`
      return claimed[0] ? tx.importJob.findFirst({ where: { id: claimed[0].id, organizationId: orgId }, select: { id: true, fileName: true, status: true, sourceId: true, accepted: true, rejected: true, createdAt: true } }) : null
    })
    return updated ? ok(res, updated, 202) : fail(res, 409, 'INVALID_STATE', 'Pratinjau impor telah diproses atau sumber CSV dinonaktifkan.')
  }))
}
