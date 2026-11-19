export type DailyEnergy = { date: string; kwh: number }
export type ExogenousValue = { date: string; weatherIndex?: number; productionUnits?: number }

/** Ordinary least squares with an intercept and the supplied weather/production predictors. */
export function exogenousLinearForecast(points: DailyEnergy[], history: ExogenousValue[], future: ExogenousValue[]) {
  const energy = [...points].sort((a, b) => a.date.localeCompare(b.date))
  const historyByDate = new Map(history.map(row => [row.date, row]))
  const futureSorted = [...future].sort((a, b) => a.date.localeCompare(b.date))
  if (energy.length < 10 || history.length !== energy.length || future.length < 1 || future.length > 30) throw new Error('INSUFFICIENT_EXOGENOUS_DATA')
  const predictors = (row: ExogenousValue) => [row.weatherIndex ?? 0, row.productionUnits ?? 0]
  const validValue = (n: number) => Number.isFinite(n) && Math.abs(n) <= 1e12
  for (let i = 0; i < energy.length; i++) {
    const row = historyByDate.get(energy[i].date)
    if (!row || !validValue(energy[i].kwh) || energy[i].kwh < 0 || !predictors(row).every(validValue)) throw new Error('INVALID_EXOGENOUS_DATA')
    if (i && Date.parse(`${energy[i].date}T00:00:00Z`) - Date.parse(`${energy[i - 1].date}T00:00:00Z`) !== 86400000) throw new Error('DATA_GAPS')
  }
  for (let i = 0; i < futureSorted.length; i++) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(futureSorted[i].date) || !predictors(futureSorted[i]).every(validValue) || (i && Date.parse(`${futureSorted[i].date}T00:00:00Z`) - Date.parse(`${futureSorted[i - 1].date}T00:00:00Z`) !== 86400000)) throw new Error('INVALID_EXOGENOUS_DATA')
  }
  if (futureSorted[0].date <= energy.at(-1)!.date || Date.parse(`${futureSorted[0].date}T00:00:00Z`) - Date.parse(`${energy.at(-1)!.date}T00:00:00Z`) !== 86400000) throw new Error('INVALID_EXOGENOUS_DATES')
  const featureIndexes = [0, 1].filter(index => {
    const values = energy.map(point => predictors(historyByDate.get(point.date)!)[index]), mean = values.reduce((sum, value) => sum + value, 0) / values.length
    return values.some(value => Math.abs(value - mean) > 1e-9)
  })
  if (!featureIndexes.length) throw new Error('EXOGENOUS_FEATURES_INSUFFICIENT')
  const featureRow = (row: ExogenousValue) => [1, ...featureIndexes.map(index => predictors(row)[index])]
  const rows = energy.map(point => featureRow(historyByDate.get(point.date)!)), n = 1 + featureIndexes.length
  const fit = (features: number[][], targets: DailyEnergy[]) => {
    const matrix = Array.from({ length: n }, (_, r) => [...Array.from({ length: n }, (_, c) => features.reduce((sum, row) => sum + row[r] * row[c], 0)), features.reduce((sum, row, i) => sum + row[r] * targets[i].kwh, 0)])
    for (let col = 0; col < n; col++) { let pivot = col; for (let row = col + 1; row < n; row++) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row; if (Math.abs(matrix[pivot][col]) < 1e-10) throw new Error('EXOGENOUS_FEATURES_COLLINEAR'); [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]]; const divisor = matrix[col][col]; for (let j = col; j <= n; j++) matrix[col][j] /= divisor; for (let row = 0; row < n; row++) if (row !== col) { const scale = matrix[row][col]; for (let j = col; j <= n; j++) matrix[row][j] -= scale * matrix[col][j] } }
    return matrix.map(row => row[n])
  }
  const holdoutStart = Math.max(8, Math.floor(energy.length * .8)), backtestCoefficients = fit(rows.slice(0, holdoutStart), energy.slice(0, holdoutStart)), coefficients = fit(rows, energy)
  const errors = energy.slice(holdoutStart).map((point, index) => Math.abs(point.kwh - rows[holdoutStart + index].reduce((sum, value, j) => sum + value * backtestCoefficients[j], 0)))
  const nonzero = energy.slice(holdoutStart).map((point, index) => point.kwh ? errors[index] / point.kwh : null).filter((value): value is number => value !== null)
  const coefficientFor = (index: number) => { const offset = featureIndexes.indexOf(index); return offset < 0 ? 0 : coefficients[offset + 1] }
  return { model: 'EXOGENOUS_LINEAR', coefficients: { intercept: coefficients[0], weatherIndex: coefficientFor(0), productionUnits: coefficientFor(1) }, activePredictors: featureIndexes.map(index => index === 0 ? 'weatherIndex' : 'productionUnits'), mae: Number((errors.reduce((sum, value) => sum + value, 0) / errors.length).toFixed(2)), mape: nonzero.length ? Number((nonzero.reduce((sum, value) => sum + value, 0) / nonzero.length * 100).toFixed(2)) : null, backtestStart: energy[holdoutStart].date, backtestEnd: energy.at(-1)!.date, trainingStart: energy[0].date, trainingEnd: energy.at(-1)!.date, forecast: futureSorted.map(row => ({ date: row.date, kwh: Number(Math.max(0, featureRow(row).reduce((sum, value, index) => sum + value * coefficients[index], 0)).toFixed(2)) })) }
}

/** Moving-average forecast; absent days are never silently treated as zero. */
export function movingAverageForecast(points: DailyEnergy[], horizon: number, window = 7) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 30 || !Number.isInteger(window) || window < 2) throw new Error('INVALID_PARAMETERS')
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date))
  if (sorted.length < window + 1) throw new Error('INSUFFICIENT_HISTORY')
  for (let i = 0; i < sorted.length; i++) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sorted[i].date) || !Number.isFinite(sorted[i].kwh) || sorted[i].kwh < 0) throw new Error('INVALID_DATA')
    if (i && Date.parse(`${sorted[i].date}T00:00:00Z`) - Date.parse(`${sorted[i - 1].date}T00:00:00Z`) !== 86400000) throw new Error('DATA_GAPS')
  }
  let absoluteError = 0, percentageError = 0, percentageCount = 0
  for (let i = window; i < sorted.length; i++) {
    const predicted = sorted.slice(i - window, i).reduce((sum, x) => sum + x.kwh, 0) / window
    const error = Math.abs(sorted[i].kwh - predicted)
    absoluteError += error
    if (sorted[i].kwh > 0) { percentageError += error / sorted[i].kwh; percentageCount++ }
  }
  const values = sorted.map(x => x.kwh), last = Date.parse(`${sorted[sorted.length - 1].date}T00:00:00Z`)
  const forecast = Array.from({ length: horizon }, (_, index) => {
    const value = values.slice(-window).reduce((sum, x) => sum + x, 0) / window
    values.push(value)
    return { date: new Date(last + (index + 1) * 86400000).toISOString().slice(0, 10), kwh: Number(value.toFixed(2)) }
  })
  return { model: 'MOVING_AVERAGE', window, trainingStart: sorted[0].date, trainingEnd: sorted[sorted.length - 1].date, mae: Number((absoluteError / (sorted.length - window)).toFixed(2)), mape: percentageCount ? Number((percentageError / percentageCount * 100).toFixed(2)) : null, forecast }
}

/** Simple exponential smoothing with rolling one-step backtest and constant horizon level. */
export function exponentialSmoothingForecast(points: DailyEnergy[], horizon: number, alpha = 0.3) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 30 || !Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new Error('INVALID_PARAMETERS')
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date))
  if (sorted.length < 8) throw new Error('INSUFFICIENT_HISTORY')
  for (let i = 0; i < sorted.length; i++) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sorted[i].date) || !Number.isFinite(sorted[i].kwh) || sorted[i].kwh < 0) throw new Error('INVALID_DATA')
    if (i && Date.parse(`${sorted[i].date}T00:00:00Z`) - Date.parse(`${sorted[i - 1].date}T00:00:00Z`) !== 86400000) throw new Error('DATA_GAPS')
  }
  let level = sorted[0].kwh, absoluteError = 0, percentageError = 0, percentageCount = 0
  for (let i = 1; i < sorted.length; i++) {
    const predicted = level, actual = sorted[i].kwh, error = Math.abs(actual - predicted)
    absoluteError += error
    if (actual > 0) { percentageError += error / actual; percentageCount++ }
    level = alpha * actual + (1 - alpha) * level
  }
  const last = Date.parse(`${sorted[sorted.length - 1].date}T00:00:00Z`)
  const forecast = Array.from({ length: horizon }, (_, index) => ({ date: new Date(last + (index + 1) * 86400000).toISOString().slice(0, 10), kwh: Number(level.toFixed(2)) }))
  return { model: 'EXPONENTIAL_SMOOTHING', alpha, trainingStart: sorted[0].date, trainingEnd: sorted[sorted.length - 1].date, mae: Number((absoluteError / (sorted.length - 1)).toFixed(2)), mape: percentageCount ? Number((percentageError / percentageCount * 100).toFixed(2)) : null, forecast }
}
