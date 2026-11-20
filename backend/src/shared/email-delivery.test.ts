import { describe, expect, it } from 'vitest'
import { deliverEmail, emailDeliveryConfigured } from './email-delivery.js'

describe('email gateway configuration', () => {
  it('requires endpoint, token, and sender address', () => {
    expect(emailDeliveryConfigured({ EMAIL_DELIVERY_URL: 'https://mail.example.test/send', EMAIL_DELIVERY_TOKEN: 'secret', EMAIL_FROM_ADDRESS: 'noreply@example.test' } as NodeJS.ProcessEnv)).toBe(true)
    expect(emailDeliveryConfigured({ EMAIL_DELIVERY_URL: 'https://mail.example.test/send', EMAIL_DELIVERY_TOKEN: 'secret' } as NodeJS.ProcessEnv)).toBe(false)
  })
  it('fails closed without a configured gateway', async () => {
    await expect(deliverEmail({ to: 'a@example.test', subject: 'Test', text: 'Test' }, {} as NodeJS.ProcessEnv)).rejects.toThrow('EMAIL_DELIVERY_NOT_CONFIGURED')
  })
})
