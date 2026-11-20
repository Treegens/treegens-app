// A link to the sender's own payment page, shown to a signer after they press Finish. The rules and every sentence
// are in src/lib/paylink.ts. Sign&Grow never touches the money: it keeps an address, shows it to the right person
// at the right moment, and writes down that it did.
import { route, type Ctx } from './router.ts';
import { get, run } from './db.ts';
import { bad, baseUrl, str } from './util.ts';
import { audit, hasNotPaid } from './envelopes.ts';
import { mine, assertMayChange } from './routes-envelopes.ts';
import { assertNotLocked } from './tplroles.ts';
import { find } from './routes-sign.ts';
import { PAID_TRUST_DAYS } from '../lib/policy.ts';
import { checkPayUrl, payLabel, payNotYet, PAY_KINDS } from '../lib/paylink.ts';

const ACTS = (role: string) => role === 'signer' || role === 'inperson';
const ownHost = () => {
  try {
    return new URL(baseUrl()).hostname;
  } catch {
    return '';
  }
};

// Whether this account may put a Pay button in front of signers right now, and if not, why. Asked when the link is
// set and again every time it would be shown: trust that is taken away (a refund, a dispute, a person removing the
// mark) or a pause takes every link of the account off the screens at once, without anyone having to find them.
export function payRefusal(accountId: string): string | null {
  const a = get('SELECT * FROM accounts WHERE id=?', accountId);
  if (!a) return 'This account no longer exists.';
  if (a.suspended_at) return 'Sending is paused on this account, so its payment links are shown to nobody until a person has lifted the pause.';
  if (a.dispute_at) return 'A card payment of this account was disputed, so its payment links are shown to nobody until that is cleared.';
  return hasNotPaid(a) ? payNotYet(PAID_TRUST_DAYS) : null;
}

const linkOf = (e: any) => (e.pay_url ? { url: e.pay_url as string, host: new URL(e.pay_url).hostname, kind: e.pay_kind || 'deposit', label: payLabel(e.pay_kind) } : null);

// The sender's view: the link, whether it can be shown now, and who was shown it and pressed it.
route('GET', '/envelopes/:id/pay-link', (c) => {
  const e = mine(c, c.params.id);
  const why = payRefusal(e.account_id);
  return {
    pay_link: linkOf(e), may: !why, why, kinds: PAY_KINDS,
    people: e.recipients.filter((r: any) => ACTS(r.role)).map((r: any) => ({ id: r.id, name: r.name, shown_at: r.pay_shown_at || null, opened_at: r.pay_opened_at || null })),
  };
});

// Setting, changing or removing it ({ url: '' } removes). Changing is for whoever may change the envelope, while it
// is a draft, a template or out for signing. Once it is completed or closed the link can only be removed: a link
// that changes after people signed is the one thing a stolen login would want to do here.
route('PUT', '/envelopes/:id/pay-link', async (c: Ctx) => {
  const e = mine(c, c.params.id);
  assertMayChange(c, e);
  // The link comes with the template's wording, so an envelope whose wording is locked keeps it (tplroles.ts).
  assertNotLocked(c, e, 'The payment link cannot be changed.');
  const b = await c.body();
  const raw = str(b?.url ?? '', 2000).trim();
  const kind = b?.kind == null || b.kind === '' ? e.pay_kind || 'deposit' : String(b.kind);
  if (!PAY_KINDS[kind]) throw bad(`"${str(kind, 40)}" is not one of the buttons. Use one of: ${Object.keys(PAY_KINDS).join(', ')}. Nothing was saved.`);
  const open = e.kind === 'template' || e.status === 'draft' || e.status === 'sent';
  const was = linkOf(e);
  if (!raw) {
    if (!was) return { pay_link: null };
    run('UPDATE envelopes SET pay_url=NULL, pay_kind=NULL WHERE id=?', e.id);
    if (e.kind === 'envelope') audit(e.id, c.actor, 'Payment link removed', `"${was.label}" to ${was.url} is no longer shown to anyone.`);
    return { pay_link: null };
  }
  if (!open) throw bad(`This envelope is ${e.status}, so its payment link can only be removed now, not added or changed. Nothing was saved.`, 409);
  const why = payRefusal(e.account_id);
  if (why) throw bad(`${why} Nothing was saved.`, 403);
  const ok = checkPayUrl(raw, ownHost());
  if ('error' in ok) throw bad(ok.error);
  if (was && was.url === ok.href && was.kind === kind) return { pay_link: was };
  run('UPDATE envelopes SET pay_url=?, pay_kind=? WHERE id=?', ok.href, kind, e.id);
  if (e.kind === 'envelope')
    audit(e.id, c.actor, was ? 'Payment link changed' : 'Payment link added', `"${payLabel(kind)}" opens ${ok.href}${was ? ` (it opened ${was.url} before)` : ''}. It is shown to each person who signs, after they finish, and never in an email. Sign&Grow takes no part in the payment.`);
  return { pay_link: linkOf({ pay_url: ok.href, pay_kind: kind }) };
});

// What the signing page shows after Finish. Only to someone who signs and has finished, only while the envelope is
// out or completed (not once it was voided, declined or ran out of time: then nobody should be asked for money for
// it), and only while the account may still show one. The first time a person is shown a link, the audit trail says
// so with the address, so a dispute about "I was never told" or "it said something else" has an answer.
route('GET', '/sign/:token/pay', (c) => {
  const { e, r, actor } = find(c);
  if (!e.pay_url || !ACTS(r.role) || r.status !== 'completed' || !['sent', 'completed'].includes(e.status) || payRefusal(e.account_id)) return { pay: null };
  const link = linkOf(e)!;
  if (r.pay_shown_url !== link.url) {
    run('UPDATE recipients SET pay_shown_url=?, pay_shown_at=COALESCE(pay_shown_at, ?) WHERE id=?', link.url, new Date().toISOString(), r.id);
    audit(e.id, actor, 'Shown the payment link', `${r.name} was shown "${link.label}", which opens ${link.url}.`);
  }
  const sender = get('SELECT name, email FROM users WHERE id=?', e.sender_id) || { name: 'The sender', email: '' };
  const account = get('SELECT name FROM accounts WHERE id=?', e.account_id)?.name || '';
  return { pay: { ...link, sender: { name: sender.name, email: sender.email }, account } };
}, 'public');

// The button was pressed. Written once for each address, so the sender sees it and the record has it. Whether the
// payment was made is never known here, and the line says so.
route('POST', '/sign/:token/pay-opened', (c) => {
  const { e, r, actor } = find(c);
  if (!e.pay_url || !ACTS(r.role) || r.status !== 'completed' || payRefusal(e.account_id)) return { recorded: false };
  if (r.pay_opened_url === e.pay_url) return { recorded: false };
  run('UPDATE recipients SET pay_opened_url=?, pay_opened_at=COALESCE(pay_opened_at, ?) WHERE id=?', e.pay_url, new Date().toISOString(), r.id);
  audit(e.id, actor, 'Opened the payment link', `${r.name} pressed "${payLabel(e.pay_kind)}" and was sent on to ${e.pay_url}. Whether a payment was made is not known to Sign&Grow.`);
  return { recorded: true };
}, 'public');
