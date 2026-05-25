import * as logger from './logger'

export interface WebhookPayload {
  /** App identifier — lets a webhook serve multiple installations */
  app:       'SundayRec'
  church:    string
  severity:  'warn' | 'error'
  category:  string
  message:   string
  timestamp: string
}

/**
 * Fire a webhook POST. Auto-detects Slack-style URLs and reformats the payload
 * accordingly. Discord uses the same `content` shape so it works for both.
 * Generic JSON for everything else.
 *
 * Best-effort: failures are logged, not surfaced — the user already knows
 * about the underlying error (this is just a delivery channel for it).
 */
export async function sendWebhook(url: string, p: WebhookPayload): Promise<boolean> {
  if (!url || !/^https?:\/\//i.test(url)) return false

  // Slack/Discord both accept `{"text": ...}` (Slack) and `{"content": ...}` (Discord);
  // a single payload that has both works for either.
  const human = `${p.severity === 'error' ? '⚠️' : 'ℹ️'} *SundayRec* (${p.church || 'untitled'})\n` +
                `[${p.category}] ${p.message}\n_${p.timestamp}_`

  const isSlackOrDiscord = /hooks\.slack\.com|discord(app)?\.com\/api\/webhooks/i.test(url)

  const body = isSlackOrDiscord
    ? JSON.stringify({ text: human, content: human })
    : JSON.stringify(p)

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 10_000)
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal:  ctrl.signal,
    })
    clearTimeout(t)
    if (!res.ok) {
      logger.warn('webhook', 'http_error', { status: res.status })
      return false
    }
    return true
  } catch (err) {
    logger.warn('webhook', 'send_failed', { error: (err as Error).message })
    return false
  }
}
