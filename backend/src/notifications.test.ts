import { describe, expect, it, vi } from 'vitest'
import { deliverOneAlertEmail, notificationMaxAttempts, notificationRetryDelayMs } from './notifications.js'
import { deliverEmail } from './shared/email-delivery.js'
import type { PrismaClient } from '@prisma/client'

vi.mock('./shared/email-delivery.js', () => ({ deliverEmail: vi.fn() }))

function fakeDatabase(executeStatements: string[]) {
  const delivery = { id: 'delivery-id', organizationId: 'org-id', alertId: 'alert-id', userId: 'user-id', attemptCount: 1 }
  const transaction = {
    $executeRaw: async (parts: TemplateStringsArray) => { executeStatements.push(parts.join('?')); return 1 },
    $queryRaw: async () => [delivery],
    auditLog: { create: vi.fn() },
  }
  return {
    $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
    notificationPreference: { findFirst: vi.fn().mockResolvedValue({ user: { email: 'recipient@example.invalid', fullName: 'Recipient' } }) },
    alert: { findFirst: vi.fn().mockResolvedValue({ message: 'Demand threshold exceeded' }) },
  } as unknown as PrismaClient
}

describe('alert email retry schedule', () => {
  it('backs off exponentially across five attempts', () => {
    expect(notificationRetryDelayMs(1)).toBe(15_000)
    expect(notificationRetryDelayMs(2)).toBe(30_000)
    expect(notificationRetryDelayMs(notificationMaxAttempts)).toBe(240_000)
    expect(notificationMaxAttempts).toBe(5)
  })

  it('sends a claimed notification and records a successful attempt', async () => {
    const calls: string[] = []
    const db = fakeDatabase(calls)
    vi.mocked(deliverEmail).mockResolvedValueOnce(undefined)

    await expect(deliverOneAlertEmail(db)).resolves.toBe(true)
    expect(deliverEmail).toHaveBeenCalledOnce()
    expect(calls.some(sql => sql.includes("'SENT'"))).toBe(true)
  })

  it('schedules a retry after a transient email failure', async () => {
    const calls: string[] = []
    const db = fakeDatabase(calls)
    vi.mocked(deliverEmail).mockRejectedValueOnce(new Error('Temporary mail gateway failure'))

    await expect(deliverOneAlertEmail(db)).resolves.toBe(true)
    expect(calls.some(sql => sql.includes("'QUEUED'"))).toBe(true)
  })
})
