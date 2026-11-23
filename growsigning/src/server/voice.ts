import { run } from './db.ts';
import { now, esc } from './util.ts';
import { maskPhone } from '../lib/checks.ts';
import { voiceProvider } from '../lib/channels.ts';
import { phoneKey } from './sms.ts';

// A one-time code read out on a phone call ("Call me with the code" on the signing page), for a landline or for
// someone who cannot read a text. It is the code of the check by text message: the same digits, the same tries, the
// same limits and the same lock (signercode.ts requestCode decides all of that before it calls here). A call is
// counted against the account's daily limit on text messages, like one text. It is never tried again: a code
// that arrives late would only confuse, and the person can press the button again. Our record keeps the number
// masked and never the code, except on a machine with no provider (the outbox), where reading it is the only way
// to try the flow.

const short = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

/** What the call says: who it is from, then the code slowly, digit by digit, twice. */
export function callWords(code: string, sender: string): string {
  const digits = code.split('').join(', ');
  return `This is GrowSigning, with a code from ${sender}. Your code is: ${digits}. Again: ${digits}. Goodbye.`;
}

function twiml(code: string, sender: string): string {
  const say = (s: string) => `<Say language="en-GB">${esc(s)}</Say>`;
  const slow = code.split('').map((d) => `${say(d)}<Pause length="1"/>`).join('');
  return `<Response>${say(`This is GrowSigning, with a code from ${sender}.`)}<Pause length="1"/>${say('Your code is')}${slow}${say('Again.')}${slow}${say('Goodbye.')}</Response>`;
}

/** Places the call. 'sent': the provider took it. 'outbox': no provider here. 'failed': it would not. */
export async function callCode(t: { to: string; code: string; sender: string; accountId: string; envelopeId: string; recipientId: string }): Promise<'sent' | 'outbox' | 'failed'> {
  const mode = voiceProvider();
  const masked = maskPhone(t.to), key = phoneKey(t.to);
  // Counted like one text message against SMS_DAILY_PER_ACCOUNT, whatever becomes of it.
  run('INSERT INTO sms_usage (account_id, kind, dest_hash, at, parts) VALUES (?,?,?,?,1)', t.accountId, 'code', key, now());
  const record = (status: string, error: string | null, pid: string | null, said: string | null) =>
    run('INSERT INTO voice_calls (account_id, envelope_id, recipient_id, to_masked, dest_hash, status, error, at, provider, provider_id, said) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      t.accountId, t.envelopeId, t.recipientId, masked, key, status, error, now(), mode, pid, said);
  if (mode === 'outbox') {
    record('outbox', null, null, callWords(t.code, t.sender));
    return 'outbox';
  }
  if (mode !== 'twilio') {
    record('failed', 'Calls are switched off on this server', null, null);
    return 'failed';
  }
  const env = process.env;
  const sid = env.TWILIO_ACCOUNT_SID!.trim();
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ To: t.to, From: env.TWILIO_FROM!.trim(), Twiml: twiml(t.code, t.sender) }).toString(),
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN!.trim()}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    const out: any = await res.json().catch(() => ({}));
    if (res.ok) {
      record('sent', null, out?.sid ? String(out.sid) : null, null);
      return 'sent';
    }
    const digits = t.to.replace(/\D/g, '');
    record('failed', short(`The call provider answered ${res.status}${out?.message ? `: ${out.message}` : ''}`).split(t.to).join(masked).split(digits).join(masked), null, null);
  } catch (e: any) {
    record('failed', e?.name === 'TimeoutError' ? 'The call provider did not answer in time' : short(e?.message), null, null);
  }
  return 'failed';
}
