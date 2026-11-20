// Background job scheduler. Honors the FSD "BullMQ + Redis" requirement when REDIS_URL is
// configured, and falls back to in-process interval polling when Redis is absent (local dev, CI).
// Every task is idempotent and claim-locked at the database level, so both drive modes are safe.
import type { Queue, Worker } from 'bullmq'

export type ScheduledTask = {
  // Stable identifier used for the BullMQ repeatable job key and the log event name.
  name: string
  // Interval between runs, in milliseconds.
  everyMs: number
  // The idempotent unit of work. Must not throw for control flow; failures are logged and retried.
  run: () => Promise<unknown>
  // Run once immediately on startup in addition to the schedule.
  runOnStart?: boolean
}

type Logger = (level: 'info' | 'error', event: string, fields?: Record<string, unknown>) => void

export type SchedulerHandle = { mode: 'bullmq' | 'in-process'; stop: () => Promise<void> }

function redactConnectionUrl(url: string) {
  try { const parsed = new URL(url); if (parsed.password) parsed.password = '***'; return parsed.toString() }
  catch { return 'redis://[unparseable]' }
}

// In-process mode: a guarded setInterval per task, matching the previous server.ts behavior exactly.
function startInProcess(tasks: ScheduledTask[], log: Logger): SchedulerHandle {
  const timers: NodeJS.Timeout[] = []
  for (const task of tasks) {
    let running = false
    const tick = () => {
      if (running) return
      running = true
      void Promise.resolve(task.run())
        .catch(error => log('error', `${task.name}_failed`, { error }))
        .finally(() => { running = false })
    }
    if (task.runOnStart) tick()
    const timer = setInterval(tick, task.everyMs)
    timer.unref()
    timers.push(timer)
  }
  log('info', 'scheduler_started', { mode: 'in-process', tasks: tasks.map(task => task.name) })
  return { mode: 'in-process', stop: async () => { for (const timer of timers) clearInterval(timer) } }
}

// BullMQ mode: one queue with a repeatable job per task, and one worker that dispatches by job name.
async function startBullmq(tasks: ScheduledTask[], redisUrl: string, log: Logger): Promise<SchedulerHandle> {
  const { Queue, Worker, QueueEvents } = await import('bullmq')
  const IORedisModule = await import('ioredis')
  const IORedis = (IORedisModule.default ?? IORedisModule) as unknown as typeof import('ioredis').Redis
  // BullMQ requires maxRetriesPerRequest: null on the blocking connection.
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null })
  const queueName = 'energytrack-jobs'
  const taskByName = new Map(tasks.map(task => [task.name, task]))
  const queue: Queue = new Queue(queueName, { connection })
  const queueEvents = new QueueEvents(queueName, { connection: connection.duplicate() })

  // Reconcile repeatable schedulers so interval changes take effect across restarts.
  const existing = await queue.getJobSchedulers()
  for (const scheduler of existing) if (scheduler.key && !taskByName.has(scheduler.key)) await queue.removeJobScheduler(scheduler.key)
  for (const task of tasks) {
    await queue.upsertJobScheduler(task.name, { every: task.everyMs }, { name: task.name, opts: { removeOnComplete: true, removeOnFail: 100 } })
    if (task.runOnStart) await queue.add(task.name, {}, { removeOnComplete: true, removeOnFail: 100 })
  }

  const worker: Worker = new Worker(queueName, async job => {
    const task = taskByName.get(job.name)
    if (!task) return
    await task.run()
  }, { connection: connection.duplicate(), concurrency: 1 })

  worker.on('failed', (job, error: Error) => log('error', `${job?.name ?? 'job'}_failed`, { error: error?.message }))
  worker.on('error', (error: Error) => log('error', 'scheduler_worker_error', { error: error.message }))
  connection.on('error', (error: Error) => log('error', 'scheduler_redis_error', { error: error.message }))

  log('info', 'scheduler_started', { mode: 'bullmq', redis: redactConnectionUrl(redisUrl), tasks: tasks.map(task => task.name) })
  return {
    mode: 'bullmq',
    stop: async () => {
      await worker.close()
      await queueEvents.close()
      await queue.close()
      connection.disconnect()
    }
  }
}

// Starts the scheduler in whichever mode the environment supports. Never throws: if Redis is
// configured but unreachable at startup, it logs and falls back to in-process polling so the
// process still does its background work.
export async function startScheduler(tasks: ScheduledTask[], log: Logger): Promise<SchedulerHandle> {
  const redisUrl = process.env.REDIS_URL?.trim()
  if (!redisUrl) return startInProcess(tasks, log)
  try { return await startBullmq(tasks, redisUrl, log) }
  catch (error) {
    log('error', 'scheduler_bullmq_init_failed', { error: error instanceof Error ? error.message : String(error) })
    return startInProcess(tasks, log)
  }
}
