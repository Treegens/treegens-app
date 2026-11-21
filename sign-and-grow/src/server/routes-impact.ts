// Trees on the screens: what the signing page, the envelope page and the review step may say, and the one account
// setting. The facts come from src/server/impact.ts; nothing here is decided by the page that asks.
import { route } from './router.ts';
import { run } from './db.ts';
import { bad } from './util.ts';
import { find } from './routes-sign.ts';
import { mine } from './routes-envelopes.ts';
import { record } from './seclog.ts';
import { treesAtFinish, signerMoment, signerSaw, senderMoment, senderSaw, allPaidForecast, recordShowsTrees, signs } from './impact.ts';
// 'Trees on screens and emails' (src/server/tenantpolicy.ts): off, these routes answer as for someone who plants nothing.
import { showsTrees } from './tenantpolicy.ts';
import { isGovernment } from '../lib/deployment.ts';

const CLOSED = ['voided', 'expired', 'declined'];

// For the person holding a signing link, once any access code or one-time code has been passed (find refuses before).
//   { finish: 10 }  mangroves that will be planted when they finish: only for someone who signs, whose turn it is,
//                   with a paid signature. 0 for everyone else, and the page then says nothing.
//   { done: {...} } after they finished: trees (10 or 0), first, celebrate, total, sheets. Null for an approver, a
//                   viewer, a copy or a witness.
route('GET', '/sign/:token/impact', (c) => {
  const { e, r } = find(c);
  if (CLOSED.includes(e.status) || !signs(r) || !showsTrees(e.account_id)) return { finish: 0, done: null };
  return { finish: treesAtFinish(r), done: signerMoment(e, r) };
}, 'public');

// The first-time picture was drawn: it is not offered again, on any device.
route('POST', '/sign/:token/impact/seen', (c) => {
  const { r } = find(c);
  signerSaw(r);
  return { ok: true };
}, 'public');

// For the sender, on an envelope of theirs.
//   A draft:  { plus: true } when every signature of it would come out of a payment, so the review step may say that
//             each person who signs plants 10 mangroves. A forecast, not a promise: it is asked again after sending.
//   Sent:     { paid, signers, planted, sheets, celebrate }.
route('GET', '/envelopes/:id/impact', (c) => {
  const e = mine(c, c.params.id, 'envelope');
  if (!showsTrees(e.account_id)) return { plus: false, sent: null };
  if (e.status === 'draft') return { plus: allPaidForecast(e), sent: null };
  return { plus: false, sent: senderMoment(e, c.user.id) };
});

route('POST', '/envelopes/:id/impact/seen', (c) => {
  const e = mine(c, c.params.id, 'envelope');
  if (senderMoment(e, c.user.id)?.celebrate) senderSaw(e.account_id);
  return { ok: true };
});

// 'Trees on the signing record' (Settings, Account). On by default. Off: the box "Signed without paper" is left off
// the signing record of documents completed from then on. Screens, emails and /impact are not changed by it.
// fixed: this server never puts them there (DEPLOYMENT_PROFILE=government), so the page shows no switch.
route('GET', '/account/impact-record', (c) => ({ on: recordShowsTrees(c.account.id), ...(isGovernment() ? { fixed: true } : {}) }));
route('PUT', '/account/impact-record', async (c) => {
  const b = await c.body();
  if (typeof b?.on !== 'boolean') throw bad('Send "on" as true or false. Nothing was changed.');
  if (isGovernment()) throw bad('This server never puts trees on the signing record, so there is nothing to switch. Nothing was changed.', 409);
  const was = recordShowsTrees(c.account.id);
  run('UPDATE accounts SET cert_impact_off=? WHERE id=?', b.on ? 0 : 1, c.account.id);
  if (was !== b.on) record('settings.changed', { c, about: ['account', c.account.id], details: { settings: { trees_on_signing_record: { from: was, to: b.on } } } });
  return { on: recordShowsTrees(c.account.id) };
}, 'admin');
