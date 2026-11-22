// What earlier reports left open, finished (research/continue.json: repair:chat, repair:stamp, repair:ds-self-host,
// repair:ds-mail-records, repair:ds-sec-log, repair:ds-retention, repair:ds-lang-core, finish:ux-revise).
// Each test names the item it closes. No network: nothing here calls outside this process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, Client, signUp, upload, simple, signAll, tokenFor, type Server } from './helpers.ts';
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
  assert.match(parts, /\{onHelp && <button type="button" className="btn sm sg-other sg-help" aria-haspopup="dialog" onClick=\{onHelp\}>\{T\('sign\.shell\.help'\)\}<\/button>\}\s*<\/header>/);
  assert.match(parts, /\{!onHelp && <a href=\{helpHref\(data\)\}/);
  // 44 px to press, by the rule the header's Other actions already has.
  assert.match(read('src/app/styles/simplesign.css'), /\.sg-bar \.btn\.sm\.sg-other \{ min-height: 44px; \}/);
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /const headHelp = me\.role === 'witness' \? undefined : go\('help'\);/);
  assert.equal(page.match(/onHelp=\{headHelp\}/g)?.length, 3, 'the consent screen, the document, and the screen of someone who changes it or chooses who comes next');
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

// ---- repair:stamp --------------------------------------------------------------------------------------------------

/** A clean design on white: rings `width` pixels wide, every `gap` pixels from the middle out. */
function ringDesign(side: number, width: number, gap: number) {
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  const c = side / 2;
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const r = Math.hypot(x - c, y - c);
      if (r > c - 4) continue;
      if ((r % gap) < width) {
        const i = (y * side + x) * 4;
        data[i] = 30, data[i + 1] = 40, data[i + 2] = 140;
      }
    }
  return { width: side, height: side, data };
}

test('stamp: a design of hairlines and small type is said to break up at its size, with the one move that keeps it whole', async () => {
  const ink = await import('../src/lib/stampink.ts');
  const fine = (pic: any, mm: number, texture?: number) => {
    const p = ink.prepare(pic);
    const look = { ...ink.lookFor(7, p.found.ink, p), ...(texture == null ? {} : { texture }) };
    return ink.impression(p, look, undefined, mm).fine!;
  };
  // Hairline rings, 2 of 600 pixels: 0.13 mm at 40 mm across, 0.4 mm at 120 mm.
  const thin = ringDesign(600, 2, 14);
  assert.ok(fine(thin, 40) >= ink.FINE_WARN_SHARE, `thin at 40 mm: ${fine(thin, 40)}`);
  assert.ok(fine(thin, 120) < ink.FINE_WARN_SHARE, 'the same design printed large is not thin');
  // A bold seal is never said to be thin, at the smallest size a stamp field takes too.
  const bold = ringDesign(600, 30, 70);
  assert.ok(fine(bold, 40) < 0.05, `bold at 40 mm: ${fine(bold, 40)}`);
  // The measure is taken before the texture, so moving the texture does not change it; the maker hides the line once
  // the texture is low enough to keep thin lines whole.
  assert.equal(fine(thin, 40, 0), fine(thin, 40, 1));
  assert.equal(ink.fineShare({ width: 2, height: 2, v: new Float32Array(4) }, 10), 0, 'nothing to measure');
  assert.equal(ink.fineShare({ width: 10, height: 10, v: new Float32Array(100) }, 10), 0, 'no ink');
  const maker = read('src/components/stamps/StampMaker.tsx');
  assert.match(maker, /result\.fine >= FINE_WARN_SHARE && look\.texture > FINE_WARN_TEXTURE/);
  assert.match(maker, /move &ldquo;Rubber texture&rdquo; towards &ldquo;Even ink&rdquo;/);
  // It is a line of advice, not a stop: nothing has to be pressed to finish, and Finish is not held back by it.
  assert.doesNotMatch(maker.slice(maker.indexOf('st-fine'), maker.indexOf('</p>', maker.indexOf('st-fine'))), /role="alert"|disabled/);
});

test('stamp: the section of Settings that keeps them is "Stamps and seals", as the designer named it', () => {
  assert.equal(sectionsFor('owner').find(([k]) => k === 'stamps')?.[1], 'Stamps and seals');
  assert.equal(landingFor('owner', 'stamps').tab, 'stamps', 'old links still land');
  // Every sentence that sends a person there names it as it is on the screen.
  const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx|md)$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  for (const f of [...walk('src'), 'README.md']) assert.doesNotMatch(read(f), /Settings, Stamps(?! and seals)|Settings > Stamps(?! and seals)/, f);
  // The card is headed as the tab is, and says at once that a seal here is a picture, not a certified seal
  // (the simplicity reviewer: a tab that promises seals over a card that only denies them reads as a contradiction).
  assert.match(read('src/components/stamps/StampSettings.tsx'), /<h2 id="st-h">Stamps and seals<\/h2>/);
  assert.match(read('src/lib/stamps.ts'), /STAMP_IS_TEAM = 'A stamp or seal here is a picture of a stamp that someone on your team puts on a document\. GrowSigning does not check that they may use it, and it is not a certified electronic seal\.'/);
});

// ---- repair:ds-mail-records, repair:ds-retention: names and sizes ----------------------------------------------------

test('settings: the section is called "Records and data" everywhere a person reads it', () => {
  assert.deepEqual(sectionsFor('owner').map(([, l]) => l), ['Profile', 'Security', 'Account', 'Sending', 'Team', 'Stamps and seals', 'Plan', 'Records and data', 'API and webhooks']);
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

test('self-host: the compose example carries a converter that has no way out of its own network', () => {
  const compose = read('docker-compose.example.yml');
  // The converter: on the internal network only, and only when asked for.
  const svc = compose.slice(compose.indexOf('\n  gotenberg:'), compose.indexOf('\nnetworks:'));
  assert.match(svc, /image: gotenberg\/gotenberg:8/);
  assert.match(svc, /profiles: \["office"\]/);
  assert.match(svc, /networks:\n\s+- convert\n/);
  assert.doesNotMatch(svc, /- default|ports:/, 'nothing but the internal network, and no port to the outside');
  assert.match(compose, /\nnetworks:\n  convert:\n    internal: true\n/);
  // The app reaches both: its way out, and the converter.
  const app = compose.slice(compose.indexOf('\n  growsigning:'), compose.indexOf('\n  backup:'));
  assert.match(app, /networks:\n\s+- default\n\s+- convert\n/);
  // The backup still has no network at all.
  assert.match(compose.slice(compose.indexOf('\n  backup:')), /network_mode: none/);
  // Said where an operator reads it, and that it was only checked, not run.
  const readme = read('README.md');
  assert.match(readme, /docker compose --profile office up -d/);
  assert.match(readme, /CONVERTER_URL=http:\/\/gotenberg:3000/);
  assert.match(readme, /checked with `docker compose config`; we have not run the office\s+profile in Docker ourselves/);
  assert.match(read('docs/controls.md'), /`gotenberg` service of `docker-compose\.example\.yml`/);
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
  // The minutes in which "no" can be taken back are over.
  db.run('UPDATE archive_refused SET token_hash=NULL WHERE email=?', 'city.records@gmail.com');
  // The same inbox under two other spellings: not asked again.
  for (const again of ['cityrecords@gmail.com', 'c.i.t.y.records+x@googlemail.com']) {
    const r = await owner.post('/account/archive-addresses', { email: again });
    assert.equal(r.status, 409, `${again}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, 'refused');
    assert.equal(db.get('SELECT COUNT(*) n FROM emails WHERE to_email=?', again).n, 0, 'nothing was sent');
  }
});

test('mail-records: once three inboxes marked the asking email as spam, the account asks nobody new for 30 days, and its copies go on', async () => {
  const TOKEN = 'open-platform-mail-events-3c1f';
  const was = process.env.MAIL_EVENTS_TOKEN;
  process.env.MAIL_EVENTS_TOKEN = TOKEN;
  try {
    const owner = await person('Una Unwanted', 'una@spammy.example');
    const acct = await accountOf(owner);
    // One confirmed address, before any of it: it keeps its copies throughout.
    const kept = 'records@spammy-office.example';
    assert.equal((await owner.post('/account/archive-addresses', { email: kept })).status, 200);
    const link = db.get('SELECT link FROM emails WHERE to_email=? ORDER BY id DESC LIMIT 1', kept).link;
    assert.equal((await browser().post('/public/archive-confirm', { token: new URL(link).searchParams.get('token'), answer: 'yes' })).status, 200);
    const mark = async (email: string) => {
      assert.equal((await owner.post('/account/archive-addresses', { email })).status, 200);
      const m = db.get('SELECT id FROM emails WHERE to_email=? ORDER BY id DESC LIMIT 1', email);
      assert.equal((await new Client().post(`/mail/events?token=${TOKEN}`, { type: 'complaint', email, mail_id: String(m.id) })).status, 200);
    };
    // Two marks: still asking.
    await mark('stranger1@elsewhere-a.example');
    await mark('stranger2@elsewhere-b.example');
    // The same inbox under another spelling is not asked again, so it cannot be counted twice either.
    assert.equal((await owner.post('/account/archive-addresses', { email: 'stranger2+x@elsewhere-b.example' })).status, 409);
    assert.equal((await owner.post('/account/archive-addresses', { email: 'stranger3@elsewhere-c.example' })).status, 200);
    // The third mark stops the asking.
    const m3 = db.get("SELECT id FROM emails WHERE to_email='stranger3@elsewhere-c.example' ORDER BY id DESC LIMIT 1");
    assert.equal((await new Client().post(`/mail/events?token=${TOKEN}`, { type: 'complaint', email: 'stranger3@elsewhere-c.example', mail_id: String(m3.id) })).status, 200);
    const stopped = await owner.post('/account/archive-addresses', { email: 'fourth@elsewhere-d.example' });
    assert.equal(stopped.status, 429, JSON.stringify(stopped.data));
    assert.equal(stopped.data.code, 'asks_stopped');
    assert.match(stopped.data.error, /^3 people marked the email that asks an address to confirm as spam in the last 30 days, so this account cannot ask any address until \d{1,2} \w+ \d{4} at \d\d:\d\d UTC\. Addresses already confirmed keep getting their copies\./);
    assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='fourth@elsewhere-d.example'").n, 0, 'nothing was sent');
    assert.equal(db.get("SELECT COUNT(*) n FROM archive_addresses WHERE email='fourth@elsewhere-d.example'").n, 0, 'and nothing was kept');
    // Sending goes on, and so do the copies to the confirmed address.
    assert.equal(db.get('SELECT suspended_at s FROM accounts WHERE id=?', acct).s, null, 'the marks do not pause the account');
    await simple(owner, 'client@spammy-client.example', { send: true });
    assert.ok(db.get('SELECT COUNT(*) n FROM emails WHERE to_email=? AND archive_envelope IS NOT NULL', kept).n >= 1);
    // Another account is not touched by it.
    const other = await person('Ola Other', 'ola@notspammy.example');
    assert.equal((await other.post('/account/archive-addresses', { email: 'fifth@elsewhere-e.example' })).status, 200);
    // Thirty days after the oldest mark the account may ask again.
    db.run("UPDATE archive_refused SET at=? WHERE account_id=? AND email='stranger1@elsewhere-a.example'", new Date(Date.now() - 31 * 864e5).toISOString(), acct);
    assert.equal((await owner.post('/account/archive-addresses', { email: 'fourth@elsewhere-d.example' })).status, 200);
  } finally {
    if (was === undefined) delete process.env.MAIL_EVENTS_TOKEN;
    else process.env.MAIL_EVENTS_TOKEN = was;
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
  assert.equal((await owner.post(`/envelopes/${e.id}/remind`, {})).status, 200);
  // Signed (so the finished copy with its PDF goes out too), then disputed from the same link.
  assert.equal((await signAll(e.id, 'second@copies.example')).status, 200);
  const dispute = await browser().post(`/sign/${tokenFor(e.id, 'second@copies.example')}/dispute`, { detail: 'I never agreed to this and did not sign it.' });
  assert.equal(dispute.status, 200, JSON.stringify(dispute.data));
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
  assert.ok(copies.filter((c: any) => c.html.includes('sent to second@copies.example on ')).length >= 2, 'the request and its reminder');
  assert.ok(copies.some((c: any) => c.subject.includes('Disputed: Simple agreement')), 'the email that tells the sender of the dispute');
  assert.ok(copies.some((c: any) => c.subject.includes('Completed: Simple agreement')), 'the email with the finished document');
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

test('sec-log: a webhook added for the security record is said to be that where API and webhooks lists it', async () => {
  const { securityOnlyHook } = await import('../src/lib/seclog.ts');
  assert.equal(securityOnlyHook('security.event'), true);
  assert.equal(securityOnlyHook(' security.event '), true);
  for (const e of ['*', '', null, 'envelope.completed', 'security.event,envelope.completed']) assert.equal(securityOnlyHook(e), false, String(e));
  // The two cards: Security adds one with only that event, API and webhooks lists every webhook with the line.
  const owner = await person('Wes Webhook', 'wes@hooks.example');
  const was = process.env.ALLOW_PRIVATE_WEBHOOKS;
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    const made = await owner.post('/webhooks', { url: 'http://127.0.0.1:9/siem', events: ['security.event'] });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const doc = await owner.post('/webhooks', { url: 'http://127.0.0.1:9/crm' });
    assert.equal(doc.status, 200, JSON.stringify(doc.data));
  } finally {
    if (was === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    else process.env.ALLOW_PRIVATE_WEBHOOKS = was;
  }
  const hooks = (await owner.get('/webhooks')).data.webhooks;
  assert.deepEqual(hooks.map((h: any) => securityOnlyHook(h.events)).sort(), [false, true]);
  assert.equal((await owner.get('/account/security')).data.webhooks.length, 1, 'the Security card lists only its own');
  const page = read('src/app/app/settings/page.tsx');
  assert.match(page, /\{securityOnlyHook\(h\.events\) && <div className="muted small">Sends the security record only, nothing about documents\. It is also listed under <Link href="\/app\/settings\?tab=security">Security<\/Link>\.<\/div>\}/);
  assert.match(read('src/components/settings/SecurityLog.tsx'), /api\('\/webhooks', \{ body: \{ url: hook, events: \['security\.event'\] \} \}\)/);
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
  assert.equal(db.get('SELECT 1 x FROM envelopes WHERE id=?', free.id) ?? null, null, 'the left-over draft that nobody holds is gone');
});

test('retention: with a schedule on, the Delete dialog offers "Keep it instead" in its own row of buttons, not inside a sentence', async () => {
  const { keepInstead } = await import('../src/components/sender/Retention.tsx').catch(() => ({ keepInstead: null as any }));
  const src = read('src/components/sender/Retention.tsx');
  const notes = src.slice(src.indexOf('export function DeleteNotes'), src.indexOf('const Lists'));
  assert.doesNotMatch(notes, /Keep it instead|Rather keep it/, 'no button in the middle of the words');
  assert.match(notes, /Delete its files for good<\/button> \(\{RETENTION_NOTICE_DAYS\}-day wait\)/);
  const dialogs = read('src/components/sender/dialogs.tsx');
  assert.match(dialogs, /\{other && <button type="button" className="btn" onClick=\{other\.onClick\}>\{other\.label\}<\/button>\}/);
  // Cancel first, the third way out, then the one filled button.
  const row = dialogs.slice(dialogs.indexOf('export function ConfirmDialog'));
  assert.ok(row.indexOf('{keepLabel}') < row.indexOf('{other.label}') && row.indexOf('{other.label}') < row.indexOf('confirmLabel}</button>'));
  // 44 px to press in that row with a mouse too, as it was inside the text.
  assert.match(read('src/app/styles/envelope.css'), /^\.sn-dialog \.actions \.btn \{ min-height: 44px; \}$/m);
  const page = read('src/app/app/envelopes/[id]/page.tsx');
  assert.match(page, /other=\{!isTpl && keepInstead\(ret\) \? \{ label: keepInsteadLabel\(ret!\), onClick: \(\) => \(setDialog\(''\), setKeeping\('keep'\)\) \} : null\}/);
  // When it is offered: a schedule with a day, a closed document that is not held, and keeping moves that day at
  // least a day later, or someone asked for its files to go (repair-open-platform). Never on a purged or held one.
  assert.match(src, /export function keepInstead\(r: R \| null \| undefined, now = Date\.now\(\)\): boolean \{\s*if \(!r \|\| r\.purged_at \|\| !scheduleOn\(r\)\) return false;\s*if \(!\(r\.goes_at \|\| r\.due_at\) \|\| !deleteOffers\(r\)\.keep\) return false;[\s\S]*?return !!r\.asked \|\| !!keepMovesTo\(r, now\);/);
  assert.match(src, /return until \? `Keep it until \$\{longDate\(until\)\}` : 'Keep its files';/);
});

test('retention: "Keep it" in the Delete dialog is offered only when it keeps the document longer, and says until when', async () => {
  const { keepMovesTo } = await import('../src/lib/retention.ts');
  const now = Date.parse('2026-11-21T12:00:00Z');
  const day = 864e5;
  // Completed today, one year schedule: the schedule already keeps it a year, so keeping changes nothing.
  assert.equal(keepMovesTo({ period: { days: 365 }, due_at: new Date(now + 365 * day).toISOString(), goes_at: null }, now), null);
  // Completed half a year ago: keeping gives it a year from today, half a year more.
  assert.equal(keepMovesTo({ period: { days: 365 }, due_at: new Date(now + 182 * day).toISOString(), goes_at: null }, now), new Date(now + 365 * day).toISOString());
  // In its 14-day notice: keeping moves it well past that.
  assert.ok(keepMovesTo({ period: { days: 30 }, due_at: new Date(now - day).toISOString(), goes_at: new Date(now + 13 * day).toISOString() }, now));
  // Less than a day more is not worth a button.
  assert.equal(keepMovesTo({ period: { days: 30 }, due_at: new Date(now + 30 * day - 3600e3).toISOString(), goes_at: null }, now), null);
  // No period (only a request to delete it): nothing to count.
  assert.equal(keepMovesTo({ period: null, due_at: null, goes_at: new Date(now + 14 * day).toISOString() }, now), null);
  assert.equal(keepMovesTo({ period: { days: 30 }, due_at: null, goes_at: null }, now), null);
  // The server keeps exactly the period from today, which is the day the button names.
  assert.match(read('src/server/records.ts'), /const until = period \? new Date\(Date\.now\(\) \+ period\.days \* DAY\)\.toISOString\(\) : null;/);
});

async function pdfText(pdf: Uint8Array): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) out.push(...(await (await doc.getPage(i)).getTextContent()).items.map((x: any) => x.str));
    return out.join(' ');
  } finally {
    await doc.destroy().catch(() => {});
  }
}

test('retention: the deletion record comes as a PDF to print as well, and an admin export carries it so closing the account does not lose it', async () => {
  const rec = await import('../src/server/records.ts');
  const owner = await person('Rhea Records', 'rhea@destroy.example');
  const acct = await accountOf(owner);
  const member = await person('Max Member', 'max@destroy-member.example');
  // Nothing on the record yet: the PDF says so instead of failing.
  const empty = await owner.get('/account/retention/log?format=pdf');
  assert.equal(empty.status, 200);
  assert.match(await pdfText(empty.data), /No files have been deleted under this account\./);
  // A completed document whose files are deleted, a hold, and a schedule change.
  const e = await simple(owner, 'party@destroy.example', { send: true });
  assert.equal((await signAll(e.id, 'party@destroy.example')).status, 200);
  const sha = db.get('SELECT final_sha256 s FROM envelopes WHERE id=?', e.id).s;
  assert.ok(sha);
  assert.equal(rec.purgeEnvelope(e.id, 'documents', { name: 'Rhea Records', why: 'Asked for by the client, letter of 3 March.' }), true);
  const held = await simple(owner, 'held@destroy.example');
  assert.equal((await owner.post(`/envelopes/${held.id}/hold`, { reason: 'Court case 2026/77' })).status, 200);
  const { handle } = await import('../src/server/router.ts');
  const raw = (c: Client, url: string) => handle(new Request(`http://test.local/api${url}`, { headers: { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': c.ip } }));
  const r = await raw(owner, '/account/retention/log?format=pdf');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition') || '', /^attachment; filename="deletion-record-\d{4}-\d{2}-\d{2}\.pdf"$/);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  const text = (await pdfText(new Uint8Array(await r.arrayBuffer()))).replace(/\s+/g, ' ');
  for (const w of ['Deletion record', 'Rhea Records', acct, `Document ${e.id}`, sha, 'Delete the files', 'Asked for by the client, letter of 3 March.', 'Put on hold', 'Court case 2026/77', 'nobody outside it has checked it', 'does not reach copies that people saved'])
    assert.ok(text.includes(w), `the PDF says: ${w}`);
  // Day month year, as every date of the product.
  assert.match(text, /\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d UTC/);
  assert.doesNotMatch(text, /certificate|destruction|purge|disposition/i, 'the words of the screens, not of records law');
  // Another account reads its own record, which holds nothing of this one.
  const other = await raw(member, '/account/retention/log?format=pdf');
  assert.equal(other.status, 200);
  const otherText = await pdfText(new Uint8Array(await other.arrayBuffer()));
  assert.doesNotMatch(otherText, new RegExp(`${e.id}|Rhea|${sha}`));
  // The export of an admin carries the record as a file of its own, with every line.
  const zip = await owner.get('/export');
  assert.equal(zip.status, 200);
  const bytes = Buffer.from(zip.data);
  assert.ok(bytes.includes(Buffer.from('deletion-record.csv')), 'the file is in the export');
  assert.ok(bytes.includes(Buffer.from('Once the account is closed, the copy we keep loses its names and words.')), 'and README.txt says why');
  // The screen offers both formats the same way, each saying what it gives (repair-open-platform: one button and one
  // link left the person guessing that the button gives a spreadsheet).
  const card = read('src/components/settings/RetentionSettings.tsx');
  assert.match(card, /<span>Download the deletion record:<\/span>\s*<a className="btn" href="\/api\/account\/retention\/log\?format=csv">As a spreadsheet<\/a>\s*<a className="btn" href="\/api\/account\/retention\/log\?format=pdf">As a PDF to print<\/a>/);
  assert.equal((card.match(/>Download/g) || []).length, 1, 'one Download on the card');
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

// ---- repair-open-platform: what the skeptic and the simplicity reviewer found -------------------------------------

test('mail-records: a spam mark on the asking email counts even when the address was removed before the mark arrived', async () => {
  const TOKEN = 'open-platform-mail-events-9d2e';
  const was = process.env.MAIL_EVENTS_TOKEN;
  process.env.MAIL_EVENTS_TOKEN = TOKEN;
  try {
    const owner = await person('Del Dodger', 'del@dodge-op.example');
    const acct = await accountOf(owner);
    for (const to of ['s1@victim-op-a.example', 's2@victim-op-b.example', 's3@victim-op-c.example']) {
      const r = await owner.post('/account/archive-addresses', { email: to });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const mail = db.get('SELECT id FROM emails WHERE to_email=? ORDER BY id DESC LIMIT 1', to).id;
      // Removed at once, before the stranger's mark comes in.
      assert.equal((await owner.call('DELETE', `/account/archive-addresses/${r.data.address.id}`)).status, 200);
      assert.equal((await new Client().post(`/mail/events?token=${TOKEN}`, { type: 'complaint', email: to, mail_id: String(mail) })).status, 200);
      assert.equal(db.get("SELECT why FROM archive_refused WHERE account_id=? AND email=?", acct, to)?.why, 'spam', 'the mark is kept for the account');
    }
    const r = await owner.post('/account/archive-addresses', { email: 's4@victim-op-d.example' });
    assert.equal(r.status, 429, JSON.stringify(r.data));
    assert.equal(r.data.code, 'asks_stopped');
    assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='s4@victim-op-d.example'").n, 0, 'nothing was sent');
    // A repeat of the same news changes nothing, and a removed address does not come back.
    assert.equal(db.get('SELECT COUNT(*) n FROM archive_addresses WHERE account_id=?', acct).n, 0);
  } finally {
    if (was === undefined) delete process.env.MAIL_EVENTS_TOKEN;
    else process.env.MAIL_EVENTS_TOKEN = was;
  }
});

test('mail-records: with more than three marks the refusal names the day asking really works again', async () => {
  const TOKEN = 'open-platform-mail-events-4b7a';
  const was = process.env.MAIL_EVENTS_TOKEN;
  process.env.MAIL_EVENTS_TOKEN = TOKEN;
  try {
    const owner = await person('Four Marks', 'four@marks-op.example');
    const acct = await accountOf(owner);
    const tos = ['m1@x-op-a.example', 'm2@x-op-b.example', 'm3@x-op-c.example'];
    for (const to of tos) {
      assert.equal((await owner.post('/account/archive-addresses', { email: to })).status, 200);
      const mail = db.get('SELECT id FROM emails WHERE to_email=? ORDER BY id DESC LIMIT 1', to).id;
      assert.equal((await new Client().post(`/mail/events?token=${TOKEN}`, { type: 'complaint', email: to, mail_id: String(mail) })).status, 200);
    }
    // A fourth mark, and the marks spread out: 25, 20, 10 and 1 days old.
    db.run("INSERT INTO archive_refused (account_id, email, email_key, why, at, until) VALUES (?, 'm4@x-op-d.example', 'm4@x-op-d.example', 'spam', ?, ?)", acct, new Date().toISOString(), new Date(Date.now() + 30 * 864e5).toISOString());
    const ages: Record<string, number> = { 'm1@x-op-a.example': 25, 'm2@x-op-b.example': 20, 'm3@x-op-c.example': 10, 'm4@x-op-d.example': 1 };
    for (const [e, d] of Object.entries(ages)) db.run('UPDATE archive_refused SET at=? WHERE account_id=? AND email=?', new Date(Date.now() - d * 864e5).toISOString(), acct, e);
    const r = await owner.post('/account/archive-addresses', { email: 'm5@x-op-e.example' });
    assert.equal(r.status, 429);
    // Asking works again once two marks are older than 30 days: the second oldest, 20 days old, ages out in 10 days.
    const day = new Date(Date.now() + 10 * 864e5);
    assert.match(r.data.error, new RegExp(`until ${day.getUTCDate()} ${day.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${day.getUTCFullYear()}`), r.data.error);
    // On that day (the two oldest past 30 days), asking works.
    db.run("UPDATE archive_refused SET at=? WHERE account_id=? AND email IN ('m1@x-op-a.example','m2@x-op-b.example')", new Date(Date.now() - 31 * 864e5).toISOString(), acct);
    assert.equal((await owner.post('/account/archive-addresses', { email: 'm5@x-op-e.example' })).status, 200);
  } finally {
    if (was === undefined) delete process.env.MAIL_EVENTS_TOKEN;
    else process.env.MAIL_EVENTS_TOKEN = was;
  }
});

test('self-host: /help promises no reply from a person unless a help request reaches somebody', () => {
  const help = read('src/app/help/page.tsx');
  const lines = help.split('\n');
  const promise = /person (replies|will (look|help|trace|read)|is one click away)|One person has it|Write to a person/;
  lines.forEach((l, i) => {
    if (!promise.test(l) || /^\s*(\/\/|\{?\/\*)/.test(l)) return;
    assert.ok(/support\.promised/.test(l) || /support\.promised/.test(lines[i - 1] || '') || /support\.promised/.test(lines[i - 2] || ''), `help/page.tsx:${i + 1} promises a person without asking support.promised: ${l.trim().slice(0, 120)}`);
  });
  assert.match(read('src/app/help/NotMe.tsx'), /\{supportReachable\(\) \? 'Write to a person about it' : 'Write to us about it'\}/);
  // The metadata is the same for every server, so it promises nothing about a person.
  assert.doesNotMatch(help.match(/export const metadata = [^\n]+/)![0], /person/);
  // With nobody named, the section says so plainly, and the form's answer after sending promises nothing either.
  assert.match(help, /Nobody has been named to answer help requests on this server yet\. The form keeps what you write and gives you a reference/);
  assert.match(read('src/app/help/tools.tsx'), /\{info\.reply \? <>A person will read it and reply by email to \{a\.done\.email\}\.<\/> : <>It is kept, but nobody has been named/);
});

test('stamp: a design with thin lines at its size starts with even ink and says so; the sliders are named by their own words', () => {
  const maker = read('src/components/stamps/StampMaker.tsx');
  // Once for each picture, on its first impression: thin lines and texture above the line, so even ink from the start.
  assert.match(maker, /evenFirst\.current = 'pending';/);
  assert.match(maker, /if \(!r\.empty && \(r\.fine \|\| 0\) >= FINE_WARN_SHARE && look\.texture > FINE_WARN_TEXTURE\) \{\s*setEvened\(true\);\s*setLook\(\(l\) => \(l \? \{ \.\.\.l, texture: FINE_WARN_TEXTURE \} : l\)\);/);
  assert.match(maker, /This stamp has very thin lines at this size, so we printed it with even ink to keep them whole\. You can change this under &ldquo;Adjust the look&rdquo;\./);
  // The fold stays closed for it: nothing to press.
  const block = maker.slice(maker.indexOf('if (evenFirst.current'), maker.indexOf('// Nothing left at these settings'));
  assert.doesNotMatch(block, /setAdjust/);
  // A screen reader hears "Rubber texture", not the end words run together; the end words stay its description.
  assert.match(maker, /<span id=\{`\$\{id\}-tex-l`\}>Rubber texture<\/span>\s*<input type="range"[^\n]*aria-labelledby=\{`\$\{id\}-tex-l`\} aria-describedby=\{`\$\{id\}-tex`\}/);
  assert.match(maker, /<span id=\{`\$\{id\}-paper-l`\}>What counts as paper<\/span>\s*<input type="range"[^\n]*aria-labelledby=\{`\$\{id\}-paper-l`\}/);
});

test('self-host, dialogs: a fold at the end of a dialog is reached with Tab, and the footer sentence links are 44 px', () => {
  for (const f of ['src/components/sign/Dialog.tsx', 'src/components/sender/Dialog.tsx'])
    assert.match(read(f), /^const FOCUSABLE = 'a\[href\], button:not\(\[disabled\]\), details > summary, /m, f);
  assert.match(read('src/app/styles/public.css'), /^\.pub-foot-brand p a \{ display: inline-flex; align-items: center; min-height: 44px; \}$/m);
});
