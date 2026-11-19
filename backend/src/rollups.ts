import { Prisma, PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { cumulativeDelta, rolloverValueAt } from './cumulative.js'
import { siteDate } from './cost.js'
import { localDateStartUtc, nextLocalDate } from './local-date.js'
import { localBucketKey } from './energy.js'

export type RollupTx = Prisma.TransactionClient

export async function enqueueReadingRollups(tx: RollupTx, organizationId: string, readings: { meterId: string; timestamp: Date }[]) {
  const firstByMeter = new Map<string, Date>()
  for (const reading of readings) {
    const previous = firstByMeter.get(reading.meterId)
    if (!previous || reading.timestamp < previous) firstByMeter.set(reading.meterId, reading.timestamp)
  }
  for (const [meterId, requestedFrom] of firstByMeter) await enqueueMeterRollup(tx, organizationId, [meterId], requestedFrom)
}

export async function enqueueMeterRollup(tx: RollupTx, organizationId: string, meterIds: string[], requestedFrom: Date) {
  for (const meterId of [...new Set(meterIds)]) {
    await tx.$executeRaw`INSERT INTO "MeterRollupTask" ("id", "organizationId", "meterId", "requestedFrom", "generation", "processedGeneration", "status", "nextAttemptAt", "createdAt", "updatedAt") VALUES (${randomUUID()}::uuid, ${organizationId}::uuid, ${meterId}::uuid, ${requestedFrom}, 1, 0, 'QUEUED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT ("organizationId", "meterId") DO UPDATE SET "requestedFrom" = LEAST("MeterRollupTask"."requestedFrom", EXCLUDED."requestedFrom"), "generation" = "MeterRollupTask"."generation" + 1, "status" = CASE WHEN "MeterRollupTask"."status" = 'PROCESSING' THEN 'PROCESSING' ELSE 'QUEUED' END, "nextAttemptAt" = CURRENT_TIMESTAMP, "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP`
  }
}

type RollupRow = { organizationId: string; meterId: string; localDate: string; timezone: string; energyKwh: Prisma.Decimal; readingCount: number; resetCount: number; rolloverCount: number; quality: string }
export type Granularity = 'HOUR' | 'DAY' | 'MONTH'
export type AggregateRow = { bucketKey: string; bucketStart: Date; localDate: string; energy: Prisma.Decimal; readingCount: number; resetCount: number; rolloverCount: number }

function localHourIdentity(timestamp: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp)
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '0'
  const bucketStart = new Date(timestamp.getTime() - Number(get('minute')) * 60_000 - Number(get('second')) * 1_000 - timestamp.getUTCMilliseconds())
  return { bucketKey: localBucketKey(timestamp, timezone, 'HOUR'), bucketStart }
}

export function aggregateBucket(granularity: Granularity, timestamp: Date, timezone: string) {
  const localDate = siteDate(timestamp, timezone)
  if (granularity === 'HOUR') return { ...localHourIdentity(timestamp, timezone), localDate }
  if (granularity === 'DAY') return { bucketKey: localDate, bucketStart: localDateStartUtc(localDate, timezone), localDate }
  const month = localDate.slice(0, 7)
  return { bucketKey: month, bucketStart: localDateStartUtc(`${month}-01`, timezone), localDate }
}

export function expectedReadings(granularity: Granularity, row: Pick<AggregateRow, 'bucketKey' | 'bucketStart' | 'localDate'>, timezone: string, intervalMinutes: number) {
  let end: Date
  if (granularity === 'HOUR') end = new Date(row.bucketStart.getTime() + 3_600_000)
  else if (granularity === 'DAY') end = localDateStartUtc(nextLocalDate(row.localDate), timezone)
  else {
    const [year, month] = row.bucketKey.split('-').map(Number)
    const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10)
    end = localDateStartUtc(nextMonth, timezone)
  }
  return Math.ceil((end.getTime() - row.bucketStart.getTime()) / (intervalMinutes * 60_000))
}

export async function processOneMeterRollup(db: PrismaClient) {
  const claimed = await db.$queryRaw<{ id: string; organizationId: string; meterId: string; requestedFrom: Date; generation: number }[]>`
    WITH candidate AS (
      SELECT "id" FROM "MeterRollupTask"
      WHERE ("status" = 'QUEUED' AND "nextAttemptAt" <= CURRENT_TIMESTAMP)
         OR ("status" = 'PROCESSING' AND "lockedAt" < CURRENT_TIMESTAMP - INTERVAL '10 minutes')
      ORDER BY "nextAttemptAt", "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "MeterRollupTask" task SET "status" = 'PROCESSING', "lockedAt" = CURRENT_TIMESTAMP, "attempts" = task."attempts" + 1, "updatedAt" = CURRENT_TIMESTAMP
    FROM candidate WHERE task."id" = candidate."id"
    RETURNING task."id", task."organizationId", task."meterId", task."requestedFrom", task."generation"`
  const task = claimed[0]
  if (!task) return false
  try {
    const meter = await db.meter.findFirst({ where: { id: task.meterId, organizationId: task.organizationId }, include: { site: { select: { timezone: true } }, configurationVersions: { select: { rolloverValue: true, effectiveFrom: true, effectiveTo: true } } } })
    if (!meter) {
      await db.meterRollupTask.updateMany({ where: { id: task.id, generation: task.generation }, data: { status: 'COMPLETED', processedGeneration: task.generation, lockedAt: null, lastError: null } })
      return true
    }
    const rollups: RollupRow[] = [], firstLocalDate = siteDate(task.requestedFrom, meter.site.timezone)
    let aggregateFromDate = firstLocalDate
    let aggregateFrom = localDateStartUtc(firstLocalDate, meter.site.timezone)
    let aggregateData: { organizationId: string; meterId: string; granularity: Granularity; bucketKey: string; bucketStart: Date; localDate: string; timezone: string; energyKwh: Prisma.Decimal; readingCount: number; expectedReadingCount: number; completenessPercent: Prisma.Decimal; resetCount: number; rolloverCount: number; quality: string }[] = []
    let latestProcessedAt = task.requestedFrom
    if (meter.metric === 'ENERGY_IMPORT' && meter.unit === 'kWh') {
      const reaggregateFrom = localDateStartUtc(`${firstLocalDate.slice(0, 7)}-01`, meter.site.timezone)
      aggregateFrom = reaggregateFrom
      aggregateFromDate = siteDate(reaggregateFrom, meter.site.timezone)
      const prior = meter.meterType === 'CUMULATIVE' ? await db.meterReading.findFirst({ where: { organizationId: task.organizationId, meterId: task.meterId, quality: 'VALID', unit: 'kWh', timestamp: { lt: reaggregateFrom } }, orderBy: [{ timestamp: 'desc' }, { id: 'desc' }], select: { value: true } }) : null
      const readings = await db.meterReading.findMany({ where: { organizationId: task.organizationId, meterId: task.meterId, quality: 'VALID', unit: 'kWh', timestamp: { gte: reaggregateFrom } }, orderBy: [{ timestamp: 'asc' }, { id: 'asc' }], select: { timestamp: true, value: true } })
      if (readings.length) latestProcessedAt = readings.at(-1)!.timestamp
      const daily = new Map<string, { energy: Prisma.Decimal; readingCount: number; resetCount: number; rolloverCount: number }>()
      const aggregates = new Map<Granularity, Map<string, AggregateRow>>(['HOUR', 'DAY', 'MONTH'].map(granularity => [granularity as Granularity, new Map()]))
      let previous: Prisma.Decimal | undefined = prior ? new Prisma.Decimal(prior.value) : undefined
      for (const reading of readings) {
        const current = new Prisma.Decimal(reading.value)
        const date = siteDate(reading.timestamp, meter.site.timezone)
        const bucket = daily.get(date) ?? { energy: new Prisma.Decimal(0), readingCount: 0, resetCount: 0, rolloverCount: 0 }
        const aggregateRows = (['HOUR', 'DAY', 'MONTH'] as const).map(granularity => {
          const identity = aggregateBucket(granularity, reading.timestamp, meter.site.timezone)
          const map = aggregates.get(granularity)!
          const row = map.get(identity.bucketKey) ?? { ...identity, energy: new Prisma.Decimal(0), readingCount: 0, resetCount: 0, rolloverCount: 0 }
          row.readingCount++
          map.set(identity.bucketKey, row)
          return row
        })
        let delta: Prisma.Decimal | undefined
        let event: 'RESET' | 'ROLLOVER' | undefined
        if (meter.meterType === 'INTERVAL') delta = current
        else if (meter.meterType === 'CUMULATIVE' && previous !== undefined) {
          const result = cumulativeDelta(previous, current, rolloverValueAt(reading.timestamp, meter))
          delta = result.delta ?? undefined
          event = result.event ?? undefined
          if (event === 'RESET') bucket.resetCount++
          if (event === 'ROLLOVER') bucket.rolloverCount++
        }
        previous = current
        if (delta !== undefined) {
          bucket.energy = bucket.energy.add(delta)
          bucket.readingCount++
          for (const row of aggregateRows) row.energy = row.energy.add(delta)
        }
        for (const row of aggregateRows) {
          if (event === 'RESET') row.resetCount++
          if (event === 'ROLLOVER') row.rolloverCount++
        }
        daily.set(date, bucket)
      }
      for (const [localDate, value] of daily) rollups.push({ organizationId: task.organizationId, meterId: task.meterId, localDate, timezone: meter.site.timezone, energyKwh: value.energy, readingCount: value.readingCount, resetCount: value.resetCount, rolloverCount: value.rolloverCount, quality: value.resetCount ? 'REVIEW_REQUIRED' : value.rolloverCount ? 'ROLLOVER_ADJUSTED' : 'VALIDATED' })
      aggregateData = [...aggregates].flatMap(([granularity, rows]) => [...rows.values()].map(row => {
        const expected = expectedReadings(granularity, row, meter.site.timezone, meter.intervalMinutes)
        return { organizationId: task.organizationId, meterId: task.meterId, granularity, bucketKey: row.bucketKey, bucketStart: row.bucketStart, localDate: row.localDate, timezone: meter.site.timezone, energyKwh: row.energy, readingCount: row.readingCount, expectedReadingCount: expected, completenessPercent: new Prisma.Decimal(expected ? Math.min(row.readingCount, expected) * 100 / expected : 0).toDecimalPlaces(2), resetCount: row.resetCount, rolloverCount: row.rolloverCount, quality: row.resetCount ? 'REVIEW_REQUIRED' : row.rolloverCount ? 'ROLLOVER_ADJUSTED' : 'VALIDATED' }
      }))
    }
    await db.$transaction(async tx => {
      await tx.meterEnergyRollup.deleteMany({ where: { organizationId: task.organizationId, meterId: task.meterId, localDate: { gte: aggregateFromDate } } })
      if (rollups.length) await tx.meterEnergyRollup.createMany({ data: rollups })
      for (const granularity of ['HOUR', 'DAY', 'MONTH'] as const) {
        const previous = await tx.meterEnergyAggregate.findMany({ where: { organizationId: task.organizationId, meterId: task.meterId, granularity, bucketStart: { gte: aggregateFrom } }, select: { bucketKey: true, version: true } })
        const versions = new Map(previous.map(row => [row.bucketKey, row.version]))
        await tx.meterEnergyAggregate.deleteMany({ where: { organizationId: task.organizationId, meterId: task.meterId, granularity, bucketStart: { gte: aggregateFrom } } })
        const data = aggregateData.filter(row => row.granularity === granularity).map(row => ({ ...row, version: (versions.get(row.bucketKey) ?? 0) + 1 }))
        if (data.length) await tx.meterEnergyAggregate.createMany({ data })
      }
      const current = await tx.meterRollupTask.findUnique({ where: { id: task.id }, select: { generation: true } })
      if (!current) return
      await tx.meterRollupTask.update({ where: { id: task.id }, data: { processedGeneration: task.generation, status: current.generation === task.generation ? 'COMPLETED' : 'QUEUED', requestedFrom: current.generation === task.generation ? latestProcessedAt : undefined, nextAttemptAt: new Date(), lockedAt: null, lastError: null } })
    }, { timeout: 60_000 })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Meter rollup failed.'
    const attempts = await db.meterRollupTask.findUnique({ where: { id: task.id }, select: { attempts: true, generation: true } })
    const generationChanged = (attempts?.generation ?? task.generation) !== task.generation
    const failed = !generationChanged && (attempts?.attempts ?? 0) >= 8
    await db.meterRollupTask.updateMany({ where: { id: task.id }, data: { status: failed ? 'FAILED' : 'QUEUED', attempts: generationChanged ? 0 : undefined, nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(generationChanged ? 1 : attempts?.attempts ?? 1, 8))), lockedAt: null, lastError: message } })
    return true
  }
}
