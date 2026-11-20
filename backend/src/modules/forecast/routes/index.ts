import type { Request, RequestHandler, Response, Router } from 'express'
import { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { energyByLocalDay } from '../../../energy.js'
import { exogenousLinearForecast, exponentialSmoothingForecast, movingAverageForecast, type ExogenousValue } from '../../../forecast.js'
import { localCalendarWindow } from '../../../shared/local-date.js'
import { siteDate } from '../../../cost.js'

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
  siteForOrg: (siteId: string, orgId: string) => Promise<unknown>
}

export function registerForecastRoutes(api: Router, { db, auth, csrf, wrap, ok, fail, pageQuery, pageResult, siteForOrg }: Dependencies) {
const forecastInputSchema = z.object({ siteId: z.string().uuid(), meterId: z.string().uuid().optional(), days: z.coerce.number().int().min(8).max(365).default(30), horizon: z.coerce.number().int().min(1).max(30).default(7), model: z.enum(['MOVING_AVERAGE', 'EXPONENTIAL_SMOOTHING', 'COMPARE', 'EXOGENOUS_LINEAR']).default('MOVING_AVERAGE'), alpha: z.coerce.number().gt(0).max(1).default(0.3) })
type ForecastInput = z.infer<typeof forecastInputSchema>
const forecastDate = (date: string) => new Date(`${date}T00:00:00.000Z`)
const addCalendarDays = (date: string, days: number) => { const value = forecastDate(date); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }
async function calculateForecast(org: string, input: ForecastInput) {
  const site = await db.site.findFirst({ where: { id: input.siteId, organizationId: org }, select: { timezone: true } })
  if (!site) throw new Error('SITE_NOT_FOUND')
  const meterFilter = { siteId: input.siteId, metric: 'ENERGY_IMPORT', ...(input.meterId ? { id: input.meterId } : {}) }
  if (input.meterId && !await db.meter.findFirst({ where: { ...meterFilter, organizationId: org, status: { not: 'RETIRED' } }, select: { id: true } })) throw new Error('METER_NOT_FOUND')
  const localToday = siteDate(new Date(), site.timezone), window = localCalendarWindow(localToday, input.days, site.timezone)
  const { start, end } = window
  const scope = { organizationId: org, quality: 'VALID', meter: meterFilter }
  const [readings, prior] = await Promise.all([
    db.meterReading.findMany({ where: { ...scope, timestamp: { gte: start, lt: end } }, include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'asc' } }),
    db.meterReading.findMany({ where: { ...scope, timestamp: { lt: start } }, distinct: ['meterId'], include: { meter: { select: { meterType: true, metric: true, rolloverValue: true, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } }, site: { select: { timezone: true } } } } }, orderBy: { timestamp: 'desc' } })
  ])
  const points = energyByLocalDay(readings, prior)
  const expectedLastDay = new Date(`${localToday}T00:00:00.000Z`)
  expectedLastDay.setUTCDate(expectedLastDay.getUTCDate() - 1)
  if (!points.length || points[points.length - 1].date !== expectedLastDay.toISOString().slice(0, 10)) throw new Error('INSUFFICIENT_HISTORY')
  try {
    if (input.model === 'EXOGENOUS_LINEAR') {
      const forecastStart = addCalendarDays(points.at(-1)!.date, 1), forecastEnd = addCalendarDays(points.at(-1)!.date, input.horizon)
      const drivers = await db.forecastDriver.findMany({ where: { organizationId: org, siteId: input.siteId, date: { gte: forecastDate(points[0].date), lte: forecastDate(forecastEnd) } }, orderBy: { date: 'asc' } })
      const byDate = new Map(drivers.map(row => [row.date.toISOString().slice(0, 10), row]))
      const toDriver = (date: string): ExogenousValue => { const row = byDate.get(date); return { date, ...(row?.weatherIndex != null ? { weatherIndex: Number(row.weatherIndex) } : {}), ...(row?.productionUnits != null ? { productionUnits: Number(row.productionUnits) } : {}) } }
      const history = points.map(point => toDriver(point.date)), future = Array.from({ length: input.horizon }, (_, index) => toDriver(addCalendarDays(points.at(-1)!.date, index + 1)))
      if (history.some(row => row.weatherIndex === undefined && row.productionUnits === undefined) || future.some(row => row.weatherIndex === undefined && row.productionUnits === undefined)) throw new Error('EXOGENOUS_DATA_GAP')
      return { model: input.model, result: exogenousLinearForecast(points, history, future), siteId: input.siteId, meterId: input.meterId ?? null, timezone: site.timezone, unit: 'kWh', note: 'Forecast linear menggunakan cuaca Open-Meteo dan/atau output produksi yang tersimpan untuk site. Nilai cuaca adalah suhu rata-rata harian °C; hasil merupakan estimasi.', drivers: { source: [...new Set(drivers.map(row => row.source))], forecastStart, forecastEnd } }
    }
    const movingAverage = input.model === 'EXPONENTIAL_SMOOTHING' ? null : movingAverageForecast(points, input.horizon)
    const exponentialSmoothing = input.model === 'MOVING_AVERAGE' ? null : exponentialSmoothingForecast(points, input.horizon, input.alpha)
    const comparison = input.model === 'COMPARE' ? [movingAverage, exponentialSmoothing].filter(Boolean).map(result => ({ model: result!.model, mae: result!.mae, mape: result!.mape })) : null
    return { model: input.model, movingAverage, exponentialSmoothing, comparison, siteId: input.siteId, meterId: input.meterId ?? null, timezone: site.timezone, unit: 'kWh', note: 'Perkiraan statistik per hari kalender lokal site, bukan data terukur. MAE/MAPE berasal dari backtest one-step; tidak ada interval kepercayaan.', trainingStart: points[0].date, trainingEnd: points[points.length - 1].date }
  } catch (e) {
    if (e instanceof Error && ['INSUFFICIENT_HISTORY', 'DATA_GAPS'].includes(e.message)) throw e
    throw e
  }
}
api.get('/forecast-drivers', auth, wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query)
  const query = pageQuery(req, ['date', 'source', 'updatedAt'], 'date'), org = res.locals.user.organizationId
  if (!await siteForOrg(input.siteId, org) || (res.locals.allowedSiteIds && !res.locals.allowedSiteIds.includes(input.siteId))) return fail(res, 404, 'NOT_FOUND', 'Site forecast tidak ditemukan pada scope ini.')
  const where = { organizationId: org, siteId: input.siteId, ...(input.from || input.to ? { date: { ...(input.from ? { gte: forecastDate(input.from) } : {}), ...(input.to ? { lte: forecastDate(input.to) } : {}) } } : {}) }
  const [total, rows] = await Promise.all([db.forecastDriver.count({ where }), db.forecastDriver.findMany({ where, orderBy: { [query.sort]: query.direction }, skip: query.requested ? (query.page - 1) * query.pageSize : undefined, take: query.requested ? query.pageSize : 25 })])
  return ok(res, pageResult(rows, total, query))
}))
api.post('/forecast-drivers', auth, csrf, wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid(), rows: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), weatherIndex: z.number().min(-100).max(100).optional(), productionUnits: z.number().min(0).max(1e12).optional() }).strict().refine(row => row.weatherIndex !== undefined || row.productionUnits !== undefined, 'Isi suhu/cuaca atau output produksi.')).min(1).max(365) }).parse(req.body)
  const user = res.locals.user, site = await db.site.findFirst({ where: { id: input.siteId, organizationId: user.organizationId, ...(res.locals.allowedSiteIds ? { id: { in: res.locals.allowedSiteIds } } : {}) }, select: { id: true } })
  if (!site) return fail(res, 404, 'NOT_FOUND', 'Site forecast tidak ditemukan pada scope ini.')
  const unique = new Set(input.rows.map(row => row.date))
  if (unique.size !== input.rows.length) return fail(res, 422, 'DUPLICATE_DATES', 'Setiap tanggal hanya boleh muncul sekali dalam satu permintaan.')
  const saved = await db.$transaction(async tx => {
    const rows = []
    for (const row of input.rows) rows.push(await tx.forecastDriver.upsert({ where: { organizationId_siteId_date: { organizationId: user.organizationId, siteId: input.siteId, date: forecastDate(row.date) } }, create: { organizationId: user.organizationId, siteId: input.siteId, date: forecastDate(row.date), weatherIndex: row.weatherIndex, productionUnits: row.productionUnits, source: 'MANUAL', updatedBy: user.id }, update: { weatherIndex: row.weatherIndex, productionUnits: row.productionUnits, source: 'MANUAL', sourceReference: null, updatedBy: user.id } }))
    await tx.auditLog.create({ data: { organizationId: user.organizationId, userId: user.id, action: 'FORECAST_DRIVERS_SAVED', entity: 'ForecastDriver', details: { siteId: input.siteId, count: rows.length } } })
    return rows
  })
  return ok(res, { saved: saved.length, rows: saved }, 201)
}))
api.post('/forecast-drivers/weather-sync', auth, csrf, wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid(), days: z.number().int().min(1).max(15).default(7) }).parse(req.body), user = res.locals.user
  const site = await db.site.findFirst({ where: { id: input.siteId, organizationId: user.organizationId, ...(res.locals.allowedSiteIds ? { id: { in: res.locals.allowedSiteIds } } : {}) }, select: { id: true, name: true, latitude: true, longitude: true, timezone: true } })
  if (!site) return fail(res, 404, 'NOT_FOUND', 'Site forecast tidak ditemukan pada scope ini.')
  if (site.latitude == null || site.longitude == null) return fail(res, 422, 'SITE_COORDINATES_REQUIRED', 'Isi latitude dan longitude pada detail site sebelum sinkronisasi cuaca.')
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.search = new URLSearchParams({ latitude: String(site.latitude), longitude: String(site.longitude), daily: 'temperature_2m_mean', timezone: site.timezone, forecast_days: String(input.days + 1) }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
  if (!response.ok) return fail(res, 502, 'WEATHER_PROVIDER_ERROR', `Open-Meteo merespons HTTP ${response.status}. Coba sinkronkan lagi nanti.`)
  const payload = await response.json() as { daily?: { time?: string[]; temperature_2m_mean?: (number | null)[] } }
  const dates = payload.daily?.time ?? [], temps = payload.daily?.temperature_2m_mean ?? []
  const startDate = siteDate(new Date(), site.timezone), imported = dates.flatMap((date, index) => date >= startDate && date <= addCalendarDays(startDate, input.days) && Number.isFinite(temps[index]) ? [{ date, weatherIndex: temps[index] as number }] : [])
  if (!imported.length) return fail(res, 502, 'WEATHER_PROVIDER_EMPTY', 'Penyedia cuaca tidak mengembalikan prakiraan harian untuk site ini.')
  const saved = await db.$transaction(async tx => {
    const rows = []
    for (const row of imported) rows.push(await tx.forecastDriver.upsert({ where: { organizationId_siteId_date: { organizationId: user.organizationId, siteId: site.id, date: forecastDate(row.date) } }, create: { organizationId: user.organizationId, siteId: site.id, date: forecastDate(row.date), weatherIndex: row.weatherIndex, source: 'OPEN_METEO', sourceReference: 'https://open-meteo.com/en/docs', updatedBy: user.id, metadata: { variable: 'temperature_2m_mean', unit: '°C', fetchedAt: new Date().toISOString() } }, update: { weatherIndex: row.weatherIndex, source: 'OPEN_METEO', sourceReference: 'https://open-meteo.com/en/docs', updatedBy: user.id, metadata: { variable: 'temperature_2m_mean', unit: '°C', fetchedAt: new Date().toISOString() } } }))
    await tx.auditLog.create({ data: { organizationId: user.organizationId, userId: user.id, action: 'WEATHER_DRIVER_SYNCED', entity: 'ForecastDriver', details: { siteId: site.id, provider: 'OPEN_METEO', count: rows.length, variable: 'temperature_2m_mean' } } })
    return rows
  })
  return ok(res, { provider: 'OPEN_METEO', variable: 'temperature_2m_mean', unit: '°C', siteId: site.id, imported: saved.length, rows: saved, attribution: 'Weather data by Open-Meteo' }, 201)
}))
api.get('/analytics/forecast', auth, wrap(async (req, res) => {
  const input = forecastInputSchema.parse(req.query), org = res.locals.user.organizationId
  if (!await siteForOrg(input.siteId, org) || (res.locals.allowedSiteIds && !res.locals.allowedSiteIds.includes(input.siteId))) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan pada scope ini.')
  try { return ok(res, await calculateForecast(org, input)) }
  catch (error) { if (error instanceof Error && error.message === 'METER_NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Meter energi tidak ditemukan pada site ini.'); if (error instanceof Error && ['INSUFFICIENT_HISTORY', 'DATA_GAPS'].includes(error.message)) return fail(res, 422, error.message, 'Perkiraan memerlukan sedikitnya delapan hari berurutan tanpa celah.'); if (error instanceof Error && error.message === 'EXOGENOUS_DATA_GAP') return fail(res, 422, error.message, 'Lengkapi sumber data cuaca atau produksi untuk setiap tanggal historis dan tanggal prakiraan.'); if (error instanceof Error && ['EXOGENOUS_FEATURES_INSUFFICIENT', 'EXOGENOUS_FEATURES_COLLINEAR'].includes(error.message)) return fail(res, 422, error.message, 'Fitur data cuaca/produksi tidak cukup bervariasi untuk menghitung regresi.'); throw error }
}))
api.post('/analytics/forecast-runs', auth, csrf, wrap(async (req, res) => {
  const input = forecastInputSchema.parse(req.body), user = res.locals.user, org = user.organizationId
  if (!await siteForOrg(input.siteId, org)) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan.')
  try {
    const result = await calculateForecast(org, input)
    const run = await db.$transaction(async tx => {
      const saved = await tx.forecastRun.create({ data: { organizationId: org, siteId: input.siteId, meterId: input.meterId ?? null, requestedBy: user.id, model: input.model, parameters: input as Prisma.InputJsonObject, result: result as Prisma.InputJsonObject } })
      await tx.auditLog.create({ data: { organizationId: org, userId: user.id, action: 'FORECAST_RUN_CREATED', entity: 'ForecastRun', entityId: saved.id, details: { siteId: input.siteId, meterId: input.meterId ?? null, model: input.model, horizon: input.horizon, days: input.days } } })
      return saved
    })
    return ok(res, { ...run, result }, 201)
  } catch (error) { if (error instanceof Error && error.message === 'METER_NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Meter energi tidak ditemukan pada site ini.'); if (error instanceof Error && ['INSUFFICIENT_HISTORY', 'DATA_GAPS'].includes(error.message)) return fail(res, 422, error.message, 'Perkiraan memerlukan sedikitnya delapan hari berurutan tanpa celah.'); if (error instanceof Error && error.message === 'EXOGENOUS_DATA_GAP') return fail(res, 422, error.message, 'Lengkapi sumber data cuaca atau produksi untuk setiap tanggal historis dan tanggal prakiraan.'); if (error instanceof Error && ['EXOGENOUS_FEATURES_INSUFFICIENT', 'EXOGENOUS_FEATURES_COLLINEAR'].includes(error.message)) return fail(res, 422, error.message, 'Fitur data cuaca/produksi tidak cukup bervariasi untuk menghitung regresi.'); throw error }
}))
api.get('/analytics/forecast-runs', auth, wrap(async (req, res) => {
  const input = z.object({ siteId: z.string().uuid().optional(), meterId: z.string().uuid().optional() }).parse(req.query), query=pageQuery(req,['createdAt','model'],'createdAt'), user = res.locals.user
  if (input.siteId && res.locals.allowedSiteIds && !res.locals.allowedSiteIds.includes(input.siteId)) return fail(res, 404, 'NOT_FOUND', 'Site tidak ditemukan pada scope ini.')
  const meter = input.meterId ? await db.meter.findFirst({ where: { id: input.meterId, organizationId: user.organizationId, metric: 'ENERGY_IMPORT', AND: [...(input.siteId ? [{ siteId: input.siteId }] : []), ...(res.locals.allowedSiteIds ? [{ siteId: { in: res.locals.allowedSiteIds } }] : [])] }, select: { id: true } }) : null
  if (input.meterId && !meter) return fail(res, 404, 'NOT_FOUND', 'Meter forecast tidak ditemukan pada scope ini.')
  const scope = [ ...(input.siteId ? [{ siteId: input.siteId }] : []), ...(input.meterId ? [{ meterId: input.meterId }] : []), ...(res.locals.allowedSiteIds ? [{ siteId: { in: res.locals.allowedSiteIds } }] : []) ]
  const where={organizationId:user.organizationId,...(scope.length?{AND:scope}:{}),...(query.search?{model:{contains:query.search,mode:'insensitive' as const}}:{})}
  const [total,runs]=await Promise.all([db.forecastRun.count({where}),db.forecastRun.findMany({where,orderBy:{[query.sort]:query.direction},skip:query.requested?(query.page-1)*query.pageSize:undefined,take:query.requested?query.pageSize:25,include:{requester:{select:{id:true,fullName:true}}}})])
  return ok(res,pageResult(runs,total,query))
}))
}
