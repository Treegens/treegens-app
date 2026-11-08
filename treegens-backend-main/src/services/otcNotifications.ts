import axios from 'axios'
import env from '../config/environment'
import { enqueueNotification } from './notificationService'

/**
 * Alerts for the OTC desk.
 *
 * Every alert lands in the in-app inbox (and web push when the wallet has a
 * subscription). Alerts for the BUYER are additionally mirrored to Telegram
 * when OTC_TELEGRAM_CHAT_ID and a bot token are configured, because the buyer
 * must hear about a counted video within minutes, not when they next open
 * the app.
 */

export type OtcNotificationInput = {
  recipientWalletAddress: string
  kind: string
  title: string
  body: string
  /** Web app path, e.g. /otc/deals/123 */
  link?: string
  payload?: Record<string, unknown>
  /** Mirror to Telegram (buyer alerts only). */
  telegram?: boolean
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function telegramConfigured(): boolean {
  return Boolean(env.OTC_TELEGRAM_BOT_TOKEN && env.OTC_TELEGRAM_CHAT_ID)
}

export async function sendOtcTelegram(
  title: string,
  body: string,
  link?: string,
): Promise<boolean> {
  if (!telegramConfigured()) return false
  const url = link ? `${env.OTC_PUBLIC_APP_URL}${link}` : ''
  const text =
    `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}` +
    (url ? `\n<a href="${escapeHtml(url)}">Open in TreeGens</a>` : '')
  try {
    await axios.post(
      `https://api.telegram.org/bot${env.OTC_TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: env.OTC_TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      { timeout: 8000 },
    )
    return true
  } catch (error: any) {
    console.warn('[OTC] Telegram alert failed', {
      message: error?.message || String(error),
    })
    return false
  }
}

/** Never throws: an alert failure must not fail the action that caused it. */
export async function notifyOtc(input: OtcNotificationInput): Promise<void> {
  const recipient = String(input.recipientWalletAddress || '').toLowerCase()
  if (recipient) {
    await enqueueNotification({
      recipientWalletAddress: recipient,
      kind: input.kind,
      title: input.title,
      body: input.body,
      link: input.link,
      payload: input.payload,
    }).catch((error: any) => {
      console.warn('[OTC] inbox notification failed', {
        kind: input.kind,
        message: error?.message || String(error),
      })
    })
  }
  if (input.telegram) {
    await sendOtcTelegram(input.title, input.body, input.link)
  }
}
