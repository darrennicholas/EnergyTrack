export const REPORT_MAX_ATTEMPTS = 3
export function reportRetryDelayMs(attempt: number) { return 5_000 * 2 ** Math.max(0, attempt - 1) }
export function reportRetry(attempt: number) {
  const retry = attempt < REPORT_MAX_ATTEMPTS
  return { retry, delayMs: retry ? reportRetryDelayMs(attempt) : 0 }
}
