// The last open ends: leaving a team by yourself, and what follows further down in this file.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, simple, signUp, mailTo, PNG, type Server } from './helpers.ts';
import { PRICING } from '../src/lib/impact.ts';

let db: Server['db'];
let cron: Server['cron'];
before(async () => {
  ({ db, cron } = await boot());
});

const PW = 'correct horse battery';
let n = 0;
const ip = () => `10.${200 + Math.floor(++n / 250)}.${n % 250}.9`;
const from = () => Object.assign(new Client(), { ip: ip() });
const person = (name: string, email: string) => signUp(name, email, ip());
const me = async (c: Client) => (await c.get('/me')).data;
const idOf = async (c: Client) => (await me(c)).user.id;
const inviteFor = (email: string) => db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email)?.token;
async function join(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const c = from();
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: inviteFor(email) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}
const withKey = (key: string) => {
  const c = from();
  const call = c.call.bind(c);
  c.call = (method: string, url: string, body?: any, headers: Record<string, string> = {}) => call(method, url, body, { authorization: `Bearer ${key}`, ...headers });
  return c;
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const auditOf = (envelopeId: string) => db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', envelopeId);

// ---- Leaving a team ------------------------------------------------------------------------------------------

test('a member leaves a team by themselves: what they sent stays with the team, they stay signed in, and the admins are told', async () => {
  const owner = await person('Olga Owner', 'olga@leave.example');
  const adm = await join(owner, 'Adam Admin', 'adam@leave.example', 'admin');
  const sam = await join(owner, 'Sam Stays', 'sam@leave.example');
  const lea = await join(owner, 'Lea Leaver', 'lea@leave.example');
  const [ownerId, samId, leaId] = [await idOf(owner), await idOf(sam), await idOf(lea)];
  const team = (await me(owner)).account;

  // Lea has an envelope out for signature, a draft, and an API key that something uses.
  const out = await simple(lea, 'client@leave.example', { subject: 'Lea in flight' });
  assert.equal((await lea.post(`/envelopes/${out.id}/send`)).status, 200);
  const draft = await simple(lea, 'later@leave.example', { subject: 'Lea draft' });
  const key = (await lea.post('/api-keys', { name: 'Lea script' })).data.key;
  const viaKey = withKey(key);
  assert.equal((await viaKey.get('/envelopes')).status, 200);

  // The owner cannot walk out, a key cannot do it for a person, and a successor has to be someone who stays.
  const own = await owner.post('/account/leave', {});
  assert.equal(own.status, 400);
  assert.match(own.data.error, /You own .* Make someone else the owner first/);
  const keyed = await viaKey.post('/account/leave', {});
  assert.equal(keyed.status, 403, JSON.stringify(keyed.data));
  for (const to of ['usr_nobody', leaId]) {
    const r = await lea.post('/account/leave', { to });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /not on the team\. Nothing was changed/);
  }
  assert.equal(db.get('SELECT COUNT(*) n FROM memberships WHERE account_id=? AND user_id=?', team.id, leaId).n, 1, 'nothing changed so far');

  // Lea leaves and names nobody: the owner takes over.
  const left = await lea.post('/account/leave', {});
  assert.equal(left.status, 200, JSON.stringify(left.data));
  assert.equal(left.data.left, team.name);
  assert.equal(left.data.handed_to.id, ownerId);
  assert.equal(left.data.handed_over, 2);
  assert.equal(left.data.keys_stopped.length, 1);
  for (const id of [out.id, draft.id]) assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', id).sender_id, ownerId);
  assert.ok(auditOf(out.id).some((a: any) => a.action === 'Handed over' && /From Lea Leaver <lea@leave\.example> to Olga Owner <olga@leave\.example>: Lea Leaver left the team/.test(a.detail)));
  assert.equal((await owner.get(`/envelopes/${out.id}`)).status, 200, 'the team still has the envelope');

  // She is still signed in, in a workspace of her own, with the welcome signatures a person gets once.
  const now_ = await me(lea);
  assert.notEqual(now_.account.id, team.id);
  assert.equal(now_.role, 'owner');
  assert.equal(now_.account.id, left.data.now_in.id);
  assert.equal(db.get("SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=? AND reason='welcome'", now_.account.id).n, PRICING.welcomeSignatures);
  assert.equal((await lea.get(`/envelopes/${out.id}`)).status, 404, 'no way back into the team');
  assert.equal((await lea.get('/account/members')).data.members.length, 1);
  // Her key stopped with her.
  const dead = await viaKey.get('/envelopes');
  assert.equal(dead.status, 401, JSON.stringify(dead.data));

  // The owner and the admin are told, with what was handed over and which key stopped. Other members are not mailed.
  for (const [email, who] of [['olga@leave.example', 'you'], ['adam@leave.example', 'Olga Owner']] as const) {
    const m = mailTo(email).find((x: any) => x.subject === `Lea Leaver left ${team.name}`);
    assert.ok(m, `${email} is told`);
    const t = text(m.html);
    assert.match(t, new RegExp(`2 envelopes, drafts and templates and any bulk sends now belong to ${who}\\.`));
    assert.match(t, /"Lea script"/);
    assert.doesNotMatch(t, /—/);
  }
  assert.equal(mailTo('sam@leave.example').filter((x: any) => /left/.test(x.subject)).length, 0);

  // The admin leaves too and chooses Sam, a plain member, who is told because the envelopes are now Sam's.
  const mine = await simple(adm, 'other@leave.example', { subject: 'Adam in flight' });
  assert.equal((await adm.post(`/envelopes/${mine.id}/send`)).status, 200);
  const gone = await adm.post('/account/leave', { to: samId });
  assert.equal(gone.status, 200, JSON.stringify(gone.data));
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', mine.id).sender_id, samId);
  assert.match(text(mailTo('sam@leave.example').find((x: any) => x.subject === `Adam Admin left ${team.name}`)!.html), /1 envelope, draft or template and any bulk sends now belong to you\./);
  assert.equal((await sam.get(`/envelopes/${mine.id}`)).status, 200);

  // Lea can be invited back, and joins by signing in.
  assert.equal((await owner.post('/account/invites', { email: 'lea@leave.example' })).status, 200);
  const back = from();
  const r = await back.post('/auth/login', { email: 'lea@leave.example', password: PW, invite: inviteFor('lea@leave.example') });
  assert.equal(r.data.joined, team.name);
});

// ---- Public forms: shared devices, closing accounts ----------------------------------------------------------

const visitor = () => from();
const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
const envelopeOf = (url: string) => db.get('SELECT envelope_id e FROM recipients WHERE token=?', url.split('/sign/')[1]).e as string;
async function formOf(owner: Client, name: string, shared = false) {
  const tpl = await simple(owner, '', { kind: 'template', subject: name, recipients: [{ id: 'r', role: 'signer', role_name: 'Visitor' }] });
  const made = await owner.post('/powerforms', { template_id: tpl.id, name, shared_device: shared });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  return (await owner.get('/powerforms')).data.powerforms.find((p: any) => p.id === made.data.id);
}

test('a public form on a shared device takes many people from one address, clears an abandoned start after an hour, and offers the next person a fresh form', async () => {
  const desk = await person('Dana Desk', 'dana@desk.example');
  const plain = await formOf(desk, 'Visitor sign-in');
  const kiosk = await formOf(desk, 'Front desk waiver', true);
  assert.equal(plain.shared_device, false);
  assert.equal(kiosk.shared_device, true);
  assert.equal((await visitor().get(`/public/powerforms/${kiosk.slug}`)).data.shared_device, true);

  // Everyone at the front desk comes from the same address. An ordinary form stops at three unfinished starts and
  // says what the owner can do about it. The shared-device form carries on.
  const here = ip();
  const at = () => Object.assign(new Client(), { ip: here });
  const start = (c: Client, slug: string, who: string) => c.post(`/public/powerforms/${slug}/start`, { name: `Guest ${who}`, email: `${who}@guests.example` });
  for (const who of ['p1', 'p2', 'p3']) assert.equal((await start(at(), plain.slug, who)).status, 200);
  const stopped = await start(at(), plain.slug, 'p4');
  assert.equal(stopped.status, 429);
  assert.match(stopped.data.error, /ask whoever gave you the link to mark it as used on a shared device/);
  const urls: string[] = [];
  for (let i = 0; i < 8; i++) {
    const s = await start(at(), kiosk.slug, `k${i}`);
    assert.equal(s.status, 200, JSON.stringify(s.data));
    urls.push(s.data.url);
  }

  // The person who finishes on the shared device is offered a fresh form for whoever is next. Someone on an
  // ordinary form is not.
  const tok = (url: string) => url.split('/sign/')[1];
  assert.equal((await at().get(`/sign/${tok(urls[0])}`)).data.envelope.next_person, kiosk.slug);
  const ordinary = (await start(visitor(), plain.slug, 'elsewhere')).data.url;
  assert.equal((await visitor().get(`/sign/${tok(ordinary)}`)).data.envelope.next_person, null);

  // Two people walked away from the tablet more than an hour ago. A third stopped clicking an hour ago but has been
  // typing since, which counts as being there. The timer clears the first two only.
  for (const u of urls.slice(1, 4)) {
    db.run('UPDATE envelopes SET sent_at=? WHERE id=?', ago(0.05), envelopeOf(u));
    db.run('UPDATE audit SET at=? WHERE envelope_id=?', ago(0.05), envelopeOf(u));
  }
  const typing = at();
  await typing.post(`/sign/${tok(urls[3])}/consent`);
  db.run('UPDATE audit SET at=? WHERE envelope_id=?', ago(0.05), envelopeOf(urls[3]));
  assert.equal((await typing.post(`/sign/${tok(urls[3])}/save`, { values: {} })).status, 200);
  await cron.tick();
  assert.deepEqual(urls.slice(0, 5).map((u) => db.get('SELECT status FROM envelopes WHERE id=?', envelopeOf(u)).status), ['sent', 'expired', 'expired', 'sent', 'sent']);
  assert.match(db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Envelope expired'", envelopeOf(urls[1])).detail, /left unfinished for 60 minutes/);
  // On the ordinary form the same hour changes nothing: its starts are kept for a day.
  for (const who of ['p1', 'p2', 'p3']) {
    const e = db.get('SELECT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE r.email=?', `${who}@guests.example`).id;
    db.run('UPDATE envelopes SET sent_at=? WHERE id=?', ago(0.05), e);
    db.run('UPDATE audit SET at=? WHERE envelope_id=?', ago(0.05), e);
  }
  await cron.tick();
  assert.equal(db.get("SELECT COUNT(*) n FROM envelopes WHERE powerform_id=? AND status='sent'", plain.id).n, 4);

  // The owner's list says who signed and who is filling one in now, not how often the form was opened.
  const list = (await desk.get('/powerforms')).data.powerforms;
  assert.deepEqual([list.find((p: any) => p.id === kiosk.id).signed, list.find((p: any) => p.id === kiosk.id).open], [0, 6]);
  // Switching the mark off and pausing are separate: one call changes only what it names.
  assert.equal((await desk.call('PATCH', `/powerforms/${kiosk.id}`, { shared_device: false })).status, 200);
  let now_ = (await desk.get('/powerforms')).data.powerforms.find((p: any) => p.id === kiosk.id);
  assert.deepEqual([now_.shared_device, now_.active], [false, 1]);
  assert.equal((await desk.call('PATCH', `/powerforms/${kiosk.id}`, { active: false })).status, 200);
  now_ = (await desk.get('/powerforms')).data.powerforms.find((p: any) => p.id === kiosk.id);
  assert.deepEqual([now_.shared_device, now_.active], [false, 0]);
});

test('a public form of an account that is being closed says it is closed before anyone types into it', async () => {
  const owner = await person('Cleo Closing', 'cleo@closing.example');
  const form = await formOf(owner, 'Membership form');
  assert.equal((await visitor().get(`/public/powerforms/${form.slug}`)).data.closed, false);
  assert.equal((await owner.post('/me/delete', { password: PW })).data.closed, 'scheduled');
  assert.equal((await visitor().get(`/public/powerforms/${form.slug}`)).data.closed, true);
  const mails = mailTo('cleo@closing.example').length;
  const tried = await visitor().post(`/public/powerforms/${form.slug}/start`, { name: 'Walk In', email: 'walkin@closing.example' });
  assert.equal(tried.status, 503);
  assert.equal(db.get("SELECT COUNT(*) n FROM recipients WHERE email='walkin@closing.example'").n, 0, 'nothing of the visitor is kept');
  assert.equal(mailTo('cleo@closing.example').length, mails, 'and the owner is not emailed about a form they are closing anyway');
  // Signing in again keeps the account, and the form is open again.
  const back = from();
  assert.equal((await back.post('/auth/login', { email: 'cleo@closing.example', password: PW })).data.restored, true);
  assert.equal((await visitor().get(`/public/powerforms/${form.slug}`)).data.closed, false);
});

// ---- The email check and deleted documents -------------------------------------------------------------------

test('the code of a genuine email is still recognised after its document was deleted, and nothing else about it is kept', async () => {
  const sender = await person('Gina Gone', 'gina@gone.example');
  const e = await simple(sender, 'reader@gone.example', { subject: 'Lease for flat 4' });
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const first = db.get('SELECT check_code c FROM recipients WHERE envelope_id=?', e.id).c as string;
  // The address is corrected, so the first email's link is replaced and a second email goes out with a new code.
  const rid = db.get('SELECT id FROM recipients WHERE envelope_id=?', e.id).id;
  assert.equal((await sender.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, email: 'reader2@gone.example' })).status, 200);
  const second = db.get('SELECT check_code c FROM recipients WHERE envelope_id=?', e.id).c as string;
  assert.notEqual(first, second);
  const anon = visitor();
  const check = async (code: string) => (await anon.post('/public/check', { code })).data;
  assert.equal((await check(first)).replaced, true);
  assert.equal((await check(second)).genuine, true);

  // A draft that was never sent leaves no codes behind when it is deleted.
  const draft = await simple(sender, 'never@gone.example', { subject: 'Never sent' });
  assert.equal((await sender.call('DELETE', `/envelopes/${draft.id}`)).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM forgotten_codes').n, 0);

  // The sender voids and deletes the document. Both emails are still in two inboxes.
  assert.equal((await sender.post(`/envelopes/${e.id}/void`, { reason: 'Sent by mistake' })).status, 200);
  assert.equal((await sender.call('DELETE', `/envelopes/${e.id}`)).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', e.id).n, 0);
  for (const code of [first, second]) {
    const a = await check(code);
    assert.deepEqual(Object.keys(a).sort(), ['can_report', 'deleted', 'deleted_at', 'genuine'], 'real, deleted, when, and whether a report can be filed: nothing about who or what');
    assert.equal(a.genuine, true);
    assert.equal(a.deleted, true);
    assert.equal(a.can_report, true);
  }
  // What is kept is a fingerprint. The code itself, the names and the subject are nowhere.
  const kept = JSON.stringify(db.all('SELECT * FROM forgotten_codes'));
  for (const gone of [first, second, 'gone.example', 'Lease', 'Gina']) assert.ok(!kept.includes(gone), `${gone} is not kept`);
  // Whoever still holds the email can report it all the same. The fingerprint keeps the account's id (it names
  // nobody), so the report is filed against the account that sent it, once for each code however often it is made.
  const gid = (await sender.get('/me')).data.account.id;
  assert.ok(db.all('SELECT account_id a FROM forgotten_codes').every((f: any) => f.a === gid));
  const report = await anon.post('/public/check/report', { code: first, reason: 'phishing' });
  assert.equal(report.status, 200);
  assert.deepEqual(report.data, { ok: true, deleted: true });
  assert.equal((await anon.post('/public/check/report', { code: first, reason: 'spam' })).status, 200);
  const filed = db.all('SELECT envelope_id, reporter, reason FROM abuse_reports WHERE account_id=?', gid);
  assert.equal(filed.length, 1, 'one code is one person, counted once');
  assert.equal(filed[0].envelope_id, '', 'nothing of the envelope is left to point at');
  assert.ok(!/gone\.example|Gina|Lease/.test(JSON.stringify(filed)), 'and the report names nobody');
  // Only when nothing says which account it came from (the account is gone too) is the person sent to the contact form.
  db.run('UPDATE forgotten_codes SET account_id=NULL WHERE code_hash != (SELECT code_hash FROM forgotten_codes ORDER BY reported DESC LIMIT 1)');
  const orphan = await anon.post('/public/check/report', { code: second, reason: 'phishing' });
  assert.equal(orphan.status, 404);
  assert.match(orphan.data.error, /really sent, but the document it was about has been deleted since/);
  // And the check page no longer offers a report it cannot file.
  assert.equal((await check(second)).can_report, false);
  // A code we never issued is still not recognised.
  assert.equal((await check('AAAA-BBBB-CCCC')).genuine, false);
  // After a year the fingerprints go too.
  db.run('UPDATE forgotten_codes SET at=?', ago(366));
  await cron.tick();
  assert.equal(db.get('SELECT COUNT(*) n FROM forgotten_codes').n, 0);
  assert.equal((await check(first)).genuine, false);
});

// ---- Stored copies of emails ---------------------------------------------------------------------------------

test('copies of emails that name a deleted person go with them, and copies outside a document\'s record go after 90 days', async () => {
  const owner = await person('Tara Team', 'tara@copies.example');
  const mia = await join(owner, 'Mia Member', 'mia@copies.example', 'admin');
  // Mia invites someone: that email goes to another person and names Mia.
  assert.equal((await mia.post('/account/invites', { email: 'newbie@copies.example' })).status, 200);
  // Mia makes a key and closes her login at once: the owner is told about the key, in an email that names Mia.
  assert.equal((await mia.post('/api-keys', { name: 'Mia tool' })).status, 200);
  const named = () => db.get("SELECT COUNT(*) n FROM emails WHERE envelope_id IS NULL AND (html LIKE '%Mia Member%' OR subject LIKE '%Mia Member%' OR html LIKE '%mia@copies.example%')").n;
  assert.ok(named() >= 1);
  assert.equal((await mia.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
  assert.ok(mailTo('tara@copies.example').some((m: any) => /Mia Member/.test(m.subject + m.html)), 'the owner was told (the copy written after the deletion is the notice itself)');
  // Everything written before the deletion that names her is gone: the invitation she sent, and notices about her.
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='newbie@copies.example' AND html LIKE '%Mia Member%'").n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE html LIKE '%mia@copies.example%'").n, 0);

  // A copy that belongs to no document is deleted 90 days after it was sent. One about a document stays with it.
  const e = await simple(owner, 'kept@copies.example', { subject: 'Kept with its document' });
  assert.equal((await owner.post(`/envelopes/${e.id}/send`)).status, 200);
  db.run('UPDATE emails SET at=?', ago(91));
  const outside = db.get('SELECT COUNT(*) n FROM emails WHERE envelope_id IS NULL').n;
  assert.ok(outside > 0);
  await cron.tick();
  assert.equal(db.get('SELECT COUNT(*) n FROM emails WHERE envelope_id IS NULL AND at < ?', ago(90)).n, 0);
  assert.ok(db.get('SELECT COUNT(*) n FROM emails WHERE envelope_id=?', e.id).n > 0);
});

// ---- A signer's copy outlives the sender's delete button -----------------------------------------------------

test('deleting a voided envelope that someone had already signed takes it out of the sender\'s account and leaves the signer their copy', async () => {
  const sender = await person('Vera Voider', 'vera@voided.example');
  const two = { recipients: [{ id: 'a', role: 'signer', name: 'Ann First', email: 'ann@voided.example' }, { id: 'b', role: 'signer', name: 'Bob Second', email: 'bob@voided.example' }],
    fields: [{ id: 'fa', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'fb', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 }] };
  const e = await simple(sender, '', { subject: 'Half signed', ordered: false, ...two });
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const { signAll } = await import('./helpers.ts');
  assert.equal((await signAll(e.id, 'ann@voided.example')).status, 200);
  const annToken = db.get("SELECT token FROM recipients WHERE envelope_id=? AND email='ann@voided.example'", e.id).token;
  assert.equal((await sender.post(`/envelopes/${e.id}/void`, { reason: 'Deal is off' })).status, 200);
  const gone = await sender.call('DELETE', `/envelopes/${e.id}`);
  assert.deepEqual(gone.data, { ok: true, kept_for_recipients: true });
  // Out of the lists. The account's admins (here the sender owns the account) can still find it under "removed by
  // its sender" and open it, which says so.
  assert.ok(!(await sender.get('/envelopes')).data.envelopes.some((x: any) => x.id === e.id));
  assert.ok((await sender.get('/envelopes?box=removed')).data.envelopes.some((x: any) => x.id === e.id));
  assert.ok((await sender.get(`/envelopes/${e.id}`)).data.removed_at, 'opened as removed');
  // Ann signed it. Her link still opens, and what she signed can still be downloaded.
  const ann = visitor();
  const page = await ann.get(`/sign/${annToken}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.envelope.status, 'voided');
  const pdf = await ann.call('GET', `/sign/${annToken}/download`);
  assert.equal(pdf.status, 200);

  // One that nobody had signed is deleted for good, as before.
  const none = await simple(sender, 'nobody@voided.example', { subject: 'Never signed' });
  assert.equal((await sender.post(`/envelopes/${none.id}/send`)).status, 200);
  assert.equal((await sender.post(`/envelopes/${none.id}/void`, { reason: 'Mistake' })).status, 200);
  const del = await sender.call('DELETE', `/envelopes/${none.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data?.kept_for_recipients, undefined);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', none.id).n, 0);
});

// ---- Lost the email about a help request ---------------------------------------------------------------------

test('someone who lost every email about their help request gets its link again, and the form tells nobody who has written to us', async () => {
  const { SUPPORT_TOPICS } = await import('../src/lib/policy.ts');
  const topic = (SUPPORT_TOPICS as readonly string[])[0];
  const asked = await visitor().post('/public/support', { email: 'Lost.Mail@help.example', name: 'Lou Lost', topic, message: 'I cannot open my document and I need a person to look at it.' });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const first = mailTo('Lost.Mail@help.example').concat(mailTo('lost.mail@help.example')).find((m: any) => /\/help\/request\//.test(m.link || m.html));
  assert.ok(first, 'the confirmation carries the link');
  const original = /https?:\/\/[^"\s<]+\/help\/request\/[\w-]+\/[\w-]+/.exec(first.html)![0];

  // Asked for again from the help page, with the address written differently.
  const before = db.get('SELECT MAX(id) m FROM emails').m;
  const found = await visitor().post('/public/support/find', { email: ' lost.mail@HELP.example ' });
  assert.deepEqual([found.status, found.data], [200, { ok: true }]);
  // The answer goes back first and the email follows a moment later, so the answer takes the same time whether or
  // not anything was found (tests/support.test.ts times it).
  await new Promise((r) => setTimeout(r, 50));
  const again = db.all('SELECT to_email, subject, html FROM emails WHERE id > ?', before);
  assert.equal(again.length, 1);
  assert.match(again[0].subject, /^Your requests to Sign&Grow: the link again$/);
  assert.ok(again[0].html.includes(original.replace(/&/g, '&amp;')) || again[0].html.includes(original), 'the same link as before, so older emails keep working');
  assert.match(again[0].html, new RegExp(asked.data.reference));
  const path = original.replace(/^https?:\/\/[^/]+/, '').replace('/help/request/', '/public/support/ticket/');
  assert.equal((await visitor().get(path)).status, 200);

  // An address nobody wrote from gets the same answer and no email.
  const sofar = db.get('SELECT MAX(id) m FROM emails').m;
  const nobody = await visitor().post('/public/support/find', { email: 'never.wrote@help.example' });
  assert.deepEqual([nobody.status, nobody.data], [200, { ok: true }]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(db.get('SELECT COUNT(*) n FROM emails WHERE id > ?', sofar).n, 0);
  assert.equal((await visitor().post('/public/support/find', { email: 'not an address' })).status, 400);

  // It cannot be used to fill someone's inbox: three times a day for one address, whoever asks.
  for (let i = 0; i < 2; i++) assert.equal((await visitor().post('/public/support/find', { email: 'lost.mail@help.example' })).status, 200);
  assert.equal((await visitor().post('/public/support/find', { email: 'lost.mail@help.example' })).status, 429);
});

test('deleting one account never removes the stored emails of another customer, whatever the two are called', async () => {
  const copies = (email: string) => db.get('SELECT COUNT(*) n FROM emails WHERE envelope_id IS NULL AND lower(to_email)=lower(?)', email).n;
  // Vic has copies of emails that belong to no document: his confirmation, and an invitation he sent.
  const vic = await person('John Smith', 'vic@samename.example');
  assert.equal((await vic.post('/account/invites', { email: 'vics.colleague@samename.example' })).status, 200);
  const billy = await person('Billy Joe', 'billy.joe@samename.example');
  const before = { vic: copies('vic@samename.example'), invite: copies('vics.colleague@samename.example'), billy: copies('billy.joe@samename.example') };
  assert.ok(before.vic > 0 && before.invite > 0 && before.billy > 0);

  // A stranger whose name is words that every email of ours ends with, another John Smith, and someone whose
  // address is the tail of Billy's: each deletes their account at once.
  for (const [name, email] of [['Sent with', 'stranger@samename.example'], ['John Smith', 'other.john@samename.example'], ['Joe Short', 'joe@samename.example']]) {
    const c = await person(name, email);
    assert.equal((await c.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
  }
  assert.deepEqual({ vic: copies('vic@samename.example'), invite: copies('vics.colleague@samename.example'), billy: copies('billy.joe@samename.example') }, before, 'nobody else lost a thing');

  // When Vic himself goes, the copies that are his or about him go: the ones to him, and the invitation he sent.
  assert.equal((await vic.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
  assert.equal(copies('vic@samename.example') - db.get("SELECT COUNT(*) n FROM emails WHERE lower(to_email)='vic@samename.example' AND at > ?", new Date(Date.now() - 5000).toISOString()).n <= 0, true);
  assert.equal(copies('vics.colleague@samename.example'), 0);
  assert.equal(copies('billy.joe@samename.example'), before.billy);
  void billy;
});

test('deleting a login never removes a copy that strangers\' words point at, nor an email still waiting to be delivered', async () => {
  process.env.SUPPORT_EMAIL = 'desk@words.example';
  try {
    const count = (where: string, ...p: any[]) => db.get(`SELECT COUNT(*) n FROM emails WHERE ${where}`, ...p).n;
    const later = () => new Date(Date.now() + 5 * 60_000).toISOString();
    const vic = await person('Vic Victim', 'vic@words.example');
    // Carol, signed in under her own confirmed address, asks for help and names Vic the usual way.
    const carol = await person('Carol Customer', 'carol@words.example');
    const { SUPPORT_TOPICS } = await import('../src/lib/policy.ts');
    assert.equal((await carol.post('/public/support', { email: 'carol@words.example', name: 'Carol Customer', topic: (SUPPORT_TOPICS as readonly string[])[0],
      message: 'My colleague Vic Victim <vic@words.example> cannot open the document I sent him. Can someone look?' })).status, 200);
    // Mallory puts Vic's address into her own name, and invites Nina.
    const mal = await person('Mal <vic@words.example>', 'mal@words.example');
    assert.equal((await mal.post('/account/invites', { email: 'nina@words.example' })).status, 200);
    const theirs = { carol: count("to_email='carol@words.example'"), desk: count("to_email='desk@words.example'"), nina: count("to_email='nina@words.example'") };
    assert.ok(theirs.carol >= 2 && theirs.desk === 1 && theirs.nina === 1, JSON.stringify(theirs));
    // The mail server is down for the desk's copy, Nina's invitation and one email to Vic himself.
    db.run("UPDATE emails SET status='failed', tries=1, next_try_at=? WHERE to_email IN ('desk@words.example','nina@words.example')", later());
    db.run("UPDATE emails SET status='failed', tries=1, next_try_at=? WHERE id=(SELECT MIN(id) FROM emails WHERE to_email='vic@words.example')", later());
    assert.equal((await vic.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
    assert.deepEqual({ carol: count("to_email='carol@words.example'"), desk: count("to_email='desk@words.example'"), nina: count("to_email='nina@words.example'") }, theirs, 'nobody else lost a copy');
    // Vic's own copies went, except the one still waiting to be delivered (and the notice that his login is gone).
    assert.equal(count("to_email='vic@words.example' AND status='failed' AND next_try_at IS NOT NULL"), 1);
    assert.equal(count("to_email='vic@words.example' AND NOT (status='failed' AND next_try_at IS NOT NULL) AND subject NOT LIKE 'Your Sign&Grow account is closed%'"), 0);

    // Someone signs up with Nina's address without being able to confirm it, and deletes that login at once. The
    // invitation Mallory sent to that address before is Mallory's record, not theirs.
    db.run("UPDATE emails SET status='sent', next_try_at=NULL WHERE to_email IN ('desk@words.example','nina@words.example')");
    const eve = from();
    assert.equal((await eve.post('/auth/signup', { name: 'Not Nina', email: 'nina@words.example', password: PW })).status, 200);
    assert.equal((await eve.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
    assert.equal(count("to_email='nina@words.example' AND subject NOT LIKE 'Your Sign&Grow account is closed%' AND subject NOT LIKE 'Confirm your email%'"), 1, 'the invitation is still there');

    // When Carol herself goes, her copies go, and so does the desk's note about her request, which is marked as
    // being about her. Mallory's invitation to Nina stays.
    assert.equal((await carol.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
    assert.equal(count("to_email='desk@words.example'"), 0);
    assert.equal(count("to_email='carol@words.example' AND subject NOT LIKE 'Your Sign&Grow account is closed%'"), 0);
    assert.equal(count("to_email='nina@words.example' AND subject LIKE '%invit%'"), 1);
  } finally {
    delete process.env.SUPPORT_EMAIL;
  }
});

test('reports made through a public form never count towards pausing its owner, also after the owner deleted the abandoned starts', async () => {
  const owner = await person('Polly Forms', 'polly@formreports.example');
  const form = await formOf(owner, 'Volunteer waiver');
  const acc = (await me(owner)).account.id;
  // Someone starts the form three times under three addresses of their own and walks away.
  const starts: { code: string; e: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const s = await visitor().post(`/public/powerforms/${form.slug}/start`, { name: `Troll ${i}`, email: `troll${i}@formreports.example` });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    starts.push({ code: db.get('SELECT check_code c FROM recipients WHERE token=?', s.data.url.split('/sign/')[1]).c, e: envelopeOf(s.data.url) });
  }
  // The timer closes them after a day, and the owner tidies up: nobody signed, so they are deleted for good.
  for (const { e } of starts) (db.run('UPDATE envelopes SET sent_at=? WHERE id=?', ago(2), e), db.run('UPDATE audit SET at=? WHERE envelope_id=?', ago(2), e));
  await cron.tick();
  for (const { e } of starts) {
    assert.equal((await owner.call('DELETE', `/envelopes/${e}`)).status, 200);
    assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', e).n, 0);
  }
  // The three codes are still recognised and can still be reported. Each report is kept for a person to read, and
  // none counts towards the pause, exactly as while the starts existed.
  for (const { code } of starts) {
    assert.equal((await visitor().post('/public/check', { code })).data.can_report, true);
    assert.equal((await visitor().post('/public/check/report', { code, reason: 'phishing' })).status, 200);
  }
  assert.deepEqual(db.all('SELECT via_form FROM abuse_reports WHERE account_id=?', acc).map((r: any) => r.via_form), [1, 1, 1]);
  assert.equal(db.get('SELECT suspended_at FROM accounts WHERE id=?', acc).suspended_at, null, 'not paused');
  // Nothing about the visitors is kept with the mark: only that the code was a form visitor's.
  assert.ok(!/troll|Troll/.test(JSON.stringify(db.all('SELECT * FROM forgotten_codes'))));

  // An ordinary recipient of the same account, whose document was deleted, still reports like anyone else.
  const e = await simple(owner, 'reader@formreports.example', { subject: 'Ordinary letter' });
  assert.equal((await owner.post(`/envelopes/${e.id}/send`)).status, 200);
  const code = db.get('SELECT check_code c FROM recipients WHERE envelope_id=?', e.id).c;
  assert.equal((await owner.post(`/envelopes/${e.id}/void`, { reason: 'Mistake' })).status, 200);
  assert.equal((await owner.call('DELETE', `/envelopes/${e.id}`)).status, 200);
  assert.equal((await visitor().post('/public/check/report', { code, reason: 'spam' })).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM abuse_reports WHERE account_id=? AND via_form=0', acc).n, 1);
});

test('handing over and leaving at the same moment never leave an account without exactly one owner, nor hand envelopes to someone who has gone', async () => {
  const ownersOf = (accountId: string) => db.all("SELECT user_id FROM memberships WHERE account_id=? AND role='owner'", accountId).length;
  // The owner hands the account to Lea while Lea presses Leave. Exactly one of the two happens, and the other says why.
  const olga = await person('Olga Hand', 'olga@samemoment.example');
  const lea = await join(olga, 'Lea Hand', 'lea@samemoment.example');
  const team = (await me(olga)).account;
  const [t, l] = await Promise.all([olga.post('/account/transfer-owner', { user_id: await idOf(lea) }), lea.post('/account/leave', {})]);
  assert.equal(ownersOf(team.id), 1, 'one owner, never none');
  assert.deepEqual([t.status, l.status].filter((s) => s === 200).length, 1, JSON.stringify([t.data, l.data]));
  assert.match((t.status === 200 ? l : t).data.error, /You own .* cannot leave|not on the team now, so nothing was changed/);

  // Bea leaves (her things go to the owner) while Ann leaves and names Bea. Whatever order they land in, Ann's
  // envelope ends up with somebody who is still on the team.
  const owner = await person('Otto Pair', 'otto@samemoment.example');
  const ann = await join(owner, 'Ann Pair', 'ann@samemoment.example');
  const bea = await join(owner, 'Bea Pair', 'bea@samemoment.example');
  const pair = (await me(owner)).account;
  const e = await simple(ann, 'client@samemoment.example', { subject: 'Ann in flight' });
  assert.equal((await ann.post(`/envelopes/${e.id}/send`)).status, 200);
  const [b, a] = await Promise.all([bea.post('/account/leave', {}), ann.post('/account/leave', { to: await idOf(bea) })]);
  assert.equal(b.status, 200);
  const holder = db.get('SELECT sender_id s FROM envelopes WHERE id=?', e.id).s;
  assert.ok(db.get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', pair.id, holder), 'the envelope belongs to a member');
  if (a.status !== 200) assert.match(a.data.error, /not on the team\. Nothing was changed/);
  assert.equal((await owner.get(`/envelopes/${e.id}`)).status, 200);

  // Leave pressed twice at once: one goes through, the other is told there was nothing to leave, and the owner gets
  // one email, not a second one that says nothing was handed over.
  const tom = await join(owner, 'Tom Twice', 'tom@samemoment.example');
  const mine = await simple(tom, 'c2@samemoment.example', { subject: 'Tom in flight' });
  assert.equal((await tom.post(`/envelopes/${mine.id}/send`)).status, 200);
  const [x, y] = await Promise.all([tom.post('/account/leave', {}), tom.post('/account/leave', {})]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.match((x.status === 409 ? x : y).data.error, /no longer on the team .*nothing to leave\. Nothing was changed/);
  assert.equal(mailTo('otto@samemoment.example').filter((m: any) => m.subject === `Tom Twice left ${pair.name}`).length, 1);
  assert.equal(db.all("SELECT m.account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='tom@samemoment.example'").length, 1, 'one workspace of his own');
});

test('someone an admin removes is told where they will be the next time they sign in', async () => {
  const o1 = await person('Olga Rem', 'olga@removed-lands.example');
  const o2 = await person('Otto Rem', 'otto@removed-lands.example');
  const rita = await join(o1, 'Rita Rem', 'rita@removed-lands.example');
  assert.equal((await o2.post('/account/invites', { email: 'rita@removed-lands.example' })).status, 200);
  assert.equal((await rita.post('/invites/accept', { token: inviteFor('rita@removed-lands.example') })).status, 200);
  const other = (await me(o2)).account.name;
  assert.equal((await o1.call('DELETE', `/account/members/${await idOf(rita)}`)).status, 200);
  const m = mailTo('rita@removed-lands.example').find((x: any) => /You were removed/.test(x.subject));
  assert.ok(text(m.html).includes(`The next time you sign in you are in ${other}, another workspace you belong to`), text(m.html));
  assert.doesNotMatch(text(m.html), /a workspace of your own/);
  const again = from();
  assert.equal((await again.post('/auth/login', { email: 'rita@removed-lands.example', password: PW })).status, 200);
  assert.equal((await me(again)).account.name, other, 'and that is where she lands');
  // Someone in no other team is told they get a workspace of their own.
  const q = await join(o1, 'Quinn Alone', 'quinn@removed-lands.example');
  assert.equal((await o1.call('DELETE', `/account/members/${await idOf(q)}`)).status, 200);
  assert.match(text(mailTo('quinn@removed-lands.example').find((x: any) => /You were removed/.test(x.subject)).html), /you are in a workspace of your own/);
});

test('a shared-device form takes a steady stream of people from one front desk, and every limit says what it is', async () => {
  const keep = { n: process.env.NEW_ACCOUNT_DAILY_RECIPIENTS, u: process.env.UNPAID_DAILY_RECIPIENTS };
  // The daily limit for new accounts is a separate rule with its own words; here it is out of the way.
  process.env.NEW_ACCOUNT_DAILY_RECIPIENTS = process.env.UNPAID_DAILY_RECIPIENTS = '1000';
  try {
    const { POWERFORM_SHARED_STARTS_PER_HOUR, POWERFORM_STARTS_PER_HOUR } = await import('../src/lib/policy.ts');
    assert.ok(POWERFORM_SHARED_STARTS_PER_HOUR >= 60);
    const desk = await person('Dana Busy', 'dana@frontdesk.example');
    const kiosk = await formOf(desk, 'Front desk waiver', true);
    const plain = await formOf(desk, 'Ordinary form');
    const here = ip();
    const at = () => Object.assign(new Client(), { ip: here });
    // Each person finishes before the next one starts (marked done here, to keep the test quick).
    const done = (url: string) => db.run("UPDATE recipients SET status='completed' WHERE token=?", url.split('/sign/')[1]);
    for (let i = 0; i < POWERFORM_SHARED_STARTS_PER_HOUR; i++) {
      const s = await at().post(`/public/powerforms/${kiosk.slug}/start`, { name: `Guest ${i}`, email: `g${i}@frontdesk.example` });
      assert.equal(s.status, 200, `person ${i + 1}: ${JSON.stringify(s.data)}`);
      done(s.data.url);
    }
    const full = await at().post(`/public/powerforms/${kiosk.slug}/start`, { name: 'One More', email: 'more@frontdesk.example' });
    assert.equal(full.status, 429);
    assert.match(full.data.error, new RegExp(`started ${POWERFORM_SHARED_STARTS_PER_HOUR} times within an hour .* Please try again in \\d+ minutes?\\. .*own phones`));
    assert.doesNotMatch(full.data.error, /Too many attempts/);
    // The front desk's stream does not use up what the same connection may start on ordinary forms.
    for (let i = 0; i < POWERFORM_STARTS_PER_HOUR; i++) {
      const s = await at().post(`/public/powerforms/${plain.slug}/start`, { name: `Walker ${i}`, email: `w${i}@frontdesk.example` });
      assert.equal(s.status, 200, `ordinary ${i + 1}: ${JSON.stringify(s.data)}`);
      done(s.data.url);
    }
    const ordinary = await at().post(`/public/powerforms/${plain.slug}/start`, { name: 'Walker More', email: 'wmore@frontdesk.example' });
    assert.equal(ordinary.status, 429);
    assert.match(ordinary.data.error, new RegExp(`started ${POWERFORM_STARTS_PER_HOUR} times within an hour .* mark it as used on a shared device: such a form takes up to ${POWERFORM_SHARED_STARTS_PER_HOUR} people an hour`));
    // Another connection is not affected.
    assert.equal((await visitor().post(`/public/powerforms/${kiosk.slug}/start`, { name: 'Elsewhere', email: 'else@frontdesk.example' })).status, 200);
  } finally {
    for (const [k, v] of [['NEW_ACCOUNT_DAILY_RECIPIENTS', keep.n], ['UNPAID_DAILY_RECIPIENTS', keep.u]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('a form start that was cleared offers the visitor a fresh form and emails its owner nothing about deadlines', async () => {
  const desk = await person('Ivo Inbox', 'ivo@cleared.example');
  const kiosk = await formOf(desk, 'Sign-in sheet', true);
  const here = ip();
  const at = () => Object.assign(new Client(), { ip: here });
  const s = await at().post(`/public/powerforms/${kiosk.slug}/start`, { name: 'Walker One', email: 'walker@cleared.example' });
  const tok = s.data.url.split('/sign/')[1];
  const eid = envelopeOf(s.data.url);
  db.run('UPDATE envelopes SET sent_at=? WHERE id=?', ago(0.05), eid);
  db.run('UPDATE audit SET at=? WHERE envelope_id=?', ago(0.05), eid);
  await cron.tick();
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', eid).status, 'expired');
  const before = mailTo('ivo@cleared.example').length;
  // Back on the tablet, or the visitor's own email: the link says the form was cleared and where to start again.
  const view = await at().get(`/sign/${tok}`);
  assert.equal(view.status, 200);
  assert.deepEqual([view.data.envelope.form_cleared, view.data.envelope.start_again, view.data.envelope.removed], [true, kiosk.slug, false]);
  const finish = await at().post(`/sign/${tok}/complete`, { values: {}, signature_png: PNG });
  assert.equal(finish.status, 400);
  assert.match(finish.data.error, new RegExp(`cleared to make room for others\\. To sign, start again at http://test\\.local/f/${kiosk.slug}\\. The new form starts empty`));
  const more = await at().post(`/sign/${tok}/request-extension`, {});
  assert.equal(more.status, 409);
  assert.match(more.data.error, /start again/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mailTo('ivo@cleared.example').length, before, 'the owner was not told a deadline passed, nor asked for more time');
  // A paused form has nowhere to start again: the words say so.
  assert.equal((await desk.call('PATCH', `/powerforms/${kiosk.id}`, { active: false })).status, 200);
  assert.equal((await at().get(`/sign/${tok}`)).data.envelope.start_again, null);
  assert.match((await at().post(`/sign/${tok}/complete`, { values: {}, signature_png: PNG })).data.error, /not taking new people right now\. Please contact whoever gave you the link/);

  // A visitor who pressed Finish while no signature was free was told their answers are kept: that start stays the
  // owner's to reopen, so the owner still hears that they could not open it.
  db.run('UPDATE recipients SET form_waits_at=? WHERE token=?', ago(0.01), tok);
  await at().get(`/sign/${tok}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mailTo('ivo@cleared.example').filter((m: any) => m.subject === 'Could not open: Sign-in sheet').length, 1);
});

test('an expired envelope its sender removed tells the signer so, and never emails the sender a link that leads nowhere', async () => {
  const owner = await person('Olga Hidden', 'olga@hidden-expired.example');
  const mona = await join(owner, 'Mona Member', 'mona@hidden-expired.example');
  const two = { ordered: false, recipients: [{ id: 'a', role: 'signer', name: 'Ann First', email: 'ann@hidden-expired.example' }, { id: 'b', role: 'signer', name: 'Bob Second', email: 'bob@hidden-expired.example' }],
    fields: [{ id: 'fa', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'fb', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 }] };
  const e = await simple(mona, '', { subject: 'Expired half signed', ...two });
  assert.equal((await mona.post(`/envelopes/${e.id}/send`)).status, 200);
  const { signAll } = await import('./helpers.ts');
  assert.equal((await signAll(e.id, 'ann@hidden-expired.example')).status, 200);
  db.run('UPDATE envelopes SET expires_at=? WHERE id=?', new Date(Date.now() - 60_000).toISOString(), e.id);
  await cron.tick();
  assert.deepEqual((await mona.call('DELETE', `/envelopes/${e.id}`)).data, { ok: true, kept_for_recipients: true });
  const before = mailTo('mona@hidden-expired.example').length;
  const bob = visitor();
  const bobTok = db.get("SELECT token FROM recipients WHERE envelope_id=? AND email='bob@hidden-expired.example'", e.id).token;
  const page = await bob.get(`/sign/${bobTok}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.envelope.removed, true, 'the page does not offer to ask for more time');
  const ask = await bob.post(`/sign/${bobTok}/request-extension`, {});
  assert.equal(ask.status, 409);
  assert.match(ask.data.error, /Mona Member has removed this document from their list.*ask them to send it again/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mailTo('mona@hidden-expired.example').length, before, 'no "Could not open" and no "More time needed"');
  // Once an admin puts it back, the ordinary help returns.
  assert.equal((await owner.post(`/envelopes/${e.id}/restore`, {})).status, 200);
  assert.equal((await bob.get(`/sign/${bobTok}`)).data.envelope.removed, false);
  assert.equal((await bob.post(`/sign/${bobTok}/request-extension`, {})).status, 200);
});

test('deleting keeps every envelope on which somebody keeps a copy, the dialog is told the same rule, and a retry key never sends a deleted one again', async () => {
  const { signAll, upload } = await import('./helpers.ts');
  const owner = await person('Olga Keeps', 'olga@keeps.example');
  const mona = await join(owner, 'Mona Keeps', 'mona@keeps.example');
  const tokenOf = (eid: string, email: string) => db.get('SELECT token FROM recipients WHERE envelope_id=? AND email=?', eid, email).token;

  // Only a viewer had finished (confirmed viewing) before it was voided. Their download keeps working after delete.
  const file = await upload(mona, 1);
  const made = await mona.post('/envelopes', { subject: 'Viewer only', documents: [{ id: 'd', file_id: file.id }], ordered: false,
    recipients: [{ id: 'v', role: 'viewer', name: 'Vera Viewer', email: 'vera@keeps.example' }, { id: 's', role: 'signer', name: 'Sid Signer', email: 'sid@keeps.example' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 's', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
  const viewerOnly = made.data.envelope.id;
  assert.equal((await mona.post(`/envelopes/${viewerOnly}/send`)).status, 200);
  assert.equal((await signAll(viewerOnly, 'vera@keeps.example')).status, 200);
  assert.equal((await mona.post(`/envelopes/${viewerOnly}/void`, { reason: 'Changed my mind' })).status, 200);
  assert.equal((await mona.get(`/envelopes/${viewerOnly}`)).data.kept_on_delete, true, 'the dialog says it is kept');
  assert.deepEqual((await mona.call('DELETE', `/envelopes/${viewerOnly}`)).data, { ok: true, kept_for_recipients: true });
  assert.equal((await visitor().call('GET', `/sign/${tokenOf(viewerOnly, 'vera@keeps.example')}/download`)).status, 200);

  // Signed, then changed and sent back to sign again, then voided: kept, and the dialog was told so beforehand.
  const two = { ordered: false, recipients: [{ id: 'a', role: 'signer', name: 'Cy First', email: 'cy@keeps.example' }, { id: 'b', role: 'signer', name: 'Di Second', email: 'di@keeps.example' }],
    fields: [{ id: 'fa', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'fb', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 }] };
  const again = await simple(mona, '', { subject: 'Signed before', ...two });
  assert.equal((await mona.post(`/envelopes/${again.id}/send`)).status, 200);
  assert.equal((await signAll(again.id, 'cy@keeps.example')).status, 200);
  const full = (await mona.get(`/envelopes/${again.id}`)).data.envelope;
  const put = await mona.put(`/envelopes/${again.id}`, { ...full, fields: [...full.fields, { id: 'nn', document_id: full.documents[0].id, type: 'note', value: 'Changed', page: 0, x: 0.5, y: 0.8, w: 0.3, h: 0.03 }], resign: true });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal((await mona.post(`/envelopes/${again.id}/void`, { reason: 'x' })).status, 200);
  const view = (await mona.get(`/envelopes/${again.id}`)).data;
  assert.ok(view.envelope.recipients.every((r: any) => r.status !== 'completed'), 'nobody is marked completed any more');
  assert.equal(view.kept_on_delete, true);
  assert.equal((await mona.call('DELETE', `/envelopes/${again.id}`)).data.kept_for_recipients, true);

  // Nobody finished: the dialog says "for good", and it is.
  const none = await simple(mona, 'nobody@keeps.example', { subject: 'Never signed' });
  assert.equal((await mona.post(`/envelopes/${none.id}/send`)).status, 200);
  assert.equal((await mona.post(`/envelopes/${none.id}/void`, { reason: 'Mistake' })).status, 200);
  assert.equal((await mona.get(`/envelopes/${none.id}`)).data.kept_on_delete, false);
  assert.equal((await mona.call('DELETE', `/envelopes/${none.id}`)).data?.kept_for_recipients, undefined);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', none.id).n, 0);

  // An integration made and sent one with an Idempotency-Key; it was signed and Mona deleted it. The retry of that
  // same call must not send it to the signer a second time.
  const key = (await mona.post('/api-keys', { name: 'crm' })).data.key;
  const api = withKey(key);
  const f2 = await upload(mona, 1);
  const body = { subject: 'Order 1001', send: true, documents: [{ id: 'd', file_id: f2.id }], recipients: [{ id: 'r', role: 'signer', name: 'Pat Payer', email: 'pat@keeps.example' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] };
  const first = await api.call('POST', '/envelopes', body, { 'idempotency-key': 'order-1001' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal((await signAll(first.data.envelope.id, 'pat@keeps.example')).status, 200);
  assert.equal((await mona.call('DELETE', `/envelopes/${first.data.envelope.id}`)).data.kept_for_recipients, true);
  const mails = mailTo('pat@keeps.example').length;
  const retry = await api.call('POST', '/envelopes', body, { 'idempotency-key': 'order-1001' });
  assert.equal(retry.status, 409);
  assert.match(retry.data.error, /already made envelope .* deleted from your lists since\. Nothing new was created and nobody was emailed again/);
  assert.equal(mailTo('pat@keeps.example').length, mails);
  assert.equal(db.get("SELECT COUNT(*) n FROM envelopes WHERE subject='Order 1001'").n, 1);
});

test('the Leave dialog can name where the person lands: /me lists workspaces oldest first, and leaving goes to the first of the others', async () => {
  const o1 = await person('Olga First', 'olga@lands.example');
  const o2 = await person('Otto Second', 'otto@lands.example');
  const o3 = await person('Ivy Third', 'ivy@lands.example');
  const mira = await join(o1, 'Mira Many', 'mira@lands.example');
  for (const o of [o2, o3]) {
    assert.equal((await o.post('/account/invites', { email: 'mira@lands.example' })).status, 200);
    assert.equal((await mira.post('/invites/accept', { token: inviteFor('mira@lands.example') })).status, 200);
  }
  const now_ = await me(mira);
  assert.deepEqual(now_.accounts.map((a: any) => a.name), ["Olga First's workspace", "Otto Second's workspace", "Ivy Third's workspace"]);
  assert.equal(now_.account.name, "Ivy Third's workspace");
  // What the dialog says (the first of the others in that list) is where the server puts her.
  const named = now_.accounts.find((a: any) => a.id !== now_.account.id).name;
  const left = await mira.post('/account/leave', {});
  assert.equal(left.status, 200);
  assert.equal(left.data.now_in.name, named);
  assert.equal((await me(mira)).account.name, named);
});
