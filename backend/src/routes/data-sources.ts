import type { Request, RequestHandler, Response, Router } from 'express'
import { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'

type PageQuery = { page: number; pageSize: number; sort: string; direction: 'asc' | 'desc'; search: string; requested: boolean }
type Dependencies = {
  db: PrismaClient
  auth: RequestHandler
  csrf: RequestHandler
  wrap: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler
  ok: (res: Response, data: unknown, status?: number) => unknown
  fail: (res: Response, status: number, code: string, message: string) => unknown
  pageQuery: (req: Request, fields: string[], defaultSort: string) => PageQuery
  pageResult: <T>(items: T[], total: number, query: PageQuery) => unknown
}

export function registerDataSourceRoutes(api: Router, { db, auth, csrf, wrap, ok, fail, pageQuery, pageResult }: Dependencies) {
  api.get('/data-sources', auth, wrap(async (req, res) => {
    const query = pageQuery(req, ['name', 'type', 'status', 'createdAt'], 'name'), org = res.locals.user.organizationId
    const search = query.search ? Prisma.sql`AND (s."name" ILIKE ${`%${query.search}%`} OR s."type" ILIKE ${`%${query.search}%`} OR COALESCE(s."description",'') ILIKE ${`%${query.search}%`})` : Prisma.empty
    const where = Prisma.sql`FROM "IntegrationSource" s WHERE s."organizationId" = ${org}::uuid ${search}`
    const [counts, rows] = await Promise.all([
      db.$queryRaw<{ count: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count ${where}`),
      db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT s."id", s."organizationId", s."name", s."type", s."description", s."status", s."createdAt", (s."secretHash" IS NULL AND NOT EXISTS (SELECT 1 FROM "IntegrationCredential" c WHERE c."sourceId" = s."id" AND c."organizationId" = s."organizationId")) AS "editable" ${where} ORDER BY s.${Prisma.raw(`"${query.sort}" ${query.direction.toUpperCase()}`)} LIMIT ${query.requested ? query.pageSize : 1000} OFFSET ${query.requested ? (query.page - 1) * query.pageSize : 0}`)
    ])
    return ok(res, pageResult(rows, Number(counts[0]?.count || 0), query))
  }))

  api.post('/data-sources', auth, csrf, wrap(async (req, res) => {
    const input = z.object({ name: z.string().trim().min(2).max(100), type: z.enum(['MANUAL', 'CSV', 'API', 'SIMULATOR']), description: z.string().trim().max(500).optional() }).strict().parse(req.body)
    const org = res.locals.user.organizationId
    const existing = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "IntegrationSource" WHERE "organizationId" = ${org}::uuid AND lower("name") = lower(${input.name}) LIMIT 1`
    if (existing.length) return fail(res, 409, 'CONFLICT', 'Nama sumber sudah digunakan.')
    const rows = await db.$queryRaw`INSERT INTO "IntegrationSource" ("id", "organizationId", "name", "type", "description") VALUES (gen_random_uuid(), ${org}::uuid, ${input.name}, ${input.type}, ${input.description || null}) RETURNING "id", "name", "type", "description", "status", "createdAt"`
    return ok(res, (rows as unknown[])[0], 201)
  }))

  api.patch('/data-sources/:id', auth, csrf, wrap(async (req, res) => {
    const input = z.object({ description: z.string().trim().max(500).nullable().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).strict().refine(value => Object.keys(value).length > 0).parse(req.body)
    if (!z.string().uuid().safeParse(req.params.id).success) return fail(res, 404, 'NOT_FOUND', 'Sumber data tidak ditemukan.')
    const rows = await db.$queryRaw`UPDATE "IntegrationSource" s SET "description" = CASE WHEN ${Object.hasOwn(input, 'description')} THEN ${input.description ?? null} ELSE "description" END, "status" = COALESCE(${input.status ?? null}, "status") WHERE s."id" = ${req.params.id}::uuid AND s."organizationId" = ${res.locals.user.organizationId}::uuid AND s."secretHash" IS NULL AND NOT EXISTS (SELECT 1 FROM "IntegrationCredential" c WHERE c."sourceId" = s."id" AND c."organizationId" = s."organizationId") RETURNING s."id", s."name", s."type", s."description", s."status", s."createdAt"`
    return (rows as unknown[]).length ? ok(res, (rows as unknown[])[0]) : fail(res, 404, 'NOT_FOUND', 'Sumber data tidak ditemukan atau dikelola integrasi lama.')
  }))
}
