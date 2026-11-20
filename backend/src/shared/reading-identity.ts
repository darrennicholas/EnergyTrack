import { createHash } from 'node:crypto'

/** Shared fallback identity for imports that do not supply an external reading ID. */
export function readingIdentity(meterId: string, timestamp: Date, rawValue: string, unit: string, namespace = 'csv'): string {
  return `${namespace}:${createHash('sha256').update(`${meterId}|${timestamp.toISOString()}|${rawValue}|${unit}`).digest('hex')}`
}
