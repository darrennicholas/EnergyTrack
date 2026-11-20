export type EmailMessage = { to: string; subject: string; text: string }

export function emailDeliveryConfigured(env = process.env) {
  return !!(env.EMAIL_DELIVERY_URL && env.EMAIL_DELIVERY_TOKEN && env.EMAIL_FROM_ADDRESS)
}

/** Deliver through a configured, authenticated mail gateway without persisting plaintext credentials. */
export async function deliverEmail(message: EmailMessage, env = process.env) {
  const endpoint = env.EMAIL_DELIVERY_URL, token = env.EMAIL_DELIVERY_TOKEN, from = env.EMAIL_FROM_ADDRESS
  if (!endpoint || !token || !from) throw new Error('EMAIL_DELIVERY_NOT_CONFIGURED')
  const url = new URL(endpoint)
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('EMAIL_DELIVERY_REQUIRES_HTTPS')
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ from, ...message }), signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`EMAIL_DELIVERY_FAILED_${response.status}`)
}
