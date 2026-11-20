import { describe, expect, it } from 'vitest'
import { REPORT_MAX_ATTEMPTS, reportRetry } from './report-retry.js'

describe('report artifact retry policy', () => {
  it('backs off exponentially and stops at the configured attempt limit', () => {
    expect(reportRetry(1)).toEqual({ retry: true, delayMs: 5000 })
    expect(reportRetry(2)).toEqual({ retry: true, delayMs: 10000 })
    expect(reportRetry(REPORT_MAX_ATTEMPTS)).toEqual({ retry: false, delayMs: 0 })
  })
})
