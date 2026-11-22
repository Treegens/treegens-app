// Ask for a payment, taken here by card while signing (src/server/collect.ts has the rules, src/lib/collect.ts the
// words). Routes for the admin who connects the account's own Stripe account, for the sender who asks for a payment on
// a document or a template, for the person who signs and pays, and for Stripe's own messages.
import { route, type Ctx } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, HttpError, now, rateLimit, str } from './util.ts';
import { audit, completeRecipient, loadEnvelope, notifySender, type Actor } from './envelopes.ts';
import { mine, assertMayChange } from './routes-envelopes.ts';
import { assertNotLocked } from './tplroles.ts';
import { assertNotHeld } from './records.ts';
import { find, look } from './routes-sign.ts';
import { delegateFinished } from './delegation.ts';
import { sendMail } from './mail.ts';
import { labelOf } from '../lib/bysender.ts';
import { moneyText, payAhead } from '../lib/collect.ts';
import {
  amountFields, amountFor, checkoutFor, collectOn, collectRefusal, connectionOf, connectUrl, disconnect, finishConnect, noteNotAsked, notAsked,
  onStripeEvent, openAsking, readyRow, rowOf, rowWords, saveSetting, settingOf, signedByStripe,
} from './collect.ts';

const offHere = () => bad('Taking payments is not set up on this server. Nothing was changed.', 404);
const connWords = (c: any) => (c ? { name: c.name, livemode: !!c.livemode, connected_at: c.connected_at } : null);

// ---- The account's own Stripe account ----------------------------------------------------------------------------------

route('GET', '/collect/connection', (c) => {
  if (!collectOn()) return { available: false };
  const why = collectRefusal(c.account.id);
  return { available: true, connected: connWords(connectionOf(c.account.id)), may: !why, why, open_asking: c.admin ? openAsking(c.account.id) : undefined };
});

route('POST', '/collect/connect', (c) => {
  if (!collectOn()) throw offHere();
  const why = collectRefusal(c.account.id);
  if (why) throw bad(`${why} Nothing was connected.`, 403);
  return { url: connectUrl(c.account.id, c.user.id) };
}, 'admin');

// Stripe sends the browser back here. It is answered with a move back to Settings, which says what happened.
route('GET', '/collect/callback', async (c) => {
  const back = (how: string) => new Response(null, { status: 303, headers: { location: `/app/settings?tab=sending&collect=${how}` } });
  if (!collectOn()) return back('off');
  if (!c.admin) return back('failed');
  if (c.q.get('error')) return back('declined');
  try {
    await finishConnect(str(c.q.get('state'), 100), str(c.q.get('code'), 300), c.account.id, c.user, c.actor.name);
    return back('connected');
  } catch {
    return back('failed');
  }
});

route('DELETE', '/collect/connection', async (c) => {
  if (!collectOn()) throw offHere();
  const n = openAsking(c.account.id);
  await disconnect(c.account.id);
  return { disconnected: true, open_asking: n };
}, 'admin');

// ---- On a document or a template ----------------------------------------------------------------------------------------

const peopleOf = (e: any) => {
  const rows = all('SELECT * FROM collect_payments WHERE envelope_id=? ORDER BY created_at', e.id);
  return e.recipients.filter((r: any) => r.role === 'signer' || r.role === 'inperson').map((r: any) => {
    const row = rows.find((x: any) => x.recipient_id === r.id && x.email === String(r.email || '').toLowerCase());
    const w = row ? rowWords(row) : null;
    return { id: r.id, name: r.name, state: w?.state || null, line: w?.line || null, amount: row && row.status !== 'not_asked' ? moneyText(row.amount, row.currency) : null };
  });
};

route('GET', '/envelopes/:id/collect', (c) => {
  const e = mine(c, c.params.id);
  if (!collectOn()) return { available: false, setting: settingOf(e) };
  const why = collectRefusal(e.account_id);
  return {
    available: true, connected: connWords(connectionOf(e.account_id)), may: !why, why, setting: settingOf(e), pay_link: !!e.pay_url,
    fields: amountFields(e).map((f: any) => ({ id: f.id, label: f.label || `${f.formula ? 'Calculated' : 'Number'} field on page ${Number(f.page || 0) + 1}` })),
    people: e.kind === 'envelope' ? peopleOf(e) : [],
  };
});

// Setting, changing or taking it off. { off: true } takes it off. Set and changed while a draft or a template; once
// sent it can only be taken off, so nobody who already paid or is paying finds a different amount.
route('PUT', '/envelopes/:id/collect', async (c: Ctx) => {
  const b = await c.body();
  const e = mine(c, c.params.id);
  assertMayChange(c, e);
  assertNotLocked(c, e, 'The payment cannot be changed.');
  if (e.kind === 'envelope' && e.status === 'draft') assertNotHeld([e.id], c.actor.name, 'change it');
  const off = b?.off === true;
  const open = e.kind === 'template' || e.status === 'draft';
  if (!off) {
    if (!collectOn()) throw offHere();
    if (!open) throw bad(`This document is ${e.status === 'sent' ? 'out for signing' : e.status}, so its payment can only be taken off now, not added or changed. Nothing was saved.`, 409);
    if (!connectionOf(e.account_id)) throw bad('Connect your Stripe account first, in Settings, Sending. Nothing was saved.', 409);
    const why = collectRefusal(e.account_id);
    if (why) throw bad(`${why} Nothing was saved.`, 403);
    if (e.pay_url) throw bad('This document already links to your own payment page. Take that link off first, or keep it and do not ask here. Nothing was saved.', 409);
  } else if (!e.collect_currency) return { setting: null };
  const was = settingOf(e);
  const now_ = saveSetting(e, off ? null : b);
  if (e.kind === 'envelope') {
    const what = (s: any) => `${s.amount_text || `the amount in "${s.field_label || 'a field'}"`} for "${s.for}", ${s.when === 'before' ? 'before finishing' : 'after finishing'}`;
    if (!now_) audit(e.id, c.actor, 'Payment request removed', `${was ? `${what(was)}. ` : ''}Nobody who signs from now on is asked to pay here.`);
    else audit(e.id, c.actor, was ? 'Payment request changed' : 'Payment request added', `Each person who signs is asked to pay ${what(now_)}, by card on Stripe's page, into ${connectionOf(e.account_id)?.name}'s Stripe account.`);
  }
  return { setting: now_ };
});

// ---- The person who signs and pays ----------------------------------------------------------------------------------------

// What the signing page shows: nothing for a document that asks for no payment. "ahead" on the document screen (one
// line, so nobody is surprised), "ready" when it is time to pay, "started" while Stripe has not confirmed, "paid" after.
route('GET', '/sign/:token/collect', (c) => {
  const { e, r } = find(c);
  const no = notAsked(e, r);
  if (no === 'none' || no === 'off' || no === 'team') return { collect: null };
  const conn = connectionOf(e.account_id);
  const row = rowOf(r);
  if (no && !(row && row.status === 'paid')) return { collect: null };
  const base = { merchant: row?.merchant || conn?.name || '', account: get('SELECT name FROM accounts WHERE id=?', e.account_id)?.name || '', for: row?.for_text || e.collect_for, when: e.collect_when === 'before' ? 'before' : 'after' };
  if (row?.status === 'paid') return { collect: { ...base, state: rowWords(row).state, amount: moneyText(row.amount, row.currency), lines: rowWords(row).lines, finished: r.status === 'completed' } };
  if (!['sent', 'completed'].includes(e.status) || e.hidden_at) return { collect: null };
  const s = settingOf(e)!;
  if (r.status !== 'completed') {
    // Before finishing: a Finish already waits for this payment, or the one line ahead of it.
    if (s.when === 'before' && row && row.finish_body && (row.status === 'ready' || row.status === 'started' || row.status === 'expired'))
      return { collect: { ...base, state: row.status === 'started' ? 'started' : 'ready', amount: moneyText(row.amount, row.currency) } };
    return { collect: { ...base, state: 'ahead', amount: s.amount_text, line: payAhead({ amount: s.amount_text, field: s.field_label, merchant: base.merchant, for: base.for, when: s.when }) } };
  }
  if (s.when !== 'after') return { collect: null };
  const a = amountFor(e, r);
  if ('none' in a) return { collect: null };
  if ('error' in a) {
    noteNotAsked(e, r, a.error, { name: 'System' });
    return { collect: null };
  }
  const ready = readyRow(e, r, a.minor);
  return { collect: { ...base, state: ready.status === 'started' ? 'started' : 'ready', amount: moneyText(ready.amount, ready.currency) } };
}, 'public');

// Pay: the Stripe page for this person, the one already open or a new one. Never before Finish was pressed.
route('POST', '/sign/:token/collect/start', async (c) => {
  find(c);
  rateLimit(`collect:${c.params.token}`, 20, 3600_000);
  const { e, r, actor } = look(c);
  const no = notAsked(e, r);
  if (no) throw bad('This document does not ask you for a payment now. You do not need to pay anything here.', 409);
  if (!['sent', 'completed'].includes(e.status) || e.hidden_at) throw bad('This document is closed, so no payment is taken for it. You do not need to pay anything here.', 409);
  const row = rowOf(r);
  if (!row || row.status === 'not_asked') throw bad('There is nothing to pay yet. Press Finish first.', 409);
  if (row.status === 'paid') return { paid: true };
  if (row.when_to === 'before' && (r.status === 'completed' || !row.finish_body)) {
    if (r.status !== 'completed') throw bad('There is nothing to pay yet. Press Finish first.', 409);
  }
  if (row.when_to === 'after' && r.status !== 'completed') throw bad('There is nothing to pay yet. Press Finish first.', 409);
  return checkoutFor(e, r, row, actor);
}, 'public');

// ---- Stripe's messages ----------------------------------------------------------------------------------------------------

/**
 * Pay before finishing: once Stripe confirmed, the person's part completes with what they signed. If it cannot (the
 * document changed or closed meanwhile) nothing is signed, the payment stays confirmed, and they are told to open the
 * document again; the sender is told when the document closed, because they hold money for an unsigned document.
 */
export async function finishAfterPayment(row: any) {
  if (!row || row.status !== 'paid' || row.when_to !== 'before' || !row.finish_body) return;
  const e = loadEnvelope(row.envelope_id);
  const r = e?.recipients.find((x: any) => x.id === row.recipient_id);
  if (!e || !r) return;
  const body = JSON.parse(row.finish_body);
  run('UPDATE collect_payments SET finish_body=NULL WHERE id=?', row.id);
  if (r.status === 'completed') return;
  const actor: Actor = { name: labelOf(r), ip: row.finish_ip || undefined, ua: row.finish_ua || undefined };
  try {
    await completeRecipient(e, r, body, actor);
    await delegateFinished(e, r.id, 'completed').catch(() => {});
  } catch (x: any) {
    const closed = e.status !== 'sent';
    audit(e.id, { name: 'System' }, 'Paid, not finished yet', `${r.name}'s payment is confirmed, and their part could not be completed with it: ${str(x?.message || 'the document changed', 300)} ${closed ? 'The document is closed.' : 'They are asked to open the document again and finish.'}`);
    if (r.email) void sendMail({ to: r.email, subject: `Your payment is confirmed: ${e.subject}`, heading: 'Your payment is confirmed',
      lines: [closed ? `Stripe confirmed your payment for "${e.subject}", but the document was closed before your signature could be added. Ask the sender about a refund.` : `Stripe confirmed your payment for "${e.subject}". The document changed meanwhile, so your signature was not added yet.`,
        closed ? 'There is nothing more to do on the document.' : 'Open the link in the email you got for this document, look at it again and press Finish. You will not be asked to pay again.'] }).catch(() => {});
    if (closed) await notifySender(e, 'always', `Paid, but not signed: ${e.subject}`, `${r.name} paid, and the document was closed first`, [`Stripe confirmed ${r.name}'s payment of ${moneyText(row.amount, row.currency)}, and the document was ${e.status} before their part was complete. If you do not want to keep the money, refund it in your Stripe dashboard.`]).catch(() => {});
  }
}

route('POST', '/collect/webhook', async (c) => {
  const secret = String(process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '').trim();
  if (!collectOn() || !secret) throw new HttpError(404, 'Taking payments is not set up on this server.');
  const raw = await c.req.text();
  if (!signedByStripe(raw, c.req.headers.get('stripe-signature') || '', secret)) throw new HttpError(400, 'Bad signature.');
  let ev: any;
  try {
    ev = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Send the JSON Stripe sends.');
  }
  const out = await onStripeEvent(ev);
  if (out.done === 'paid') await finishAfterPayment(out.row);
  return { received: true, done: out.done, at: now() };
}, 'public');
