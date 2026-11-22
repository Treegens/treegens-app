import { run, get, all } from './db.ts';
import { now, hmac } from './util.ts';
import { smsProvider, maskPhone } from '../lib/checks.ts';
import { smsDailyPerAccount } from '../lib/policy.ts';
import { textParts, plainSigns } from '../lib/smsparts.ts';

// Text messages. Built like mail.ts on purpose: every text is recorded, the answer says what really became of it,
// and one the provider would not take is tried again by the timer and never called sent. Two things differ, because
// a text costs money and a phone number is more private than an email address: every new text is counted against a
// daily limit for its account, and the number is kept on the row only until the provider has taken the text.

export type Text = {
  to: string; // international form, see normalPhone()
  text: string;
  accountId: string;
  envelopeId?: string;
  recipientId?: string;
  kind: 'code' | 'link' | 'reminder';
  expiresAt?: string; // when a code in it stops working. It is never sent again after that.
};

/** The provider took it, there is no provider on this machine (it sits in the dev outbox), or the provider would not take it. */
export type TextStatus = 'sent' | 'outbox' | 'failed';

/** How texts leave this server, or null when its operator has not switched them on. */
export const smsMode = () => smsProvider();

// A phone number as a keyed fingerprint: the same number always gives the same value, and the value says nothing
// about the number. The limits on one number are counted with it, so no table but recipients holds a number.
export const phoneKey = (phone: string): string => hmac(`tel:${phone}`).slice(0, 32);

const g = globalThis as any;

// ---- Handing a text to the provider ------------------------------------------------------------------

// The provider said no for good: a number that does not exist, a number whose owner opted out. Trying again would
// only cost money, so nobody does, and whoever listens is told at once.
class Refused extends Error {}
const refusedFor = (status: number) => status >= 400 && status < 500 && ![401, 403, 404, 408, 409, 425, 429].includes(status);
const short = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

async function hand(to: string, text: string): Promise<string | null> {
  const env = process.env;
  const mode = smsProvider();
  const signal = AbortSignal.timeout(15_000);
  if (mode === 'twilio') {
    const sid = env.TWILIO_ACCOUNT_SID!.trim();
    const p = new URLSearchParams({ To: to, Body: text });
    // A messaging service picks the sending number itself (and handles opt-outs), so it wins when both are set.
    if ((env.TWILIO_MESSAGING_SERVICE_SID || '').trim()) p.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID!.trim());
    else p.set('From', env.TWILIO_FROM!.trim());
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST', signal, body: p.toString(),
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN!.trim()}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    const out: any = await res.json().catch(() => ({}));
    if (res.ok) return out?.sid ? String(out.sid) : null;
    if (res.status === 401 || res.status === 403) console.error('[sms] Twilio refused our credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN. No text message leaves until they are right.');
    throw new (refusedFor(res.status) ? Refused : Error)(`The text message provider answered ${res.status}${out?.message ? `: ${short(out.message).replace(/[.\s]+$/, '')}` : ''}${out?.code ? ` (its code ${short(out.code)})` : ''}`);
  }
  if (mode === 'hook') {
    const token = (env.SMS_WEBHOOK_TOKEN || '').trim();
    const res = await fetch(env.SMS_WEBHOOK_URL!.trim(), {
      method: 'POST', signal, body: JSON.stringify({ to, text }),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    const said = await res.text().catch(() => '');
    if (res.ok) {
      try {
        const id = JSON.parse(said)?.id;
        return id == null ? null : String(id).slice(0, 100);
      } catch {
        return null;
      }
    }
    if (res.status === 401 || res.status === 403) console.error('[sms] The address in SMS_WEBHOOK_URL refused our request. Check SMS_WEBHOOK_TOKEN. No text message leaves until it is right.');
    throw new (refusedFor(res.status) ? Refused : Error)(`The text message provider answered ${res.status}${said ? `: ${short(said).replace(/[.\s]+$/, '')}` : ''}`);
  }
  throw new Error('Text messages are switched off on this server.');
}

// ---- Sending, and trying again -----------------------------------------------------------------------

/** Minutes to wait before each further try: the same gaps as for email (see MAIL_RETRY_MINUTES). */
export const TEXT_RETRY_MINUTES = [5, 30, 120, 360, 1440];
const TEXT_MAX_AGE_MS = 2 * 864e5;
const TEXT_STUCK_MS = 15 * 60_000;
// What is left in the body of a text that carried a code, once nobody has to send it any more.
const CODE_GONE = 'A one-time code. The text itself was removed from our record once it no longer had to be sent.';

/** 'delayed': the first try failed and more follow. 'sent': a later try went through. 'gave_up': no more tries. */
export type TextOutcome = 'delayed' | 'sent' | 'gave_up';
type TextListener = (text: any, what: TextOutcome) => void | Promise<void>;
// Kept on globalThis under a name, so a module that is loaded twice (a dev server reloading) listens once.
const listeners: Record<string, TextListener> = (g.__tssmsListeners ??= {});
/** Lets the code that owns a text's subject matter (an envelope) record what became of it. */
export const onTextOutcome = (name: string, fn: TextListener) => void (listeners[name] = fn);
async function tell(id: number | bigint, what: TextOutcome) {
  const text = get('SELECT id, account_id, envelope_id, recipient_id, kind, to_masked, status, error, tries, at FROM texts WHERE id=?', id);
  for (const fn of Object.values(listeners)) {
    try {
      await fn(text, what);
    } catch (e: any) {
      console.error('[sms] could not record what happened to a text', e?.message);
    }
  }
}

// One try at handing a recorded text to the provider. `again` is a try made by the timer.
async function deliver(id: number | bigint, again = false): Promise<TextStatus> {
  const row = get('SELECT * FROM texts WHERE id=?', id);
  const mode = smsProvider();
  // Once a text no longer has to be handed over, the number goes from the row and so does a code.
  const done = `to_phone=NULL${row.kind === 'code' ? ', body=?' : ''}`;
  const gone = row.kind === 'code' ? [CODE_GONE] : [];
  if (mode === 'outbox') {
    // A machine without a provider, in development or in a test: the text stays readable in the outbox and nobody
    // receives it. The number is not needed any more. The body is kept, code and all, because reading it there is
    // the only way to try the flow.
    run("UPDATE texts SET status='outbox', to_phone=NULL, tried_at=? WHERE id=?", now(), id);
    return 'outbox';
  }
  try {
    if (!mode || !row.to_phone) throw new Refused(!mode ? 'Text messages were switched off on this server before this one could be sent' : 'The number was no longer on record');
    const pid = await hand(row.to_phone, row.body);
    run(`UPDATE texts SET status='sent', error=NULL, tries=tries+1, tried_at=?, next_try_at=NULL, provider_id=?, ${done} WHERE id=?`, now(), pid, ...gone, id);
    if (again) await tell(id, 'sent');
    return 'sent';
  } catch (e: any) {
    const tries = row.tries + 1;
    const wait = e instanceof Refused ? undefined : TEXT_RETRY_MINUTES[tries - 1];
    // Providers like to repeat the number in what they answer. The record only ever shows it masked.
    const digits = String(row.to_phone || '').replace(/\D/g, '');
    const said = short(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'The text message provider did not answer in time' : e?.message || e)
      .split(row.to_phone || '\u0000').join(row.to_masked).split(digits || '\u0000').join(row.to_masked);
    run(`UPDATE texts SET status='failed', error=?, tries=?, tried_at=?, next_try_at=?${wait ? '' : `, ${done}`} WHERE id=?`,
      said, tries, now(), wait ? new Date(Date.now() + wait * 60_000).toISOString() : null, ...(wait ? [] : gone), id);
    console.error('[sms] failed', row.to_masked, said);
    if (!wait) await tell(id, 'gave_up');
    else if (tries === 1) await tell(id, 'delayed');
    return 'failed';
  }
}

/**
 * Records a text and makes one try at sending it. Every new text counts against its account's daily limit, whatever
 * becomes of it (a try made again by the timer does not count twice). Callers ask textsLeft() first.
 */
export async function sendText(t: Text): Promise<{ status: TextStatus; id: number }> {
  const key = phoneKey(t.to);
  // A provider bills every part, and the daily limit counts them: see src/lib/smsparts.ts. A curly quote or a long
  // dash is made plain first, so it does not turn a 1 or 2 part text into 3 or 4.
  const text = plainSigns(t.text);
  const { parts } = textParts(text);
  const r = run('INSERT INTO texts (account_id, envelope_id, recipient_id, kind, to_phone, to_masked, dest_hash, body, status, at, expires_at, provider, parts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    t.accountId, t.envelopeId ?? null, t.recipientId ?? null, t.kind, t.to, maskPhone(t.to), key, text, 'queued', now(), t.expiresAt ?? null, smsProvider(), parts);
  run('DELETE FROM sms_usage WHERE account_id=? AND at < ?', t.accountId, new Date(Date.now() - 2 * 864e5).toISOString());
  run('INSERT INTO sms_usage (account_id, kind, dest_hash, at, parts) VALUES (?,?,?,?,?)', t.accountId, t.kind, key, now(), parts);
  const id = Number(r.lastInsertRowid);
  return { status: await deliver(id), id };
}

// ---- The daily limit -----------------------------------------------------------------------------------

const dayAgo = () => new Date(Date.now() - 864e5).toISOString();

/** How many more text message parts this account can cause in the 24 hours that end now (a long or non-Latin text is several). */
export const textsLeft = (accountId: string): number => smsDailyPerAccount() - get('SELECT COALESCE(SUM(parts), 0) n FROM sms_usage WHERE account_id=? AND at > ?', accountId, dayAgo()).n;

/** The fingerprints of the numbers this account has texted in the last 24 hours. */
export const numbersToday = (accountId: string): Set<string> => new Set(all('SELECT DISTINCT dest_hash h FROM sms_usage WHERE account_id=? AND at > ?', accountId, dayAgo()).map((x) => x.h));

/** How many texts with a link or a reminder went to this number from this account in the last 24 hours. */
export const linkTextsToday = (accountId: string, phone: string): number =>
  get("SELECT COUNT(*) n FROM sms_usage WHERE account_id=? AND dest_hash=? AND kind!='code' AND at > ?", accountId, phoneKey(phone), dayAgo()).n;

/** In about how many hours the daily limit has room again: when the oldest of today's texts is a day old. */
export function textsRoomInHours(accountId: string): number {
  const oldest = get('SELECT MIN(at) at FROM sms_usage WHERE account_id=? AND at > ?', accountId, dayAgo())?.at;
  return oldest ? Math.max(1, Math.ceil((Date.parse(oldest) + 864e5 - Date.now()) / 3600_000)) : 1;
}

// ---- The timer ---------------------------------------------------------------------------------------------

// A text that waited for another try is decided again at the moment it is tried, by everything that applies then,
// exactly as a first try is: the number on file now, a "not my number", a report, a decline, the pause, the daily
// limits. What applies is known to the code that owns what the text is about (an envelope: see signercode.ts), so
// that code says it here. It also tells the sender where they need to hear it, so a refusal here is quiet.
type RetryGuard = (text: any) => Promise<string | null> | string | null;
const guards: Record<string, RetryGuard> = (g.__tssmsGuards ??= {});
/** Lets the code that owns a text's subject matter decide, at the moment of every later try, whether it may still go. */
export const onTextRetry = (name: string, fn: RetryGuard) => void (guards[name] = fn);
async function askAgain(row: any): Promise<{ why: string; quiet: boolean } | null> {
  for (const fn of Object.values(guards)) {
    try {
      const why = await fn(row);
      if (why) return { why: `Not sent again: ${why}.`, quiet: true };
    } catch (e: any) {
      // A text that should not have gone cannot be called back, so one we could not decide about is not sent.
      console.error('[sms] could not decide whether a text may still go', e?.message);
      return { why: 'Not sent again: we could not check whether it may still go.', quiet: false };
    }
  }
  return null;
}

// Why a text that is waiting for another try must not go out any more, or null when it may.
function tooLate(row: any): { why: string; quiet: boolean } | null {
  // A code that has run out, or that a newer code has replaced, would only confuse whoever gets it.
  if (row.expires_at && row.expires_at <= now()) return { why: 'Not sent again: the code in it no longer worked by then.', quiet: true };
  // A signing link is only worth texting while it still opens the document.
  const signing = /\/sign\/([\w-]+)/.exec(row.body || '')?.[1];
  if (signing && get('SELECT e.status FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.token=?', signing)?.status !== 'sent')
    return { why: 'Not sent again: its link no longer opens a document that is waiting.', quiet: true };
  if (Date.now() - Date.parse(row.at) > TEXT_MAX_AGE_MS) return { why: 'Not sent again: it would have arrived more than two days late.', quiet: false };
  return null;
}

/**
 * Called by the timer (see cron.ts), like retryMail(). Tries every text again whose next try is due, and picks up
 * texts that were left 'queued' because the process stopped while sending them. Returns what it did.
 */
export async function retryTexts(): Promise<{ sent: number; failed: number; dropped: number }> {
  const out = { sent: 0, failed: 0, dropped: 0 };
  const t = now(), stuck = new Date(Date.now() - TEXT_STUCK_MS).toISOString();
  const isDue = "((status='failed' AND next_try_at IS NOT NULL AND next_try_at <= ?) OR (status='queued' AND COALESCE(tried_at, at) < ?))";
  for (const { id } of all(`SELECT id FROM texts WHERE ${isDue} ORDER BY id LIMIT 200`, t, stuck)) {
    // The timer can run twice at once. Each text is claimed by one statement before it is tried, so nobody gets it twice.
    const lease = new Date(Date.now() + TEXT_STUCK_MS).toISOString();
    if (!run(`UPDATE texts SET tried_at=?, next_try_at=CASE WHEN status='failed' THEN ? ELSE next_try_at END WHERE id=? AND ${isDue}`, t, lease, id, t, stuck).changes) continue;
    const row = get('SELECT * FROM texts WHERE id=?', id);
    const no = tooLate(row) || (await askAgain(row));
    if (no) {
      run(`UPDATE texts SET status='failed', next_try_at=NULL, to_phone=NULL, error=COALESCE(error || ' ', '') || ?${row.kind === 'code' ? ', body=?' : ''} WHERE id=?`, no.why, ...(row.kind === 'code' ? [CODE_GONE] : []), id);
      if (!no.quiet) await tell(id, 'gave_up');
      out.dropped++;
      continue;
    }
    const how = await deliver(id, true);
    if (how === 'sent') out.sent++;
    else if (how === 'failed') out.failed++;
  }
  return out;
}

/** A newer code makes every earlier text with a code for the same person pointless: none of them is tried again. */
export function dropCodeTexts(recipientId: string) {
  run("UPDATE texts SET expires_at=? WHERE recipient_id=? AND kind='code' AND (status='queued' OR (status='failed' AND next_try_at IS NOT NULL))", now(), recipientId);
}

/**
 * Every text to this person that still waits for a try, of any kind, is not sent at all: the number, the check or
 * the person changed, or someone said the number is not theirs. `why` finishes "Not sent again: ...".
 */
export function dropTexts(recipientId: string, why: string) {
  run(`UPDATE texts SET status='failed', next_try_at=NULL, to_phone=NULL, error=COALESCE(error || ' ', '') || ?, body=CASE WHEN kind='code' THEN ? ELSE body END
    WHERE recipient_id=? AND (status='queued' OR (status='failed' AND next_try_at IS NOT NULL))`, `Not sent again: ${why}.`, CODE_GONE, recipientId);
}
