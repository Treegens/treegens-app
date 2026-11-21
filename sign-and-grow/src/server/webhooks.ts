import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { all, get, run } from './db.ts';
import { hmac, now, id, baseUrl } from './util.ts';
import { sendMail } from './mail.ts';
import { webhookRefusal, webhookMayBePrivate } from '../lib/outside.ts';
import { webhookCustom } from './customfields.ts';

// envelope.updated: something about an envelope changed that is none of the others. Today that is news about an
// email to one of its recipients (it came back, it was marked as spam, the sender had it tried again): the delivery
// carries "recipient_id" and "change". Read the envelope again to see how it stands.
// security.event: a line of the account's security record (seclog.ts). Only for a webhook that lists it by name: "*"
// never includes it, because it carries the team's internet addresses.
export const WEBHOOK_EVENTS = ['envelope.sent', 'envelope.completed', 'envelope.declined', 'envelope.voided', 'envelope.expired', 'envelope.corrected', 'envelope.updated', 'recipient.viewed', 'recipient.completed', 'comment.created', 'security.event'];

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

export const MAX_WEBHOOKS = 20; // per account
export const KEEP_BODIES = 200; // deliveries of each webhook that can be sent again
const TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 64 * 1024;
const PENDING_MS = 2 * 60_000; // three tries with their waits end well inside this

// One answer for "does not resolve" and "resolves to a private address", so this check cannot be used to find
// out which names exist inside our own network.
const REFUSED = 'That address cannot be used for a webhook. It has to be an https address on the public internet that we can reach.';

type Target = { url: URL; addresses: { address: string; family: number }[] };

// Webhook targets are user supplied, so refuse anything that points back into a private network. The host name is
// looked up once, here, and the delivery connects only to the addresses that passed the check. A name that
// answers with a public address first and a private one a moment later gets nowhere.
export async function resolvePublic(raw: string): Promise<Target> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Enter a full URL, starting with https://');
  }
  const open = process.env.ALLOW_PRIVATE_WEBHOOKS === '1';
  if (u.protocol !== 'https:' && !(open && u.protocol === 'http:')) throw new Error('Webhook URLs must use https.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // With OUTSIDE_CALLS listed or none, only to the hosts the operator listed in WEBHOOK_ALLOW_HOSTS, at saving and at
  // every delivery (src/lib/outside.ts). An exact name listed there may lead into the operator's own network.
  const ruled = webhookRefusal(host);
  if (ruled) throw new Error(ruled);
  const listedPrivate = webhookMayBePrivate(host);
  // A name server that never answers must not hold a delivery up for longer than a server that never answers.
  const slow = () => new Promise<never>((_, no) => setTimeout(no, TIMEOUT_MS).unref());
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await Promise.race([dns.lookup(host, { all: true }), slow()]).catch(() => []);
  if (!addrs.length || (!open && !listedPrivate && addrs.some((a) => isPrivate(a.address)))) throw new Error(REFUSED);
  return { url: u, addresses: addrs.map((a) => ({ address: a.address, family: a.family })) };
}
export async function assertPublicUrl(raw: string) {
  await resolvePublic(raw);
}

// POSTs to the addresses that were checked, not to whatever the name resolves to by now. The Host header and the
// TLS server name still carry the host name, so the receiving server and its certificate are the right ones.
// Redirects are not followed. Only the status is kept: the reply is read up to a limit and thrown away.
function post(t: Target, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const lookup = (_host: string, opts: any, cb: any) => (opts?.all ? cb(null, t.addresses) : cb(null, t.addresses[0].address, t.addresses[0].family));
    const req = (t.url.protocol === 'https:' ? https : http).request(t.url, { method: 'POST', agent: false, lookup, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
      let seen = 0;
      res.on('data', (chunk: Buffer) => {
        if ((seen += chunk.length) > MAX_REPLY_BYTES) req.destroy();
      });
      res.on('error', () => {}); // cutting a reply short is our own doing, not a failed delivery
      resolve(res.statusCode as number);
    });
    // One deadline for the whole exchange, so a server that answers a byte a minute cannot hold a connection open.
    const timer = setTimeout(() => req.destroy(new Error(`No answer within ${TIMEOUT_MS / 1000} seconds.`)), TIMEOUT_MS);
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}

// How a delivery is shown: pending while it is being tried, then delivered or failed. A row still marked as being
// tried long after the last try could have ended was cut short by a restart. It counts as failed and can be sent again.
export function deliveryView(d: any) {
  const cut = !d.done && Date.parse(d.at) < Date.now() - PENDING_MS;
  const state = !d.done && !cut ? 'pending' : d.done && d.status && d.status < 300 ? 'delivered' : 'failed';
  return {
    id: d.id, webhook_id: d.webhook_id, url: d.url, event: d.event, envelope_id: d.envelope_id, state, status: d.status,
    error: cut ? 'The server restarted before this delivery finished. Send it again.' : d.error, attempts: d.attempts, at: d.at,
    can_redeliver: state !== 'pending' && !!d.has_body,
  };
}

// Exported for the security record (seclog.ts), whose deliveries name no envelope (envelopeId null).
export async function deliver(hook: any, event: string, envelopeId: string | null, body: string) {
  // The row is written before the first try. An event that is in flight when the server stops is then still in the
  // log, and can be sent again from there.
  const rowId = Number(run('INSERT INTO webhook_deliveries (webhook_id, event, envelope_id, attempts, at, body, done) VALUES (?,?,?,0,?,?,0)', hook.id, event, envelopeId, now(), body).lastInsertRowid);
  // Keep the log useful but small: the content of the latest deliveries of THIS webhook is kept for sending again.
  // Counted per webhook, never by the row id, which every account shares.
  run('UPDATE webhook_deliveries SET body=NULL WHERE webhook_id=? AND body IS NOT NULL AND id NOT IN (SELECT id FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT ?)', hook.id, hook.id, KEEP_BODIES);
  let status: number | null = null;
  let error: string | null = null;
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      const target = await resolvePublic(hook.url);
      const ts = Math.floor(Date.now() / 1000);
      status = await post(target, {
        'content-type': 'application/json',
        'user-agent': 'GrowSigning-Webhook/1',
        'x-growsigning-event': event,
        'x-growsigning-timestamp': String(ts),
        'x-growsigning-signature': `sha256=${hmac(`${ts}.${body}`, hook.secret)}`,
      }, body);
      error = null;
      if (status < 300) break;
    } catch (e: any) {
      status = null;
      error = String(e?.message || e).slice(0, 300);
    }
    run('UPDATE webhook_deliveries SET status=?, error=?, attempts=? WHERE id=?', status, error, attempts, rowId);
    if (attempts < 3) await new Promise((r) => setTimeout(r, attempts * 2000));
  }
  run('UPDATE webhook_deliveries SET status=?, error=?, attempts=?, done=1 WHERE id=?', status, error, attempts, rowId);
  // Three failures in a row and nobody told: that is how integrations break silently. Email the admins, once a day at most.
  const ok = status !== null && status < 300;
  if (!ok) {
    const last = all('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND done=1 ORDER BY id DESC LIMIT 3', hook.id);
    const fresh = get('SELECT alerted_at FROM webhooks WHERE id=?', hook.id);
    if (last.length === 3 && last.every((d) => !d.status || d.status >= 300) && (!fresh?.alerted_at || Date.parse(fresh.alerted_at) < Date.now() - 864e5)) {
      run('UPDATE webhooks SET alerted_at=? WHERE id=?', now(), hook.id);
      for (const u of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", hook.account_id))
        void sendMail({ to: u.email, subject: 'A GrowSigning webhook keeps failing', heading: 'Your webhook is not receiving events',
          lines: [`The last three deliveries to ${hook.url} failed (${error || `HTTP ${status}`}).`,
            `The latest ${KEEP_BODIES} events for this webhook are kept in full in the delivery log. Once your side is fixed, you can send each of them again from Settings, API and webhooks.`,
            'Older events stay listed, but can no longer be sent again. The sooner this is fixed, the less there is to catch up on by hand.'],
          cta: { label: 'Open the delivery log', url: `${baseUrl()}/app/settings?tab=developers` } }).catch(() => {});
    }
  }
}

// Send a past delivery again, exactly as it was, after fixing whatever made it fail.
export function redeliver(webhookId: string, event: string, envelopeId: string | null, body: string) {
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
  // The envelope's custom fields and each document's own name and value pairs go with it (customfields.ts).
  const body = JSON.stringify({ id: id('evt'), event, created_at: now(), envelope: e && { ...e, ...webhookCustom(envelopeId) }, ...extra, text: `${e?.subject || 'Envelope'}: ${event.replace('.', ' ')}` });
  for (const h of hooks) void deliver(h, event, envelopeId, body).catch(() => {});
}
