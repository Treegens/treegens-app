import dns from 'node:dns/promises';
import net from 'node:net';
import { all, get, run } from './db.ts';
import { hmac, now, id, baseUrl } from './util.ts';
import { sendMail } from './mail.ts';

export const WEBHOOK_EVENTS = ['envelope.sent', 'envelope.completed', 'envelope.declined', 'envelope.voided', 'envelope.expired', 'envelope.corrected', 'recipient.viewed', 'recipient.completed'];

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

// Webhook targets are user supplied, so refuse anything that points back into a private network.
export async function assertPublicUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Enter a full URL, starting with https://');
  }
  if (process.env.ALLOW_PRIVATE_WEBHOOKS === '1') return;
  if (u.protocol !== 'https:') throw new Error('Webhook URLs must use https.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('That hostname does not resolve.');
  if (addrs.some((a) => isPrivate(a.address))) throw new Error('Webhook URLs must point to a public address.');
}

async function deliver(hook: any, event: string, envelopeId: string, body: string) {
  let status: number | null = null;
  let error: string | null = null;
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      await assertPublicUrl(hook.url);
      const ts = Math.floor(Date.now() / 1000);
      const res = await fetch(hook.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'SignAndGrow-Webhook/1',
          'x-signandgrow-event': event,
          'x-signandgrow-timestamp': String(ts),
          'x-signandgrow-signature': `sha256=${hmac(`${ts}.${body}`, hook.secret)}`,
        },
        body,
      });
      status = res.status;
      error = null;
      if (res.status < 300) break;
    } catch (e: any) {
      error = String(e?.message || e).slice(0, 300);
    }
    if (attempts < 3) await new Promise((r) => setTimeout(r, attempts * 2000));
  }
  run('INSERT INTO webhook_deliveries (webhook_id, event, envelope_id, status, error, attempts, at, body) VALUES (?,?,?,?,?,?,?,?)', hook.id, event, envelopeId, status, error, attempts, now(), body);
  // Three failures in a row and nobody told: that is how integrations break silently. Email the admins, once a day at most.
  const ok = status !== null && status < 300;
  if (!ok) {
    const last = all('SELECT status FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 3', hook.id);
    const fresh = get('SELECT alerted_at FROM webhooks WHERE id=?', hook.id);
    if (last.length === 3 && last.every((d) => !d.status || d.status >= 300) && (!fresh?.alerted_at || Date.parse(fresh.alerted_at) < Date.now() - 864e5)) {
      run('UPDATE webhooks SET alerted_at=? WHERE id=?', now(), hook.id);
      for (const u of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", hook.account_id))
        void sendMail({ to: u.email, subject: 'A Sign&Grow webhook keeps failing', heading: 'Your webhook is not receiving events',
          lines: [`The last three deliveries to ${hook.url} failed (${error || `HTTP ${status}`}).`, 'Nothing is lost: every event is kept in the delivery log, and once your side is fixed you can send each one again from Settings.'],
          cta: { label: 'Open the delivery log', url: `${baseUrl()}/app/settings?tab=developers` } }).catch(() => {});
    }
  }
  // Keep the log useful but small: bodies of older deliveries are dropped.
  run('UPDATE webhook_deliveries SET body=NULL WHERE webhook_id=? AND id < (SELECT MAX(id) - 200 FROM webhook_deliveries WHERE webhook_id=?)', hook.id, hook.id);
}

// Send a past delivery again, exactly as it was, after fixing whatever made it fail.
export function redeliver(webhookId: string, event: string, envelopeId: string, body: string) {
  const hook = get('SELECT * FROM webhooks WHERE id=?', webhookId);
  if (hook) void deliver(hook, event, envelopeId, body).catch(() => {});
}

// Fire and forget: signing never waits on someone else's server.
export function fireWebhooks(accountId: string, event: string, envelopeId: string, extra: Record<string, any> = {}) {
  const hooks = all('SELECT * FROM webhooks WHERE account_id=? AND active=1', accountId).filter((h) => h.events === '*' || h.events.split(',').includes(event));
  if (!hooks.length) return;
  const e = get('SELECT id, status, subject, sent_at, completed_at FROM envelopes WHERE id=?', envelopeId);
  // "text" is a one-line summary for chat tools and no-code automations that only want a message to show.
  // "id" is unique per event and stays the same when a delivery is sent again, so receivers can ignore repeats.
  const body = JSON.stringify({ id: id('evt'), event, created_at: now(), envelope: e, ...extra, text: `${e?.subject || 'Envelope'}: ${event.replace('.', ' ')}` });
  for (const h of hooks) void deliver(h, event, envelopeId, body).catch(() => {});
}
