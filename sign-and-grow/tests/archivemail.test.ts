// Archive copies of emails: up to five addresses an admin names, each confirmed from its own inbox, get a copy of every
// email the account sends about its documents, as an email of their own, with every signing link, security code and
// one-time code taken out. Stored and tried again like the rest, never counted towards a limit, never a bounce on a
// recipient, waiting while sending is paused. And SMTP_REQUIRE_TLS, which hands nothing over unencrypted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { boot, Client, signUp, upload, simple, signAll, tokenFor, PNG, type Server } from './helpers.ts';
import { fmtCode } from '../src/server/util.ts';
import { ARCHIVE_LINK_REMOVED, ARCHIVE_CODE_REMOVED, ARCHIVE_MAX_ADDRESSES, ARCHIVE_BOUNCES_TO_PAUSE, ARCHIVE_ASKS_PER_ADDRESS_DAY } from '../src/lib/archivemail.ts';

let db: Server['db'];
let cron: Server['cron'];
let mail: typeof import('../src/server/mail.ts');
let arch: typeof import('../src/server/archivemail.ts');
let flushComments: (id?: string) => Promise<any>;
before(async () => {
  ({ db, cron } = await boot());
  mail = await import('../src/server/mail.ts');
  arch = await import('../src/server/archivemail.ts');
  flushComments = (await import('../src/server/routes-comments.ts')).flushComments;
});
after(() => {
  delete process.env.SMTP_URL;
  delete process.env.SMTP_REQUIRE_TLS;
  delete process.env.MAIL_EVENTS_TOKEN;
  (globalThis as any).__tsmail = undefined;
});

let n = 0;
const ip = () => `10.${200 + Math.floor(++n / 250)}.${n % 250}.9`;
const person = (name: string, email: string) => signUp(name, email, ip());
const browser = () => Object.assign(new Client(), { ip: ip() });
const accountOf = async (c: Client) => (await c.get('/me')).data.account.id as string;

// The link in the newest email that asked this address to confirm, as only its inbox has it.
const confirmToken = (email: string) => new URL(db.get('SELECT link FROM emails WHERE to_email=? AND archive_to IS NOT NULL AND archive_envelope IS NULL ORDER BY id DESC LIMIT 1', email)?.link).searchParams.get('token')!;
// An admin adds the address and someone with that inbox confirms it.
async function confirmed(c: Client, email: string) {
  const r = await c.post('/account/archive-addresses', { email });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ok = await browser().post('/public/archive-confirm', { token: confirmToken(email), answer: 'yes' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  return r.data.address.id as string;
}
const copiesTo = (email: string) => db.all('SELECT * FROM emails WHERE to_email=? AND archive_envelope IS NOT NULL ORDER BY id', email);
// Every email of these envelopes that left, and the copies of them that went to one archive address.
const originals = (ids: string[]) => db.all(`SELECT * FROM emails WHERE envelope_id IN (${ids.map(() => '?').join(',')}) AND status IN ('sent','outbox') ORDER BY id`, ...ids);

// Every secret that opens or signs something of these envelopes.
function secretsOf(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    for (const r of db.all('SELECT token t, check_code c FROM recipients WHERE envelope_id=? UNION ALL SELECT token, check_code FROM recipient_members WHERE envelope_id=? UNION ALL SELECT token, check_code FROM retired_tokens WHERE envelope_id=? OR recipient_id IN (SELECT id FROM recipients WHERE envelope_id=?)', id, id, id, id)) {
      if (r.t) out.push(r.t);
      if (r.c) out.push(r.c, fmtCode(r.c));
    }
  }
  return out;
}
function assertClean(copy: any, secrets: string[], what = copy.subject) {
  const p = JSON.parse(copy.payload);
  for (const part of [copy.html, p.text, copy.subject]) {
    for (const s of secrets) assert.equal(String(part).includes(s), false, `${what}: a secret is in the copy`);
    assert.doesNotMatch(String(part), /\/sign\/[A-Za-z0-9_-]{8,}/, `${what}: a signing link is in the copy`);
    assert.doesNotMatch(String(part), /check\?code=|help\?topic=signing&amp;code=|help\?topic=signing&code=/, `${what}: a link with a security code is in the copy`);
  }
  assert.equal(copy.link, null);
  assert.equal(copy.envelope_id, null, 'a copy is never one of the envelope\'s own emails');
  assert.equal(copy.recipient_id, null);
}

// ---- 1. Settings: up to five, each confirmed from its own inbox -------------------------------------------------------

test('an address gets nothing until someone with its inbox confirms it, and only admins, signed in, can add one', async () => {
  const owner = await person('Olu Owner', 'olu@council.example');
  const records = 'records@council.example';
  assert.equal((await owner.post('/account/archive-addresses', { email: 'not an address' })).status, 400);
  const added = await owner.post('/account/archive-addresses', { email: ' Records@Council.example ' });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.address.email, records);
  assert.equal(added.data.address.state, 'waiting');
  assert.equal(added.data.message, 'We sent a link to confirm it. Copies start once it is confirmed.');
  const ask = db.get('SELECT * FROM emails WHERE to_email=? ORDER BY id DESC LIMIT 1', records);
  assert.match(ask.subject, /^Confirm: copies of emails from/);
  assert.ok(ask.expires_at, 'the link in it runs out');
  assert.equal(db.get('SELECT confirm_hash h FROM archive_addresses WHERE email=?', records).h.length, 64, 'only a fingerprint of the link is kept');
  assert.equal(JSON.stringify((await owner.get('/account/archive-addresses')).data).includes(confirmToken(records)), false, 'the admin never sees the link');

  // Not confirmed: an envelope goes out and nothing goes to the address.
  const e1 = await simple(owner, 'sam@resident.example', { send: true });
  assert.equal(copiesTo(records).length, 0);

  // Opening the page changes nothing (a mail program that checks links does exactly that).
  const tok = confirmToken(records);
  const look = await browser().get(`/public/archive-confirm?token=${tok}`);
  assert.equal(look.status, 200, JSON.stringify(look.data));
  assert.equal(look.data.state, 'waiting');
  assert.equal(look.data.email, records);
  assert.equal(db.get('SELECT confirmed_at c FROM archive_addresses WHERE email=?', records).c, null);
  assert.equal((await browser().post('/public/archive-confirm', { token: 'made-up', answer: 'yes' })).status, 404);
  assert.equal((await browser().post('/public/archive-confirm', { token: tok, answer: 'maybe' })).status, 400);

  const yes = await browser().post('/public/archive-confirm', { token: tok, answer: 'yes' });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  assert.equal(yes.data.state, 'confirmed');
  assert.equal((await browser().post('/public/archive-confirm', { token: tok, answer: 'yes' })).status, 404, 'the link works once');
  assert.ok(db.all("SELECT subject FROM emails WHERE to_email='olu@council.example'").some((m) => /now go to records@council\.example/.test(m.subject)), 'the owner and admins hear of it');
  assert.ok(db.get("SELECT 1 x FROM security_events WHERE account_id=? AND kind='settings.changed' AND about_type='archive_address'", await accountOf(owner)), 'and it is in the security record');
  assert.equal(copiesTo(records).length, 0, 'emails sent before the confirmation are not copied');

  // Confirmed: the next envelope is copied.
  const e2 = await simple(owner, 'tia@resident.example', { send: true });
  assert.equal(copiesTo(records).length, 1);
  assert.equal(copiesTo(records)[0].archive_envelope, e2.id);
  assert.notEqual(e1.id, e2.id);

  // Asking again for an address that takes copies sends nothing.
  assert.equal((await owner.post('/account/archive-addresses', { email: records })).status, 409);

  // A member reads that copies go somewhere, never where; a member cannot add one.
  await owner.post('/account/invites', { email: 'mo@council.example', role: 'member' });
  const inv = db.get("SELECT token FROM invites WHERE email='mo@council.example'").token;
  const mo = browser();
  assert.equal((await mo.post('/auth/signup', { name: 'Mo Member', email: 'mo@council.example', password: 'correct horse battery', invite: inv })).status, 200);
  const seen = await mo.get('/account/archive-addresses');
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.data, { may_change: false, taking: 1 });
  assert.equal((await mo.post('/account/archive-addresses', { email: 'mine@private.example' })).status, 403);

  // An API key reads the list and cannot change it: a leaked key must not add its own inbox.
  const key = (await owner.post('/api-keys', { name: 'records', scope: 'admin' })).data.key;
  const api = new Client();
  const call = api.call.bind(api);
  api.call = (m: string, u: string, b?: any, h: Record<string, string> = {}) => call(m, u, b, { authorization: `Bearer ${key}`, ...h });
  assert.equal((await api.get('/account/archive-addresses')).data.addresses.length, 1);
  const byKey = await api.post('/account/archive-addresses', { email: 'thief@elsewhere.example' });
  assert.equal(byKey.status, 403);
  assert.match(byKey.data.error, /An API key cannot add an archive address/);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='thief@elsewhere.example'").n, 0);
  const id = (await owner.get('/account/archive-addresses')).data.addresses[0].id;
  assert.equal((await api.call('DELETE', `/account/archive-addresses/${id}`)).status, 403);

  // Another account can neither see, remove nor confirm it.
  const other = await person('Ola Other', 'ola@other.example');
  assert.equal((await other.call('DELETE', `/account/archive-addresses/${id}`)).status, 404);
  assert.equal((await other.get('/account/archive-addresses')).data.addresses.length, 0);
});

test('at most five, "this was not me" stops the asking for 30 days and can be taken back at once, and asking is limited', async () => {
  const owner = await person('Ama Owner', 'ama@limits.example');
  for (let i = 1; i <= ARCHIVE_MAX_ADDRESSES; i++) assert.equal((await owner.post('/account/archive-addresses', { email: `box${i}@limits.example` })).status, 200);
  const sixth = await owner.post('/account/archive-addresses', { email: 'box6@limits.example' });
  assert.equal(sixth.status, 409);
  assert.match(sixth.data.error, /can have 5 archive addresses/);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='box6@limits.example'").n, 0, 'nothing was sent to the sixth');

  // The reader of box1 did not ask for it.
  const tok = confirmToken('box1@limits.example');
  const no = await browser().post('/public/archive-confirm', { token: tok, answer: 'no' });
  assert.equal(no.status, 200, JSON.stringify(no.data));
  assert.equal(no.data.state, 'refused');
  const list = (await owner.get('/account/archive-addresses')).data;
  assert.equal(list.addresses.some((a: any) => a.email === 'box1@limits.example'), false);
  assert.equal(list.refused[0].email, 'box1@limits.example');
  const again = await owner.post('/account/archive-addresses', { email: 'box1@limits.example' });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'refused');
  // Pressed by mistake: the same page takes it back, and the address waits for Confirm again.
  const undo = await browser().post('/public/archive-confirm', { token: tok, answer: 'undo' });
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal((await browser().post('/public/archive-confirm', { token: tok, answer: 'yes' })).status, 200);
  assert.equal(db.get("SELECT confirmed_at c FROM archive_addresses WHERE email='box1@limits.example'").c !== null, true);
  // A refusal older than the undo window cannot be taken back.
  const tok2 = confirmToken('box2@limits.example');
  await browser().post('/public/archive-confirm', { token: tok2, answer: 'no' });
  db.run("UPDATE archive_refused SET at=? WHERE email='box2@limits.example'", new Date(Date.now() - 2 * 3600_000).toISOString());
  assert.equal((await browser().post('/public/archive-confirm', { token: tok2, answer: 'undo' })).status, 410);

  // "Send the link again" is limited per address and per day, and says when it works again.
  for (let i = 1; i < ARCHIVE_ASKS_PER_ADDRESS_DAY; i++) assert.equal((await owner.post('/account/archive-addresses', { email: 'box3@limits.example' })).status, 200);
  const more = await owner.post('/account/archive-addresses', { email: 'box3@limits.example' });
  assert.equal(more.status, 429);
  assert.match(more.data.error, /You can send one again from/);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='box3@limits.example'").n, ARCHIVE_ASKS_PER_ADDRESS_DAY);
  // Only the newest link works.
  const newest = confirmToken('box3@limits.example');
  assert.equal((await browser().get(`/public/archive-confirm?token=${newest}`)).status, 200);

  // A link that ran out confirms nothing.
  const tok4 = confirmToken('box4@limits.example');
  db.run("UPDATE archive_addresses SET confirm_until=? WHERE email='box4@limits.example'", new Date(Date.now() - 1000).toISOString());
  const late = await browser().post('/public/archive-confirm', { token: tok4, answer: 'yes' });
  assert.equal(late.status, 410);
  assert.match(late.data.error, /ran out/);

  // Removing one frees its place, and nothing more goes to it.
  const id5 = (await owner.get('/account/archive-addresses')).data.addresses.find((a: any) => a.email === 'box5@limits.example').id;
  assert.equal((await owner.call('DELETE', `/account/archive-addresses/${id5}`)).status, 200);
  assert.equal((await owner.post('/account/archive-addresses', { email: 'box6@limits.example' })).status, 200);
});

test('a paused account asks no address, and a name that reads like a brand is refused like a team invitation', async () => {
  const owner = await person('Pia Owner', 'pia@paused.example');
  const account = await accountOf(owner);
  db.run('UPDATE accounts SET suspended_at=?, suspended_reason=? WHERE id=?', new Date().toISOString(), 'reports', account);
  const r = await owner.post('/account/archive-addresses', { email: 'records@paused.example' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /Sending is paused/);
  assert.equal(db.get("SELECT COUNT(*) n FROM archive_addresses WHERE email='records@paused.example'").n, 0, 'an address that could not be asked is not kept');
  db.run('UPDATE accounts SET suspended_at=NULL WHERE id=?', account);
  db.run("UPDATE accounts SET name='PayPal Billing Support' WHERE id=?", account);
  const posing = await owner.post('/account/archive-addresses', { email: 'records@paused.example' });
  assert.equal(posing.status, 422);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='records@paused.example'").n, 0);
});

// ---- 2. Every email about an envelope, as its own email, with nothing that opens or signs ---------------------------

test('the copy takes out links and codes, keeps the rest, and says what it is', () => {
  const s = { tokens: ['TOKENabcdefghijklmnop1234'], codes: ['ABCD2345EFGH'], codeMail: true };
  const m = arch.archiveMail({
    to: 'ada@example.com', subject: 'Please sign: Lease', heading: '482913 is your code',
    lines: ['Open http://test.local/sign/TOKENabcdefghijklmnop1234 to sign.', 'Your security code is ABCD-2345-EFGH.', 'See https://www.gov.example/rules and http://test.local/help.', 'Signed on 20 November 2026 at 14:05 UTC, 2026-11-20.', 'Stop: http://test.local/sign/TOKENabcdefghijklmnop1234?mute=1'],
    links: [{ label: 'Lease', url: 'http://test.local/sign/TOKENabcdefghijklmnop1234', note: 'from Jo' }],
    cta: { label: 'Review and sign', url: 'http://test.local/sign/TOKENabcdefghijklmnop1234' }, code: 'ABCD2345EFGH', expiresAt: new Date().toISOString(),
  }, s);
  const all = [m.subject, m.heading, ...m.lines].join('\n');
  assert.equal(all.includes('TOKENabcdefghijklmnop1234'), false);
  assert.equal(all.includes('ABCD'), false);
  assert.equal(all.includes('482913'), false);
  assert.match(m.heading, new RegExp(`^${ARCHIVE_CODE_REMOVED.replace(/[()]/g, '\\$&')} is your code$`));
  assert.ok(m.lines.includes(`Review and sign: ${ARCHIVE_LINK_REMOVED}`));
  assert.ok(m.lines.includes(`Lease (from Jo): ${ARCHIVE_LINK_REMOVED}`));
  assert.ok(m.lines.includes(`Security code: ${ARCHIVE_CODE_REMOVED}`));
  assert.match(all, /https:\/\/www\.gov\.example\/rules/, 'a link to another site stays');
  assert.match(all, /http:\/\/test\.local\/help\./, 'a link to a page of ours that opens nothing stays');
  assert.match(all, /20 November 2026 at 14:05 UTC, 2026-11-20/, 'dates and times stay, also in an email with a code');
  assert.equal(m.cta, undefined);
  assert.equal(m.code, undefined);
  assert.equal(m.subject, 'Archive copy: Please sign: Lease');
});

test('every kind of email about an envelope is copied to each confirmed address, as its own email, with no link, security code or one-time code in it', async () => {
  const owner = await person('Rae Records', 'rae@town.example');
  const A = 'archive-a@town.example', B = 'archive-b@town.example';
  await confirmed(owner, A);
  await confirmed(owner, B);
  const ids: string[] = [];
  const otp: string[] = [];

  // A request, a reminder, a deadline warning, a decline.
  const e1 = await simple(owner, 'dee@resident.example', { send: true, subject: 'Parking permit', expire_days: 10 });
  ids.push(e1.id);
  assert.equal((await owner.post(`/envelopes/${e1.id}/remind`)).status, 200);
  db.run('UPDATE envelopes SET expires_at=?, sent_at=? WHERE id=?', new Date(Date.now() + 2 * 864e5).toISOString(), new Date(Date.now() - 8 * 864e5).toISOString(), e1.id);
  await cron.tick();
  assert.equal((await browser().post(`/sign/${tokenFor(e1.id, 'dee@resident.example')}/decline`, { reason: 'Wrong street' })).status, 200);

  // Voided, and corrected (a new address for a signer: the old one is told, the new one asked).
  const e2 = await simple(owner, 'eli@resident.example', { send: true, subject: 'Hall booking' });
  ids.push(e2.id);
  const rid = db.get('SELECT id FROM recipients WHERE envelope_id=?', e2.id).id;
  assert.equal((await owner.post(`/envelopes/${e2.id}/correct`, { recipient_id: rid, email: 'eli.new@resident.example' })).status, 200);
  assert.equal((await owner.post(`/envelopes/${e2.id}/void`, { reason: 'Booked twice' })).status, 200);

  // A comment and its answer.
  const e3 = await simple(owner, 'fay@resident.example', { send: true, subject: 'Tree survey' });
  ids.push(e3.id);
  const fay = browser();
  assert.equal((await fay.post(`/sign/${tokenFor(e3.id, 'fay@resident.example')}/comments`, { text: 'Which trees are meant?' })).status, 200);
  db.run('UPDATE comment_news SET at=? WHERE envelope_id=?', new Date(Date.now() - 3600_000).toISOString(), e3.id);
  await flushComments(e3.id);

  // A one-time code by email, then the signer finishes: the completed copy goes to them and the sender.
  const e4 = await simple(owner, 'gus@resident.example', { send: true, subject: 'Allotment lease', recipients: [{ id: 'r', role: 'signer', name: 'Gus Grower', email: 'gus@resident.example', verify: 'email_code' }] });
  ids.push(e4.id);
  const gus = browser();
  const gtok = tokenFor(e4.id, 'gus@resident.example');
  assert.equal((await gus.post(`/sign/${gtok}/code`)).status, 200);
  const code = /(\d{6}) is your code/.exec(db.get("SELECT html FROM emails WHERE to_email='gus@resident.example' AND subject LIKE 'Your code to open%' ORDER BY id DESC LIMIT 1").html)![1];
  otp.push(code);
  assert.equal((await gus.post(`/sign/${gtok}/code/check`, { code })).status, 200);
  await gus.post(`/sign/${gtok}/consent`);
  const v = (await gus.get(`/sign/${gtok}`)).data;
  assert.equal((await gus.post(`/sign/${gtok}/complete`, { values: Object.fromEntries(v.fields.map((f: any) => [f.id, '1'])), signature_png: PNG, initials_png: PNG })).status, 200);

  // A witness, asked once their signer has signed.
  const file = await upload(owner, 1);
  const deed = await owner.post('/envelopes', {
    subject: 'Deed of dedication', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'ann', role: 'signer', name: 'Ann Signer', email: 'ann@resident.example' }, { id: 'wit', role: 'witness', witness_for: 'ann', name: 'Will Witness', email: 'will@resident.example' }],
    fields: [{ document_id: 'd', recipient_id: 'ann', type: 'signature', page: 0, x: 0.1, y: 0.3, w: 0.25, h: 0.06 },
      { document_id: 'd', recipient_id: 'wit', type: 'signature', page: 0, x: 0.1, y: 0.6, w: 0.22, h: 0.05 }, { document_id: 'd', recipient_id: 'wit', type: 'full_name', page: 0, x: 0.1, y: 0.66, w: 0.3, h: 0.024 },
      { document_id: 'd', recipient_id: 'wit', type: 'text', label: 'Witness address', page: 0, x: 0.1, y: 0.69, w: 0.4, h: 0.045 }, { document_id: 'd', recipient_id: 'wit', type: 'date_signed', page: 0, x: 0.5, y: 0.6, w: 0.16, h: 0.024 }],
  });
  assert.equal(deed.status, 200, JSON.stringify(deed.data));
  ids.push(deed.data.envelope.id);
  assert.equal((await signAll(deed.data.envelope.id, 'ann@resident.example')).status, 200);
  assert.ok(db.get("SELECT 1 x FROM emails WHERE to_email='will@resident.example'"), 'the witness was asked');

  // A signing group: one email and one link for each member.
  const grp = await owner.post('/groups', { name: 'Planning desk', members: [{ name: 'Pat Planner', email: 'pat@planning.example' }, { name: 'Qui Planner', email: 'qui@planning.example' }] });
  assert.equal(grp.status, 200, JSON.stringify(grp.data));
  const gfile = await upload(owner, 1);
  const ge = await owner.post('/envelopes', { subject: 'Planning consent', send: true, documents: [{ id: 'd', file_id: gfile.id }], recipients: [{ id: 'g', role: 'signer', group_id: grp.data.group.id }], fields: [{ document_id: 'd', recipient_id: 'g', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
  assert.equal(ge.status, 200, JSON.stringify(ge.data));
  ids.push(ge.data.envelope.id);

  const sent = originals(ids);
  // What the flows sent: the request (its subject is the document's), a reminder, a deadline warning, a decline, the
  // request to a corrected address, a void, a comment, a one-time code, the completed copies, a witness and a group.
  const has = (to: string, subject: string) => assert.ok(sent.some((m) => m.to_email === to && m.subject === subject), `sent "${subject}" to ${to}: ${sent.map((m) => `${m.to_email} ${m.subject}`).join(' | ')}`);
  has('dee@resident.example', 'Parking permit');
  has('dee@resident.example', 'Reminder: Parking permit');
  has('dee@resident.example', 'Expires soon: Parking permit');
  has('rae@town.example', 'Declined: Parking permit');
  has('eli.new@resident.example', 'Hall booking');
  has('eli.new@resident.example', 'Voided: Hall booking');
  has('rae@town.example', 'Questions and comments: Tree survey');
  has('gus@resident.example', 'Your code to open a document from Rae Records');
  has('gus@resident.example', 'Completed: Allotment lease');
  has('will@resident.example', 'Deed of dedication');
  has('pat@planning.example', 'Planning consent');
  has('qui@planning.example', 'Planning consent');

  const secrets = [...secretsOf(ids), ...otp];
  for (const to of [A, B]) {
    const copies = db.all(`SELECT * FROM emails WHERE to_email=? AND archive_envelope IN (${ids.map(() => '?').join(',')}) ORDER BY id`, to, ...ids);
    assert.equal(copies.length, sent.length, `${to} has a copy of each of the ${sent.length} emails`);
    for (const m of sent) {
      const copy = copies.find((x) => x.subject === `Archive copy: ${m.subject}` && x.html.includes(`Archive copy of an email sent to ${m.to_email} on `));
      assert.ok(copy, `${to} has the copy of "${m.subject}" to ${m.to_email}`);
      assert.equal(copy.archive_envelope, m.envelope_id);
      assertClean(copy, secrets, `${m.subject} to ${m.to_email}`);
      assert.match(JSON.parse(copy.payload).text, /^Archive copy of an email sent to /, 'the first line, also in the text');
    }
  }
  // The one-time code itself, and the link in the request: gone, said so.
  const codeCopy = copiesTo(A).find((x) => x.subject.startsWith('Archive copy: Your code to open'))!;
  assert.match(codeCopy.html, /\(code removed in this copy\) is your code/);
  const request = copiesTo(A).find((x) => x.subject === 'Archive copy: Parking permit')!;
  assert.match(JSON.parse(request.payload).text, /Review and sign: \(link removed in this copy\)/);
  assert.match(request.html, /Security code: \(code removed in this copy\)/);
  // Nothing about an envelope of another account, and no copy of a copy.
  assert.equal(db.get(`SELECT COUNT(*) n FROM emails WHERE to_email IN (?,?) AND archive_envelope IS NOT NULL AND archive_envelope NOT IN (${ids.map(() => '?').join(',')})`, A, B, ...ids).n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE subject LIKE 'Archive copy: Archive copy:%'").n, 0);
  // Not one of the envelope's emails: the envelope page lists none of them.
  const page = (await owner.get(`/envelopes/${e1.id}`)).data;
  assert.equal(JSON.stringify(page).includes(A), false);
});

test('no copy for other accounts, none of account emails, and copies carry the same attachments as separate emails', async () => {
  const calls: any[] = [];
  process.env.SMTP_URL = 'smtp://stand-in.invalid';
  (globalThis as any).__tsmail = { sendMail: async (m: any) => (calls.push(m), { messageId: 'x' }) };
  try {
    const owner = await person('Sol Sender', 'sol@county.example');
    const other = await person('Oto Other', 'oto@county.example');
    await confirmed(owner, 'records@county.example');
    const e = await simple(owner, 'una@resident.example', { send: true, subject: 'Grant agreement' });
    const o = await simple(other, 'una@resident.example', { send: true, subject: 'Other council' });
    assert.equal((await signAll(e.id, 'una@resident.example')).status, 200);
    const copies = copiesTo('records@county.example');
    assert.equal(copies.some((c) => c.archive_envelope === o.id), false, 'another account\'s envelope is never copied');
    assert.equal(copies.some((c) => /Confirm|now go to/.test(c.subject)), false, 'emails that are not about a document are not copied');
    const done = copies.find((c) => c.subject.startsWith('Archive copy: Completed'))!;
    const orig = db.get("SELECT payload FROM emails WHERE envelope_id=? AND to_email='una@resident.example' AND subject LIKE 'Completed:%'", e.id);
    const att = (p: string) => JSON.parse(p).attachments.map((a: any) => a.sha256);
    assert.equal(att(orig.payload).length, 1, 'the completed copy has the signed PDF attached');
    assert.deepEqual(att(done.payload), att(orig.payload), 'and so has its archive copy');
    // Each copy was handed to the mail server as an email of its own, to the archive address, never as a hidden copy.
    const toArchive = calls.filter((m) => m.to === 'records@county.example' && m.subject.startsWith('Archive copy: '));
    assert.equal(toArchive.length, copies.length);
    for (const m of calls) assert.equal(m.bcc, undefined);
    for (const m of calls.filter((x) => x.to === 'una@resident.example')) assert.equal([m.cc, m.bcc].flat().filter(Boolean).length, 0);
    assert.equal(toArchive.find((m) => m.subject.startsWith('Archive copy: Completed'))!.attachments.length, 1);
    assert.equal(db.get('SELECT copies n FROM archive_addresses WHERE email=?', 'records@county.example').n, copies.length, 'counted for Settings');
  } finally {
    delete process.env.SMTP_URL;
    (globalThis as any).__tsmail = undefined;
  }
});

// ---- 3. Stored and tried again like the rest; never a limit, never a bounce on a recipient; waiting while paused ----

const TOKEN = 'archive-test-secret-5b1d7e2a';
const news = (body: any) => new Client().post(`/mail/events?token=${TOKEN}`, body);

test('copies never count towards the daily limit and take nobody\'s place on it', async () => {
  const owner = await person('Lin Limits', 'lin@limits-town.example');
  const account = await accountOf(owner);
  for (let i = 1; i <= 3; i++) await confirmed(owner, `rec${i}@limits-town.example`);
  process.env.NEW_ACCOUNT_DAILY_RECIPIENTS = '2';
  try {
    const a = await simple(owner, 'one@resident.example', { send: true });
    const b = await simple(owner, 'two@resident.example', { send: true });
    assert.equal(copiesTo('rec1@limits-town.example').length, 2, 'both were copied');
    // Two people reached, the limit is two: a third person is refused, the archive addresses counted for nothing.
    const reached = db.all('SELECT email FROM reached WHERE account_id=?', account).map((r) => r.email).sort();
    assert.deepEqual(reached, ['one@resident.example', 'two@resident.example']);
    const third = await simple(owner, 'three@resident.example').catch(() => null);
    const sent3 = third && await owner.post(`/envelopes/${third.id}/send`);
    assert.equal(sent3?.status, 429, 'the limit is the same as without archive addresses');
    assert.ok(a.id && b.id);
  } finally {
    delete process.env.NEW_ACCOUNT_DAILY_RECIPIENTS;
  }
});

test('news about a copy counts for its archive address alone: three that come back pause it, spam pauses it, an arrival clears the count', async () => {
  process.env.MAIL_EVENTS_TOKEN = TOKEN;
  try {
    const owner = await person('Bo Bounce', 'bo@bounce-town.example');
    const account = await accountOf(owner);
    // The archive address is also the owner's own login: news about a copy must not mark the login.
    await confirmed(owner, 'bo@bounce-town.example');
    const ids: string[] = [];
    for (let i = 0; i < ARCHIVE_BOUNCES_TO_PAUSE + 1; i++) ids.push((await simple(owner, `r${i}@resident.example`, { send: true, subject: `Notice ${i}` })).id);
    const copies = copiesTo('bo@bounce-town.example');
    assert.equal(copies.length, ARCHIVE_BOUNCES_TO_PAUSE + 1);

    // An arrival after a bounce clears the count: two bounces, one delivered, then the count starts again.
    assert.equal((await news({ type: 'bounce', email: 'bo@bounce-town.example', mail_id: String(copies[0].id) })).status, 200);
    assert.equal((await news({ type: 'bounce', email: 'bo@bounce-town.example', mail_id: String(copies[0].id) })).data.repeat, 1, 'the same news twice counts once');
    assert.equal(db.get("SELECT bounces n FROM archive_addresses WHERE email='bo@bounce-town.example'").n, 1);
    db.run('UPDATE emails SET tried_at=? WHERE id=?', new Date(Date.now() + 1000).toISOString(), copies[1].id);
    await news({ type: 'delivered', email: 'bo@bounce-town.example', mail_id: String(copies[1].id) });
    assert.equal(db.get("SELECT bounces n FROM archive_addresses WHERE email='bo@bounce-town.example'").n, 0);

    // Nobody else is touched: not the recipients, not the login with the same address, not the do-not-mail list.
    assert.equal(db.get("SELECT email_bounced_at b FROM users WHERE email='bo@bounce-town.example'").b, null);
    for (const id of ids) assert.equal(db.get('SELECT COUNT(*) n FROM recipients WHERE envelope_id=? AND bounced_at IS NOT NULL', id).n, 0);
    assert.equal(db.get('SELECT COUNT(*) n FROM bounced_addresses WHERE account_id=?', account).n, 0);
    for (const id of ids) assert.equal(db.all("SELECT action FROM audit WHERE envelope_id=? AND action LIKE '%deliver%'", id).length, 0, 'the envelope\'s record says nothing about copies');

    // Three more that come back, with none arriving between: paused, the admins hear of it, the next email is not copied.
    for (const c of [copies[1], copies[2], copies[3]]) await news({ type: 'bounce', email: 'bo@bounce-town.example', mail_id: String(c.id) });
    const a = db.get("SELECT * FROM archive_addresses WHERE email='bo@bounce-town.example'");
    assert.ok(a.paused_at);
    assert.equal(a.paused_why, 'bounced');
    assert.ok(db.all("SELECT subject FROM emails WHERE to_email='bo@bounce-town.example' AND archive_to IS NULL").some((m) => /are paused/.test(m.subject)));
    assert.equal(db.get("SELECT email_bounced_at b FROM users WHERE email='bo@bounce-town.example'").b, null, 'still not the login');
    const view = (await owner.get('/account/archive-addresses')).data.addresses[0];
    assert.equal(view.state, 'paused');
    await simple(owner, 'later@resident.example', { send: true });
    assert.equal(copiesTo('bo@bounce-town.example').length, ARCHIVE_BOUNCES_TO_PAUSE + 1, 'no copy while paused');
    assert.equal(db.get("SELECT missed n FROM archive_addresses WHERE email='bo@bounce-town.example'").n, 1, 'and it is counted as missed');

    // "Send the link again", confirmed from the inbox: copies start again.
    assert.equal((await owner.post('/account/archive-addresses', { email: 'bo@bounce-town.example' })).status, 200);
    assert.equal((await browser().post('/public/archive-confirm', { token: confirmToken('bo@bounce-town.example'), answer: 'yes' })).status, 200);
    await simple(owner, 'after@resident.example', { send: true });
    assert.equal(copiesTo('bo@bounce-town.example').length, ARCHIVE_BOUNCES_TO_PAUSE + 2);

    // Marked as spam: paused at once, and it is no report against the account.
    const last = copiesTo('bo@bounce-town.example').at(-1);
    await news({ type: 'complaint', email: 'bo@bounce-town.example', mail_id: String(last.id) });
    assert.equal(db.get("SELECT paused_why w FROM archive_addresses WHERE email='bo@bounce-town.example'").w, 'spam');
    assert.equal(db.get('SELECT COUNT(*) n FROM abuse_reports WHERE account_id=?', account).n, 0);
  } finally {
    delete process.env.MAIL_EVENTS_TOKEN;
  }
});

test('copies wait while sending is paused and go when it is lifted; a removed address gets none that were waiting', async () => {
  const owner = await person('Pam Paused', 'pam@paused-town.example');
  const account = await accountOf(owner);
  await confirmed(owner, 'records@paused-town.example');
  await confirmed(owner, 'second@paused-town.example');
  const e = await simple(owner, 'val@resident.example', { send: true, subject: 'Licence' });
  assert.equal(copiesTo('records@paused-town.example').length, 1);
  db.run('UPDATE accounts SET suspended_at=?, suspended_reason=? WHERE id=?', new Date().toISOString(), 'reports', account);
  // What the signer does still works while paused, and its emails go: the completed copy. Its archive copies wait.
  assert.equal((await signAll(e.id, 'val@resident.example')).status, 200);
  const done = db.get("SELECT status FROM emails WHERE to_email='val@resident.example' AND subject LIKE 'Completed:%'");
  assert.ok(['sent', 'outbox'].includes(done.status), 'the signer got their copy');
  const waiting = () => db.all("SELECT * FROM emails WHERE to_email='records@paused-town.example' AND archive_envelope=? AND subject LIKE 'Archive copy: Completed%' AND html LIKE '%sent to val@resident.example%'", e.id);
  assert.equal(waiting().length, 1);
  assert.equal(waiting()[0].status, 'queued');
  // The timer leaves it alone, however long the pause.
  const old = new Date(Date.now() - 3 * 864e5).toISOString();
  db.run("UPDATE emails SET at=?, tried_at=NULL WHERE to_email IN ('records@paused-town.example','second@paused-town.example') AND status='queued'", old);
  await mail.retryMail();
  assert.equal(waiting()[0].status, 'queued');
  assert.equal(waiting()[0].tries, 0, 'waiting is not a try');
  // A removed address gets none of what was waiting for it.
  const second = (await owner.get('/account/archive-addresses')).data.addresses.find((a: any) => a.email === 'second@paused-town.example');
  assert.equal((await owner.call('DELETE', `/account/archive-addresses/${second.id}`)).status, 200);
  // Lifted: the next timer run sends it, more than two days later, because a copy is a record.
  db.run('UPDATE accounts SET suspended_at=NULL WHERE id=?', account);
  await mail.retryMail();
  assert.equal(waiting()[0].status, 'outbox');
  const gone = db.get("SELECT status, error FROM emails WHERE to_email='second@paused-town.example' AND archive_envelope=? AND subject LIKE 'Archive copy: Completed%' AND html LIKE '%sent to val@resident.example%'", e.id);
  assert.equal(gone.status, 'failed');
  assert.match(gone.error, /removed/);
});

test('a copy the mail server would not take is tried again like any email, and one goes only once the email it copies has left', async () => {
  const owner = await person('Ray Retry', 'ray@retry-town.example');
  await confirmed(owner, 'records@retry-town.example');
  const tried: any[] = [];
  let refuse = (m: any) => m.to === 'records@retry-town.example';
  process.env.SMTP_URL = 'smtp://stand-in.invalid';
  (globalThis as any).__tsmail = { sendMail: async (m: any) => { tried.push(m); if (refuse(m)) throw new Error('451 try again later'); return {}; } };
  try {
    await simple(owner, 'wes@resident.example', { send: true, subject: 'Rates' });
    const c = copiesTo('records@retry-town.example')[0];
    assert.equal(c.status, 'failed');
    assert.ok(c.next_try_at, 'it is tried again');
    refuse = () => false;
    db.run('UPDATE emails SET next_try_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), c.id);
    await mail.retryMail();
    assert.equal(db.get('SELECT status, tries FROM emails WHERE id=?', c.id).status, 'sent');

    // The email to the resident fails first: no copy yet. When it goes on a later try, the copy goes with it.
    refuse = (m) => m.to === 'xia@resident.example';
    const e2 = await simple(owner, 'xia@resident.example', { send: true, subject: 'Bins' });
    assert.equal(db.all('SELECT 1 FROM emails WHERE archive_envelope=?', e2.id).length, 0, 'nothing is copied that has not left');
    refuse = () => false;
    db.run("UPDATE emails SET next_try_at=? WHERE to_email='xia@resident.example' AND status='failed'", new Date(Date.now() - 1000).toISOString());
    await mail.retryMail();
    const copy = db.get('SELECT * FROM emails WHERE archive_envelope=?', e2.id);
    assert.equal(copy.status, 'sent');
    assert.match(copy.html, /Archive copy of an email sent to xia@resident\.example on /);
    await mail.retryMail();
    assert.equal(db.all('SELECT 1 FROM emails WHERE archive_envelope=?', e2.id).length, 1, 'and only once');
  } finally {
    delete process.env.SMTP_URL;
    (globalThis as any).__tsmail = undefined;
  }
});

test('deleting an envelope deletes our stored copies of its emails too', async () => {
  const owner = await person('Del Deleter', 'del@delete-town.example');
  await confirmed(owner, 'records@delete-town.example');
  const e = await simple(owner, 'yan@resident.example', { send: true, subject: 'Draft lease' });
  assert.equal((await owner.post(`/envelopes/${e.id}/void`, { reason: 'Not needed' })).status, 200);
  assert.ok(copiesTo('records@delete-town.example').length >= 2);
  const del = await owner.call('DELETE', `/envelopes/${e.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(db.get('SELECT 1 x FROM envelopes WHERE id=?', e.id), null, 'nobody kept a copy, so it is deleted for good');
  assert.equal(db.all('SELECT 1 FROM emails WHERE archive_envelope=?', e.id).length, 0);
  // The timer cleans up after any deletion it did not see.
  db.run('INSERT INTO emails (to_email, subject, html, status, at, archive_to, archive_envelope) VALUES (?,?,?,?,?,?,?)', 'records@delete-town.example', 'x', 'x', 'sent', new Date().toISOString(), 'arc_x', 'env_gone');
  arch.forgetArchiveCopies();
  assert.equal(db.all("SELECT 1 FROM emails WHERE archive_envelope='env_gone'").length, 0);
});

// ---- 4. SMTP_REQUIRE_TLS: nothing is handed to the relay unencrypted ------------------------------------------------

test('SMTP_REQUIRE_TLS passes requireTLS to the transport, and nothing in SMTP_URL switches it off', async () => {
  const nodemailer = (await import('nodemailer')).default as any;
  const real = nodemailer.createTransport;
  const given: any[] = [];
  nodemailer.createTransport = (o: any) => (given.push(o), { sendMail: async () => ({}) });
  process.env.SMTP_URL = 'smtp://user:pw@relay.example:587?requireTLS=false&ignoreTLS=true';
  try {
    (globalThis as any).__tsmail = undefined;
    assert.equal(await mail.sendMail({ to: 'off@example.com', subject: 'Off', heading: 'Off', lines: ['x'] }), 'sent');
    assert.equal(given.at(-1).requireTLS, undefined, 'without the setting the address decides, as before');
    process.env.SMTP_REQUIRE_TLS = '1';
    (globalThis as any).__tsmail = undefined;
    assert.equal(await mail.sendMail({ to: 'on@example.com', subject: 'On', heading: 'On', lines: ['x'] }), 'sent');
    const o = given.at(-1);
    assert.equal(o.requireTLS, true);
    assert.equal(new URL(o.url).searchParams.get('requireTLS'), 'true', 'the address cannot say false: the library reads the address last');
    // What the library makes of it: requireTLS on, whatever else the address says.
    const { parseConnectionUrl } = (await import('nodemailer/lib/shared' as any)) as any;
    assert.equal(parseConnectionUrl(o.url).requireTLS, true);
    assert.deepEqual(mail.transportOptions('smtps://relay.example:465'), { url: mail.transportOptions('smtps://relay.example:465').url, requireTLS: true });
  } finally {
    nodemailer.createTransport = real;
    delete process.env.SMTP_URL;
    delete process.env.SMTP_REQUIRE_TLS;
    (globalThis as any).__tsmail = undefined;
  }
});

// A mail server on this machine that offers no STARTTLS and takes whatever it is given. It says which commands it saw.
async function plainRelay() {
  const saw: string[] = [];
  const server = net.createServer((sock) => {
    sock.write('220 plain.test ESMTP\r\n');
    let buf = '', data = false;
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') (data = false), sock.write('250 queued\r\n');
          continue;
        }
        const cmd = line.split(' ')[0].toUpperCase();
        saw.push(cmd);
        if (cmd === 'EHLO') sock.write('250-plain.test\r\n250 8BITMIME\r\n');
        else if (cmd === 'STARTTLS') sock.write('502 5.5.1 STARTTLS not offered\r\n');
        else if (cmd === 'DATA') (data = true), sock.write('354 go ahead\r\n');
        else if (cmd === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { saw, port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(r)) };
}

test('with SMTP_REQUIRE_TLS a mail server without STARTTLS gets nothing, the email waits for another try, and the sender reads why', async () => {
  const relay = await plainRelay();
  process.env.SMTP_URL = `smtp://127.0.0.1:${relay.port}`;
  try {
    (globalThis as any).__tsmail = undefined;
    assert.equal(await mail.sendMail({ to: 'plain@example.com', subject: 'Without the setting', heading: 'x', lines: ['x'] }), 'sent', 'without the setting it goes unencrypted, as /security then says');
    assert.ok(relay.saw.includes('DATA'));
    relay.saw.length = 0;

    process.env.SMTP_REQUIRE_TLS = '1';
    (globalThis as any).__tsmail = undefined;
    assert.equal(await mail.sendMail({ to: 'secret@example.com', subject: 'With the setting', heading: 'x', lines: ['x'] }), 'failed');
    assert.ok(relay.saw.includes('STARTTLS'), 'it asked for encryption');
    assert.equal(relay.saw.includes('MAIL'), false, 'and handed nothing over without it');
    assert.equal(relay.saw.includes('DATA'), false);
    const row = db.get("SELECT status, error, next_try_at FROM emails WHERE to_email='secret@example.com'");
    assert.equal(row.status, 'failed');
    assert.ok(row.next_try_at, 'kept and tried again');
    const { TLS_REFUSED } = await import('../src/lib/mailtls.ts');
    assert.equal(row.error, TLS_REFUSED);
  } finally {
    delete process.env.SMTP_URL;
    delete process.env.SMTP_REQUIRE_TLS;
    (globalThis as any).__tsmail?.close?.();
    (globalThis as any).__tsmail = undefined;
    await relay.close();
  }
});

test('/security says what the encryption on the way to the mail provider covers, and never more', async () => {
  const { mailTlsPoint, mailTls } = await import('../src/lib/mailtls.ts');
  assert.equal(mailTlsPoint({}), null, 'no mail server, nothing to say');
  const off = mailTlsPoint({ SMTP_URL: 'smtp://relay.example:587' })!;
  assert.equal(off.not, true);
  assert.match(off.text, /otherwise unencrypted/);
  const on = mailTlsPoint({ SMTP_URL: 'smtp://relay.example:587', SMTP_REQUIRE_TLS: '1' })!;
  assert.equal(on.not, false);
  assert.match(on.text, /the email is not handed over/);
  assert.equal(mailTls({ SMTP_URL: 'smtps://relay.example:465' }), 'implicit');
  for (const p of [off, on, mailTlsPoint({ SMTP_URL: 'smtps://relay.example:465' })!]) {
    assert.match(p.text, /one step from this server to the mail provider/);
    assert.match(p.text, /MTA-STS or REQUIRETLS there/);
    assert.match(p.text, /It is not end to end encryption/);
    assert.doesNotMatch(p.text, /encrypted end to end|end-to-end encrypted/i);
  }
  assert.match(mailTlsPoint({ SMTP_URL: 'smtp://relay.example:587?tls.rejectUnauthorized=false', SMTP_REQUIRE_TLS: '1' })!.text, /does not check the mail provider's certificate/);
});

// ---- 5. The words and the screens say what the code does, in the designer's words ----------------------------------

test('the copy, the card, /security, the API description and the README use the same words and numbers', async () => {
  const fs = await import('node:fs');
  const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const lib = await import('../src/lib/archivemail.ts');
  // The designer's correction (research/ux-notes.json, "ds-mail-records"): these exact words.
  assert.equal(ARCHIVE_LINK_REMOVED, '(link removed in this copy)');
  assert.equal(lib.ARCHIVE_ONE_LINE, 'Each copy has the signing link taken out.');
  assert.equal(lib.ARCHIVE_ADDED, 'We sent a link to confirm it. Copies start once it is confirmed.');
  const en = JSON.parse(read('src/locales/en.json'));
  assert.equal(en['settings.archive.title'], 'Copies of every email');

  // The card: on the Records and data page of Settings, marked as this feature's, one line of explanation, no
  // expander and no filled button (the page has its one main button already), and never the words to avoid.
  const page = read('src/app/app/settings/page.tsx');
  assert.match(page, /\{tab === 'data' && <ArchiveSettings \/>\}/);
  const card = read('src/components/settings/ArchiveSettings.tsx');
  assert.match(card, /'data-feature': 'ds-mail-records'/);
  assert.match(card, /'data-item': 'card'/);
  assert.match(card, /ARCHIVE_ONE_LINE/);
  assert.doesNotMatch(card, /btn primary|<details|data-more/);
  assert.doesNotMatch(card, /from '@\/server|\.\.\/server/);
  const words = Object.entries(en).filter(([k]) => k.startsWith('settings.archive.')).map(([, v]) => String(v)).join(' ');
  assert.doesNotMatch(`${words} ${lib.ARCHIVE_ONE_LINE} ${lib.ARCHIVE_ADDED}`, /\bBCC\b|journal|\bTLS\b|—/i);
  // Every key the card asks for is there, also the ones chosen by a condition.
  for (const m of card.matchAll(/'(settings\.archive\.[a-z_]+)'/g)) assert.ok(en[m[1]], `${m[1]} is in en.json`);
  // Nothing of this is on a sender's daily path or a signer's screen.
  for (const f of ['src/components/Editor.tsx', 'src/app/sign/[token]/page.tsx', 'src/app/app/envelopes/[id]/page.tsx']) assert.doesNotMatch(read(f), /archive-addresses|ArchiveSettings/, f);

  // The page the link opens asks before anything changes: it reads with GET and changes only on a press.
  const view = read('src/app/archive-confirm/ConfirmView.tsx');
  assert.match(view, /api\(`\/public\/archive-confirm\?token=/);
  assert.match(view, /onClick=\{\(\) => answer\('yes'\)\}/);
  assert.equal((view.match(/btn primary/g) || []).length, 1);
  assert.doesNotMatch(view, /from '@\/server|—/);

  // /security lists archive addresses under "Who can see your documents", with the number the server enforces.
  const policy = await import('../src/lib/policy.ts');
  const who = policy.WHO_CAN_SEE.find((w) => /Archive addresses/.test(w.who))!;
  assert.ok(who, 'archive addresses are on the list');
  assert.match(who.what, new RegExp(`up to ${ARCHIVE_MAX_ADDRESSES} email addresses`));
  assert.match(who.what, /confirmed from its own inbox before it gets anything/);
  assert.match(who.what, /signing link and the codes taken out/);
  assert.match(who.what, /Signers are not told/);
  const security = read('src/app/security/page.tsx');
  assert.match(security, /mailTlsPoint\(\)/);
  assert.match(security, /mailTls && !mailTls\.not && <Point/);
  assert.match(security, /mailTls\?\.not && <Point/);

  // The API description, the settings file and the README name what exists.
  const { openapi } = await import('../src/server/openapi.ts');
  const paths = (openapi() as any).paths;
  assert.ok(paths['/account/archive-addresses'].get && paths['/account/archive-addresses'].post);
  assert.ok(paths['/account/archive-addresses/{id}'].delete);
  assert.match(paths['/account/archive-addresses'].get.description, /\(link removed in this copy\)/);
  assert.match(read('.env.example'), /^# SMTP_REQUIRE_TLS=1$/m);
  const readme = read('README.md');
  assert.match(readme, /^\| `SMTP_REQUIRE_TLS` \|/m);
  assert.match(readme, /\(link removed in this copy\)/);
  for (const text of [readme, read('.env.example'), security, JSON.stringify(policy.WHO_CAN_SEE)]) assert.doesNotMatch(text, /(emails?|copies) (are|is) encrypted end to end|end-to-end encrypted email/i);
});

test('a link that was answered works for nobody else, a member cannot add or remove, and a copy is never copied again', async () => {
  const owner = await person('Ana Admin', 'ana@parish.example');
  const added = await owner.post('/account/archive-addresses', { email: 'clerk@parish.example' });
  const tok = confirmToken('clerk@parish.example');
  assert.equal((await browser().post('/public/archive-confirm', { token: tok, answer: 'yes' })).status, 200);
  // The same link a second time, from a forwarded email say: it confirms and refuses nothing any more.
  assert.equal((await browser().get(`/public/archive-confirm?token=${tok}`)).status, 404);
  assert.equal((await browser().post('/public/archive-confirm', { token: tok, answer: 'no' })).status, 404);
  assert.equal((await owner.get('/account/archive-addresses')).data.addresses[0].state, 'confirmed');
  // Someone who is not signed in to the account reads and changes nothing.
  const stranger = await person('Sy Stranger', 'sy@elsewhere.example');
  assert.equal((await stranger.call('DELETE', `/account/archive-addresses/${added.data.address.id}`)).status, 404);
  assert.equal((await stranger.get('/account/archive-addresses')).data.addresses.length, 0);
  assert.equal((await browser().get('/account/archive-addresses')).status, 401);
  // A copy is an email about no envelope, so it is never copied in turn, however many addresses there are.
  await confirmed(owner, 'second@parish.example');
  const e = await simple(owner, 'pat@resident.example', { send: true, subject: 'Hall hire' });
  const all = db.all('SELECT to_email, subject FROM emails WHERE archive_envelope=?', e.id);
  assert.equal(all.length, 2 * originals([e.id]).length);
  assert.equal(all.some((m: any) => m.subject.startsWith('Archive copy: Archive copy: ')), false);
});
