// What earlier reports left open, finished (research/continue.json: repair:chat, repair:stamp, repair:ds-self-host,
// repair:ds-mail-records, repair:ds-sec-log, repair:ds-retention, repair:ds-lang-core, finish:ux-revise).
// Each test names the item it closes. No network: nothing here calls outside this process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, Client, signUp, upload, simple, tokenFor, type Server } from './helpers.ts';
import { sectionsFor, landingFor } from '../src/lib/settingsnav.ts';
import { archiveKey } from '../src/lib/archivemail.ts';
import { otherActions, WITNESS_ACTIONS } from '../src/components/sign/actions.ts';
import { securityDetail } from '../src/lib/seclog.ts';
import { removedInWords } from '../src/lib/retention.ts';
import { numberOnScreen } from '../src/lib/numbers.ts';
import { SUPPORTED_LOCALES, t } from '../src/lib/i18n.ts';
import { dayText } from '../src/lib/dates.ts';
import { fmtCode } from '../src/server/util.ts';

let db: Server['db'];
let cron: Server['cron'];
before(async () => {
  ({ db, cron } = await boot());
});
after(() => {
  delete process.env.SECURITY_HEADS_DIR;
  delete process.env.SUPPORT_EMAIL;
});

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const ip = () => `10.${120 + Math.floor(++n / 250)}.${n % 250}.7`;
const person = (name: string, email: string) => signUp(name, email, ip());
const browser = () => Object.assign(new Client(), { ip: ip() });
const accountOf = async (c: Client) => (await c.get('/me')).data.account.id as string;
const keyed = (c: Client, url: string, body: any, key: string) => c.call('POST', url, body, { 'idempotency-key': key });

// ---- repair:chat ---------------------------------------------------------------------------------------------------

test('chat: Help on the signing page is one button in the top bar, with no second Help in Other actions or the footer', () => {
  const parts = read('src/components/sign/parts.tsx');
  // The button is drawn only when the page gives it something to open, and then the footer link is left out.
  assert.match(parts, /\{onHelp && <button type="button" className="btn sm sg-other sg-help" aria-haspopup="dialog" onClick=\{onHelp\}>Help<\/button>\}\s*<\/header>/);
  assert.match(parts, /\{!onHelp && <a href=\{helpHref\(data\)\}/);
  // 44 px to press, by the rule the header's Other actions already has.
  assert.match(read('src/app/styles/simplesign.css'), /\.sg-bar \.btn\.sm\.sg-other \{ min-height: 44px; \}/);
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /const headHelp = me\.role === 'witness' \? undefined : go\('help'\);/);
  assert.equal(page.match(/onHelp=\{headHelp\}/g)?.length, 2, 'the consent screen and the document');
  // Other actions has no Help button of its own any more, and its list never had one for a signer.
  const dialogs = read('src/components/sign/dialogs.tsx');
  const menu = dialogs.slice(dialogs.indexOf('export function MenuDialog'), dialogs.indexOf('export function', dialogs.indexOf('export function MenuDialog') + 10));
  assert.doesNotMatch(menu, /onHelp|>Help</);
  assert.equal(otherActions({ role: 'signer' }, { stage: 'sign', deadline: true }).includes('help' as any), false);
  // A witness keeps Help in their own short list (charter 2.6) and so gets no second one in the bar.
  assert.deepEqual([...WITNESS_ACTIONS], ['absent', 'ask', 'help']);
  // The measuring script presses it where it is.
  assert.match(read('tests/ux/flows.cjs'), /'Help in the top bar'/);
});

// ---- repair:stamp, repair:ds-mail-records, repair:ds-retention: names and sizes ---------------------------------------

test('settings: the section is called "Records and data" everywhere a person reads it', () => {
  assert.deepEqual(sectionsFor('owner').map(([, l]) => l), ['Profile', 'Security', 'Account', 'Sending', 'Team', 'Stamps', 'Plan', 'Records and data', 'API and webhooks']);
  assert.equal(sectionsFor('member').some(([, l]) => /data/i.test(l)), false);
  assert.match(landingFor('member', 'data').note || '', /^Records and data is set by the owner and the admins of this account/);
  // Old links keep working: the key in the address did not change.
  assert.equal(landingFor('owner', 'data').tab, 'data');
  // Nothing still sends a person to a section that is not on the screen.
  const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx|json|md)$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  for (const f of [...walk('src'), ...walk('docs'), 'README.md']) {
    const text = read(f);
    assert.equal(/Settings,? (then )?Your data|Open Your data|still called "Your data"/.test(text), false, `${f} still names the old section`);
  }
});

test('stamp, self-host: the editor palette and the public footer links are 44 px to press on a desktop too', () => {
  assert.match(read('src/app/styles/editor.css'), /^\.ed \.palette button \{ min-height: 44px; \}$/m);
  const pub = read('src/app/styles/public.css');
  assert.match(pub, /\.pub-foot nav a \{[^}]*min-height: 44px;/);
  assert.doesNotMatch(pub, /\.pub-foot nav a \{[^}]*min-height: 32px/);
});

// ---- repair:ds-self-host -------------------------------------------------------------------------------------------

test('self-host: "A person replies" is said only where a help request reaches somebody', async () => {
  delete process.env.SUPPORT_EMAIL;
  const was = process.env.OPERATOR_EMAILS;
  delete process.env.OPERATOR_EMAILS;
  try {
    assert.equal((await browser().get('/public/support')).data.reply, null, 'zero setup: nothing is promised');
    process.env.SUPPORT_EMAIL = 'help@op.example';
    assert.ok((await browser().get('/public/support')).data.reply.hours > 0);
  } finally {
    delete process.env.SUPPORT_EMAIL;
    if (was !== undefined) process.env.OPERATOR_EMAILS = was;
  }
  const foot = read('src/components/Public.tsx');
  const reachable = foot.slice(foot.indexOf('{support?.reply'), foot.indexOf('</div>', foot.indexOf('{support?.reply')));
  const [yes, no] = reachable.split('\n            : ');
  assert.match(yes, /A person replies/);
  assert.doesNotMatch(no, /person replies|write to us/i, 'with nobody to read it, the footer only points at the help page');
  assert.match(no, /The help page<\/Link> has answers\./);
  assert.match(read('src/app/developers/page.tsx'), /\{supportReachable\(\) && <p className="muted">Stuck on something this page does not answer\?/);
});

// ---- repair:ds-mail-records ----------------------------------------------------------------------------------------

test('mail-records: one Gmail inbox is one inbox however its address is dotted', async () => {
  assert.equal(archiveKey('Rec.Ords+case7@Gmail.com'), 'records@gmail.com');
  assert.equal(archiveKey('r.e.c.o.r.d.s@googlemail.com'), 'records@gmail.com');
  // Elsewhere a full stop is part of the name.
  assert.equal(archiveKey('rec.ords+x@office.example'), 'rec.ords@office.example');
  assert.equal(archiveKey('not an address'), 'not an address');

  const owner = await person('Gil Mailer', 'gil@dots.example');
  assert.equal((await owner.post('/account/archive-addresses', { email: 'city.records@gmail.com' })).status, 200);
  const link = db.get("SELECT link FROM emails WHERE to_email='city.records@gmail.com' AND archive_to IS NOT NULL ORDER BY id DESC LIMIT 1").link;
  const no = await browser().post('/public/archive-confirm', { token: new URL(link).searchParams.get('token'), answer: 'no' });
  assert.equal(no.status, 200, JSON.stringify(no.data));
  db.run('UPDATE archive_refused SET undo_until=NULL WHERE 1=1');
  // The same inbox under two other spellings: not asked again.
  for (const again of ['cityrecords@gmail.com', 'c.i.t.y.records+x@googlemail.com']) {
    const r = await owner.post('/account/archive-addresses', { email: again });
    assert.equal(r.status, 409, `${again}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, 'refused');
    assert.equal(db.get('SELECT COUNT(*) n FROM emails WHERE to_email=?', again).n, 0, 'nothing was sent');
  }
});

test('mail-records: a name that reads like a brand is left out of the asking email of an account the checks no longer apply to', async () => {
  const owner = await person('PayPal Billing Department', 'boss@lurename.example');
  const id = await accountOf(owner);
  // While the checks apply the email is refused, as before.
  const refused = await owner.post('/account/archive-addresses', { email: 'reader1@elsewhere.example' });
  assert.equal(refused.status, 422, JSON.stringify(refused.data));
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='reader1@elsewhere.example'").n, 0);
  // An account that is trusted is not refused, and the name still does not travel to a stranger's inbox.
  db.run('UPDATE accounts SET trusted_at=? WHERE id=?', new Date().toISOString(), id);
  const ok = await owner.post('/account/archive-addresses', { email: 'reader2@elsewhere.example' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const m = db.get("SELECT subject, html, payload FROM emails WHERE to_email='reader2@elsewhere.example'");
  const text = JSON.parse(m.payload).text as string;
  for (const part of [m.subject, m.html, text]) assert.doesNotMatch(part, /PayPal/i);
  assert.match(text, /A team that uses GrowSigning to get documents signed asked us to send reader2@elsewhere\.example/);
  assert.match(text, /The request was made by someone signed in as boss@lurename\.example\./);
  // An honest name is still given, in quotes, after our words.
  const honest = await person('Hana Records', 'hana@honest.example');
  assert.equal((await honest.post('/account/archive-addresses', { email: 'reader3@elsewhere.example' })).status, 200);
  assert.match(JSON.parse(db.get("SELECT payload FROM emails WHERE to_email='reader3@elsewhere.example'").payload).text, /signed[^\n]*, "[^"\n]+", asked us[^\n]*made by "Hana Records", signed in as hana@honest\.example/);
});

test('mail-records: copies of bulk sends, corrections, reminders and dispute emails carry no link and no code', async () => {
  const owner = await person('Cora Copies', 'cora@copies.example');
  const A = 'archive@copies-office.example';
  assert.equal((await owner.post('/account/archive-addresses', { email: A })).status, 200);
  const link = db.get('SELECT link FROM emails WHERE to_email=? AND archive_to IS NOT NULL ORDER BY id DESC LIMIT 1', A).link;
  assert.equal((await browser().post('/public/archive-confirm', { token: new URL(link).searchParams.get('token'), answer: 'yes' })).status, 200);

  // A bulk send from a template.
  const file = await upload(owner, 1);
  const tpl = (await owner.post('/envelopes', { kind: 'template', subject: 'Waiver', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  const rows = [1, 2, 3].map((i) => ({ Volunteer: { name: `Vol ${i}`, email: `vol${i}@copies.example` } }));
  const bulk = await owner.post('/bulk', { template_id: tpl.id, rows });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  assert.equal(bulk.data.sent, 3);
  // One envelope that is corrected to another address, reminded, and then disputed by the person named on it.
  const e = await simple(owner, 'first@copies.example', { send: true });
  assert.equal((await owner.post(`/envelopes/${e.id}/correct`, { recipient_id: e.recipients[0].id, name: 'Sam Second', email: 'second@copies.example' })).status, 200);
  await owner.post(`/envelopes/${e.id}/remind`, {});
  const dispute = await browser().post(`/sign/${tokenFor(e.id, 'second@copies.example')}/dispute`, { reason: 'I never agreed to this and did not sign it.' });
  assert.ok(dispute.status === 200 || dispute.status === 400, JSON.stringify(dispute.data));
  await cron.tick();

  const acct = await accountOf(owner);
  const ids = db.all("SELECT id FROM envelopes WHERE account_id=? AND kind='envelope'", acct).map((x: any) => x.id);
  assert.ok(ids.length >= 4);
  const secrets: string[] = [];
  for (const id of ids)
    for (const r of db.all('SELECT token t, check_code c FROM recipients WHERE envelope_id=? UNION ALL SELECT token, NULL FROM retired_tokens WHERE envelope_id=?', id, id)) {
      if (r.t) secrets.push(r.t);
      if (r.c) secrets.push(r.c, fmtCode(r.c));
    }
  assert.ok(secrets.length >= 8);
  const copies = db.all(`SELECT * FROM emails WHERE to_email=? AND archive_envelope IN (${ids.map(() => '?').join(',')}) ORDER BY id`, A, ...ids);
  // Every email about these documents that left has its copy: the three bulk requests among them.
  const left = db.all(`SELECT * FROM emails WHERE envelope_id IN (${ids.map(() => '?').join(',')}) AND status IN ('sent','outbox')`, ...ids);
  assert.equal(copies.length, left.length, 'one copy for each email that left');
  for (const i of [1, 2, 3]) assert.ok(copies.some((c: any) => c.html.includes(`Archive copy of an email sent to vol${i}@copies.example on `)), `the bulk request to vol${i}`);
  assert.ok(copies.some((c: any) => c.html.includes('sent to second@copies.example on ')), 'the email after the correction');
  for (const c of copies) {
    for (const part of [c.html, JSON.parse(c.payload).text, c.subject]) {
      for (const s of secrets) assert.equal(String(part).includes(s), false, `${c.subject}: a secret is in the copy`);
      assert.doesNotMatch(String(part), /\/sign\/[A-Za-z0-9_-]{8,}|check\?code=|help\?topic=signing&(amp;)?code=/, `${c.subject}: a link that opens something`);
    }
    assert.equal(c.link, null);
  }
});

// ---- repair:ds-sec-log ---------------------------------------------------------------------------------------------

test('sec-log: a change of the second line of the deletion schedule is said in words', () => {
  const both = securityDetail('retention.changed', { days: 365, was_days: 365, stopped_days: 90, was_stopped_days: 0, level: 'files', was_level: 'files', templates: 0 });
  assert.deepEqual(both, ['Cancelled, declined and expired documents are now kept for 90 days. Before: until someone deletes them.']);
  const first = securityDetail('retention.changed', { days: 400, was_days: 0, stopped_days: 0, was_stopped_days: 0 });
  assert.deepEqual(first, ['Finished documents are now kept for 400 days. Before: until someone deletes them.']);
  assert.equal(securityDetail('retention.changed', { days: 60, was_days: 30, stopped_days: 45, was_stopped_days: 30 }).length, 2);
  // A line written before the second pair existed reads as it did.
  assert.deepEqual(securityDetail('retention.changed', { days: 30, was_days: 0 }), ['Finished documents are now kept for 30 days. Before: until someone deletes them.']);
  // Nothing falls through to "Name: value".
  for (const s of [...both, ...first]) assert.doesNotMatch(s, /stopped_days|Stopped days/i);
});

test('sec-log: the download is read and sent in pages and holds every line once, newest first', async () => {
  const { CSV_PAGE } = await import('../src/server/routes-seclog.ts');
  const { record } = await import('../src/server/seclog.ts');
  const owner = await person('Sy Stream', 'sy@stream.example');
  const acct = await accountOf(owner);
  const me = (await owner.get('/me')).data.user.id;
  const many = CSV_PAGE * 2 + 37;
  for (let i = 0; i < many; i++) record('settings.changed', { accounts: acct, by: { type: 'user', id: me }, details: { settings: { [`probe_${i}`]: { changed: true } } } });
  const total = db.get('SELECT COUNT(*) n FROM security_events WHERE account_id=?', acct).n;
  assert.ok(total >= many);
  const r = await owner.get('/account/security-events/csv');
  assert.equal(r.status, 200);
  const text = Buffer.from(r.data).toString('utf8');
  assert.ok(text.startsWith('﻿"'), 'the mark a spreadsheet needs, then the heading');
  const lines = text.split('\r\n');
  assert.equal(lines.length, total + 1, 'the heading and every line, none twice and none missing at a page edge');
  assert.equal(text.endsWith('\r\n'), false);
  for (const i of [0, CSV_PAGE - 1, CSV_PAGE, CSV_PAGE * 2, many - 1]) assert.equal(text.split(`Probe ${i} `).length + text.split(`probe_${i}"`).length > 2, true, `line ${i} is there`);
  // The route no longer builds the whole file as one list.
  const src = read('src/server/routes-seclog.ts');
  const route = src.slice(src.indexOf("route('GET', '/account/security-events/csv'"), src.indexOf("route('GET', '/account/security',"));
  assert.match(route, /new ReadableStream<Uint8Array>/);
  assert.match(route, /LIMIT \$\{CSV_PAGE\}/);
});

test('sec-log: with SECURITY_HEADS_DIR the timer notes each record once a day outside the database, and the screen holds the record against it', async () => {
  const heads = await import('../src/server/secheads.ts');
  const { record } = await import('../src/server/seclog.ts');
  const owner = await person('Hedda Head', 'hedda@heads.example');
  const acct = await accountOf(owner);
  const chain = async () => (await owner.get('/account/security')).data.chain;

  // Not set: nothing is written, nothing is compared, and the answer is what it was.
  delete process.env.SECURITY_HEADS_DIR;
  assert.equal(heads.exportSecurityHeads(), null);
  assert.equal(heads.checkSecurityHeads(acct), null);
  assert.equal((await chain()).whole, true);

  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gs-heads-')), 'notes');
  process.env.SECURITY_HEADS_DIR = dir;
  try {
    assert.equal(heads.checkSecurityHeads(acct), null, 'no file yet: nothing to compare with');
    const day1 = new Date('2026-11-20T03:00:00Z');
    const wrote = heads.exportSecurityHeads(day1)!;
    assert.ok(wrote >= 1);
    const f1 = path.join(dir, 'security-heads-2026-11-20.jsonl');
    const text = fs.readFileSync(f1, 'utf8');
    assert.equal(fs.statSync(f1).mode & 0o077, 0, 'readable by the server\'s own user only');
    // Ids, numbers, fingerprints and times. No name, no address, no words of a line.
    assert.doesNotMatch(text, /hedda|Hedda|heads\.example|settings|signin/);
    const mine = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.account === acct);
    assert.deepEqual(Object.keys(mine).sort(), ['account', 'at', 'day', 'hash', 'seq']);
    const head = db.get('SELECT seq, hash FROM security_heads WHERE account_id=?', acct);
    assert.equal(mine.seq, head.seq);
    assert.equal(mine.hash, head.hash);
    // Once a day, and a file is never written over.
    record('settings.changed', { accounts: acct, by: { type: 'system' }, details: { settings: { later: { changed: true } } } });
    assert.equal(heads.exportSecurityHeads(day1), 0);
    assert.equal(fs.readFileSync(f1, 'utf8'), text);
    // The timer does it by itself.
    const tick = await cron.tick();
    assert.ok(typeof (tick as any).security_heads_noted === 'number');
    assert.equal(fs.readdirSync(dir).filter((f) => /^security-heads-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).length, 2);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no half-written file is left');

    // The record as it is matches its notes.
    assert.deepEqual(heads.checkSecurityHeads(acct), { ok: true, why: null, day: null, seq: null });
    assert.equal((await chain()).whole, true);

    // A record rewritten by someone who has the database and the secret: every line checks by itself, the note differs.
    const note = { ...mine, hash: 'f'.repeat(mine.hash.length) };
    fs.writeFileSync(f1, text.replace(JSON.stringify(mine), JSON.stringify(note)));
    assert.deepEqual(heads.checkSecurityHeads(acct), { ok: false, why: 'line', day: '2026-11-20', seq: mine.seq });
    let seen = await chain();
    assert.equal(seen.whole, false);
    assert.equal(seen.why, 'line');
    assert.equal(seen.broken_at, mine.seq);
    fs.writeFileSync(f1, text);

    // An older copy of the database put back: a note names a line newer than anything in the record.
    const f3 = path.join(dir, 'security-heads-2026-11-22.jsonl');
    fs.writeFileSync(f3, JSON.stringify({ day: '2026-11-22', account: acct, seq: 99_000_000, hash: 'a'.repeat(64), at: new Date().toISOString() }) + '\n');
    assert.deepEqual(heads.checkSecurityHeads(acct), { ok: false, why: 'missing', day: '2026-11-22', seq: 99_000_000 });
    seen = await chain();
    assert.equal(seen.whole, false);
    assert.equal(seen.why, 'missing');
    assert.equal(seen.broken_at, null);
    // The same note about a line old enough for the timer to have deleted it is no finding.
    fs.writeFileSync(f3, JSON.stringify({ day: '2026-11-22', account: acct, seq: 99_000_000, hash: 'a'.repeat(64), at: new Date(Date.now() - 4000 * 864e5).toISOString() }) + '\n');
    assert.equal(heads.checkSecurityHeads(acct)!.ok, true);
    // A line that is not a note, or is about another account, changes nothing; nothing is ever run from the file.
    fs.writeFileSync(f3, `not json at all ${acct}\n{"account":"${acct}","seq":"1; DROP TABLE users","hash":5}\n{"account":"someone-else","seq":1,"hash":"x","at":"2026-01-01"}\n`);
    assert.equal(heads.checkSecurityHeads(acct)!.ok, true);
    assert.ok(db.get('SELECT COUNT(*) n FROM users').n > 0);
    fs.rmSync(f3);

    // A member is not told anything about it, like the rest of the record.
    assert.equal((await owner.get('/account/security')).status, 200);
  } finally {
    delete process.env.SECURITY_HEADS_DIR;
  }
  // A folder that cannot be made: said in the log once, never thrown, the timer goes on.
  const blocker = path.join(os.tmpdir(), `gs-heads-file-${process.pid}`);
  fs.writeFileSync(blocker, 'a file where a folder should be');
  process.env.SECURITY_HEADS_DIR = path.join(blocker, 'inside');
  const said: string[] = [];
  const was = console.error;
  console.error = (...a: any[]) => void said.push(a.join(' '));
  try {
    assert.equal(heads.exportSecurityHeads(), null);
    assert.equal(heads.exportSecurityHeads(), null);
    assert.equal(heads.checkSecurityHeads(acct), null);
    assert.equal((await chain()).whole, true, 'the record itself is not affected');
  } finally {
    console.error = was;
    delete process.env.SECURITY_HEADS_DIR;
    fs.rmSync(blocker, { force: true });
  }
  assert.equal(said.length, 1, 'said once, not at every run of the timer');
  assert.match(said[0], /could not be written to SECURITY_HEADS_DIR/);
  // Told where it belongs: the settings table, the example file and the runbook. No screen mentions it.
  assert.match(read('README.md'), /\| `SECURITY_HEADS_DIR` \|/);
  assert.match(read('.env.example'), /^# SECURITY_HEADS_DIR=/m);
  assert.match(read('docs/runbooks.md'), /SECURITY_HEADS_DIR/);
  assert.doesNotMatch(read('src/locales/en.json') + read('src/components/settings/SecurityLog.tsx'), /SECURITY_HEADS_DIR|daily note/);
});

// ---- repair:ds-retention -------------------------------------------------------------------------------------------

test('retention: a draft on hold is frozen through every door that changes it, and a bulk clean-up leaves it', async () => {
  const owner = await person('Hal Holder', 'hal@frozen.example');
  const def = await owner.post('/custom-fields', { name: 'Case number' });
  assert.equal(def.status, 200, JSON.stringify(def.data));
  const dr = await simple(owner, 'draft@frozen.example');
  assert.equal((await owner.put(`/envelopes/${dr.id}/custom-fields`, { custom_fields: [{ name: 'Case number', value: 'A-1' }] })).status, 200);
  assert.equal((await owner.post(`/envelopes/${dr.id}/hold`, { reason: 'Keep the draft as it is' })).status, 200);
  const before = JSON.stringify((await owner.get(`/envelopes/${dr.id}`)).data.envelope);

  const cf = await owner.put(`/envelopes/${dr.id}/custom-fields`, { custom_fields: [] });
  assert.equal(cf.status, 409, JSON.stringify(cf.data));
  assert.equal(cf.data.code, 'legal_hold');
  assert.match(cf.data.error, /^This draft is on hold, so the software refuses to change it\. Ask an admin of the account to lift the hold under Settings, Records and data/);
  const pay = await owner.put(`/envelopes/${dr.id}/pay-link`, { url: 'https://pay.example.org/invoice/7' });
  assert.equal(pay.status, 409, JSON.stringify(pay.data));
  assert.equal(pay.data.code, 'legal_hold');
  assert.equal(JSON.stringify((await owner.get(`/envelopes/${dr.id}`)).data.envelope), before, 'nothing changed');
  // Each refused try is on the deletion record.
  assert.ok(db.get("SELECT COUNT(*) n FROM retention_log WHERE envelope_id=? AND what='refused'", dr.id).n >= 2);
  // A draft that is not on hold takes both as before.
  const free = await simple(owner, 'free@frozen.example');
  assert.equal((await owner.put(`/envelopes/${free.id}/custom-fields`, { custom_fields: [{ name: 'Case number', value: 'B-2' }] })).status, 200);

  // The bulk send's clean-up of left-over drafts (sendBatch): a held one stays, another goes.
  const file = await upload(owner, 1);
  const tpl = (await owner.post('/envelopes', { kind: 'template', subject: 'Waiver', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  const body = { template_id: tpl.id, rows: [{ Volunteer: { name: 'Row One', email: 'row1@frozen.example' } }] };
  const first = await keyed(owner, '/bulk', body, 'frozen-1');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  db.run('UPDATE envelopes SET bulk_id=? WHERE id IN (?,?)', first.data.id, dr.id, free.id);
  const again = await keyed(owner, '/bulk', body, 'frozen-1');
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.ok(db.get('SELECT 1 x FROM envelopes WHERE id=?', dr.id), 'the held draft is still there');
  assert.equal(db.get('SELECT 1 x FROM envelopes WHERE id=?', free.id), undefined, 'the left-over draft that nobody holds is gone');
});

test('retention: a day inside a history line is written out, and the stored line is left alone', () => {
  const stored = 'Signing request sent to Removed on 2026-11-21 <Removed on 2026-11-21>';
  assert.equal(removedInWords(stored, dayText), `Signing request sent to Removed on ${dayText('2026-11-21')} <Removed on ${dayText('2026-11-21')}>`);
  assert.doesNotMatch(removedInWords(stored, dayText), /\d{4}-\d{2}-\d{2}/);
  assert.equal(removedInWords('Opened the document.', dayText), 'Opened the document.');
  assert.equal(removedInWords(null, dayText), '');
  // Something that only looks like it is not touched, and a day nobody can read stays as it was stored.
  assert.equal(removedInWords('Removed on Tuesday', dayText), 'Removed on Tuesday');
  assert.equal(removedInWords('Removed on 2026-11-21', () => ''), 'Removed on 2026-11-21');
  const hist = read('src/components/sender/History.tsx');
  for (const part of ['l.title', 'l.detail', 'l.who']) assert.ok(hist.includes(`removedInWords(${part}, dayText)`), part);
});

// ---- repair:ds-lang-core -------------------------------------------------------------------------------------------

async function withFrench<T>(fn: () => Promise<T>): Promise<T> {
  const fr = SUPPORTED_LOCALES.find((l) => l.tag === 'fr')!;
  const was = { ...fr };
  Object.assign(fr, { shipped: true, ui: 'draft' });
  try {
    return await fn();
  } finally {
    Object.assign(fr, was);
  }
}

test('lang-core: a place that goes to another person at the same address through PUT starts without the first person\'s language', async () => {
  await withFrench(async () => {
    const owner = await person('Lea Langue', 'lea@lang2.example');
    const localeOf = (id: string) => db.all('SELECT locale FROM recipients WHERE envelope_id=? ORDER BY position', id).map((x: any) => x.locale);
    const doc = async (email: string) => {
      const e = await simple(owner, email, { send: true, recipients: [{ id: 'r', role: 'signer', name: 'Pierre Dupont', email, locale: 'fr' }] });
      assert.deepEqual(localeOf(e.id), ['fr']);
      return (await owner.get(`/envelopes/${e.id}`)).data.envelope;
    };
    const put = (e: any, name: string, more: any = {}) => owner.put(`/envelopes/${e.id}`, {
      subject: e.subject, documents: e.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })),
      recipients: [{ id: e.recipients[0].id, role: 'signer', name, email: e.recipients[0].email, ...more }],
      fields: e.fields.map((f: any) => ({ id: f.id, document_id: f.document_id, recipient_id: f.recipient_id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h })),
    });
    // Another person at the shared address, nothing said about the language: their browser decides.
    let e = await doc('famille@lang2.example');
    let r = await put(e, 'Marie Curie');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(localeOf(e.id), [null]);
    // The same person in another spelling keeps it.
    e = await doc('pierre@lang2.example');
    r = await put(e, 'pierre  dupont');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(localeOf(e.id), ['fr']);
    // Another person, and the sender says the language: what was said is kept.
    e = await doc('bureau@lang2.example');
    r = await put(e, 'Marie Curie', { locale: 'fr' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(localeOf(e.id), ['fr']);
  });
});

test('lang-core: amounts and counts keep the digits 0 to 9 in every language, like dates', () => {
  assert.equal(numberOnScreen(1234.5, 'en'), '1,234.5');
  assert.equal(numberOnScreen(1234.5, 'fr'), '1 234,5');
  for (const tag of ['ar-SA', 'fa', 'hi-IN-u-nu-deva', 'bn', 'my']) assert.match(numberOnScreen(1234.5, tag), /^[0-9\s.,٬٫'’]+$/u, tag);
  assert.doesNotMatch(numberOnScreen(2026, 'ar-EG'), /[٠-٩۰-۹]/);
  // The same for a number put into a sentence.
  assert.match(t('ar', 'security.detail.days_n', { count: 400 }), /400/);
});

test('lang-core: every text key that is built while the app runs exists, so no label can come out empty', () => {
  const en = JSON.parse(read('src/locales/en.json'));
  const need = (file: string, prefix: string, call: RegExp) => {
    const keys = [...read(file).matchAll(call)].map((m) => m[1]);
    assert.ok(keys.length > 3, `${file}: found the calls`);
    for (const k of new Set(keys)) assert.ok(typeof en[`${prefix}${k}`] === 'string' && en[`${prefix}${k}`], `${prefix}${k} (${file})`);
  };
  need('src/lib/seclog.ts', 'security.detail.', /\bw\((?:[^()'?]*\? )?'([a-z_0-9]+)'/g);
  need('src/server/seclog.ts', 'security.who.', /\bw\('([a-z_0-9]+)'/g);
  // Both branches of a choice between two keys.
  for (const m of read('src/lib/seclog.ts').matchAll(/\bw\([^()]*\? '([a-z_0-9]+)' : (?:[^()']*\? )?'([a-z_0-9]+)'(?: : '([a-z_0-9]+)')?/g))
    for (const k of m.slice(1).filter(Boolean)) assert.ok(en[`security.detail.${k}`], `security.detail.${k}`);
  for (const why of ['idle', 'elsewhere']) assert.ok(en[`rules.out.${why}`], `rules.out.${why}`);
});
