const partsFormatter = (timeZone: string) => new Intl.DateTimeFormat('en-US', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** Convert a calendar date's local midnight to UTC, respecting timezone offset changes. */
export function localDateStartUtc(date: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) throw new RangeError('INVALID_LOCAL_DATE')
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const target = Date.UTC(year, month - 1, day)
  const normalized = new Date(target).toISOString().slice(0, 10)
  if (normalized !== date) throw new RangeError('INVALID_LOCAL_DATE')

  const formatter = partsFormatter(timeZone)
  let candidate = target
  for (let attempt = 0; attempt < 4; attempt++) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(part => [part.type, part.value]))
    const localAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second))
    const offset = localAsUtc - candidate
    const next = target - offset
    if (next === candidate) break
    candidate = next
  }
  return new Date(candidate)
}

export function nextLocalDate(date: string) {
  const start = localDateStartUtc(date, 'UTC')
  return new Date(start.getTime() + 86400000).toISOString().slice(0, 10)
}

/** A training window spanning whole site-local calendar days, including DST-short/long days. */
export function localCalendarWindow(endDate: string, days: number, timeZone: string) {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new RangeError('INVALID_LOCAL_WINDOW')
  localDateStartUtc(endDate, timeZone)
  const start = new Date(`${endDate}T00:00:00.000Z`)
  start.setUTCDate(start.getUTCDate() - days)
  const startDate = start.toISOString().slice(0, 10)
  return { startDate, endDate, start: localDateStartUtc(startDate, timeZone), end: localDateStartUtc(endDate, timeZone) }
}
