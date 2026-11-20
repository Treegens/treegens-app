// Keeping closed envelopes for a set time and no longer (src/server/records.ts): the account's rule and a template's
// own period, the due date for each way of closing, the one email 14 days before, "Keep it", legal holds on an
// envelope and a folder (every way of deleting refused and recorded, closing the account too, and the operators'
// two-person lift), "Purge now" with its 14 days and calling it off, what each level removes and nothing more, the
// audit trail that says which lines were redacted instead of calling the record altered, /verify and the signing
// link after a purge, the export and the evidence pack, the disposition record that is never changed, and today's
// delete and restore as they were.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { boot, Client, PNG, simple, upload, tokenFor, signUp, mailTo, type Server } from './helpers.ts';
import { RETENTION_NOTICE_DAYS, PURGED_LINK, redactedNote, removedOn, retentionStays } from '../src/lib/retention.ts';

let db: Server['db'];
let rec: typeof import('../src/server/records.ts');
before(async () => {
  ({ db } = await boot());
  rec = await import('../src/server/records.ts');
});

const DAY = 864e5;
const today = () => new Date().toISOString().slice(0, 10);
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const onDisk = (s: string) => fs.existsSync(path.join(process.env.DATA_DIR!, 'blobs', s));
let n = 0;
const ip = () => `10.77.${Math.floor(++n / 250)}.${n % 250}`;
const person = (name: string, email: string) => signUp(name, email, ip());
const signer = () => Object.assign(new Client(), { ip: ip() });
const PW = 'correct horse battery';
const inviteFor = (email: string) => db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email)?.token;
async function join(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const c = signer();
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: inviteFor(email) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}

// A completed envelope: one signer types a value, signs, and (with `attach`) attaches a file of their own.
async function completed(c: Client, email: string, o: { subject?: string; attach?: boolean; template?: string } = {}) {
  let e: any;
  if (o.template) e = (await c.post('/envelopes', { template_id: o.template, subject: o.subject || 'From a template', recipients: { Signer: { name: 'Tia Templ', email } } })).data.envelope;
  else {
    // A page of its own: stored files are shared by their fingerprint, and the same bytes in another test would keep the file.
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]).drawText(`Lease ${email} ${Math.random()}`, { x: 72, y: 700 });
    const form = new FormData();
    form.append('file', new Blob([await pdf.save()], { type: 'application/pdf' }), 'Lease.pdf');
    const file = (await c.call('POST', '/files', form)).data;
    const r = await c.post('/envelopes', {
      subject: o.subject || 'Lease for Rosa Lind', message: 'Hello Rosa Lind, please sign.',
      documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Rosa Lind', email }],
      fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
        { id: 't', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Flat number', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.04 },
        ...(o.attach ? [{ id: 'a', document_id: 'd', recipient_id: 'r', type: 'attachment', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.06, required: false }] : [])],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    e = r.data.envelope;
  }
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, email);
  const s = signer();
  await s.post(`/sign/${tok}/consent`);
  const v = (await s.get(`/sign/${tok}`)).data;
  let att: string | null = null;
  if (o.attach) {
    const d = await PDFDocument.create();
    d.addPage([300, 300]).drawText(`Passport of Rosa Lind ${Math.random()}`, { x: 20, y: 150 });
    const f = new FormData();
    f.append('file', new Blob([await d.save()], { type: 'application/pdf' }), 'passport.pdf');
    const up = await s.call('POST', `/sign/${tok}/upload`, f);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    att = up.data.id;
  }
  const values: Record<string, string> = {};
  for (const x of v.fields) values[x.id] = x.type === 'attachment' ? att! : x.type === 'text' ? 'Flat 12B' : '1';
  const done = await s.post(`/sign/${tok}/complete`, { values, signature_png: PNG });
  assert.equal(done.data.envelope_status, 'completed', JSON.stringify(done.data));
  return { id: e.id as string, tok, attachment: att, final: db.get('SELECT final_sha256 s FROM envelopes WHERE id=?', e.id).s as string };
}
// The rule says closed envelopes are due; this moves one envelope's closing back in time.
const closedDaysAgo = (eid: string, days: number) => db.run('UPDATE envelopes SET completed_at=? WHERE id=?', ago(days), eid);
// The 14 days after the email have passed.
const noticePassed = (eid: string) => db.run('UPDATE retention_queue SET noticed_at=?, goes_at=? WHERE envelope_id=?', ago(RETENTION_NOTICE_DAYS + 1), ago(1), eid);
const queue = (eid: string) => db.get('SELECT * FROM retention_queue WHERE envelope_id=?', eid);
const purgedAt = (eid: string) => db.get('SELECT purged_at p FROM envelopes WHERE id=?', eid)?.p;

test('the rule: off by default, only admins change it, 30 to 9,999 days, a level, a template of its own, and a dry run that counts', async () => {
  const owner = await person('Ola Owner', 'ola@ret.test');
  const member = await join(owner, 'Mo Member', 'mo@ret.test');
  const r = await owner.get('/account/retention');
  assert.equal(r.status, 200);
  assert.equal(r.data.policy.on, false, 'off by default');
  assert.equal(r.data.levels.length, 3);
  assert.ok(r.data.stays.some((s: string) => /SHA-256/.test(s)) && r.data.stays.some((s: string) => /Backups/.test(s)), 'what stays is said');
  assert.ok(!r.data.stays.join(' ').match(/deleted everywhere/i));
  assert.equal((await member.get('/account/retention')).data.may_change, false, 'a member may read the rule');
  assert.equal((await member.get('/account/retention')).data.holds, undefined, 'and sees no holds or queue');
  assert.equal((await member.put('/account/retention', { days: 365 })).status, 403);
  for (const days of [29, 10_000, 1.5, 'many']) assert.equal((await owner.put('/account/retention', { days })).status, 400, `days ${days} is refused`);
  assert.equal((await owner.put('/account/retention', { days: 365, level: 'everything' })).status, 400);
  // A dry run says how many closed envelopes the rule would reach at once, and saves nothing.
  const e = await completed(owner, 'rosa1@ret.test');
  closedDaysAgo(e.id, 400);
  const dry = await owner.put('/account/retention', { days: 365, dry_run: true });
  assert.equal(dry.data.would_notice_now, 1);
  assert.equal((await owner.get('/account/retention')).data.policy.on, false, 'nothing was saved');
  const tpl = (await owner.post('/envelopes', { kind: 'template', subject: 'Contract template' })).data.envelope;
  const set = await owner.put('/account/retention', { days: 365, level: 'values', name: 'Contracts', code: 'GRS 2.1 item 050', templates: { [tpl.id]: 3650 } });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.deepEqual(set.data.policy, { on: true, days: 365, level: 'values', name: 'Contracts', code: 'GRS 2.1 item 050' });
  assert.equal((await owner.get('/account/retention')).data.templates.find((t: any) => t.id === tpl.id).days, 3650);
  assert.equal((await owner.put('/account/retention', { templates: { tpl_nothere: 400 } })).status, 404);
  const log = (await owner.get('/account/retention/log')).data.lines;
  assert.ok(log.some((l: any) => l.what === 'policy' && /Was: off/.test(l.detail)), 'the change is in the record');
  assert.ok(log.some((l: any) => l.what === 'template_period'));
  assert.equal((await member.get('/account/retention/log')).status, 403, 'the record is for admins');
  // A name typed like a spreadsheet formula is written so that it cannot run as one.
  rec.logLine(db.get("SELECT a.id FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email='ola@ret.test'").id, null, 'keep', { who: '=HYPERLINK("http://x")' });
  const csv = await owner.call('GET', '/account/retention/log?format=csv');
  assert.match(Buffer.from(csv.data).toString(), /line,at,what,envelope_id/);
  assert.match(Buffer.from(csv.data).toString(), /"'=HYPERLINK/);
  // The security record has the change too (seclog.ts).
  assert.ok(db.get("SELECT 1 x FROM security_events WHERE kind='retention.changed'"));
});

test('due dates for each way of closing, counted from when it closed, and a template\'s own period', async () => {
  const owner = await person('Dee Dates', 'dee@ret.test');
  assert.equal((await owner.put('/account/retention', { days: 100 })).status, 200);
  const done = await completed(owner, 'rosa2@ret.test');
  const at = db.get('SELECT completed_at c FROM envelopes WHERE id=?', done.id).c;
  let f = (await owner.get(`/envelopes/${done.id}`)).data.retention;
  assert.equal(f.closed_at, at);
  assert.equal(f.due_at, new Date(Date.parse(at) + 100 * DAY).toISOString());
  // Voided.
  const v = await simple(owner, 'void@ret.test');
  await owner.post(`/envelopes/${v.id}/send`);
  await owner.post(`/envelopes/${v.id}/void`, { reason: 'Wrong flat' });
  const vat = db.get("SELECT at FROM audit WHERE envelope_id=? AND action='Envelope voided'", v.id).at;
  f = (await owner.get(`/envelopes/${v.id}`)).data.retention;
  assert.equal(f.closed_at, vat);
  assert.equal(f.due_at, new Date(Date.parse(vat) + 100 * DAY).toISOString());
  // Declined.
  const d = await simple(owner, 'decline@ret.test');
  await owner.post(`/envelopes/${d.id}/send`);
  const s = signer();
  const tok = tokenFor(d.id, 'decline@ret.test');
  await s.post(`/sign/${tok}/consent`);
  assert.equal((await s.post(`/sign/${tok}/decline`, { reason: 'Not my flat' })).status, 200);
  const dat = db.get("SELECT at FROM audit WHERE envelope_id=? AND action='Declined'", d.id).at;
  assert.equal((await owner.get(`/envelopes/${d.id}`)).data.retention.closed_at, dat);
  // Expired: the timer closes it when its deadline passes.
  const x = await simple(owner, 'expire@ret.test');
  await owner.post(`/envelopes/${x.id}/send`);
  db.run('UPDATE envelopes SET expires_at=? WHERE id=?', ago(1), x.id);
  await (await import('../src/server/envelopes.ts')).cronTick();
  assert.equal(db.get('SELECT status s FROM envelopes WHERE id=?', x.id).s, 'expired');
  const xat = db.get("SELECT at FROM audit WHERE envelope_id=? AND action='Envelope expired'", x.id).at;
  assert.equal((await owner.get(`/envelopes/${x.id}`)).data.retention.closed_at, xat);
  // Still out: never due.
  const out = await simple(owner, 'out@ret.test');
  await owner.post(`/envelopes/${out.id}/send`);
  f = (await owner.get(`/envelopes/${out.id}`)).data.retention;
  assert.equal(f.closed_at, null);
  assert.equal(f.due_at, null);
  // A template's own period wins for what is started from it.
  const file = await upload(owner, 1);
  const tpl = (await owner.post('/envelopes', { kind: 'template', subject: 'Lease template', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Signer' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  assert.equal((await owner.put('/account/retention', { templates: { [tpl.id]: 3650 } })).status, 200);
  const fromTpl = await completed(owner, 'tia@ret.test', { template: tpl.id });
  f = (await owner.get(`/envelopes/${fromTpl.id}`)).data.retention;
  assert.equal(f.period.days, 3650);
  assert.equal(f.period.from, 'template');
});

test('the 14-day email goes once, to the sender and the admins, and nothing goes before those 14 days', async () => {
  const owner = await person('Nia Notice', 'nia@ret.test');
  const member = await join(owner, 'Sol Sender', 'sol@ret.test');
  assert.equal((await owner.put('/account/retention', { days: 30 })).status, 200);
  const e = await completed(member, 'rosa3@ret.test');
  closedDaysAgo(e.id, 400);
  const soon = await completed(member, 'rosa4@ret.test');
  closedDaysAgo(soon.id, 20); // due in 10 days: in the queue now, goes in 14
  const later = await completed(member, 'rosa5@ret.test');
  closedDaysAgo(later.id, 5); // due in 25 days: not yet
  const before = { sol: mailTo('sol@ret.test').length, nia: mailTo('nia@ret.test').length };
  // The timer serves every account in this database, so each envelope is looked at by itself.
  await rec.retentionTick();
  assert.ok(queue(e.id).noticed_at && queue(soon.id).noticed_at);
  assert.equal(queue(later.id), null);
  assert.ok(!purgedAt(e.id) && !purgedAt(soon.id), 'nothing goes at the email');
  const sol = mailTo('sol@ret.test').slice(before.sol), nia = mailTo('nia@ret.test').slice(before.nia);
  assert.equal(sol.length, 1, 'one email to the sender with both');
  assert.equal(nia.length, 1, 'one to the admin');
  assert.match(sol[0].subject, /2 envelopes will be purged/);
  assert.match(sol[0].html, new RegExp(e.id));
  assert.match(sol[0].html, new RegExp(soon.id));
  assert.doesNotMatch(sol[0].html, new RegExp(later.id));
  assert.match(sol[0].html, /Keep it/);
  assert.match(sol[0].html, /What stays after a purge/);
  assert.doesNotMatch(sol[0].html, /deleted everywhere/i);
  for (const id of [e.id, soon.id]) {
    const q = queue(id);
    assert.ok(Date.parse(q.goes_at) >= Date.parse(q.noticed_at) + RETENTION_NOTICE_DAYS * DAY - 1000, 'at least 14 days after the email');
  }
  // Again: no second email.
  await rec.retentionTick();
  assert.equal(mailTo('sol@ret.test').length, before.sol + 1);
  assert.equal(mailTo('nia@ret.test').length, before.nia + 1);
  // 14 days on, it goes.
  noticePassed(e.id);
  await rec.retentionTick();
  assert.ok(purgedAt(e.id));
  assert.ok(!purgedAt(soon.id));
  // The rule switched off: what was announced does not happen, and the record says so.
  assert.equal((await owner.put('/account/retention', { days: null })).status, 200);
  await rec.retentionTick();
  assert.equal(queue(soon.id).noticed_at, null);
  assert.ok(db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Purge called off'", soon.id));
  noticePassed(soon.id);
  await rec.retentionTick();
  assert.ok(!purgedAt(soon.id));
});

test('a level raised after the email does not remove more than the email said', async () => {
  const owner = await person('Lev Level', 'lev@ret.test');
  await owner.put('/account/retention', { days: 30, level: 'documents' });
  const e = await completed(owner, 'rosa6@ret.test');
  closedDaysAgo(e.id, 400);
  await rec.retentionTick();
  await owner.put('/account/retention', { level: 'personal' });
  noticePassed(e.id);
  await rec.retentionTick();
  assert.equal(db.get('SELECT purged_level l FROM envelopes WHERE id=?', e.id).l, 'documents');
  assert.equal(db.get('SELECT name FROM recipients WHERE envelope_id=?', e.id).name, 'Rosa Lind', 'names stay');
});

test('Keep it: a reason in the audit trail, one more period, and nobody keeps what is not theirs', async () => {
  const owner = await person('Kim Keep', 'kim@ret.test');
  const member = await join(owner, 'Kai Member', 'kai@ret.test');
  const other = await join(owner, 'Oli Other', 'oli@ret.test');
  await owner.put('/account/retention', { days: 30 });
  const e = await completed(member, 'rosa7@ret.test');
  closedDaysAgo(e.id, 400);
  await rec.retentionTick();
  assert.ok(queue(e.id).noticed_at);
  assert.equal((await member.post(`/envelopes/${e.id}/keep`, { reason: '' })).status, 400, 'a reason is needed');
  assert.equal((await other.post(`/envelopes/${e.id}/keep`, { reason: 'Mine now' })).status, 404, 'another member cannot see it');
  const k = await member.post(`/envelopes/${e.id}/keep`, { reason: 'Tenant still lives there' });
  assert.equal(k.status, 200, JSON.stringify(k.data));
  assert.ok(Math.abs(Date.parse(k.data.kept_until) - (Date.now() + 30 * DAY)) < 60_000);
  const line = db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Kept past its retention date'", e.id);
  assert.match(line.detail, /Tenant still lives there/);
  assert.equal(queue(e.id).noticed_at, null);
  noticePassed(e.id);
  db.run('UPDATE retention_queue SET noticed_at=NULL, goes_at=NULL WHERE envelope_id=?', e.id);
  const mails = mailTo('kai@ret.test').length;
  await rec.retentionTick();
  assert.equal(queue(e.id).noticed_at, null, 'kept: no email for another period');
  assert.equal(mailTo('kai@ret.test').length, mails);
  assert.ok(!purgedAt(e.id));
  // Off and never asked: nothing to keep it from.
  await owner.put('/account/retention', { days: null });
  assert.equal((await member.post(`/envelopes/${e.id}/keep`, { reason: 'Just in case' })).status, 400);
});

test('legal hold: every way of deleting is refused and recorded, a folder hold follows what leaves it, only an admin lifts it with a reason', async () => {
  const owner = await person('Hal Hold', 'hal@ret.test');
  const member = await join(owner, 'Hu Member', 'hu@ret.test');
  await owner.put('/account/retention', { days: 30 });
  // One nobody signed: deleting it would remove it for good.
  const v = await simple(member, 'vhold@ret.test');
  await member.post(`/envelopes/${v.id}/send`);
  await member.post(`/envelopes/${v.id}/void`, { reason: 'Hold me' });
  assert.equal((await member.post(`/envelopes/${v.id}/hold`, { reason: 'Claim 7' })).status, 403, 'members cannot hold');
  assert.equal((await owner.post(`/envelopes/${v.id}/hold`, { reason: '' })).status, 400, 'a reason is needed');
  const h = await owner.post(`/envelopes/${v.id}/hold`, { reason: 'Claim 7 against us', matter: 'M-7' });
  assert.equal(h.status, 200, JSON.stringify(h.data));
  assert.equal((await owner.post(`/envelopes/${v.id}/hold`, { reason: 'again' })).status, 409);
  // The member sees that it is held, not why.
  const seen = (await member.get(`/envelopes/${v.id}`)).data.retention;
  assert.equal(seen.held, true);
  assert.equal(seen.holds[0].reason, undefined);
  assert.equal((await owner.get(`/envelopes/${v.id}`)).data.retention.holds[0].reason, 'Claim 7 against us');
  // The sender deletes: refused, recorded.
  const del = await member.call('DELETE', `/envelopes/${v.id}`);
  assert.equal(del.status, 409);
  assert.equal(del.data.code, 'legal_hold');
  assert.ok(db.get('SELECT 1 x FROM envelopes WHERE id=?', v.id), 'still there');
  assert.ok(db.get("SELECT 1 x FROM retention_log WHERE envelope_id=? AND what='refused'", v.id), 'the attempt is recorded');
  // Purge now: refused.
  assert.equal((await member.post(`/envelopes/${v.id}/purge`, { level: 'documents' })).status, 409);
  // The rule: never, also long past its date.
  db.run("UPDATE audit SET at=? WHERE envelope_id=? AND action='Envelope voided'", ago(400), v.id);
  await rec.retentionTick();
  db.run('INSERT OR REPLACE INTO retention_queue (envelope_id, account_id, noticed_at, goes_at, level) VALUES (?,?,?,?,?)', v.id, db.get('SELECT account_id a FROM envelopes WHERE id=?', v.id).a, ago(30), ago(1), 'documents');
  await rec.retentionTick();
  assert.ok(!purgedAt(v.id));
  assert.equal(rec.purgeEnvelope(v.id, 'personal', { name: 'test', why: 'test' }), false, 'the purge itself refuses');
  // A folder hold covers what is in it, and what leaves it afterwards.
  const f1 = await completed(member, 'rosa8@ret.test');
  await member.call('PATCH', `/envelopes/${f1.id}`, { folder: 'Claims' });
  const fh = await owner.post('/account/retention/holds', { folder: 'Claims', reason: 'Litigation hold', matter: 'L-2026-4' });
  assert.equal(fh.status, 200, JSON.stringify(fh.data));
  assert.equal(fh.data.covers, 1);
  await member.call('PATCH', `/envelopes/${f1.id}`, { folder: 'Elsewhere' });
  assert.equal(rec.isHeld([f1.id]).size, 1, 'moving it out does not free it');
  // One put in the folder afterwards is covered too, and keeps the cover when it leaves.
  const f2 = await completed(member, 'rosa9@ret.test');
  await member.call('PATCH', `/envelopes/${f2.id}`, { folder: 'Claims' });
  await member.call('PATCH', `/envelopes/${f2.id}`, { folder: null });
  assert.equal(rec.isHeld([f2.id]).size, 1);
  const lift = await member.call('DELETE', `/envelopes/${f2.id}/hold`, { reason: 'done' });
  assert.equal(lift.status, 409, 'its own hold is the folder\'s: the envelope route says where to lift it');
  // Lifting: admins, with a reason.
  assert.equal((await member.call('DELETE', `/account/retention/holds/${fh.data.hold.id}`, { reason: 'Settled' })).status, 403);
  assert.equal((await owner.call('DELETE', `/account/retention/holds/${fh.data.hold.id}`, { reason: '' })).status, 400);
  assert.equal((await owner.call('DELETE', `/account/retention/holds/${fh.data.hold.id}`, { reason: 'Settled in court' })).status, 200);
  assert.equal(rec.isHeld([f1.id, f2.id]).size, 0);
  assert.ok(db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Legal hold lifted'", f1.id));
  assert.equal((await owner.call('DELETE', `/envelopes/${v.id}/hold`, { reason: 'Claim dropped' })).status, 200);
  assert.equal((await member.call('DELETE', `/envelopes/${v.id}`)).status, 200, 'deleting works again');
  const log = (await owner.get('/account/retention/log')).data.lines.map((l: any) => l.what);
  for (const w of ['hold', 'hold_lifted', 'refused']) assert.ok(log.includes(w), w);
  assert.ok(db.get("SELECT 1 x FROM security_events WHERE kind='legal_hold.placed'"));
  assert.ok(db.get("SELECT 1 x FROM security_events WHERE kind='legal_hold.lifted'"));
  // A hold placed while a purge waits calls the purge off, with a line in the record.
  const w = await completed(member, 'rosa18@ret.test');
  assert.equal((await member.post(`/envelopes/${w.id}/purge`, { level: 'documents' })).status, 200);
  assert.equal((await owner.post(`/envelopes/${w.id}/hold`, { reason: 'Before it goes' })).status, 200);
  assert.equal(queue(w.id).asked_at, null);
  assert.ok(db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Purge called off'", w.id));
  // An integration key with the "send" scope neither places nor lifts a hold, whoever made it.
  const made = await owner.post('/api-keys', { name: 'Website' });
  const key = new Client();
  const call = key.call.bind(key);
  key.call = (m: string, u: string, b?: any, h: Record<string, string> = {}) => call(m, u, b, { authorization: `Bearer ${made.data.key}`, ...h });
  assert.equal((await key.call('DELETE', `/envelopes/${w.id}/hold`, { reason: 'Integration says so' })).status, 403);
  assert.equal(rec.isHeld([w.id]).size, 1);
  assert.equal((await key.put('/account/retention', { days: null })).status, 403);
});

test('legal hold: closing the account is refused with the list of holds, also on the timer and in purgeUser', async () => {
  const owner = await person('Cy Close', 'cy@ret.test');
  const e = await completed(owner, 'rosa10@ret.test');
  await owner.post(`/envelopes/${e.id}/hold`, { reason: 'Audit by the regulator', matter: 'R-1' });
  const r = await owner.post('/me/delete', { password: PW, now: true });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /legal hold/);
  assert.match(r.data.error, /R-1/);
  const uid = db.get('SELECT id FROM users WHERE email=?', 'cy@ret.test').id;
  assert.equal(db.get('SELECT closing_at c FROM users WHERE id=?', uid).c, null, 'nothing changed');
  const trust = await import('../src/server/routes-trust.ts');
  assert.throws(() => trust.purgeUser(uid), /legal hold/);
  // A login that is closing when a hold is on (set by hand here) is not deleted by the timer either.
  db.run('UPDATE users SET closing_at=? WHERE id=?', ago(1), uid);
  await trust.purgeClosedAccounts();
  assert.ok(db.get('SELECT 1 x FROM users WHERE id=?', uid), 'kept');
  assert.ok(db.get('SELECT 1 x FROM envelopes WHERE id=?', e.id));
  await trust.purgeClosedAccounts();
  const refused = db.all("SELECT detail FROM retention_log WHERE what='refused' AND envelope_id=?", e.id);
  assert.equal(refused.filter((x) => /close the account/.test(x.detail)).length, 1, 'recorded once a day, not every run');
  db.run('UPDATE users SET closing_at=NULL WHERE id=?', uid);
});

test('the people who run the server lift a hold only as two, and both are on the record', async () => {
  process.env.OPERATOR_EMAILS = 'op1@ret.test,op2@ret.test';
  try {
    const owner = await person('Ann Admin', 'ann@ret.test');
    const e = await completed(owner, 'rosa11@ret.test');
    const h = (await owner.post(`/envelopes/${e.id}/hold`, { reason: 'Internal review' })).data.hold;
    const op1 = await person('Opal One', 'op1@ret.test');
    const op2 = await person('Otto Two', 'op2@ret.test');
    assert.equal((await owner.post(`/operator/holds/${h.id}/lift`, { reason: 'x' })).status, 404, 'customers do not see the route');
    assert.ok((await op1.get('/operator/holds')).data.holds.some((x: any) => x.id === h.id));
    assert.equal((await op1.post(`/operator/holds/${h.id}/lift`, { reason: '' })).status, 400);
    let r = await op1.post(`/operator/holds/${h.id}/lift`, { reason: 'Court order 12/2026' });
    assert.equal(r.data.waiting_for_second, true);
    r = await op1.post(`/operator/holds/${h.id}/lift`, { reason: 'Court order 12/2026' });
    assert.equal(r.data.waiting_for_second, true, 'the same person twice is still one');
    assert.equal(rec.isHeld([e.id]).size, 1);
    r = await op2.post(`/operator/holds/${h.id}/lift`, { reason: 'Confirmed with counsel' });
    assert.equal(r.data.lifted, true);
    assert.equal(rec.isHeld([e.id]).size, 0);
    const lifted = db.get('SELECT * FROM legal_holds WHERE id=?', h.id);
    assert.match(lifted.lifted_by, /Opal One and Otto Two/);
    assert.ok(db.get("SELECT 1 x FROM retention_log WHERE what='override_asked' AND detail LIKE '%Court order%'"));
    assert.match(mailTo('ann@ret.test').pop().subject, /legal hold .* was lifted/);
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
});

test('each level removes exactly what it says', async () => {
  const owner = await person('Pia Purge', 'pia@ret.test');
  const day = today(), gone = removedOn(day);
  const purge = async (level: string, email: string) => {
    const e = await completed(owner, email, { attach: true });
    const before = db.get('SELECT d.file_id f, f.sha256 s FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=?', e.id);
    const attSha = db.get('SELECT sha256 s FROM files WHERE id=?', e.attachment).s;
    // The test client sends no browser name, so one is written the way a real browser's would be.
    db.run("UPDATE recipients SET user_agent='Mozilla/5.0 Firefox/140.0' WHERE envelope_id=?", e.id);
    assert.equal((await owner.post(`/envelopes/${e.id}/purge`, { level })).status, 200);
    noticePassed(e.id);
    await rec.retentionTick();
    assert.ok(purgedAt(e.id), `${level}: purged`);
    // Every level: the documents.
    assert.equal(db.get('SELECT COUNT(*) n FROM documents WHERE envelope_id=?', e.id).n, 0);
    assert.equal(db.get('SELECT 1 x FROM files WHERE id=?', before.f), null);
    assert.equal(onDisk(before.s), false, 'the uploaded pages are off the disk');
    assert.equal(onDisk(e.final), false, 'the signed PDF is off the disk');
    assert.equal(onDisk(attSha), false, 'the attachment is off the disk');
    assert.equal(db.get('SELECT 1 x FROM files WHERE id=?', e.attachment), null);
    assert.equal(db.get('SELECT purged_sha256 s FROM envelopes WHERE id=?', e.id).s, e.final, 'the fingerprint stays');
    const r = db.get('SELECT * FROM recipients WHERE envelope_id=?', e.id);
    const t = db.get("SELECT value FROM fields WHERE envelope_id=? AND type='text'", e.id).value;
    return { e, r, t, audit: db.all('SELECT * FROM audit WHERE envelope_id=? ORDER BY seq', e.id), mails: db.get('SELECT COUNT(*) n FROM emails WHERE envelope_id=?', e.id).n };
  };
  const d = await purge('documents', 'docs@ret.test');
  assert.equal(d.t, 'Flat 12B', 'documents: typed values stay');
  assert.ok(d.r.signature_png, 'and the signature picture');
  assert.equal(d.r.name, 'Rosa Lind', 'and the names');
  assert.ok(d.audit.every((a: any) => !a.redacted_at), 'and the audit trail is untouched');
  assert.ok(d.mails > 0, 'and our copies of the emails');
  const v = await purge('values', 'vals@ret.test');
  assert.equal(v.t, null, 'values: typed values go');
  assert.equal(v.r.signature_png, null, 'and the signature picture');
  assert.equal(v.r.name, 'Rosa Lind', 'names stay');
  assert.equal(v.r.email, 'vals@ret.test');
  const p = await purge('personal', 'pers@ret.test');
  assert.equal(p.t, null);
  assert.equal(p.r.name, gone, 'personal: the name is replaced');
  assert.equal(p.r.email, gone);
  assert.equal(p.r.ip, gone, 'and the internet address');
  assert.equal(p.r.user_agent, gone, 'and the browser');
  const trail = JSON.stringify(p.audit);
  assert.doesNotMatch(trail, /pers@ret\.test/);
  assert.doesNotMatch(trail, /Rosa Lind/);
  assert.doesNotMatch(trail, /pia@ret\.test/, 'the sender\'s address too');
  assert.ok(p.audit.some((a: any) => a.redacted_at), 'changed lines are marked');
  assert.equal(p.mails, 0, 'our copies of the emails go');
  const env = db.get('SELECT subject, message FROM envelopes WHERE id=?', p.e.id);
  assert.equal(env.subject, `Lease for ${gone}`, 'names in the subject go');
  assert.equal(env.message, gone);
  // The account's own lists are not touched.
  assert.ok(db.get('SELECT 1 x FROM users WHERE email=?', 'pia@ret.test'));
  // A file a template also uses stays with the template.
  const file = await upload(owner, 1);
  const tpl = (await owner.post('/envelopes', { kind: 'template', subject: 'Shared file', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Signer' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  const fromTpl = await completed(owner, 'shared@ret.test', { template: tpl.id });
  assert.equal((await owner.post(`/envelopes/${fromTpl.id}/purge`, { level: 'documents' })).status, 200);
  noticePassed(fromTpl.id);
  await rec.retentionTick();
  assert.ok(purgedAt(fromTpl.id));
  assert.ok(db.get('SELECT 1 x FROM files WHERE id=?', file.id), 'the template keeps its file');
  assert.ok(onDisk(db.get('SELECT sha256 s FROM files WHERE id=?', file.id).s));
  assert.equal((await owner.get(`/envelopes/${tpl.id}`)).data.envelope.documents.length, 1);
});

test('after a purge: /verify says completed here and deleted since, the link says the sender deleted it, the trail says redacted, not altered', async () => {
  const owner = await person('Vera Verify', 'vera@ret.test');
  const e = await completed(owner, 'rosa12@ret.test');
  const pdf = (await owner.get(`/envelopes/${e.id}/download`)).data as Uint8Array;
  assert.equal(sha(pdf), e.final);
  const code = db.get('SELECT check_code c FROM recipients WHERE envelope_id=?', e.id).c;
  assert.equal((await owner.post(`/envelopes/${e.id}/purge`, { level: 'personal' })).status, 200);
  noticePassed(e.id);
  await rec.retentionTick();
  // The file.
  const f = new FormData();
  f.append('file', new Blob([pdf], { type: 'application/pdf' }), 'signed.pdf');
  const v = (await new Client().call('POST', '/public/verify', f)).data;
  assert.equal(v.match, false);
  assert.equal(v.deleted.envelope_id, e.id);
  assert.equal(v.deleted.purged.level, 'personal');
  assert.equal(v.deleted.deleted_at, today());
  // The envelope ID.
  const look = (await new Client().get(`/public/verify/${e.id}`)).data;
  assert.equal(look.status, 'deleted');
  assert.equal(look.sha256, e.final);
  assert.equal(look.was, 'completed');
  // The signing link and the email's security code.
  const s = await new Client().get(`/sign/${e.tok}`);
  assert.equal(s.status, 410);
  assert.equal(s.data.code, 'purged');
  assert.equal(s.data.error, PURGED_LINK);
  assert.equal((await new Client().get(`/sign/${e.tok}/download`)).status, 410);
  const check = (await new Client().post('/public/check', { code })).data;
  assert.equal(check.genuine, true);
  assert.equal(check.deleted, true);
  // The sender's page: the record, with the lines that changed said as such.
  const page = (await owner.get(`/envelopes/${e.id}`)).data;
  assert.equal(page.chain.ok, true, 'not "altered"');
  assert.ok(page.chain.redacted > 0);
  assert.equal(page.chain.redacted_on, today());
  assert.match(redactedNote(page.chain.redacted_on), /Some details were removed on .*can no longer be recomputed for those lines/);
  assert.ok(page.audit.some((a: any) => a.action === 'Purged'));
  assert.equal(page.retention.purged_level, 'personal');
  assert.equal(page.retention.purged_sha256, e.final);
  // Downloads, the evidence pack and copies say what happened.
  assert.equal((await owner.get(`/envelopes/${e.id}/download`)).status, 410);
  assert.equal((await owner.get(`/envelopes/${e.id}/evidence`)).status, 410);
  assert.equal((await owner.post(`/envelopes/${e.id}/clone`, {})).status, 409);
  // The timer does not try to make its signed PDF again.
  const { finalsDue } = await import('../src/server/finalretry.ts');
  assert.ok(!finalsDue().includes(e.id));
  // A changed line that is not a redaction still shows: the chain is not a free pass.
  const seq = page.audit.find((a: any) => !a.redacted_at).seq;
  db.run("UPDATE audit SET detail=detail || ' (changed)' WHERE seq=?", seq);
  assert.equal((await owner.get(`/envelopes/${e.id}`)).data.chain.ok, false);
  // A redaction mark on an envelope that was never purged is a change like any other.
  const other = await completed(owner, 'rosa13@ret.test');
  db.run("UPDATE audit SET detail='rewritten', redacted_at=? WHERE envelope_id=? AND seq=(SELECT MIN(seq) FROM audit WHERE envelope_id=?)", now(), other.id, other.id);
  assert.equal((await owner.get(`/envelopes/${other.id}`)).data.chain.ok, false);
});
const now = () => new Date().toISOString();

test('Purge now: closed only, 14 days, called off in that time, then for good', async () => {
  const owner = await person('Pam Now', 'pam@ret.test');
  const member = await join(owner, 'Max Member', 'max@ret.test');
  const out = await simple(member, 'outnow@ret.test');
  assert.equal((await member.post(`/envelopes/${out.id}/purge`, { level: 'documents' })).status, 400, 'a draft is deleted, not purged');
  await member.post(`/envelopes/${out.id}/send`);
  assert.equal((await member.post(`/envelopes/${out.id}/purge`, { level: 'documents' })).status, 400, 'still out: not purged');
  const e = await completed(member, 'rosa14@ret.test');
  assert.equal((await member.post(`/envelopes/${e.id}/purge`, { level: 'all of it' })).status, 400);
  const before = { max: mailTo('max@ret.test').length, pam: mailTo('pam@ret.test').length };
  const r = await member.post(`/envelopes/${e.id}/purge`, { level: 'values' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(Math.abs(Date.parse(r.data.goes_at) - (Date.now() + 14 * DAY)) < 60_000);
  assert.equal(mailTo('max@ret.test').length, before.max + 1, 'the sender is emailed');
  assert.equal(mailTo('pam@ret.test').length, before.pam + 1, 'and the admin');
  assert.equal((await member.post(`/envelopes/${e.id}/purge`, { level: 'values' })).status, 409, 'once');
  // Called off within the 14 days: nothing happens.
  const off = await member.call('DELETE', `/envelopes/${e.id}/purge`);
  assert.equal(off.status, 200);
  assert.ok(db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Purge called off'", e.id));
  noticePassed(e.id);
  await rec.retentionTick();
  assert.ok(!purgedAt(e.id));
  assert.equal((await member.call('DELETE', `/envelopes/${e.id}/purge`)).status, 409, 'nothing left to call off');
  // Asked again and left: it goes, and cannot be undone.
  await owner.post(`/envelopes/${e.id}/purge`, { level: 'values' });
  await rec.retentionTick();
  assert.ok(!purgedAt(e.id), 'not before the 14 days');
  noticePassed(e.id);
  await rec.retentionTick();
  assert.ok(purgedAt(e.id));
  assert.equal((await member.call('DELETE', `/envelopes/${e.id}/purge`)).status, 409);
  assert.equal((await member.post(`/envelopes/${e.id}/keep`, { reason: 'Oops' })).status, 409);
  assert.match(db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Purged'", e.id).detail, /Pam Now asked for this purge/);
  const logged = db.get("SELECT * FROM retention_log WHERE envelope_id=? AND what='purged'", e.id);
  assert.equal(logged.level, 'values');
  assert.equal(logged.sha256, e.final);
  assert.ok(db.get("SELECT 1 x FROM security_events WHERE kind='envelope.retention_purged' AND about_id=?", e.id));
  // An open dispute keeps it from a purge, as it keeps it from deleting.
  const d = await completed(member, 'rosa15@ret.test');
  db.run("INSERT INTO disputes (id, envelope_id, recipient_id, name, via, at) VALUES ('dsp_t', ?, (SELECT id FROM recipients WHERE envelope_id=?), 'Rosa Lind', 'link', ?)", d.id, d.id, now());
  assert.equal((await member.post(`/envelopes/${d.id}/purge`, { level: 'documents' })).status, 409);
});

test('the retention record is never changed, and keeps no names after the account is deleted', async () => {
  const owner = await person('Rex Record', 'rex@ret.test');
  await owner.put('/account/retention', { days: 400 });
  const aid = db.get("SELECT a.id FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email='rex@ret.test'").id;
  const line = db.get('SELECT * FROM retention_log WHERE account_id=?', aid);
  assert.throws(() => db.run("UPDATE retention_log SET detail='nothing happened' WHERE id=?", line.id), /never changed/);
  assert.throws(() => db.run('UPDATE retention_log SET what=? WHERE id=?', 'keep', line.id), /never changed/);
  assert.throws(() => db.run('DELETE FROM retention_log WHERE id=?', line.id), /kept/);
  const trust = await import('../src/server/routes-trust.ts');
  trust.purgeUser(db.get('SELECT id FROM users WHERE email=?', 'rex@ret.test').id);
  const after = db.get('SELECT * FROM retention_log WHERE id=?', line.id);
  assert.equal(after.account_id, null);
  assert.equal(after.who, null);
  assert.equal(after.detail, null);
  assert.equal(after.what, 'policy', 'what happened stays');
  assert.throws(() => db.run('DELETE FROM retention_log WHERE id=?', line.id), /kept/, 'for a year after');
});

test('the export lists what was purged instead of calling it a PDF that could not be made', async () => {
  const owner = await person('Eve Export', 'eve@ret.test');
  const e = await completed(owner, 'rosa16@ret.test');
  await owner.post(`/envelopes/${e.id}/purge`, { level: 'documents' });
  noticePassed(e.id);
  await rec.retentionTick();
  const zip = (await owner.get('/export')).data as Uint8Array;
  const text = Buffer.from(zip).toString('latin1');
  assert.match(text, /had their documents purged/);
  assert.doesNotMatch(text, /could not be made so far/);
});

test('today\'s delete and restore are unchanged with the rule on', async () => {
  const owner = await person('Dan Delete', 'dan@ret.test');
  const member = await join(owner, 'Dot Member', 'dot@ret.test');
  await owner.put('/account/retention', { days: 3650 });
  const e = await completed(member, 'rosa17@ret.test');
  const del = await member.call('DELETE', `/envelopes/${e.id}`);
  assert.equal(del.data.kept_for_recipients, true);
  assert.equal((await member.get(`/envelopes/${e.id}`)).status, 404);
  assert.equal((await new Client().get(`/sign/${e.tok}`)).status, 200, 'the recipient keeps their link');
  assert.equal((await owner.post(`/envelopes/${e.id}/restore`)).status, 200);
  assert.equal((await member.get(`/envelopes/${e.id}`)).status, 200);
  const v = await simple(member, 'gone@ret.test');
  await member.post(`/envelopes/${v.id}/send`);
  await member.post(`/envelopes/${v.id}/void`, { reason: 'Mistake' });
  assert.equal((await member.call('DELETE', `/envelopes/${v.id}`)).status, 200);
  assert.equal(db.get('SELECT 1 x FROM envelopes WHERE id=?', v.id), null, 'gone for good, as before');
  assert.ok(retentionStays(null).some((s) => /have not said/.test(s)), 'without DATA_BACKUPS the page says the operator has not said');
});
