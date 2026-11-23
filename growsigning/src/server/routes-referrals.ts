import { route } from './router.ts';
import { HttpError, esc, rateLimit, str } from './util.ts';
import { isOperator } from './routes-trust.ts';
import { referralState, settleReferrals, noteDevice, lookAtCode, accountOfStop, setReferralMail, referralRecord, referralsOn } from './referrals.ts';
import { get } from './db.ts';

// Invite a friend (src/server/referrals.ts): the inviter's card, the sign-up page's question, the stop link of the
// reward email, and the record for the operators.

// The Invite friends card. Looking at it also notes this browser for the rule against inviting yourself, and gives
// any reward that is due, so the numbers on the card are true when it draws.
route('GET', '/referrals', async (c) => {
  noteDevice(c, c.account.id);
  await settleReferrals(c.account.id);
  return referralState(c.account.id);
});

// The sign-up page asks whether the code in its address is an invite that still counts. The answer never says
// whose it is. When it counts, the browser keeps the code for 30 days.
route('GET', '/public/referrals/:code', (c) => {
  rateLimit(`referral-look:${c.ip}`, 60, 60_000);
  return lookAtCode(c, str(c.params.code, 20).toLowerCase());
}, 'public');

// The stop link in "Your invite worked". It opens a small page with one button, so a mail program that opens every
// link by itself changes nothing; the button stops the emails, and the same page turns them on again.
const page = (title: string, body: string) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f4f1ea;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c2a22}main{max-width:520px;margin:0 auto;padding:40px 16px}.card{background:#fff;border:1px solid #e4dfd3;border-radius:14px;padding:28px}h1{font-size:22px;margin:0 0 12px}p{font-size:16px;line-height:1.5;margin:0 0 14px}button{font:inherit;font-weight:600;background:#1f6f43;color:#fff;border:0;border-radius:10px;padding:13px 22px;min-height:48px;cursor:pointer}a{color:#1f6f43}</style></head>
<body><main><div class="card"><h1>${esc(title)}</h1>${body}</div></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const stopPage = (account: any, token: string) => {
  const on = !get('SELECT mail_off FROM referral_codes WHERE account_id=?', account.id)?.mail_off;
  const form = (label: string, to: string) => `<form method="post" action="/api/public/referral-emails?token=${encodeURIComponent(token)}&amp;emails=${to}"><button type="submit">${label}</button></form>`;
  return on
    ? page('Stop emails about invited friends?', `<p>${esc(account.name)} gets one email each time a friend you invited earns you free signatures. Stopping the emails changes nothing else: your invite link keeps working and the signatures still arrive.</p>${form('Stop these emails', 'off')}`)
    : page('These emails are stopped', `<p>${esc(account.name)} gets no more emails about invited friends. Your invite link keeps working, and the signatures still arrive. You can see them on the Plan page.</p>${form('Send them again', 'on')}`);
};
const stopAccount = (c: any) => {
  rateLimit(`referral-stop:${c.ip}`, 30, 3600_000);
  const account = accountOfStop(c.q.get('token'));
  if (!account) throw new HttpError(404, 'This link does not work. It may be cut off. Open it again from the email.');
  return account;
};
route('GET', '/public/referral-emails', (c) => stopPage(stopAccount(c), str(c.q.get('token'), 200)), 'public');
route('POST', '/public/referral-emails', (c) => {
  const account = stopAccount(c);
  setReferralMail(account.id, c.q.get('emails') === 'on');
  return stopPage(account, str(c.q.get('token'), 200));
}, 'public');

// Who invited whom, for the operators: every invite, where it stands and why, newest first.
route('GET', '/operator/referrals', (c) => {
  if (!isOperator(c.user)) throw new HttpError(404, 'Not found');
  return { on: referralsOn(), referrals: referralRecord(Number(c.q.get('limit')) || 200, str(c.q.get('account_id'), 80) || undefined) };
});
