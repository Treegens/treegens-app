// Invite a friend (src/server/referrals.ts, src/lib/referral.ts): the whole path from the link to both rewards, the
// email to the inviter and its stop link, each rule against inviting yourself, the limits, expiry, taking a reward
// back, the operators' record, the switches, and that every out-of-signatures screen and message carries the offer.
// The clock is a fake one that is moved forward, as in tests/billing9.test.ts.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { boot, Client, mailTo, simple, signAll, type Server } from './helpers.ts';
import './stripe-fake.ts'; // a payment provider is connected, so signatures are counted
import { PRICING } from '../src/lib/impact.ts';
import { expiredWords } from '../src/lib/policy.ts';
import { REFERRAL_DEFAULTS, referralRulesFrom, referralOfferOn, referralRuleText, normalEmail, normalPhone, isReferralCode, REFERRAL_REFUSALS } from '../src/lib/referral.ts';

const RealDate = Date;
let shift = 0;
class FakeDate extends RealDate {
  constructor(...a: any[]) {
    if (a.length === 0) super(RealDate.now() + shift);
    else super(...(a as [any]));
  }
  static now() {
    return RealDate.now() + shift;
  }
}
(globalThis as any).Date = FakeDate;
const travel = (days: number) => void (shift += Math.round(days * 864e5));
const DAY = 864e5;

let db: Server['db'];
let cron: Server['cron'];
let credits: typeof import('../src/server/credits.ts');
let referrals: typeof import('../src/server/referrals.ts');

const PW = 'correct horse battery';
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const root = path.resolve(import.meta.dirname, '..');
const src = (p: string) => readFileSync(path.join(root, p), 'utf8');

type Person = { c: Client; id: string; uid: string; email: string; ip: string; phone: string | null };
let k = 0;
// A new login with a workspace of its own. `visit`: the browser opened an invite link first (the cookie carries the
// code). `ref`: the code is sent with the form. `phone: null`: no phone number given yet. Whatever the sign-up form
// asks for a phone, the number is set here, so each test says exactly what the account has.
async function person(first: string, o: { visit?: string; ref?: string; ip?: string; email?: string; phone?: string | null; cookies?: Record<string, string>; unverified?: boolean } = {}): Promise<Person> {
  const n = ++k;
  const c = new Client();
  c.ip = o.ip || `198.51.${100 + Math.floor(n / 200)}.${(n % 200) + 1}`;
  Object.assign(c.cookies, o.cookies || {});
  if (o.visit) assert.equal((await c.get(`/public/referrals/${o.visit}`)).status, 200);
  const email = o.email || `${first.toLowerCase()}${n}@ref.example`;
  const signupPhone = `+31 6 10 00 ${String(1000 + n)}`;
  const r = await c.post('/auth/signup', { name: `${first} Tester`, email, password: PW, phone: signupPhone, ...(o.ref ? { ref: o.ref } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const u = db.get('SELECT * FROM users WHERE email=?', email);
  if (!o.unverified) assert.equal((await c.post('/auth/verify', { token: u.verify_token })).status, 200);
  const phone = o.phone === null ? null : o.phone || `+31611${String(100000 + n)}`;
  db.run('UPDATE users SET phone=? WHERE id=?', phone, u.id);
  const me = (await c.get('/me')).data;
  return { c, id: me.account.id, uid: u.id, email, ip: c.ip, phone };
}
const invite = async (p: Person) => (await p.c.get('/referrals')).data;
const row = (friend: Person) => db.get('SELECT * FROM referrals WHERE friend_user_id=?', friend.uid);
const left = async (p: Person) => (await p.c.get('/billing')).data.signatures.available;
const lots = (p: Person, source = 'referral') => credits.lotsOf(p.id).filter((l) => l.source === source);
// The friend sends a document to someone else, and that person signs it: the first signed document.
let signer = 0;
async function firstSigned(p: Person) {
  const to = `signer${++signer}@sign.example`;
  const e = await simple(p.c, to);
  const sent = await p.c.post(`/envelopes/${e.id}/send`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const done = await signAll(e.id, to);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return e;
}
const login = async (p: Person) => {
  p.c.cookies = Object.fromEntries(Object.entries(p.c.cookies).filter(([name]) => name === 'gs_dev'));
  assert.equal((await p.c.post('/auth/login', { email: p.email, password: PW })).status, 200);
};

before(async () => {
  const s = await boot();
  db = s.db;
  cron = s.cron;
  credits = await import('../src/server/credits.ts');
  referrals = await import('../src/server/referrals.ts');
});

// ---- The rules as numbers and words ---------------------------------------------------------------------------------

test('the numbers: 3 signatures each, 30 days, 10 friends a month, 30 in all, and REFERRAL_* changes them', () => {
  assert.deepEqual(REFERRAL_DEFAULTS, { signatures: 3, expiry_days: 30, monthly_max: 10, total_max: 30 });
  assert.deepEqual(referralRulesFrom({}), REFERRAL_DEFAULTS);
  assert.deepEqual(referralRulesFrom({ REFERRAL_SIGNATURES: '5', REFERRAL_EXPIRY_DAYS: '90', REFERRAL_MONTHLY_MAX: '2', REFERRAL_TOTAL_MAX: '4' }), { signatures: 5, expiry_days: 90, monthly_max: 2, total_max: 4 });
  // Nonsense falls back to the default instead of giving away the shop.
  assert.deepEqual(referralRulesFrom({ REFERRAL_SIGNATURES: 'lots', REFERRAL_EXPIRY_DAYS: '-1', REFERRAL_MONTHLY_MAX: '', REFERRAL_TOTAL_MAX: '1.5' }), REFERRAL_DEFAULTS);
  assert.equal(REFERRAL_DEFAULTS.signatures, PRICING.welcomeSignatures, 'a reward is as many as the trial');
  // Only where signatures are counted, and never with REFERRALS=0.
  assert.equal(referralOfferOn({ STRIPE_SECRET_KEY: 'sk' }), true);
  assert.equal(referralOfferOn({}), false);
  assert.equal(referralOfferOn({ STRIPE_SECRET_KEY: 'sk', REFERRALS: '0' }), false);
  assert.equal(referralOfferOn({ STRIPE_SECRET_KEY: 'sk', BILLING_MODE: 'deployment' }), false);
  const rule = referralRuleText();
  for (const part of ['3 free signatures', '30 days', '10 rewarded friends a month', '30 in all', 'we never write to your friends', 'taken back', 'phone number']) assert.ok(rule.includes(part), part);
});

test('one mailbox is one friend: capitals, Gmail dots, plus tags and googlemail are folded', () => {
  assert.equal(normalEmail('Ann.Lee+work@GoogleMail.com'), 'annlee@gmail.com');
  assert.equal(normalEmail('annlee@gmail.com'), 'annlee@gmail.com');
  assert.equal(normalEmail('ann.lee+x@example.com'), 'ann.lee@example.com', 'dots only mean nothing at Gmail');
  assert.equal(normalPhone('+31 (0)6 1234-5678'), normalPhone('31061234 5678'));
  assert.equal(normalPhone('0031612345678'), '31612345678');
  assert.equal(isReferralCode('abcdefgh'), true);
  assert.equal(isReferralCode('ABCDEFGH'), false);
  assert.equal(isReferralCode('../../etc'), false);
});

// ---- The whole path ---------------------------------------------------------------------------------------------------

let ann: Person, bob: Person;
test('the whole path: link, sign-up, a real account, 3 signatures each, one email to the inviter', async () => {
  ann = await person('Ann');
  const inv = await invite(ann);
  assert.equal(inv.on, true);
  assert.equal(inv.url, `http://test.local/r/${inv.code}`);
  assert.ok(isReferralCode(inv.code));
  assert.deepEqual(inv.rules, REFERRAL_DEFAULTS);
  assert.deepEqual([inv.joined, inv.rewarded, inv.signatures, inv.open], [0, 0, 0, true]);
  assert.equal((await invite(ann)).code, inv.code, 'the link stays the same');

  // The sign-up page asks about the code. The answer says nothing about whose link it is.
  const look = await new Client().get(`/public/referrals/${inv.code}`);
  assert.deepEqual(look.data, { ok: true, signatures: 3, expiry_days: 30 });
  assert.equal((await new Client().get('/public/referrals/zzzzzzzz')).data.ok, false);

  // Bob opens the link (the browser keeps the code), signs up and confirms his address. No phone number yet.
  bob = await person('Bob', { visit: inv.code, phone: null });
  assert.equal(row(bob).status, 'pending');
  assert.equal(row(bob).inviter_account_id, ann.id);
  assert.equal(bob.c.cookies.gs_ref, '', 'the code is used up by the sign-up');
  assert.equal(await left(bob), 3, 'nothing is given at sign-up beyond the trial');
  assert.deepEqual([(await invite(ann)).joined, (await invite(ann)).waiting, (await invite(ann)).rewarded], [1, 1, 0]);

  // His first document is signed, but he gave no phone number: not a real account yet.
  await firstSigned(bob);
  await cron.tick();
  assert.equal(row(bob).status, 'pending');
  assert.equal(await left(ann), 3);

  // With a phone number the reward lands, here on the timer.
  db.run('UPDATE users SET phone=? WHERE id=?', '+31 6 5550 0001', bob.uid);
  await cron.tick();
  const r = row(bob);
  assert.deepEqual([r.status, r.inviter_got, r.friend_got], ['rewarded', 3, 3]);
  assert.equal(await left(ann), 6, 'the 3 of the trial and 3 for the friend');
  assert.equal(await left(bob), 5, '3 of the trial, one used, 3 for joining through a friend');

  // They are a lot of their own, and expire 30 days after they arrive, as the trial does after sign-up.
  for (const p of [ann, bob]) {
    const [lot] = lots(p);
    assert.deepEqual([lot.qty, lot.paid, lot.left], [3, false, 3]);
    assert.ok(Math.abs(Date.parse(lot.expires_at!) - (Date.parse(lot.at) + 30 * DAY)) < 1000, 'thirty days from the day they arrived');
  }
  const shown = (await ann.c.get('/billing')).data.lots.find((l: any) => l.source === 'referral');
  assert.deepEqual([shown.label, shown.of, shown.left, shown.payment_id], ['Invite a friend', 3, 3, null]);
  assert.match(db.get("SELECT detail FROM billing_log WHERE account_id=? AND what='referral'", ann.id).detail, /^3 signatures added because a friend you invited had their first document signed\. They expire on /);
  assert.match(db.get("SELECT detail FROM billing_log WHERE account_id=? AND what='referral'", bob.id).detail, /joining through a friend's invite link/);

  // One email to the inviter, in the owner's words, with the stop link. Bob gets no email about it and is never named.
  const mails = mailTo(ann.email).filter((m: any) => /Your friend signed their first document/.test(m.subject));
  assert.equal(mails.length, 1);
  const body = text(mails[0].html);
  assert.ok(body.includes('Your friend signed their first document. You both got 3 free signatures.'), body);
  assert.ok(body.includes(`Each one plants ${PRICING.treesPerSignature} trees when it is signed.`));
  assert.ok(body.includes('Stop these emails') && /referral-emails\?token=/.test(mails[0].html));
  assert.ok(!body.includes('Bob') && !body.includes(bob.email), 'the friend is not named');
  assert.equal(mailTo(bob.email).filter((m: any) => /friend|invite/i.test(m.subject)).length, 0, 'we write nothing to the friend');
  const card = JSON.stringify(await invite(ann));
  assert.ok(!card.includes(bob.email) && !card.includes('Bob'), 'the card holds counts, never who');
  assert.deepEqual([(await invite(ann)).joined, (await invite(ann)).rewarded, (await invite(ann)).signatures, (await invite(ann)).waiting], [1, 1, 3, 0]);

  // Asking again gives nothing twice.
  await cron.tick();
  await referrals.settleReferrals();
  assert.equal(await left(ann), 6);
  assert.equal(await left(bob), 5);
  assert.equal(mailTo(ann.email).filter((m: any) => /Your friend signed/.test(m.subject)).length, 1);
});

test('reward signatures are used like any other and plant trees', async () => {
  // Bob has 2 of the trial and 3 from the invite. Five more people sign: all five are his to send with.
  for (let i = 0; i < 5; i++) await firstSigned(bob);
  assert.equal(await left(bob), 0);
  assert.equal(lots(bob)[0].used, 3, 'the three reward signatures were signed with');
  const trees = (await bob.c.get('/billing')).data.mangroves;
  assert.equal(trees, 6 * PRICING.treesPerSignature, 'six signatures, the reward ones included, each plant the same');
});

test('with the code in the form and a phone number from the start, the reward lands the moment the document is signed', async () => {
  const inv = await invite(ann);
  const cy = await person('Cy', { ref: inv.code });
  assert.equal(row(cy).status, 'pending');
  await firstSigned(cy);
  assert.equal(row(cy).status, 'rewarded', 'no timer needed');
  assert.equal(await left(ann), 9);
  assert.equal(await left(cy), 5);
});

test('signing your own document is not a first signed document, and an unconfirmed address is not a real account', async () => {
  const inv = await invite(ann);
  const own = await person('Own', { ref: inv.code });
  // He sends a document to himself and signs it: free, and no signature of his is used.
  const me = (await own.c.get('/me')).data.user;
  const e = await simple(own.c, own.email, { recipients: [{ id: 'r', role: 'signer', name: me.name, email: own.email }] });
  assert.equal((await own.c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, own.email)).status, 200);
  await cron.tick();
  assert.equal(row(own).status, 'pending');
  assert.equal(await left(own), 3);

  const un = await person('Un', { ref: inv.code, unverified: true });
  await cron.tick();
  assert.equal(row(un).status, 'pending');
  assert.equal(await left(ann), 9, 'nothing for either of them');
});

test('a sign-up without a link, and one with a code nobody has, write nothing down', async () => {
  const a = await person('Plain');
  const b = await person('Typo', { ref: 'zzzzzzzz' });
  assert.equal(row(a), null);
  assert.equal(row(b), null);
});

// ---- Never for inviting yourself ----------------------------------------------------------------------------------------

let cara: Person, caraCode = '';
test('the same mailbox in another spelling is refused at sign-up', async () => {
  cara = await person('Cara', { email: 'cara.lee@gmail.com' });
  caraCode = (await invite(cara)).code;
  const twin = await person('Twin', { ref: caraCode, email: 'caralee@googlemail.com' });
  assert.deepEqual([row(twin).status, row(twin).reason], ['refused', 'same_email']);
  await firstSigned(twin);
  assert.equal(await left(cara), 3);
  assert.equal(await left(twin), 2, 'the trial, one used, and nothing more');
});

test('the same browser is refused: the device cookie of the inviting account', async () => {
  assert.ok(cara.c.cookies.gs_dev, 'looking at the invite card gave the browser its cookie');
  const second = await person('Second', { ref: caraCode, cookies: { gs_dev: cara.c.cookies.gs_dev } });
  assert.deepEqual([row(second).status, row(second).reason], ['refused', 'same_device']);
});

test('the same internet address within a day is refused, and two days later it is not', async () => {
  const near = await person('Near', { ref: caraCode, ip: cara.ip });
  assert.deepEqual([row(near).status, row(near).reason], ['refused', 'same_ip']);
  // Dora looked at her card from a cafe. A friend signs up from the same cafe two days later: that is a friend.
  const dora = await person('Dora', { ip: '203.0.113.77' });
  const code = (await invite(dora)).code;
  travel(2);
  const later = await person('Later', { ref: code, ip: '203.0.113.77' });
  assert.equal(row(later).status, 'pending');
  await firstSigned(later);
  assert.equal(row(later).status, 'rewarded');
  // An address we cannot tell apart (no proxy in front) never counts as the same.
  process.env.TRUSTED_PROXY_HOPS = '0';
  try {
    const eve = await person('Evie');
    const evieCode = (await invite(eve)).code;
    const fog = await person('Fog', { ref: evieCode });
    assert.equal(row(fog).status, 'pending');
  } finally {
    delete process.env.TRUSTED_PROXY_HOPS;
  }
});

test('the same phone number as the inviter is refused when the reward would land', async () => {
  const same = await person('Same', { ref: caraCode, phone: null });
  assert.equal(row(same).status, 'pending', 'nothing to compare at sign-up');
  db.run('UPDATE users SET phone=? WHERE id=?', `0${normalPhone(cara.phone)}`, same.uid);
  await firstSigned(same);
  assert.deepEqual([row(same).status, row(same).reason], ['refused', 'same_phone']);
  assert.equal(await left(cara), 3);
  assert.equal(lots(same).length, 0);
});

test('one reward per friend: a phone number that was a rewarded friend before is refused, whoever invites', async () => {
  const one = await person('One', { ref: caraCode, phone: '+44 7700 900123' });
  await firstSigned(one);
  assert.equal(row(one).status, 'rewarded');
  assert.equal(await left(cara), 6);
  const other = await person('Other');
  const two = await person('Two', { ref: (await invite(other)).code, phone: '0044 7700 900 123' });
  await firstSigned(two);
  assert.deepEqual([row(two).status, row(two).reason], ['refused', 'phone_used']);
  assert.equal(await left(other), 3);
  // And one login is one line: a second sign-up cannot be made for the same login at all (the address is taken).
  assert.equal(db.get('SELECT COUNT(*) n FROM referrals WHERE friend_user_id=?', one.uid).n, 1);
});

test('an address that had a login here before is not a new friend', async () => {
  const { welcomeMark } = await import('../src/server/routes-trust.ts');
  db.run('INSERT INTO welcomed (email_hash, at) VALUES (?,?)', welcomeMark('back@ref.example'), new Date().toISOString());
  const back = await person('Back', { ref: caraCode, email: 'back@ref.example' });
  assert.deepEqual([row(back).status, row(back).reason], ['refused', 'welcomed_before']);
});

test('a friend who joined the inviting account in the meantime is the same account', async () => {
  const mate = await person('Mate', { ref: caraCode });
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'member',?)", cara.id, mate.uid, new Date().toISOString());
  await firstSigned(mate);
  assert.deepEqual([row(mate).status, row(mate).reason], ['refused', 'same_account']);
});

test('every refusal has plain words for the operators, and the card of the inviter does not count refused friends', async () => {
  for (const r of db.all("SELECT DISTINCT reason FROM referrals WHERE status='refused'")) assert.ok((REFERRAL_REFUSALS as any)[r.reason], r.reason);
  const card = await invite(cara);
  assert.deepEqual([card.joined, card.rewarded, card.signatures], [1, 1, 3]);
});

// ---- Taking it back -------------------------------------------------------------------------------------------------------

test('a reward is taken back when the friend is paused for abuse: what is left leaves, what was used stays', async () => {
  const eve = await person('Eve');
  const code = (await invite(eve)).code;
  const finn = await person('Finn', { ref: code });
  const wait = await person('Wait', { ref: code, phone: null });
  await firstSigned(finn);
  assert.equal(row(finn).status, 'rewarded');
  // Eve uses four: the three of the trial go first (they end sooner), then one of the reward.
  for (let i = 0; i < 4; i++) await firstSigned(eve);
  assert.equal(await left(eve), 2);
  assert.deepEqual([lots(eve)[0].used, lots(eve)[0].left], [1, 2]);

  // An operator pauses Finn's account, and Wait's as well.
  process.env.OPERATOR_EMAILS = ann.email;
  for (const p of [finn, wait]) assert.equal((await ann.c.post(`/operator/accounts/${p.id}`, { paused: true, reason: 'Fake payment notices' })).status, 200);
  const r = row(finn);
  assert.deepEqual([r.status, r.taken_back], ['taken_back', 5], '2 left with Eve and 3 left with Finn');
  assert.ok(r.taken_back_at);
  assert.equal(await left(eve), 0);
  const lot = lots(eve)[0];
  assert.deepEqual([lot.used, lot.adjusted, lot.left], [1, 2, 0], 'the one she signed with stays used');
  assert.deepEqual([lots(finn)[0].adjusted, lots(finn)[0].left], [3, 0]);
  assert.match(db.get("SELECT detail FROM billing_log WHERE account_id=? AND what='referral-back'", eve.id).detail, /paused for abuse, so the reward for that invite was taken back: 2 signatures left your balance, and the 1 signature already used or expired stays as it is\./);
  // The ledger still accounts for every signature.
  const sums = credits.ledgerSums(eve.id);
  assert.equal(sums.bought + sums.given, sums.used + sums.held + sums.refunded + sums.expired + sums.adjusted + sums.left);
  // An invite that was still waiting is refused, and pausing again takes nothing twice.
  assert.deepEqual([row(wait).status, row(wait).reason], ['refused', 'friend_closed']);
  assert.equal(referrals.referralAbuse(finn.id), 0);
  // A paused account's own link earns nothing while the pause lasts.
  assert.equal((await new Client().get(`/public/referrals/${(await invite(finn)).code}`)).data.ok, false);
  const late = await person('Late', { ref: (await invite(finn)).code });
  assert.deepEqual([row(late).status, row(late).reason], ['refused', 'inviter_closed']);
});

// ---- The operators' record ----------------------------------------------------------------------------------------------------

test('an operator sees who invited whom, where it stands and why; nobody else does', async () => {
  const r = await ann.c.get('/operator/referrals');
  assert.equal(r.status, 200);
  const mine = r.data.referrals.find((x: any) => x.friend.email === bob.email);
  assert.deepEqual([mine.status, mine.inviter.account_id, mine.inviter.email, mine.inviter.signatures, mine.friend.signatures], ['rewarded', ann.id, ann.email, 3, 3]);
  const refused = r.data.referrals.find((x: any) => x.friend.email === 'caralee@googlemail.com');
  assert.deepEqual([refused.status, refused.reason], ['refused', REFERRAL_REFUSALS.same_email]);
  assert.ok(r.data.referrals.some((x: any) => x.status === 'taken_back' && x.taken_back === 5));
  const only = await ann.c.get(`/operator/referrals?account_id=${cara.id}`);
  assert.ok(only.data.referrals.length > 3 && only.data.referrals.every((x: any) => x.inviter.account_id === cara.id || x.friend.account_id === cara.id));
  assert.equal((await bob.c.get('/operator/referrals')).status, 404);
  delete process.env.OPERATOR_EMAILS;
  assert.equal((await ann.c.get('/operator/referrals')).status, 404);
});

// ---- The stop link of the email -------------------------------------------------------------------------------------------------

test('the stop link: opening it changes nothing, its button stops the emails, and rewards still arrive', async () => {
  const mail = mailTo(ann.email).find((m: any) => /Your friend signed/.test(m.subject))!;
  const href = /href="([^"]*referral-emails[^"]*)"/.exec(mail.html)![1].replace(/&amp;/g, '&');
  const api = href.replace('http://test.local/api', '');
  const visitor = new Client();
  const page = await visitor.get(api);
  assert.equal(page.status, 200);
  assert.match(new TextDecoder().decode(page.data), /Stop emails about invited friends\?[\s\S]*<button type="submit">Stop these emails<\/button>/);
  assert.equal((await invite(ann)).emails, true, 'a mail program that opens every link changes nothing');
  const off = await visitor.call('POST', `${api}&emails=off`);
  assert.match(new TextDecoder().decode(off.data), /These emails are stopped/);
  assert.equal((await invite(ann)).emails, false);

  const before = mailTo(ann.email).length;
  const gus = await person('Gus', { ref: (await invite(ann)).code });
  await firstSigned(gus);
  assert.equal(row(gus).status, 'rewarded');
  assert.equal(mailTo(ann.email).length, before, 'no email, and the signatures arrived all the same');
  assert.equal(lots(ann).length, 3);

  await visitor.call('POST', `${api}&emails=on`);
  assert.equal((await invite(ann)).emails, true);
  assert.equal((await visitor.get('/public/referral-emails?token=acc_nobody.0000')).status, 404);
  assert.equal((await visitor.get(`/public/referral-emails?token=${encodeURIComponent(`${bob.id}.${'0'.repeat(32)}`)}`)).status, 404, 'a token cannot be made up for another account');
});

// ---- Where someone runs out ---------------------------------------------------------------------------------------------------------

test('running out: the refusal of a send and the emails at two left and at none carry the offer', async () => {
  const hal = await person('Hal');
  const code = (await invite(hal)).code;
  for (let i = 0; i < 3; i++) await firstSigned(hal);
  assert.equal(await left(hal), 0);
  const e = await simple(hal.c, 'more@sign.example');
  const r = await hal.c.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 402);
  assert.ok(r.data.error.endsWith('Signing your own documents stays free. Or invite a friend from the Plan page: you both get 3 free signatures after their first signed document.'), r.data.error);
  // "You have 1 left" (sent at two left) and "You have used all your signatures": both name the link.
  const low = mailTo(hal.email).filter((m: any) => /signatures? left|used all your signatures/.test(m.subject));
  assert.equal(low.length, 2);
  for (const m of low) assert.ok(text(m.html).includes(`Or invite a friend: when their first document is signed, you both get 3 free signatures. Your invite link: http://test.local/r/${code}`), m.subject);
});

test('the screens: every out-of-signatures place shows the two choices, and the Plan page has Invite friends', () => {
  const en = JSON.parse(src('src/locales/en.json'));
  assert.equal(en['invite.more_title'], 'Get more signatures');
  assert.equal(en['invite.title'], 'Invite a friend, get {count} free signatures each');
  assert.equal(en['auth.friend_invited'], 'A friend invited you: you both get {count} free signatures after your first signed document.');

  const parts = src('src/components/sender/InviteFriend.tsx');
  // Two choices side by side, the link, Copy, and share buttons that open the person's own apps.
  assert.match(parts, /className="inv-choices" role="group"/);
  assert.match(parts, /T\('invite\.more_title'\)[\s\S]*T\('invite\.title', \{ count: inv\.rules\.signatures \}\)/);
  assert.match(parts, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(parts, /href=\{`mailto:\?subject=/, 'the email button opens the person\'s own mail program, with no address filled in');
  assert.match(parts, /navigator\.share\(\{/);
  assert.match(parts, /canShare && <button/, 'the share sheet only where the browser has one');
  // Nothing is uploaded and nothing is sent by us: no address book, no call that posts addresses.
  assert.ok(!/navigator\.contacts|ContactsManager|method: 'POST'|body:/.test(parts));
  // The card: the link, how many joined, how many rewards, the rules in three lines.
  assert.match(parts, /id="invite"[\s\S]*invite\.joined[\s\S]*invite\.rewarded[\s\S]*invite\.rule_how[\s\S]*invite\.rule_limits[\s\S]*invite\.rule_fair/);
  assert.equal((parts.match(/<li>\{T\('invite\.rule_/g) || []).length, 3);
  const css = src('src/app/styles/sender.css');
  assert.match(css, /\.inv-choices \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.inv-choices \{ grid-template-columns: minmax\(0, 1fr\); \}/);

  // Home (the usage meter): at none left and at "Running low" (two or one left).
  const meter = src('src/components/sender/UsageMeter.tsx');
  assert.match(meter, /\{left <= 2 && <LowChoices plan=\{a\.plan\} canUpgrade=\{canUpgrade\} \/>\}/);
  assert.match(meter, /function LowChoices[\s\S]*<InviteChoices inv=\{inv\}/);
  // The send stop screen: step 3 of the editor, inside the "this needs more than you have" notice.
  const review = src('src/components/editor/StepReview.tsx');
  assert.match(review, /if \(need > have\) \{[\s\S]*<InviteChoices inv=\{inv\} more=\{<>[\s\S]*\/billing\/topup[\s\S]*\/billing\/checkout/);
  // The Plan page: the choices when none are left, and the Invite friends card always.
  const plan = src('src/app/app/settings/page.tsx');
  assert.match(plan, /\{s\.available <= 0 && inv\?\.open && \(\s*<InviteChoices inv=\{inv\}/);
  assert.match(plan, /<InviteCard inv=\{inv\} bare=/);
  // The sign-up page says a friend invited you, and never who.
  const auth = src('src/components/AuthForm.tsx');
  assert.match(auth, /mode === 'signup' && friend > 0 && <div className="notice"[^>]*>\{T\('auth\.friend_invited', \{ count: friend \}\)\}/);
  // The short link is a page that leads to sign-up.
  assert.ok(existsSync(path.join(root, 'src/app/r/[code]/page.tsx')));
  assert.match(src('src/app/r/[code]/page.tsx'), /redirect\(isReferralCode\(code\) \? `\/signup\?ref=\$\{code\}` : '\/signup'\)/);
});

test('honest wording everywhere it is said, and no em dash in any of it', async () => {
  const rule = referralRuleText();
  assert.match(src('src/app/pricing/page.tsx'), /Invite a friend:<\/b> you both get \{sigs\(referralRulesFrom\(process\.env\)\.signatures\)\} free after their first signed document/);
  assert.match(src('src/app/help/page.tsx'), /<QA id="invite" q="How do I get free signatures by inviting a friend\?">\s*<p>\{referralRuleText\(referralRulesFrom\(process\.env\)\)\}<\/p>/);
  assert.match(src('src/server/chatkb.ts'), /=== INVITE A FRIEND ===/);
  const readme = src('README.md');
  for (const part of ['Invite a friend (`src/server/referrals.ts`', '`REFERRAL_SIGNATURES`', '`REFERRAL_EXPIRY_DAYS`', '`REFERRAL_MONTHLY_MAX`', '`REFERRAL_TOTAL_MAX`', 'expire 30 days after they arrive', 'this server keeps no fingerprint of', 'the code has no list of them', '`tests/referrals.test.ts`']) assert.ok(readme.includes(part), part);
  const env = src('.env.example');
  for (const name of ['REFERRALS', 'REFERRAL_SIGNATURES', 'REFERRAL_EXPIRY_DAYS', 'REFERRAL_MONTHLY_MAX', 'REFERRAL_TOTAL_MAX']) assert.match(env, new RegExp(`^# ${name}=`, 'm'));
  const api = (await ann.c.get('/openapi.json')).data;
  assert.ok(api.paths['/referrals'].get.description.startsWith(rule));
  for (const p of ['/public/referrals/{code}', '/public/referral-emails', '/operator/referrals']) assert.ok(api.paths[p], p);
  const { listRoutes } = await import('../src/server/router.ts');
  const ours = listRoutes().filter((r) => /referral/.test(r.path)).map((r) => `${r.method} ${r.path} ${r.level}`).sort();
  assert.deepEqual(ours, ['GET /operator/referrals user', 'GET /public/referral-emails public', 'GET /public/referrals/:code public', 'GET /referrals user', 'POST /public/referral-emails public']);
  for (const r of ours) assert.ok(api.paths[r.split(' ')[1].replace(/:(\w+)/g, '{$1}')], r);
  // "r" is kept for us among the share names, so no document can sit at /r.
  const { RESERVED } = await import('../src/lib/sharename.ts');
  assert.ok(RESERVED.has('r') && RESERVED.has('referral') && RESERVED.has('referrals'));
  for (const f of ['src/lib/referral.ts', 'src/server/referrals.ts', 'src/server/routes-referrals.ts', 'src/server/openapi-referrals.ts', 'src/components/sender/InviteFriend.tsx', 'src/app/r/[code]/page.tsx', 'tests/referrals.test.ts'])
    assert.ok(!src(f).includes(String.fromCharCode(0x2014)), `an em dash in ${f}`);
  for (const [key, value] of Object.entries(JSON.parse(src('src/locales/en.json')))) if (/^invite\.|^auth\.friend/.test(key)) assert.ok(!String(value).includes(String.fromCharCode(0x2014)), key);
});

// ---- The switches -----------------------------------------------------------------------------------------------------------------------

test('REFERRALS=0, and a server where nothing is counted: no link, no offer, nothing written down', async () => {
  const code = (await invite(ann)).code;
  const key = process.env.STRIPE_SECRET_KEY;
  for (const off of [() => (process.env.REFERRALS = '0'), () => delete process.env.STRIPE_SECRET_KEY]) {
    off();
    try {
      assert.deepEqual(await invite(ann), { on: false, rules: REFERRAL_DEFAULTS });
      assert.equal((await new Client().get(`/public/referrals/${code}`)).data.ok, false);
      const nobody = await person('Nobody', { ref: code });
      assert.equal(row(nobody), null);
      assert.equal(referrals.inviteSentence(ann.id), '');
    } finally {
      delete process.env.REFERRALS;
      process.env.STRIPE_SECRET_KEY = key;
    }
  }
  assert.equal((await invite(ann)).on, true);
});

// ---- The limits, and expiry (the clock moves from here on) ---------------------------------------------------------------------------

test('the limits: 2 a month and 3 in all here; over the month the friend still gets theirs, at the total the link is closed', async () => {
  process.env.REFERRAL_MONTHLY_MAX = '2';
  process.env.REFERRAL_TOTAL_MAX = '3';
  try {
    // Start at the first of a month, so "this month" is the same month for the whole first half.
    const today = new Date();
    travel((Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1, 12) - today.getTime()) / DAY);
    const ida = await person('Ida');
    const code = (await invite(ida)).code;
    // Three friends sign up while the link is open. Two are rewarded on both sides.
    const friends = [await person('F1', { ref: code }), await person('F2', { ref: code }), await person('F3', { ref: code })];
    await firstSigned(friends[0]);
    await firstSigned(friends[1]);
    assert.equal(await left(ida), 9);
    const card = await invite(ida);
    assert.deepEqual([card.rewarded, card.month_left, card.total_left, card.open], [2, 0, 1, false]);
    assert.equal((await new Client().get(`/public/referrals/${code}`)).data.ok, false, 'the sign-up page promises nothing while the link is at its limit');
    assert.equal(referrals.inviteSentence(ida.id), '', 'and the out-of-signatures message does not offer it');
    // The third signed up while the promise stood: they get theirs, the inviter gets none for them.
    await firstSigned(friends[2]);
    const r3 = row(friends[2]);
    assert.deepEqual([r3.status, r3.inviter_got, r3.friend_got], ['rewarded', 0, 3]);
    assert.match(r3.reason, /limit of rewarded friends for the month/);
    assert.equal(await left(ida), 9);
    assert.equal(await left(friends[2]), 5);
    assert.equal(mailTo(ida.email).filter((m: any) => /Your friend signed/.test(m.subject)).length, 2);

    // Next month the link is open again, for one more: then the total is reached.
    travel(32);
    await login(ida);
    assert.deepEqual([(await invite(ida)).month_left, (await invite(ida)).total_left, (await invite(ida)).open], [2, 1, true]);
    const f4 = await person('F4', { ref: code });
    const f5 = await person('F5', { ref: code });
    await firstSigned(f4);
    assert.deepEqual([row(f4).status, row(f4).inviter_got], ['rewarded', 3]);
    assert.match(text(mailTo(ida.email).filter((m: any) => /Your friend signed/.test(m.subject)).at(-1)!.html), /That was the last friend your link is rewarded for this month\./);
    assert.deepEqual([(await invite(ida)).total_left, (await invite(ida)).open], [0, false]);
    // F5 signed up before the total was reached; when their turn comes, the total has been reached: nothing for either.
    await firstSigned(f5);
    assert.deepEqual([row(f5).status, row(f5).reason, row(f5).friend_got], ['refused', 'total_limit', 0]);
    const f6 = await person('F6', { ref: code });
    assert.deepEqual([row(f6).status, row(f6).reason], ['refused', 'total_limit']);
    assert.equal(db.get('SELECT COUNT(*) n FROM referrals WHERE inviter_account_id=? AND inviter_got > 0', ida.id).n, 3);
  } finally {
    delete process.env.REFERRAL_MONTHLY_MAX;
    delete process.env.REFERRAL_TOTAL_MAX;
  }
});

test('expiry: reward signatures that were not used are gone 30 days after they arrived, with a line that says so', async () => {
  // More than 30 days have passed since Ann's rewards. The timer writes them off.
  await cron.tick();
  for (const lot of lots(ann)) {
    assert.equal(lot.live, false);
    assert.deepEqual([lot.expired, lot.left], [3, 0]);
  }
  await login(ann);
  assert.equal(await left(ann), 0, 'the trial and all three rewards have run out');
  const lines = db.all("SELECT detail FROM billing_log WHERE account_id=? AND what='expired'", ann.id).map((l: any) => l.detail);
  assert.ok(lines.some((l: string) => /^3 of the 3 signatures for inviting a friend that arrived on .* expired unused\.$/.test(l)), lines.join(' | '));
  assert.equal(expiredWords({ n: 3, at: '2026-12-01T10:00:00.000Z', source: 'referral' }), '3 unused signatures from inviting a friend expired on 1 December 2026 at 10:00 UTC.');
  // A new friend after that brings a fresh lot with its own 30 days.
  const zed = await person('Zed', { ref: (await invite(ann)).code });
  await firstSigned(zed);
  assert.equal(await left(ann), 3);
  const fresh = lots(ann).filter((l) => l.live);
  assert.equal(fresh.length, 1);
  assert.ok(Math.abs(Date.parse(fresh[0].expires_at!) - Date.now() - 30 * DAY) < 60_000);
});

test('fingerprints of browsers and addresses are forgotten after 90 days', async () => {
  const before = db.get('SELECT COUNT(*) n FROM referral_devices').n;
  assert.ok(before > 0);
  travel(91);
  const out = await referrals.referralsTick();
  assert.equal(out.forgotten, before);
  assert.equal(db.get('SELECT COUNT(*) n FROM referral_devices').n, 0);
  assert.ok(!db.all('SELECT device, ip FROM referral_devices').length);
});
