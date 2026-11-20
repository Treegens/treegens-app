// The last open ends: leaving a team by yourself, and what follows further down in this file.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, simple, signUp, mailTo, type Server } from './helpers.ts';
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
