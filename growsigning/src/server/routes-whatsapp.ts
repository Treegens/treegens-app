import { route, json } from './router.ts';
import { bad, rateLimit, baseUrl } from './util.ts';
import { refuse } from './signlang.ts';
import { find } from './routes-sign.ts';
import { requestCode } from './signercode.ts';
import { WHATSAPP_OFFERED } from '../lib/channels.ts';
import { metaSignatureOk, twilioSignatureOk, waReply, waStatus } from './whatsapp.ts';

// Two ways to reach people beyond email (whatsapp.ts, voice.ts): what WhatsApp tells us back, and "Call me with
// the code" on the signing page.

// Meta checks the address once when the operator sets up the webhook: it sends the token the operator chose
// (WHATSAPP_VERIFY_TOKEN) and expects the challenge back. Without that setting nothing is answered.
// While WHATSAPP_OFFERED is false (no account gets WhatsApp) both addresses answer 404 to everyone, whatever is set.
const asleep = () => {
  if (!WHATSAPP_OFFERED) throw bad('Not found.', 404);
};

route('GET', '/whatsapp/webhook', (c) => {
  asleep();
  const want = (process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
  if (!want || c.q.get('hub.mode') !== 'subscribe' || c.q.get('hub.verify_token') !== want) throw bad('This address only answers WhatsApp, with the token set in WHATSAPP_VERIFY_TOKEN.', 403);
  return new Response(String(c.q.get('hub.challenge') || ''), { status: 200, headers: { 'content-type': 'text/plain' } });
}, 'public');

// Replies (STOP, START) and delivery reports, from Meta (JSON, signed with WHATSAPP_APP_SECRET) or Twilio (a form,
// signed with TWILIO_AUTH_TOKEN). Anything not signed is refused and changes nothing.
route('POST', '/whatsapp/webhook', async (c) => {
  asleep();
  const raw = await c.req.text();
  const type = c.req.headers.get('content-type') || '';
  if (/application\/x-www-form-urlencoded/i.test(type)) {
    const form = new URLSearchParams(raw);
    if (!twilioSignatureOk(`${baseUrl()}/api/whatsapp/webhook`, form, c.req.headers.get('x-twilio-signature'))) throw bad('The signature does not match, so nothing was changed.', 403);
    const status = form.get('MessageStatus') || form.get('SmsStatus');
    if (form.get('Body') != null && /^whatsapp:/i.test(form.get('From') || '')) waReply(form.get('From')!, form.get('Body')!, form.get('OriginalRepliedMessageSid'));
    else if (status && form.get('MessageSid')) waStatus(form.get('MessageSid')!, status, form.get('ErrorMessage') || (form.get('ErrorCode') ? `Error ${form.get('ErrorCode')}` : undefined));
    return new Response('<Response/>', { status: 200, headers: { 'content-type': 'text/xml' } });
  }
  if (!metaSignatureOk(raw, c.req.headers.get('x-hub-signature-256'))) throw bad('The signature does not match, so nothing was changed.', 403);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw bad('Send a JSON body.');
  }
  for (const entry of body?.entry || [])
    for (const ch of entry?.changes || []) {
      const v = ch?.value || {};
      for (const m of v.messages || []) {
        const text = m?.text?.body ?? m?.button?.text ?? m?.button?.payload ?? m?.interactive?.button_reply?.title ?? '';
        if (m?.from) waReply(String(m.from), String(text), m?.context?.id ? String(m.context.id) : null);
      }
      for (const s of v.statuses || []) waStatus(String(s?.id || ''), String(s?.status || ''), s?.errors?.[0]?.title || s?.errors?.[0]?.message);
    }
  return json({ ok: true });
}, 'public');

// "Call me with the code": the code of a check by text message, read out on a call to the same number. Every rule
// of the code by text holds (signercode.ts requestCode): the access code first, one a minute, the hourly and daily
// limits, the account's limit on texts (a call counts as one), the pause, "not my number".
route('POST', '/sign/:token/code/call', async (c) => {
  const { e, r, locked, gate, actor } = find(c, false);
  if (locked) throw refuse('access_code_first', 401);
  if (!gate) return { sent: false, passed: true };
  rateLimit(`codecall:${r.id}`, 6, 3600_000);
  return requestCode(e, r, actor, 'call');
}, 'public');
