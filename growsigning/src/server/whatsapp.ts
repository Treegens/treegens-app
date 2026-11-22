import crypto from 'node:crypto';
import { run, get, all } from './db.ts';
import { now, bad, str, safeEqual, baseUrl } from './util.ts';
import { normalPhone, maskPhone, PHONE_HOW } from '../lib/checks.ts';
import { WHATSAPP_OFFERED, whatsappProvider, waDailyPerAccount, fillWa, WA_AGREE, isStopWord, isStartWord, waStatusWord } from '../lib/channels.ts';
import { LINK_TEXTS_PER_NUMBER_DAY } from '../lib/policy.ts';
import { phoneKey, TEXT_RETRY_MINUTES } from './sms.ts';
import { audit, emailRefusal, signUrl, senderOf, notifySender, loadEnvelope, type Actor } from './envelopes.ts';
import { forPerson } from './visibility.ts';
import { reporterKey } from './bysender.ts';

// The signing link by WhatsApp, for someone who lives in WhatsApp. Built like sms.ts on purpose: every message is
// recorded, the record says what really became of it ("Sent" when the provider took it, "Delivered to the phone"
// when the provider says so, and never "read", which proves nothing), one the provider would not take is tried
// again by the timer, the number stays on the row only until the provider has it, and every new message counts
// against a daily limit for its account. Only when the sender ticked that the person agreed, for that number, and
// never for a group, a public form, a copy, someone who signs in person, or together with the link by text message.
// A reply STOP (POST /whatsapp/webhook, routes-whatsapp.ts) stops WhatsApp from that account to that number.
// Nothing in here calls into envelopes.ts while this module is being loaded.
//
// Asleep: WHATSAPP_OFFERED (src/lib/channels.ts) is false, the owner's decision that no account gets WhatsApp. While
// it is, nothing here sends, retries, writes to the audit trail or emails a sender about WhatsApp, and every request
// that asks for it is refused with "code": "whatsapp_off". The code stays so the decision can be undone in one line.

export type WaKind = 'invite' | 'remind' | 'deadline' | 'done';
const SYSTEM: Actor = { name: 'System' };
const short = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
const clip = (s: any, max: number) => (String(s ?? '').length > max ? `${String(s).slice(0, max - 3).trimEnd()}...` : String(s ?? ''));
const dayAgo = () => new Date(Date.now() - 864e5).toISOString();
const iso = (ms: number) => new Date(ms).toISOString();

/** How WhatsApp messages leave this server, or null when its operator has not set it up. */
export const waMode = () => whatsappProvider();

/** Said by the API wherever WhatsApp is asked for. */
export const WA_OFF = 'GrowSigning does not send anything by WhatsApp, for any account, free or paid. The signing link goes by email.';
const WHAT: Record<WaKind, string> = { invite: 'the signing link by WhatsApp', remind: 'a reminder by WhatsApp', deadline: 'a closing-soon message by WhatsApp', done: 'the link to the completed document by WhatsApp' };

// ---- Handing a message to the provider ------------------------------------------------------------------

class Refused extends Error {}
const refusedFor = (status: number) => status >= 400 && status < 500 && ![401, 403, 404, 408, 409, 425, 429].includes(status);

/** The approved template the operator named for this kind of message (a closing-soon message falls back to the reminder). */
function templateFor(kind: WaKind): string {
  const env = process.env;
  const name = kind === 'invite' ? env.WHATSAPP_TEMPLATE_INVITE : kind === 'remind' ? env.WHATSAPP_TEMPLATE_REMIND : kind === 'done' ? env.WHATSAPP_TEMPLATE_DONE : env.WHATSAPP_TEMPLATE_DEADLINE || env.WHATSAPP_TEMPLATE_REMIND;
  return String(name || '').trim();
}

async function hand(row: any): Promise<string | null> {
  const env = process.env;
  const mode = whatsappProvider();
  const signal = AbortSignal.timeout(15_000);
  const v = JSON.parse(row.params || '{}');
  const tpl = templateFor(row.kind);
  if (mode === 'meta') {
    if (!tpl) throw new Refused(`no approved template is set for this kind of message, so WhatsApp would not deliver it (the operator sets WHATSAPP_TEMPLATE_${row.kind === 'invite' ? 'INVITE' : row.kind === 'done' ? 'DONE' : 'REMIND'})`);
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID!.trim())}/messages`, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN!.trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to: row.to_phone.replace(/\D/g, ''), type: 'template',
        template: { name: tpl, language: { code: (env.WHATSAPP_TEMPLATE_LANGUAGE || 'en').trim() }, components: [{ type: 'body', parameters: [v.sender, v.subject, v.link].map((text) => ({ type: 'text', text: String(text) })) }] },
      }),
    });
    const out: any = await res.json().catch(() => ({}));
    if (res.ok) return out?.messages?.[0]?.id ? String(out.messages[0].id) : null;
    if (res.status === 401 || res.status === 403) console.error('[whatsapp] Meta refused our token. Check WHATSAPP_TOKEN. No WhatsApp message leaves until it is right.');
    throw new (refusedFor(res.status) ? Refused : Error)(`The WhatsApp provider answered ${res.status}${out?.error?.message ? `: ${short(out.error.message).replace(/[.\s]+$/, '')}` : ''}${out?.error?.code ? ` (its code ${short(out.error.code)})` : ''}`);
  }
  if (mode === 'twilio') {
    const sid = env.TWILIO_ACCOUNT_SID!.trim();
    const from = env.TWILIO_WHATSAPP_FROM!.trim().replace(/^whatsapp:/i, '');
    const p = new URLSearchParams({ To: `whatsapp:${row.to_phone}`, From: `whatsapp:${from}`, StatusCallback: `${baseUrl()}/api/whatsapp/webhook` });
    // A Twilio content template (an id that starts with HX) fills the three blanks; otherwise the text itself goes,
    // which Twilio matches to the template the operator had approved.
    if (/^HX/.test(tpl)) (p.set('ContentSid', tpl), p.set('ContentVariables', JSON.stringify({ 1: v.sender, 2: v.subject, 3: v.link })));
    else p.set('Body', row.body);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST', signal, body: p.toString(),
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN!.trim()}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    const out: any = await res.json().catch(() => ({}));
    if (res.ok) return out?.sid ? String(out.sid) : null;
    throw new (refusedFor(res.status) ? Refused : Error)(`The WhatsApp provider answered ${res.status}${out?.message ? `: ${short(out.message).replace(/[.\s]+$/, '')}` : ''}${out?.code ? ` (its code ${short(out.code)})` : ''}`);
  }
  throw new Refused('WhatsApp is switched off on this server');
}

// ---- Sending, and trying again --------------------------------------------------------------------------

async function deliver(id: number, again = false): Promise<string> {
  const row = get('SELECT * FROM wa_messages WHERE id=?', id);
  const mode = whatsappProvider();
  if (mode === 'outbox') {
    run("UPDATE wa_messages SET status='outbox', to_phone=NULL, tried_at=? WHERE id=?", now(), id);
    return 'outbox';
  }
  try {
    if (!mode || !row.to_phone) throw new Refused(!mode ? 'WhatsApp was switched off on this server before this one could be sent' : 'The number was no longer on record');
    const pid = await hand(row);
    run("UPDATE wa_messages SET status='sent', error=NULL, tries=tries+1, tried_at=?, next_try_at=NULL, provider_id=?, to_phone=NULL WHERE id=?", now(), pid, id);
    if (row.recipient_id) run('UPDATE recipients SET wa_sent_to=? WHERE id=?', row.to_masked, row.recipient_id);
    if (row.envelope_id) audit(row.envelope_id, SYSTEM, again ? 'WhatsApp sent' : row.kind === 'invite' ? 'Signing link sent by WhatsApp' : 'WhatsApp sent', `${nameOf(row)}${WHAT[row.kind as WaKind]} to ${row.to_masked}${again ? `, on try ${row.tries + 1}` : ''}.`);
    return 'sent';
  } catch (e: any) {
    const tries = row.tries + 1;
    const wait = e instanceof Refused ? undefined : TEXT_RETRY_MINUTES[tries - 1];
    const digits = String(row.to_phone || '').replace(/\D/g, '');
    const said = short(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'The WhatsApp provider did not answer in time' : e?.message || e)
      .split(row.to_phone || '\u0000').join(row.to_masked).split(digits || '\u0000').join(row.to_masked);
    run(`UPDATE wa_messages SET status='failed', error=?, tries=?, tried_at=?, next_try_at=?${wait ? '' : ', to_phone=NULL'} WHERE id=?`, said, tries, now(), wait ? iso(Date.now() + wait * 60_000) : null, id);
    console.error('[whatsapp] failed', row.to_masked, said);
    if (row.envelope_id) {
      if (wait && tries === 1) audit(row.envelope_id, SYSTEM, 'WhatsApp could not be sent yet', `${nameOf(row)}${WHAT[row.kind as WaKind]} to ${row.to_masked}. What went wrong: ${said.replace(/[.\s]+$/, '')}. It is tried again automatically.`);
      if (!wait) await gaveUp(row, said, tries);
    }
    return 'failed';
  }
}
const nameOf = (row: any) => {
  const r = row.recipient_id ? get('SELECT name FROM recipients WHERE id=?', row.recipient_id) : null;
  return r?.name ? `${r.name}: ` : '';
};
async function gaveUp(row: any, said: string, tries: number) {
  const e = get('SELECT id, subject, account_id, sender_id FROM envelopes WHERE id=?', row.envelope_id);
  if (!e) return;
  const which = `${nameOf(row)}${WHAT[row.kind as WaKind]} to ${row.to_masked}`;
  audit(e.id, SYSTEM, 'WhatsApp could not be sent', `${which}${tries > 1 ? ` after ${tries} tries` : ''}. What went wrong: ${said.replace(/[.\s]+$/, '')}. No more tries are made.`);
  await notifySender(e, 'problems', `WhatsApp not delivered: ${e.subject}`, 'We could not send a WhatsApp message',
    [`${which[0].toUpperCase()}${which.slice(1)} could not be handed to the WhatsApp provider, so we have stopped trying. What went wrong: ${said.replace(/[.\s]+$/, '')}.`,
      'The email with the same link was sent separately and is not affected. Check the number: open the envelope and choose Change person in their More.']);
}

/** Records a message and makes one try. Every new message counts against its account's daily limit. Callers ask mayWa() first. */
export async function sendWa(t: { to: string; kind: WaKind; accountId: string; envelopeId?: string; recipientId?: string; params: { sender: string; subject: string; link: string } }) {
  const key = phoneKey(t.to);
  const body = fillWa(t.kind, t.params);
  const r = run('INSERT INTO wa_messages (account_id, envelope_id, recipient_id, kind, to_phone, to_masked, dest_hash, body, params, status, at, provider) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    t.accountId, t.envelopeId ?? null, t.recipientId ?? null, t.kind, t.to, maskPhone(t.to), key, body, JSON.stringify(t.params), 'queued', now(), whatsappProvider());
  run('DELETE FROM wa_usage WHERE account_id=? AND at < ?', t.accountId, iso(Date.now() - 2 * 864e5));
  run('INSERT INTO wa_usage (account_id, dest_hash, at) VALUES (?,?,?)', t.accountId, key, now());
  if (t.recipientId) run('UPDATE recipients SET wa_sent_at=? WHERE id=?', now(), t.recipientId);
  const id = Number(r.lastInsertRowid);
  return { status: await deliver(id), id };
}

/** How many more WhatsApp messages this account can cause in the 24 hours that end now. */
export const waLeft = (accountId: string): number => waDailyPerAccount() - get('SELECT COUNT(*) n FROM wa_usage WHERE account_id=? AND at > ?', accountId, dayAgo()).n;
const waToNumberToday = (accountId: string, key: string): number => get('SELECT COUNT(*) n FROM wa_usage WHERE account_id=? AND dest_hash=? AND at > ?', accountId, key, dayAgo()).n;
/** Whether this number replied STOP to a WhatsApp message from this account. */
export const waStopped = (accountId: string, phone: string | null) => !!phone && !!get('SELECT 1 x FROM wa_stops WHERE account_id=? AND dest_hash=?', accountId, phoneKey(phone));

const MAX_AGE_MS = 2 * 864e5;
/** Called by the timer (cron.ts), like retryTexts(). Each message is decided again by what applies now. */
export async function retryWhatsApp(): Promise<{ sent: number; failed: number; dropped: number }> {
  const out = { sent: 0, failed: 0, dropped: 0 };
  if (!WHATSAPP_OFFERED) return out;
  const t = now(), stuck = iso(Date.now() - 15 * 60_000);
  const isDue = "((status='failed' AND next_try_at IS NOT NULL AND next_try_at <= ?) OR (status='queued' AND COALESCE(tried_at, at) < ?))";
  for (const { id } of all(`SELECT id FROM wa_messages WHERE ${isDue} ORDER BY id LIMIT 200`, t, stuck)) {
    if (!run(`UPDATE wa_messages SET tried_at=?, next_try_at=CASE WHEN status='failed' THEN ? ELSE next_try_at END WHERE id=? AND ${isDue}`, t, iso(Date.now() + 15 * 60_000), id, t, stuck).changes) continue;
    const row = get('SELECT * FROM wa_messages WHERE id=?', id);
    const no = Date.now() - Date.parse(row.at) > MAX_AGE_MS ? 'it would have arrived more than two days late' : stillMay(row);
    if (no) {
      run("UPDATE wa_messages SET status='failed', next_try_at=NULL, to_phone=NULL, error=COALESCE(error || ' ', '') || ? WHERE id=?", `Not sent again: ${no}.`, id);
      out.dropped++;
      continue;
    }
    const how = await deliver(id, true);
    if (how === 'sent') out.sent++;
    else if (how === 'failed') out.failed++;
  }
  return out;
}
// Why a message waiting for another try must not go any more, or null.
function stillMay(row: any): string | null {
  if (!row.envelope_id || !row.recipient_id) return null;
  const e = get('SELECT * FROM envelopes WHERE id=?', row.envelope_id);
  const r = get('SELECT * FROM recipients WHERE id=?', row.recipient_id);
  if (!e || !r) return 'the person or the document it was about is no longer there';
  const phone = normalPhone(r.phone);
  if (!r.wa_link || !phone || phoneKey(phone) !== row.dest_hash || r.wa_agreed_for !== row.dest_hash) return 'the number or the choice of WhatsApp changed after it was written';
  if (!String(row.body).includes(`/sign/${r.token}`)) return 'the link in it was replaced';
  if (waStopped(e.account_id, phone)) return 'they replied STOP';
  if (row.kind === 'done' ? e.status !== 'completed' : e.status !== 'sent' || !['sent', 'viewed'].includes(r.status)) return 'what it was about has changed';
  return emailRefusal(e)?.status === 403 ? 'sending is paused on this account' : null;
}

// ---- Who may get WhatsApp, and when ---------------------------------------------------------------------

const reported = (e: any, r: any) => !!get('SELECT 1 x FROM abuse_reports WHERE envelope_id=? AND lower(reporter)=lower(?)', e.id, reporterKey(r));

// Why a WhatsApp message must not go to this person right now, or null. Asked at the moment of every message.
function mayWa(e: any, r: any, phone: string): string | null {
  if (!whatsappProvider()) return 'WhatsApp is switched off on this server';
  if (r.wa_agreed_for !== phoneKey(phone)) return 'the sender has not said that this person agreed to get messages about this by WhatsApp at this number';
  if (waStopped(e.account_id, phone)) return 'they replied STOP to an earlier WhatsApp message from this account';
  if (reported(e, r)) return 'someone using their signing link reported this document as suspicious';
  const guard = emailRefusal(e);
  if (guard && guard.status !== 429) return guard.status === 403 ? 'sending is paused on this account' : 'the envelope reads like a fake payment notice, or goes out under a name that reads like a well-known brand';
  if (waLeft(e.account_id) < 1) return `the account has sent as many WhatsApp messages as this server allows in a day (${waDailyPerAccount()})`;
  if (waToNumberToday(e.account_id, phoneKey(phone)) >= LINK_TEXTS_PER_NUMBER_DAY) return `${LINK_TEXTS_PER_NUMBER_DAY} WhatsApp messages have gone to this number from this account in the last 24 hours, which is the most we send to one number`;
  return null;
}

async function waHeld(e: any, r: any, kind: WaKind, why: string) {
  const detail = `${r.name}: ${WHAT[kind]} to ${maskPhone(r.phone)} was not sent, because ${why}.`;
  if (get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='WhatsApp not sent' AND detail=? AND at > ?", e.id, detail, dayAgo())) return;
  audit(e.id, SYSTEM, 'WhatsApp not sent', detail);
  await notifySender(e, 'problems', `WhatsApp not sent: ${e.subject}`, `We did not send ${r.name} a WhatsApp message`,
    [`${WHAT[kind][0].toUpperCase()}${WHAT[kind].slice(1)} to ${maskPhone(r.phone)} was not sent, because ${why}.`, 'The email with the same link was not affected. You can also copy their signing link from the envelope page and send it yourself.']);
}

async function waFor(e: any, rid: string, kind: WaKind): Promise<void> {
  if (!WHATSAPP_OFFERED) return;
  const cur = get('SELECT * FROM recipients WHERE id=?', rid);
  const phone = normalPhone(cur?.phone);
  if (!cur || !cur.wa_link || !phone || !cur.token || cur.status === 'declined' || cur.role === 'inperson' || cur.role === 'cc' || cur.group_id) return;
  if (kind === 'remind' && (cur.muted || (cur.wa_sent_at && Date.now() - Date.parse(cur.wa_sent_at) < 864e5))) return;
  const no = mayWa(e, cur, phone);
  if (no) return void (await waHeld(e, cur, kind, no));
  const sender = senderOf(e);
  const { status } = await sendWa({ to: phone, kind, accountId: e.account_id, envelopeId: e.id, recipientId: cur.id,
    params: { sender: clip(sender?.name || 'the sender', 40), subject: `"${clip(e.subject, 60)}"`, link: signUrl(cur) } });
  if (status === 'outbox') audit(e.id, SYSTEM, 'Not sent by WhatsApp', `${cur.name}, to ${maskPhone(phone)}. This machine has no WhatsApp provider, so the message was only written to the outbox.`);
}

/**
 * Called by notifyRecipient() in envelopes.ts after the email about a document was written: the same news by
 * WhatsApp, for a recipient the sender chose that for. A new request, a request to sign again and a reopened
 * envelope send the invitation; a reminder (at most once a day) the reminder; "expires soon" the closing-soon
 * message. It never throws: a message that cannot go is written down, and the email has gone already.
 */
export async function alsoWhatsApp(e: any, r: any, kind: string): Promise<void> {
  try {
    const k: WaKind | null = ['new', 'again', 'reopened'].includes(kind) ? 'invite' : kind === 'reminder' ? 'remind' : kind === 'expiring' ? 'deadline' : null;
    if (!k || !r?.wa_link) return;
    await waFor(e, r.id, k);
  } catch (err: any) {
    console.error('[whatsapp] could not send a signing link', err?.message);
  }
}

/** Called once the document is complete, for each person whose copy email was written: the link to it, never the PDF. */
export async function waCompleted(e: any, r: any): Promise<void> {
  try {
    if (!r?.wa_link) return;
    const fresh = get('SELECT * FROM envelopes WHERE id=?', e.id);
    if (fresh?.status !== 'completed') return;
    // Their own subject, never the name of a file they were not shown (visibility.ts).
    await waFor(forPerson(loadEnvelope(e.id), r.id), r.id, 'done');
  } catch (err: any) {
    console.error('[whatsapp] could not send the completed link', err?.message);
  }
}

// ---- Saving the choice -----------------------------------------------------------------------------------

// Why this person cannot get the link by WhatsApp as they stand, or null.
function waProblem(r: any, e: any, strict: boolean): string | null {
  const name = r.name || r.role_name || 'One of the recipients';
  if (e.kind === 'template') return `WhatsApp is chosen for one person on one envelope, because that person has to agree to it first. A template cannot send by WhatsApp, and so neither can a bulk send or a public form. Switch WhatsApp off for ${name} in the template.`;
  if (!whatsappProvider()) return `${WA_OFF} Switch WhatsApp off for ${name}.`;
  if (r.group_id) return `${name} is a group, and WhatsApp goes to one person who agreed to it. Switch WhatsApp off for the group.`;
  if (r.role === 'cc') return `${name} only gets a copy, which goes by email. Switch WhatsApp off for them.`;
  if (r.role === 'inperson') return `${name} signs in person on your device, so there is no link to send them. Switch WhatsApp off for them.`;
  if (r.link_by_sender) return `You send ${name} their link yourself, so we send them nothing by WhatsApp either. Choose one of the two.`;
  if (e.powerform_id && e.form_recipient_id === r.id) return 'The visitor of a public form types their own details, so they are never sent anything by WhatsApp.';
  if (r.text_link) return `For ${name} both the link by text message and the link by WhatsApp are on. Choose one of the two.`;
  const phone = normalPhone(r.phone);
  if (!phone) return r.phone || strict ? `"${str(r.phone, 40)}", the mobile number of ${name}, is not a full international number. ${PHONE_HOW}` : `${name} gets the link by WhatsApp, so they need a mobile number. ${PHONE_HOW}`;
  if (r.wa_agreed_for !== phoneKey(phone)) return `Tick "${WA_AGREE}" for ${name}, for the number ${maskPhone(phone)}. We only send WhatsApp messages to someone who agreed to get them.`;
  return null;
}

const samePhone = (a: any, b: any) => (normalPhone(a) || '') === (normalPhone(b) || '');
/** Whether this row is no longer the person, at the number, that the WhatsApp tick and messages were for. */
export const waMoved = (old: any, cur: any) => !!old && !!cur && (!samePhone(old.phone, cur.phone)
  || String(old.email || '').trim().toLowerCase() !== String(cur.email || '').trim().toLowerCase() || (Number(old.person_gen) || 0) !== (Number(cur.person_gen) || 0));

/**
 * WhatsApp ends for this person: the choice, the tick and the line on the certificate ("Link sent by email and by
 * WhatsApp to ..."), which would otherwise name a message that went to someone else. The audit trail keeps what was
 * sent. Called when the person or their number changes: a reassign (passCheckOn), Change person, a correction.
 */
export function waEnds(e: any, rid: string, why: string, actor: Actor = SYSTEM) {
  const row = get('SELECT id, name, wa_link, wa_agreed_for, wa_sent_to FROM recipients WHERE id=?', rid);
  if (!row || (!row.wa_link && !row.wa_agreed_for && !row.wa_sent_to)) return;
  run('UPDATE recipients SET wa_link=0, wa_agreed_at=NULL, wa_agreed_for=NULL, wa_sent_to=NULL WHERE id=?', rid);
  if (row.wa_link && WHATSAPP_OFFERED) audit(e.id, actor, 'WhatsApp switched off', `${row.name}: the signing link is no longer sent by WhatsApp, because ${why}. Email is not affected.`);
}

/**
 * Change person (POST /envelopes/:id/correct), before anything is changed. "whatsapp": false switches WhatsApp off
 * for them; switching it on needs the tick for a number, which the editor's correction takes (PUT /envelopes/:id).
 * The link by text message is refused while WhatsApp stays on, because the two are never on together.
 */
export function assertWaCorrection(e: any, rid: string, b: any) {
  const r = e?.recipients?.find((x: any) => x.id === rid);
  if (!r) return;
  const on = b?.whatsapp === true || b?.whatsapp === 1 || b?.whatsapp === 'true';
  if (!WHATSAPP_OFFERED && (on || b?.whatsapp_agreed === true)) throw bad(`${WA_OFF} Nothing was changed.`, 400, { code: 'whatsapp_off' });
  if (on || b?.whatsapp_agreed !== undefined)
    throw bad(`WhatsApp is switched on with the tick that ${r.name || 'the person'} agreed, for their number, and Change person does not take that. Nothing was changed. Use the envelope's correction instead (PUT /envelopes/:id with "whatsapp" and "whatsapp_agreed"). Here, only "whatsapp": false is taken.`, 400, { code: 'whatsapp_correct' });
  const off = b?.whatsapp === false || b?.whatsapp === 0 || b?.whatsapp === 'false';
  const textOn = b?.text_link === true || b?.text_link === 1 || b?.text_link === 'true';
  if (WHATSAPP_OFFERED && r.wa_link && textOn && !off)
    throw bad(`${r.name || 'This person'} gets the link by WhatsApp, and the link by text message and by WhatsApp are never on together. Nothing was changed. Send "whatsapp": false in the same call to text it instead.`, 400, { code: 'whatsapp_and_text' });
}

/**
 * Change person around `fix` (the correction itself). Nothing goes by WhatsApp while it runs, so the new email to
 * another person never brings a WhatsApp message to the number typed for the one before. Afterwards WhatsApp ends
 * when the sender asked ("whatsapp": false) or when it is now another person or another number, and is otherwise
 * kept as it was. A refused correction leaves it as it was.
 */
export async function correctWithWa(e: any, rid: string, b: any, actor: Actor, fix: () => Promise<void>) {
  assertWaCorrection(e, rid, b);
  const old = get('SELECT * FROM recipients WHERE id=? AND envelope_id=?', rid, e?.id);
  const had = old && (old.wa_link || old.wa_sent_to || old.wa_agreed_for) ? old : null;
  if (had?.wa_link) run('UPDATE recipients SET wa_link=0 WHERE id=?', rid);
  const restore = () => had && run('UPDATE recipients SET wa_link=? WHERE id=?', had.wa_link, rid);
  try {
    await fix();
  } catch (err) {
    restore();
    throw err;
  }
  if (!had) return;
  restore();
  const off = b?.whatsapp === false || b?.whatsapp === 0 || b?.whatsapp === 'false';
  if (off) return waEnds(e, rid, 'the sender switched it off', actor);
  if (waMoved(had, get('SELECT * FROM recipients WHERE id=?', rid))) waEnds(e, rid, 'the person or their number changed, and they agreed to WhatsApp for the one before', actor);
}

/**
 * Called by writeContent() in envelopes.ts after saveChecks, inside its transaction. Reads "whatsapp" (true or
 * false) and "whatsapp_agreed" (the sender's tick) of every recipient in the request. Leaving them out keeps what
 * the person has. A tick holds for the number on file when it is saved; another number needs it again.
 */
export function saveWhatsApp(e: any, asked: { rid: string; r: any; i: number }[], before: Map<string, any>, correcting: boolean) {
  for (const { rid, r } of asked) {
    const old = before.get(rid);
    // On an envelope that is out, another person or another number ends what was agreed and sent for the old one.
    // Without a new choice in the request WhatsApp goes off; with one, the line on the certificate starts again.
    if (correcting && old && waMoved(old, get('SELECT * FROM recipients WHERE id=?', rid))) {
      if (r?.whatsapp === undefined && r?.whatsapp_agreed === undefined) {
        waEnds(e, rid, 'the person or their number changed, and they agreed to WhatsApp for the one before');
        continue;
      }
      run('UPDATE recipients SET wa_sent_to=NULL WHERE id=?', rid);
    }
    if (r?.whatsapp === undefined && r?.whatsapp_agreed === undefined) continue;
    const row = get('SELECT * FROM recipients WHERE id=?', rid);
    if (!row) continue;
    const on = r.whatsapp === undefined ? !!row.wa_link : r.whatsapp === true || r.whatsapp === 1 || r.whatsapp === 'true';
    if (!on) {
      run('UPDATE recipients SET wa_link=0, wa_agreed_at=NULL, wa_agreed_for=NULL WHERE id=?', rid);
      if (WHATSAPP_OFFERED && old?.wa_link && e.status !== 'draft') audit(e.id, SYSTEM, 'WhatsApp switched off', `${row.name}: the signing link is no longer sent by WhatsApp.`);
      continue;
    }
    if (!WHATSAPP_OFFERED) throw bad(`${WA_OFF} Nothing was saved.`, 400, { code: 'whatsapp_off' });
    if (e.kind === 'template') throw bad(`${waProblem(row, e, false)} Nothing was saved.`, 400, { code: 'whatsapp_template' });
    const phone = normalPhone(row.phone);
    if (!old?.wa_link && !whatsappProvider()) throw bad(`${WA_OFF} For ${row.name || 'this person'}, leave WhatsApp off. Nothing was saved.`, 400, { code: 'whatsapp_off' });
    let agreedFor = row.wa_agreed_for, agreedAt = row.wa_agreed_at;
    if (r.whatsapp_agreed === false) agreedFor = agreedAt = null;
    else if (r.whatsapp_agreed === true && phone && agreedFor !== phoneKey(phone)) {
      agreedFor = phoneKey(phone);
      agreedAt = now();
      audit(e.id, SYSTEM, 'WhatsApp agreed', `The sender confirmed that ${row.name} agreed to get messages about this document by WhatsApp at ${maskPhone(phone)}.`);
    }
    run('UPDATE recipients SET wa_link=1, wa_agreed_at=?, wa_agreed_for=? WHERE id=?', agreedAt, agreedFor, rid);
    // On an envelope that is out, a choice that cannot work is refused where it is made, and nothing is saved.
    if (correcting) {
      const problem = waProblem({ ...row, wa_link: 1, wa_agreed_for: agreedFor }, e, true);
      if (problem) throw bad(`${problem} Nothing was saved.`);
    }
  }
}

/** Before an envelope goes out: everyone who gets the link by WhatsApp can get it, and the account may send that many. */
export function assertWhatsApp(e: any) {
  const will = (e.recipients || []).filter((r: any) => r.wa_link);
  if (!will.length) return;
  // A choice saved before WhatsApp was switched off for every account is dropped quietly: the link goes by email.
  if (!WHATSAPP_OFFERED) {
    for (const r of will) (run('UPDATE recipients SET wa_link=0, wa_agreed_at=NULL, wa_agreed_for=NULL WHERE id=?', r.id), (r.wa_link = 0));
    return;
  }
  for (const r of will) {
    const problem = waProblem(r, e, true);
    if (problem) throw bad(problem, 400);
  }
  const left = waLeft(e.account_id);
  if (will.length > left) throw bad(`This would send ${will.length} WhatsApp messages, and this account can send ${Math.max(0, left)} more today (the limit is ${waDailyPerAccount()} in 24 hours). Nothing was sent. Switch WhatsApp off for some people, or send later: the limit looks at the last 24 hours.`, 429);
}

/** The newest WhatsApp message to one person, for the sender's page: masked number, status words, and STOP. */
export function lastWa(recipientId: string): any {
  const m = get('SELECT account_id, dest_hash, kind, to_masked, status, error, at, next_try_at FROM wa_messages WHERE recipient_id=? ORDER BY id DESC LIMIT 1', recipientId);
  if (!m) return null;
  const stopped = !!get('SELECT 1 x FROM wa_stops WHERE account_id=? AND dest_hash=?', m.account_id, m.dest_hash);
  return { kind: m.kind, to: m.to_masked, status: m.status, said: stopped ? waStatusWord('stopped') : waStatusWord(m.status), error: m.error, at: m.at, next_try_at: m.next_try_at, stopped };
}

/** What became of every WhatsApp message about an envelope, for its sender: masked number, plain status words, never the text. */
export const waOf = (envelopeId: string) =>
  all(`SELECT m.recipient_id, m.kind, m.to_masked "to", m.status, m.error, m.at, m.tries, m.delivered_at,
      EXISTS (SELECT 1 FROM wa_stops s WHERE s.account_id=m.account_id AND s.dest_hash=m.dest_hash) stopped
      FROM wa_messages m WHERE m.envelope_id=? ORDER BY m.id DESC LIMIT 60`, envelopeId)
    .map((m: any) => ({ ...m, stopped: !!m.stopped, said: waStatusWord(m.status) }));

// ---- Replies and delivery reports (POST /whatsapp/webhook) -----------------------------------------------

/** Meta signs the body with the app secret (X-Hub-Signature-256). Without the secret nothing is believed. */
export function metaSignatureOk(raw: string, header: string | null): boolean {
  const secret = (process.env.WHATSAPP_APP_SECRET || '').trim();
  if (!secret || !header) return false;
  return safeEqual(String(header), `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
}

/** Twilio signs the full address and the sorted form fields with the auth token (X-Twilio-Signature). */
export function twilioSignatureOk(url: string, form: URLSearchParams, header: string | null): boolean {
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!token || !header) return false;
  const data = url + [...new Set(form.keys())].sort().map((k) => k + form.getAll(k).join('')).join('');
  return safeEqual(String(header), crypto.createHmac('sha1', token).update(data).digest('base64'));
}

/**
 * A reply from a number: STOP stops WhatsApp to it from the account whose message it answers, START lets that
 * account write again. Which account: the message the reply quotes (`repliedTo`, the provider's id of our message:
 * Meta's context.id, Twilio's OriginalRepliedMessageSid), or else the account that wrote to the number last (for START: the stop said last). Other
 * accounts that wrote to the same number are not stopped: one stranger must not cut someone off from their landlord.
 */
export function waReply(from: string, text: string, repliedTo?: string | null): 'stopped' | 'started' | 'ignored' {
  const phone = normalPhone(from.replace(/^whatsapp:/i, '').replace(/^(?!\+)/, '+'));
  if (!phone) return 'ignored';
  const stop = isStopWord(text), start = !stop && isStartWord(text);
  if (!stop && !start) return 'ignored';
  const key = phoneKey(phone);
  const quoted = repliedTo ? get('SELECT account_id FROM wa_messages WHERE provider_id=? AND dest_hash=?', String(repliedTo), key) : null;
  // START without a quote is for the stop they said last, which need not be the account that wrote last.
  const latest = quoted || (start ? get('SELECT account_id FROM wa_stops WHERE dest_hash=? ORDER BY at DESC LIMIT 1', key) : null)
    || get('SELECT account_id FROM wa_messages WHERE dest_hash=? ORDER BY id DESC LIMIT 1', key);
  for (const { account_id } of latest ? [latest] : []) {
    const last = get('SELECT envelope_id FROM wa_messages WHERE account_id=? AND dest_hash=? AND envelope_id IS NOT NULL ORDER BY id DESC LIMIT 1', account_id, key);
    if (stop) {
      run('INSERT OR REPLACE INTO wa_stops (account_id, dest_hash, at) VALUES (?,?,?)', account_id, key, now());
      run("UPDATE wa_messages SET status='failed', next_try_at=NULL, to_phone=NULL, error=COALESCE(error || ' ', '') || 'Not sent again: they replied STOP.' WHERE account_id=? AND dest_hash=? AND (status='queued' OR (status='failed' AND next_try_at IS NOT NULL))", account_id, key);
      if (last?.envelope_id) audit(last.envelope_id, SYSTEM, 'WhatsApp stopped', `${maskPhone(phone)} replied STOP on WhatsApp. No more WhatsApp messages go to this number from this account. Email is not affected.`);
    } else if (run('DELETE FROM wa_stops WHERE account_id=? AND dest_hash=?', account_id, key).changes && last?.envelope_id)
      audit(last.envelope_id, SYSTEM, 'WhatsApp started again', `${maskPhone(phone)} replied START on WhatsApp, so WhatsApp messages from this account may go to it again.`);
  }
  return stop ? 'stopped' : 'started';
}

/** A delivery report. "read" counts as delivered and nothing more: we never show it as proof. */
export function waStatus(providerId: string, status: string, error?: string) {
  if (!providerId) return;
  const s = String(status || '').toLowerCase();
  if (s === 'delivered' || s === 'read') run("UPDATE wa_messages SET status='delivered', delivered_at=COALESCE(delivered_at, ?) WHERE provider_id=? AND status IN ('sent','delivered')", now(), providerId);
  else if (s === 'failed' || s === 'undelivered') {
    const row = get("SELECT * FROM wa_messages WHERE provider_id=? AND status='sent'", providerId);
    if (!row) return;
    const said = short(error || 'The WhatsApp provider could not deliver it');
    run("UPDATE wa_messages SET status='failed', error=? WHERE id=?", said, row.id);
    if (row.envelope_id) audit(row.envelope_id, SYSTEM, 'WhatsApp not delivered', `${nameOf(row)}${WHAT[row.kind as WaKind]} to ${row.to_masked}. The provider said: ${said.replace(/[.\s]+$/, '')}.`);
  }
}

