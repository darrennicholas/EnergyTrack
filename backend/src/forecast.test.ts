import { describe, expect, it } from 'vitest'
import { exogenousLinearForecast, exponentialSmoothingForecast, movingAverageForecast } from './forecast.js'

const history = Array.from({ length: 8 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, kwh: 10 }))
describe('moving average forecast', () => {
  it('backtests and predicts without modifying measured values', () => {
    const result = movingAverageForecast(history, 2)
    expect(result).toMatchObject({ mae: 0, mape: 0, forecast: [{ date: '2026-11-09', kwh: 10 }, { date: '2026-11-10', kwh: 10 }] })
    expect(history).toHaveLength(8)
  })
  it('rejects insufficient history and gaps instead of inventing zero readings', () => {
    expect(() => movingAverageForecast(history.slice(0, 7), 1)).toThrow('INSUFFICIENT_HISTORY')
    expect(() => movingAverageForecast([...history.slice(0, 7), { date: '2026-11-09', kwh: 10 }], 1)).toThrow('DATA_GAPS')
  })
  it('backtests exponential smoothing and reports a constant level forecast', () => {
    const result = exponentialSmoothingForecast(history, 2, 0.3)
    expect(result).toMatchObject({ model: 'EXPONENTIAL_SMOOTHING', mae: 0, mape: 0, forecast: [{ date: '2026-11-09', kwh: 10 }, { date: '2026-11-10', kwh: 10 }] })
  })
  it('uses supplied weather and production data for an explainable forecast', () => {
    const drivers = Array.from({ length: 12 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, weatherIndex: (i * 7) % 11, productionUnits: (i * i + 3 * i) % 17 }))
    const energy = drivers.map(row => ({ date: row.date, kwh: 100 + 2 * row.weatherIndex + 3 * row.productionUnits }))
    const future = [{ date: '2026-11-13', weatherIndex: 10, productionUnits: 8 }, { date: '2026-11-14', weatherIndex: 1, productionUnits: 4 }]
    const forecast = exogenousLinearForecast(energy, drivers, future)
    expect(forecast.coefficients.intercept).toBeCloseTo(100)
    expect(forecast.coefficients.weatherIndex).toBeCloseTo(2)
    expect(forecast.coefficients.productionUnits).toBeCloseTo(3)
    expect(forecast.forecast.map(row => row.kwh)).toEqual([144, 114])
  })
  it('fits a single available weather source without requiring production observations', () => {
    const drivers = Array.from({ length: 12 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, weatherIndex: i + 1 }))
    const energy = drivers.map(row => ({ date: row.date, kwh: 30 + 2 * row.weatherIndex! }))
    const result = exogenousLinearForecast(energy, drivers, [{ date: '2026-11-13', weatherIndex: 13 }])
    expect(result.coefficients.weatherIndex).toBeCloseTo(2)
    expect(result.coefficients.productionUnits).toBe(0)
    expect(result.forecast[0].kwh).toBe(56)
  })
  it('rejects a forecast whose future predictors omit consecutive dates', () => {
    const drivers = Array.from({ length: 10 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, weatherIndex: i % 3, productionUnits: i * i }))
    const points = drivers.map(row => ({ date: row.date, kwh: 10 }))
    expect(() => exogenousLinearForecast(points, drivers, [{ date: '2026-11-12', weatherIndex: 1 }])).toThrow('INVALID_EXOGENOUS_DATES')
  })
})
