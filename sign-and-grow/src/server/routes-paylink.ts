// A link to the sender's own payment page, shown to a signer after they press Finish. The rules and every sentence
// are in src/lib/paylink.ts. GrowSigning never touches the money: it keeps an address, shows it to the right person
// at the right moment, and writes down that it did.
//
// The address itself is shown to the sender on the envelope page and to a signer after Finish, and nowhere else: the
// audit trail, and with it the certificate in every "Completed" email, every export and every evidence pack, names it
// by a fingerprint (payPrint in paydrop.ts).
import { route, type Ctx } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, baseUrl, now, str } from './util.ts';
import { sendMail } from './mail.ts';
import { audit, hasNotPaid } from './envelopes.ts';
import { mine, assertMayChange } from './routes-envelopes.ts';
import { assertNotLocked } from './tplroles.ts';
import { find, look } from './routes-sign.ts';
import { lookHost, hostRefusal } from './paydns.ts';
import { payPrint } from './paydrop.ts';
import { PAID_TRUST_DAYS } from '../lib/policy.ts';
import { checkPayUrl, payLabel, payNotYet, payLater, PAY_KINDS } from '../lib/paylink.ts';

const ACTS = (role: string) => role === 'signer' || role === 'inperson';
// Whose payment page it is: the person who set it. A link saved before that was kept counts as its sender's.
const setterOf = (e: any): string => e.pay_set_by || e.sender_id;
// Someone on the sender's own team, known by their address the way everyone on an envelope is. They are never asked
// to pay: the sender countersigning their own deposit form, or a colleague signing a public form for the office.
const onTeam = (e: any, email: any): boolean =>
  !!email && !!get('SELECT 1 x FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND lower(u.email)=lower(?)', e.account_id, String(email));

// Why this person is not shown the link now, or null when they are. Asked when it would be shown, again after the
// lookup of its address, and when it is pressed, so all three follow one rule. 'account' when the account may not
// show any link at all (payRefusal).
function notShown(e: any, r: any): string | null {
  if (!e.pay_url || !ACTS(r.role) || r.status !== 'completed') return 'none';
  // Voided, declined or out of time: the deal is off. Deleted by its sender after someone signed (hidden_at): they
  // want nothing more to do with it, and could no longer even open it to take the link off.
  if (!['sent', 'completed'].includes(e.status) || e.hidden_at) return 'closed';
  if (onTeam(e, r.email)) return 'team';
  // The link goes with the person who set it when they leave the team (paydrop.ts). This holds even where a path
  // forgot to take it off: somebody who left is never asking for money in the team's name.
  if (!get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', e.account_id, setterOf(e))) return 'left';
  return payRefusal(e.account_id) ? 'account' : null;
}

// Someone who signed was not shown the link because of the account (a refund, a dispute, a pause, the trusted mark
// taken away) or because its address does not lead to a public site any more. A Pay button that stops without a word
// is money nobody asks for, so the people who would expect it are told once, without the address, and again only
// after a link of theirs was shown in between.
function tellNotShown(e: any, why: string, scope: 'account' | 'link') {
  const t = now();
  const fresh = scope === 'account' ? run('UPDATE accounts SET pay_told_at=? WHERE id=? AND pay_told_at IS NULL', t, e.account_id).changes
    : run('UPDATE envelopes SET pay_told_at=? WHERE id=? AND pay_told_at IS NULL', t, e.id).changes;
  if (!fresh) return;
  const team = get('SELECT name FROM accounts WHERE id=?', e.account_id)?.name || 'your account';
  const to: string[] = scope === 'account' ? all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", e.account_id).map((x) => x.email)
    : all('SELECT email FROM users WHERE id IN (?, ?)', setterOf(e), e.sender_id).map((x) => x.email);
  const lines = scope === 'account'
    ? [`Someone who signed "${e.subject}" was not shown its payment link just now, and no payment link of ${team} is shown to anyone at the moment. ${why}`,
      'Nothing else changed: the documents and the signatures are as they were. The links are shown again by themselves once that has changed, and you are told again if it happens another time.']
    : [`Someone who signed "${e.subject}" was not shown its payment link just now. ${why}`, 'Open the envelope to change the link or take it off. The documents and the signatures are as they were.'];
  for (const email of new Set(to))
    void sendMail({ to: email, subject: scope === 'account' ? `Your payment links are not being shown: ${team}` : `Your payment link is not being shown: ${e.subject}`,
      heading: scope === 'account' ? 'Your payment links are not being shown' : 'Your payment link is not being shown', lines,
      cta: { label: 'Open the envelope', url: `${baseUrl()}/app/envelopes/${e.id}` } }).catch(() => {});
}
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

// The sender's view: the link with its fingerprint, whether it can be shown now and if not why, whose payment page it
// is, why it was taken off when its sender did not do that, and for each person who signs which address they were
// shown and pressed, the current one apart from earlier ones.
route('GET', '/envelopes/:id/pay-link', async (c) => {
  const first = mine(c, c.params.id);
  // Where the address leads now, so the sender learns here that a signer would not be shown it (paydns.ts).
  const host = first.pay_url ? new URL(first.pay_url).hostname : '';
  const where = host ? await lookHost(host) : null;
  const e = mine(c, c.params.id);
  const why = payRefusal(e.account_id);
  const link = linkOf(e);
  const seen = all('SELECT recipient_id, url, shown_at, opened_at FROM pay_seen WHERE envelope_id=? ORDER BY shown_at', e.id);
  const setter = link ? get('SELECT id, name FROM users WHERE id=?', setterOf(e)) : null;
  return {
    pay_link: link && { ...link, fingerprint: payPrint(link.url) }, may: !why, why, kinds: PAY_KINDS,
    host_why: link && where && !where.ok && e.pay_url === first.pay_url ? hostRefusal(where, host) : null,
    set_by: setter ? { id: setter.id, name: setter.name } : null,
    gone: !link && e.pay_gone_at ? { at: e.pay_gone_at, note: e.pay_gone_note } : null,
    people: e.recipients.filter((r: any) => ACTS(r.role)).map((r: any) => {
      const theirs = seen.filter((x: any) => x.recipient_id === r.id);
      const cur = link ? theirs.find((x: any) => x.url === link.url) : null;
      return {
        id: r.id, name: r.name, on_team: onTeam(e, r.email), shown_at: cur?.shown_at || null, opened_at: cur?.opened_at || null,
        earlier: theirs.filter((x: any) => x !== cur).map((x: any) => ({ url: x.url, fingerprint: payPrint(x.url), shown_at: x.shown_at, opened_at: x.opened_at || null })),
      };
    }),
  };
});

// Setting, changing or removing it. { url: '' } (or null) removes it; a body without "url" changes only the button and
// keeps the address. Changing is for whoever may change the envelope, while it is a draft, a template or out for
// signing. Once it is completed or closed the link can only be removed: a link that changes after people signed is
// the one thing a stolen login would want to do here. Whoever saves an address becomes the person it belongs to.
route('PUT', '/envelopes/:id/pay-link', async (c: Ctx) => {
  const check = (e: any) => {
    assertMayChange(c, e);
    // The link comes with the template's wording, so an envelope whose wording is locked keeps it (tplroles.ts).
    assertNotLocked(c, e, 'The payment link cannot be changed.');
  };
  const before = mine(c, c.params.id);
  check(before);
  const b = await c.body();
  const keep = b?.url === undefined;
  const raw = keep ? '' : str(b.url ?? '', 2000).trim();
  const kind = b?.kind == null || b.kind === '' ? before.pay_kind || 'deposit' : String(b.kind);
  if (!PAY_KINDS[kind]) throw bad(`"${str(kind, 40)}" is not one of the buttons. Use one of: ${Object.keys(PAY_KINDS).join(', ')}. Nothing was saved.`);
  const isOpen = (e: any) => e.kind === 'template' || e.status === 'draft' || e.status === 'sent';
  const mayAdd = (e: any) => {
    if (!isOpen(e)) throw bad(`This envelope is ${e.status}, so its payment link can only be removed now, not added or changed. Nothing was saved.`, 409);
    const why = payRefusal(e.account_id);
    if (why) throw bad(`${why} Nothing was saved.`, 403);
  };
  let ok: { href: string; host: string } | null = null;
  if (raw) {
    mayAdd(before);
    const checked = checkPayUrl(raw, ownHost());
    if ('error' in checked) throw bad(checked.error);
    // Where the name leads now: a name that looks public and leads into a private network is refused (paydns.ts).
    const where = await lookHost(checked.host);
    if (!where.ok) throw bad(`${hostRefusal(where, checked.host)} Nothing was saved.`);
    ok = checked;
  }
  // Looked up again after the waits, and nothing is waited for from here on: the envelope as it is now is decided on.
  const e = mine(c, c.params.id);
  check(e);
  const was = linkOf(e);
  if (!keep && !raw) {
    if (!was) return { pay_link: null };
    run('UPDATE envelopes SET pay_url=NULL, pay_kind=NULL, pay_told_at=NULL WHERE id=?', e.id);
    if (e.kind === 'envelope') audit(e.id, c.actor, 'Payment link removed', `"${was.label}" (address fingerprint ${payPrint(was.url)}) is no longer shown to anyone.`);
    return { pay_link: null };
  }
  if (keep && !was) throw bad('There is no payment link on this envelope to change. Send "url" with the address of your own payment page. Nothing was saved.');
  mayAdd(e);
  const href = ok ? ok.href : was!.url;
  if (was && was.url === href && was.kind === kind) return { pay_link: { ...was, fingerprint: payPrint(was.url) } };
  const t = now();
  if (was && was.url === href) run('UPDATE envelopes SET pay_kind=? WHERE id=?', kind, e.id);
  else run('UPDATE envelopes SET pay_url=?, pay_kind=?, pay_set_by=?, pay_set_at=?, pay_gone_at=NULL, pay_gone_note=NULL, pay_told_at=NULL WHERE id=?', href, kind, c.user.id, t, e.id);
  if (e.kind === 'envelope') {
    // The address is named by its fingerprint: this line goes into the certificate, which is emailed (paydrop.ts).
    const where = `The address is on the envelope page. It is shown to each person who signs, after they finish, and never put in an email, a certificate or an export. GrowSigning takes no part in the payment.`;
    if (was && was.url === href) audit(e.id, c.actor, 'Payment link changed', `The button now says "${payLabel(kind)}" (it said "${was.label}"). The address stays the same (fingerprint ${payPrint(href)}).`);
    else audit(e.id, c.actor, was ? 'Payment link changed' : 'Payment link added', `"${payLabel(kind)}" ${was ? 'now leads to another' : 'leads to the'} payment page ${c.user.name} gave (address fingerprint ${payPrint(href)}${was ? `, before ${payPrint(was.url)}` : ''}). ${where}`);
  }
  return { pay_link: { ...linkOf({ pay_url: href, pay_kind: kind })!, fingerprint: payPrint(href) } };
});

// What the signing page shows after Finish (notShown says to whom), with the name of the person whose payment page it
// is. Its address is asked of the DNS each time, so a name that leads into a private network by now is not shown.
// The first time a person is shown an address, the audit trail says so with its fingerprint, so a dispute about "I
// was never told" or "it said something else" has an answer, and the envelope page shows which address it was.
route('GET', '/sign/:token/pay', async (c) => {
  const first = find(c);
  const no = notShown(first.e, first.r);
  if (no === 'account') tellNotShown(first.e, payRefusal(first.e.account_id) || '', 'account');
  if (no) return { pay: null };
  const url: string = first.e.pay_url;
  const host = new URL(url).hostname;
  const where = await lookHost(host);
  // Looked up again after the wait, and nothing is waited for from here on: two requests at the same moment take
  // turns, and a link changed or an envelope voided in between is not shown (look in routes-sign.ts).
  const { e, r, actor } = look(c);
  if (notShown(e, r) || e.pay_url !== url) return { pay: null };
  const setter = get('SELECT name, email FROM users WHERE id=?', setterOf(e)) || { name: 'The sender', email: '' };
  if (!where.ok) {
    if (where.why !== 'later') tellNotShown(e, hostRefusal(where, ''), 'link');
    return { pay: null, later: where.why === 'later' ? payLater(setter.name) : null };
  }
  const link = linkOf(e)!;
  const t = now();
  if (run('INSERT OR IGNORE INTO pay_seen (recipient_id, envelope_id, url, shown_at) VALUES (?,?,?,?)', r.id, e.id, link.url, t).changes) {
    run('UPDATE recipients SET pay_shown_url=?, pay_shown_at=? WHERE id=?', link.url, t, r.id);
    audit(e.id, actor, 'Shown the payment link', `${r.name} was shown "${link.label}" after finishing (address fingerprint ${payPrint(link.url)}).`);
  }
  // Shown again: a later time it is not shown is news again (tellNotShown).
  run('UPDATE envelopes SET pay_told_at=NULL WHERE id=? AND pay_told_at IS NOT NULL', e.id);
  run('UPDATE accounts SET pay_told_at=NULL WHERE id=? AND pay_told_at IS NOT NULL', e.account_id);
  const account = get('SELECT name FROM accounts WHERE id=?', e.account_id)?.name || '';
  return { pay: { ...link, sender: { name: setter.name, email: setter.email }, account } };
}, 'public');

// The button was pressed, sent with the address the page showed. Written once for each address, and only for one this
// person was shown, under the same rules as showing it: a press after a void, from a tab left open on an address that
// was removed since, or without a showing records nothing. Whether the payment was made is never known here.
route('POST', '/sign/:token/pay-opened', async (c) => {
  find(c);
  const b = await c.body().catch(() => ({}));
  const { e, r, actor } = look(c);
  if (notShown(e, r)) return { recorded: false };
  const url = typeof b?.url === 'string' && b.url ? b.url : e.pay_url;
  const t = now();
  if (!run('UPDATE pay_seen SET opened_at=? WHERE recipient_id=? AND url=? AND opened_at IS NULL', t, r.id, url).changes) return { recorded: false };
  run('UPDATE recipients SET pay_opened_url=?, pay_opened_at=? WHERE id=?', url, t, r.id);
  audit(e.id, actor, 'Opened the payment link', `${r.name} pressed "${payLabel(e.pay_kind)}" (address fingerprint ${payPrint(url)}${url === e.pay_url ? '' : ', an address that has been changed since'}). Whether a payment was made is not known to GrowSigning.`);
  return { recorded: true };
}, 'public');
