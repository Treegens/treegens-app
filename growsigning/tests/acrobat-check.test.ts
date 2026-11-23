// The automatic Adobe Acrobat check (src/server/acrobat.ts, routes-acrobat.ts): a program on the operators' computer
// fetches a sample PDF with a document time stamp, opens it in Acrobat and reports the bar it saw. The time-stamp
// service here is a stub answering through a fetch stub (tests/sealcerts.ts); nothing reaches the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, signUp, Client, PNG, type Server } from './helpers.ts';
import { makeCert, tsaAnswer, stubTsa, TIME_STAMPING, type Made } from './sealcerts.ts';

let s: Server;
let handle: (req: Request) => Promise<Response>;
let acro: typeof import('../src/server/acrobat.ts');
let tsaMod: typeof import('../src/server/tsa.ts');
let tsaRoot: Made, tsa: Made;
const TOKEN = 'acrobat-check-token-0123456789abcdefghijklmnopqrstuvwxyz';
const SETTINGS = ['ACROBAT_CHECK_TOKEN', 'TSA_URL', 'TSA_URLS', 'TSA_TRUST', 'TSA_USER', 'TSA_PASSWORD', 'OPERATOR_EMAILS', 'SUPPORT_EMAIL'];
let ipN = 0;
const freshIp = () => `198.51.100.${++ipN % 250}`;

function settings(env: Record<string, string>) {
  for (const k of SETTINGS) delete process.env[k];
  Object.assign(process.env, env);
  tsaMod.tsaForgetRests();
}
const on = (more: Record<string, string> = {}) => settings({ ACROBAT_CHECK_TOKEN: TOKEN, TSA_URL: 'http://tsa-a.test/stamp,http://tsa-b.test/stamp', TSA_TRUST: tsaRoot.pem, OPERATOR_EMAILS: 'ops@acrobat.test', ...more });
const goodTsa = () => stubTsa((req) => tsaAnswer(req, tsa, [tsaRoot]));

async function call(method: string, url: string, o: { token?: string | null; body?: any; raw?: string; ip?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip || freshIp(), ...(o.headers || {}) };
  if (o.token !== null) headers.authorization = `Bearer ${o.token ?? TOKEN}`;
  let body: string | undefined;
  if (o.raw != null) body = o.raw;
  else if (o.body !== undefined) body = JSON.stringify(o.body);
  if (body != null) headers['content-type'] = 'application/json';
  const res = await handle(new Request(`http://test.local/api${url}`, { method, headers, body }));
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) } as { status: number; headers: Headers; data: any };
}
const sample = (q = '', o: Parameters<typeof call>[2] = {}) => call('GET', `/ops/acrobat-check/sample${q}`, o);
const report = (body: any, o: Parameters<typeof call>[2] = {}) => call('POST', '/ops/acrobat-check/result', { ...o, body });
const alerts = () => s.db.all("SELECT message FROM support_requests WHERE name='GrowSigning (automatic alert)' AND email IN ('ops@acrobat.test','acrobat-check@localhost') ORDER BY at").map((r: any) => String(r.message));
const mails = () => s.db.all("SELECT subject, html FROM emails WHERE to_email='ops@acrobat.test' ORDER BY id");
const pass = (check_id: string, more: any = {}) => ({
  check_id, banner_text: 'Signed and all signatures are valid.', banner_colour: 'blue',
  panel_lines: ['Rev. 1: Signed by ts.ssl.com', 'Signature is a document timestamp signature', 'Source of Trust obtained from Adobe Approved Trust List (AATL)'],
  acrobat_version: '2025.001.20000', os: 'Windows 11', notes: '', ...more,
});
async function fetched(q = '') {
  const stub = goodTsa();
  try {
    const r = await sample(q);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return { id: r.headers.get('x-check-id')!, r, stub };
  } finally {
    stub.restore();
  }
}

before(async () => {
  s = await boot();
  handle = (await import('../src/server/router.ts')).handle;
  acro = await import('../src/server/acrobat.ts');
  tsaMod = await import('../src/server/tsa.ts');
  tsaRoot = makeCert({ cn: 'Acrobat Check TSA Root', ca: true });
  tsa = makeCert({ cn: 'Acrobat Check Time-Stamp Unit', issuer: tsaRoot, ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true });
});
after(() => settings({}));

test('without ACROBAT_CHECK_TOKEN both routes answer 404 exactly like a route that does not exist', async () => {
  settings({ TSA_URL: 'http://tsa-a.test/stamp' });
  const none = await call('GET', '/ops/acrobat-check/nothing-here');
  for (const r of [await sample(), await report(pass('acr_abcdefghijkl'))]) {
    assert.equal(r.status, 404);
    assert.equal(r.data.error, none.data.error);
    assert.deepEqual(Object.keys(r.data).sort(), Object.keys(none.data).sort());
  }
});

test('without the token, with a wrong one, or with it in the query string: 404, and nothing is made or asked', async () => {
  on();
  const stub = goodTsa();
  try {
    assert.equal((await sample('', { token: null })).status, 404);
    assert.equal((await sample('', { token: `${TOKEN}x` })).status, 404);
    assert.equal((await sample('', { token: 'short' })).status, 404);
    assert.equal((await sample(`?token=${TOKEN}`, { token: null })).status, 404);
    assert.equal((await sample('', { token: null, headers: { authorization: `Basic ${TOKEN}` } })).status, 404);
    assert.equal((await report(pass('acr_abcdefghijkl'), { token: 'nope' })).status, 404);
    assert.equal(stub.calls.length, 0, 'no time-stamp service was asked');
  } finally {
    stub.restore();
  }
});

test('the sample is a PDF with one /DocTimeStamp from the configured service, says what it is, and a small row is kept', async () => {
  on();
  const { id, r, stub } = await fetched();
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="growsigning-acrobat-check-${id}.pdf"`);
  assert.match(id, /^acr_[A-Za-z0-9_-]+$/);
  assert.equal(r.headers.get('x-tsa-host'), 'tsa-a.test');
  assert.equal(r.headers.get('x-tsa-trusted'), 'true');
  assert.equal(stub.calls.length, 1);
  const raw = (r.data as Buffer).toString('latin1');
  assert.ok(raw.startsWith('%PDF-'));
  assert.match(raw, /\/Type \/DocTimeStamp\n\/Filter \/Adobe\.PPKLite\n\/SubFilter \/ETSI\.RFC3161/);
  assert.equal(raw.match(/\/Type \/DocTimeStamp/g)!.length, 1, 'the only signature is the document time stamp');
  assert.doesNotMatch(raw, /\/Type \/Sig\b/);
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(r.data, { updateMetadata: false });
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getTitle(), 'GrowSigning Acrobat check');
  const row = s.db.get('SELECT * FROM acrobat_checks WHERE id=?', id);
  assert.equal(row.tsa_host, 'tsa-a.test');
  assert.equal(row.trusted, 1);
  assert.equal(row.tsa_name, 'Acrobat Check Time-Stamp Unit');
  assert.equal(row.reported_at, null);
  const { sha256 } = await import('../src/server/util.ts');
  assert.equal(row.pdf_sha256, sha256(r.data));
  // The words on the page: the lines it draws, and what a PDF reader reads off it when pdftotext is installed.
  const words = acro.sampleLines(id, new Date(row.created_at), ['tsa-a.test', 'tsa-b.test']).map((l) => l[0]).join('\n');
  assert.match(words, /GrowSigning Acrobat check/);
  assert.match(words, new RegExp(`Check id: ${id}`));
  assert.match(words, /Time-stamp services in use: tsa-a\.test, tsa-b\.test/);
  assert.match(words, /This file holds no customer data\./);
  assert.match(words, /Made on \d{4}-\d\d-\d\d at \d\d:\d\d:\d\d UTC\./);
  try {
    const { execFileSync } = await import('node:child_process');
    const f = path.join(process.env.DATA_DIR!, `${id}.pdf`);
    fs.writeFileSync(f, r.data);
    const read = execFileSync('pdftotext', [f, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(read, /This file holds no customer data\./);
    assert.ok(read.includes(id));
    assert.match(read, /Time-stamp services in use: tsa-a\.test, tsa-b\.test/);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
});

test('without TSA_TRUST the sample says X-Tsa-Trusted: false', async () => {
  on({ TSA_TRUST: '' });
  delete process.env.TSA_TRUST;
  const { id, r } = await fetched();
  assert.equal(r.headers.get('x-tsa-trusted'), 'false');
  assert.equal(s.db.get('SELECT trusted FROM acrobat_checks WHERE id=?', id).trusted, 0);
});

test('?tsa= asks only that configured service, and a host that is not in TSA_URL is refused', async () => {
  on();
  const { r, stub } = await fetched('?tsa=tsa-b.test');
  assert.equal(r.headers.get('x-tsa-host'), 'tsa-b.test');
  assert.deepEqual(stub.calls.map((c) => c.url), ['http://tsa-b.test/stamp']);
  const s2 = goodTsa();
  try {
    for (const q of ['?tsa=evil.test', '?tsa=', '?tsa=TSA-B.TEST.evil', '?tsa=tsa-b.test%2Fstamp']) {
      const bad = await sample(q);
      assert.equal(bad.status, 400, q);
      assert.equal(bad.data.code, 'tsa_not_listed');
      assert.match(bad.data.error, /tsa-a\.test, tsa-b\.test/);
    }
    assert.equal(s2.calls.length, 0);
    // Upper case is the same host.
    assert.equal((await sample('?tsa=TSA-A.test')).status, 200);
  } finally {
    s2.restore();
  }
});

test('when no service answers: 503 with the reason, and the operators are told once a day', async () => {
  on();
  const before = alerts().length;
  const beforeMail = mails().length;
  const stub = stubTsa(() => 503);
  try {
    const r = await sample();
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'tsa_down');
    assert.match(r.data.error, /HTTP 503/);
    assert.equal(r.data.alerted, true);
    assert.equal((await sample()).data.alerted, false, 'the same day: not again');
    // The backup named with ?tsa= has its own mark, and says the others still serve completed documents.
    const forced = await sample('?tsa=tsa-b.test');
    assert.equal(forced.status, 503);
    assert.equal(forced.data.alerted, true);
    assert.equal((await sample('?tsa=tsa-b.test')).data.alerted, false, 'the backup: once a day too');
  } finally {
    stub.restore();
  }
  const added = alerts().slice(before);
  assert.equal(added.length, 2);
  assert.match(added[0], /No time-stamp service answered the Acrobat check/);
  assert.match(added[0], /tsa-a\.test/);
  assert.match(added[1], /The time-stamp service tsa-b\.test did not answer/);
  assert.match(added[1], /still use the other services in TSA_URL \(tsa-a\.test\)/);
  assert.doesNotMatch(added[1], /getting no time stamp/);
  assert.equal(mails().length - beforeMail, 2);
  // The next day it is told again.
  const today = new Date().toISOString().slice(0, 10);
  s.db.run('UPDATE acrobat_marks SET key=? WHERE key=?', 'down:2000-01-01:all', `down:${today}:all`);
  const stub2 = stubTsa(() => 500);
  try {
    assert.equal((await sample()).data.alerted, true);
  } finally {
    stub2.restore();
  }
  // No TSA_URL at all is the same failure.
  settings({ ACROBAT_CHECK_TOKEN: TOKEN, OPERATOR_EMAILS: 'ops@acrobat.test' });
  const none = await sample();
  assert.equal(none.status, 503);
  assert.match(none.data.error, /TSA_URL/);
});

test('a report of the blue bar passes; the server decides, and each check is reported once', async () => {
  on();
  const { id } = await fetched();
  const before = alerts().length;
  const r = await report(pass(id, { screenshot_png_base64: PNG }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.verdict, 'pass');
  assert.equal(r.data.alerted, false);
  assert.equal(alerts().length, before, 'nobody is told about a pass');
  const row = s.db.get('SELECT * FROM acrobat_checks WHERE id=?', id);
  assert.equal(row.verdict, 'pass');
  assert.equal(row.banner_colour, 'blue');
  assert.deepEqual(JSON.parse(row.panel_lines).length, 3);
  assert.match(row.screenshot_sha256, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR!, 'blobs', row.screenshot_sha256)));
  const twice = await report(pass(id));
  assert.equal(twice.status, 409);
  assert.equal(twice.data.code, 'already_reported');
  assert.equal((await report(pass('acr_doesnotexist123'))).status, 404);
  assert.equal((await report(pass('acr_doesnotexist123'))).data.code, 'unknown_check');
  // Case does not matter for the words; the colour does.
  const { id: id2 } = await fetched();
  assert.equal((await report(pass(id2, { banner_text: 'SIGNED AND ALL SIGNATURES ARE VALID.' }))).data.verdict, 'pass');
});

test('anything else fails and the operators are told at once with the bar, the panel, the service and a link', async () => {
  on();
  s.db.run("DELETE FROM acrobat_marks WHERE key LIKE 'fail:%'");
  const cases: [any, RegExp][] = [
    [{ banner_colour: 'yellow', banner_text: 'At least one signature has problems.' }, /At least one signature has problems/],
    [{ banner_colour: 'blue', banner_text: 'Signed and all signatures are' }, /does not say/],
    [{ banner_colour: 'red', banner_text: 'Signed and all signatures are valid.' }, /red, not blue/],
    [{ banner_colour: 'none', banner_text: '' }, /not there/],
  ];
  for (const [over, why] of cases) {
    const { id } = await fetched();
    const before = alerts().length;
    const beforeMail = mails().length;
    const r = await report(pass(id, { ...over, panel_lines: ['Signature validity is UNKNOWN', 'The signer\'s identity is unknown'] }));
    assert.equal(r.status, 200);
    assert.equal(r.data.verdict, 'fail');
    assert.equal(r.data.alerted, true);
    const added = alerts().slice(before);
    assert.equal(added.length, 1);
    assert.match(added[0], /Adobe Acrobat did not show the time stamp as valid/);
    assert.match(added[0], why);
    assert.match(added[0], /Signature validity is UNKNOWN/);
    assert.match(added[0], /tsa-a\.test/);
    assert.ok(added[0].includes(`http://test.local/app/operator#acrobat-${id}`));
    const m = mails().slice(beforeMail);
    assert.equal(m.length, 1);
    assert.match(m[0].subject, /Adobe Acrobat did not show the time stamp as valid/);
    assert.equal(s.db.get('SELECT alerted FROM acrobat_checks WHERE id=?', id).alerted, 1);
  }
});

test('the report is checked: kinds, lengths, the colour, a real PNG, and the size of the screenshot and the body', async () => {
  on();
  const { id } = await fetched();
  const bad = async (over: any, fieldName: string) => {
    const r = await report(pass(id, over));
    assert.equal(r.status, 400, `${fieldName}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.field, fieldName);
  };
  await bad({ banner_colour: 'green' }, 'banner_colour');
  await bad({ banner_text: 5 }, 'banner_text');
  await bad({ banner_text: 'x'.repeat(501) }, 'banner_text');
  await bad({ panel_lines: 'one line' }, 'panel_lines');
  await bad({ panel_lines: [1] }, 'panel_lines[0]');
  await bad({ panel_lines: Array(61).fill('a') }, 'panel_lines');
  await bad({ acrobat_version: null }, 'acrobat_version');
  await bad({ os: 'x'.repeat(101) }, 'os');
  await bad({ notes: 'x'.repeat(2001) }, 'notes');
  await bad({ banner_text: 'bell\u0007' }, 'banner_text');
  await bad({ screenshot_png_base64: Buffer.from('GIF89a not a png at all, really not').toString('base64') }, 'screenshot_png_base64');
  await bad({ screenshot_png_base64: 'not base64 !!!' }, 'screenshot_png_base64');
  // A PNG signature on top of nothing is not a PNG.
  await bad({ screenshot_png_base64: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(100)]).toString('base64') }, 'screenshot_png_base64');
  await bad({ screenshot_png_base64: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(1_600_000)]).toString('base64') }, 'screenshot_png_base64');
  const missing = await report({ banner_text: 'x' });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.field, 'check_id');
  const huge = await call('POST', '/ops/acrobat-check/result', { raw: JSON.stringify(pass(id, { notes: 'x'.repeat(2_300_000) })) });
  assert.equal(huge.status, 413);
  assert.equal((await call('POST', '/ops/acrobat-check/result', { raw: '{not json' })).status, 400);
  // None of that used up the check.
  assert.equal(s.db.get('SELECT reported_at FROM acrobat_checks WHERE id=?', id).reported_at, null);
  assert.equal((await report(pass(id))).data.verdict, 'pass');
});

test('each route is limited to 30 calls an hour from one address with the right token', async () => {
  on();
  const ip = '192.0.2.77';
  const stub = goodTsa();
  try {
    for (let i = 0; i < 30; i++) assert.notEqual((await report(pass('acr_doesnotexist123'), { ip })).status, 429);
    assert.equal((await report(pass('acr_doesnotexist123'), { ip })).status, 429);
    assert.equal((await sample('', { ip })).status, 200, 'the other route counts on its own');
  } finally {
    stub.restore();
  }
});

test('the timer: a sample not reported on within 2 hours, and no check for more than 2 days, are each told once', async () => {
  on();
  const { id } = await fetched();
  let before = alerts().length;
  const t0 = Date.now();
  assert.equal((await acro.acrobatTick(t0 + 3600_000)).missed, 0, 'an hour is not late');
  const late = await acro.acrobatTick(t0 + 3 * 3600_000);
  assert.ok(late.missed >= 1);
  let added = alerts().slice(before);
  assert.equal(added.length, 1);
  assert.match(added[0], /started and never reported/);
  assert.ok(added[0].includes(id));
  before = alerts().length;
  assert.equal((await acro.acrobatTick(t0 + 4 * 3600_000)).missed, 0, 'once');
  assert.equal(alerts().length, before);
  // A late report still counts, and the card says what it was.
  assert.equal((await report(pass(id))).data.verdict, 'pass');

  // Silence: nothing for 3 days after the last check.
  const nine = t0 + 3 * 86400_000;
  const quiet = await acro.acrobatTick(nine);
  assert.equal(quiet.silent, true);
  added = alerts().slice(before);
  assert.ok(added.some((a) => /No Acrobat check for more than 2 days/.test(a)));
  before = alerts().length;
  assert.equal((await acro.acrobatTick(nine + 86400_000)).silent, false, 'once for the same silence');
  assert.equal(alerts().length, before);
  // The timer runs it.
  const out = await s.cron.tick();
  assert.ok('acrobat_check' in out);
});

test('the operator card: the latest result, the last 10 and the next expected day for an operator; nothing for anyone else; never the token', async () => {
  on();
  const { id } = await fetched();
  await report(pass(id, { screenshot_png_base64: PNG, acrobat_version: '2099.1' }));
  const op = await signUp('Olive Operator', 'olive-acro@growsigning.test', '203.0.113.71');
  const other = await signUp('Nora Nobody', 'nora-acro@growsigning.test', '203.0.113.72');
  process.env.OPERATOR_EMAILS = 'ops@acrobat.test,olive-acro@growsigning.test';
  const r = await op.get('/operator/acrobat-check');
  assert.equal(r.status, 200);
  assert.equal(r.data.on, true);
  assert.equal(r.data.last.id, id);
  assert.equal(r.data.last.verdict, 'pass');
  assert.equal(r.data.last.acrobat_version, '2099.1');
  assert.equal(r.data.last.tsa_host, 'tsa-a.test');
  assert.equal(r.data.last.screenshot, true);
  assert.ok(r.data.checks.length <= 10 && r.data.checks.length > 0);
  assert.equal(r.data.checks[0].id, id);
  assert.equal(Date.parse(r.data.next_expected_at) - Date.parse(r.data.checks[0].created_at), 1 * 86400_000);
  assert.ok(!JSON.stringify(r.data).includes(TOKEN), 'the token is never shown');
  const shot = await op.get(`/operator/acrobat-check/${id}/screenshot`);
  assert.equal(shot.status, 200);
  assert.deepEqual(Buffer.from(shot.data), acro.keptScreenshot(Buffer.from(PNG.split(',')[1], 'base64'), id));
  assert.equal((await other.get('/operator/acrobat-check')).status, 404);
  assert.equal((await other.get(`/operator/acrobat-check/${id}/screenshot`)).status, 404);
  assert.equal((await new Client().get('/operator/acrobat-check')).status, 401);
  // The page draws the card from that route, and only for operators (the route answers 404 to anyone else).
  const page = fs.readFileSync('src/app/app/operator/page.tsx', 'utf8');
  assert.match(page, /<AcrobatCheckCard \/>/);
  const card = fs.readFileSync('src/app/app/operator/acrobat.tsx', 'utf8');
  assert.match(card, /\/operator\/acrobat-check/);
  assert.doesNotMatch(card, /ACROBAT_CHECK_TOKEN\b.*value|\u2014/);
});

test('tidy-up keeps the last 60 checks and their screenshots and deletes older ones', async () => {
  on();
  const { saveBlob } = await import('../src/server/db.ts');
  const base = Date.parse('2020-01-01T00:00:00Z');
  const shas: string[] = [];
  for (let i = 0; i < 70; i++) {
    const sha = saveBlob(Buffer.from(`old screenshot ${i} ${Math.random()}`));
    shas.push(sha);
    s.db.run("INSERT INTO acrobat_checks (id, created_at, tsa_host, pdf_sha256, reported_at, verdict, screenshot_sha256) VALUES (?,?,?,?,?,'pass',?)",
      `acr_tidy${String(i).padStart(6, '0')}`, new Date(base + i * 60_000).toISOString(), 'tsa-a.test', 'x'.repeat(64), new Date(base + i * 60_000).toISOString(), sha);
  }
  acro.tidyAcrobatChecks();
  assert.equal(s.db.get('SELECT COUNT(*) n FROM acrobat_checks').n, 60);
  // The newest checks (made by the tests above, after 2020) all stay; the oldest of the 70 go, with their screenshots.
  const kept = s.db.all("SELECT id FROM acrobat_checks WHERE id LIKE 'acr_tidy%'").length;
  assert.equal(kept, 60 - s.db.get("SELECT COUNT(*) n FROM acrobat_checks WHERE id NOT LIKE 'acr_tidy%'").n);
  const gone = shas.filter((sha) => !fs.existsSync(path.join(process.env.DATA_DIR!, 'blobs', sha)));
  assert.equal(gone.length, 70 - kept);
  assert.deepEqual(gone, shas.slice(0, 70 - kept), 'the oldest ones');
  assert.ok(!s.db.get("SELECT 1 x FROM acrobat_checks WHERE id='acr_tidy000000'"));
});

test('calls without the right token always get 404, never 429, and do not use up the program\'s allowance', async () => {
  on();
  const ip = '198.18.0.7';
  for (let i = 0; i < 40; i++) assert.equal((await sample('', { ip, token: i % 2 ? null : 'wrong-token' })).status, 404);
  assert.equal((await report(pass('acr_doesnotexist123'), { ip, token: null })).status, 404);
  const stub = goodTsa();
  try {
    assert.equal((await sample('', { ip })).status, 200, 'the program on the same address still gets in');
  } finally {
    stub.restore();
  }
});

test('a token shorter than 32 characters counts as unset, and openapi.json lists the routes only while the token is set', async () => {
  settings({ ACROBAT_CHECK_TOKEN: 'abc', TSA_URL: 'http://tsa-a.test/stamp' });
  assert.equal((await sample('', { token: 'abc' })).status, 404);
  const { openapi } = await import('../src/server/openapi.ts');
  const off = JSON.stringify(openapi());
  assert.doesNotMatch(off, /acrobat-check|acrobatToken/);
  on();
  const doc: any = openapi();
  assert.ok(doc.paths['/ops/acrobat-check/sample'] && doc.paths['/ops/acrobat-check/result']);
  assert.ok(doc.components.securitySchemes.acrobatToken);
});

/** A PNG with any header and a small IDAT, as an attacker could write it. */
async function rawPng(w: number, h: number, idat: Buffer, after = Buffer.alloc(0)) {
  const { crc32 } = await import('../src/server/png.ts');
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)), after]);
}

test('the screenshot: a picture too large to unpack is refused, and only its pixels are kept, as this check\'s own bytes', async () => {
  on();
  const { deflateSync } = await import('node:zlib');
  const { id } = await fetched();
  // 60000 x 60000 pixels would be about 14 GB unpacked; the file itself is small.
  const bomb = await rawPng(60000, 60000, deflateSync(Buffer.alloc(4_000_000)));
  assert.ok(bomb.length < 1_500_000);
  const r = await report(pass(id, { screenshot_png_base64: bomb.toString('base64') }));
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'screenshot_png_base64');
  // A 1x1 PNG with a web page packed after its end: accepted, but what is kept is the picture only.
  const ok = await rawPng(1, 1, deflateSync(Buffer.from([0, 10, 20, 30, 255])), Buffer.from('<html><script>alert(1)</script></html>'));
  const r2 = await report(pass(id, { screenshot_png_base64: ok.toString('base64') }));
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  const row = s.db.get('SELECT screenshot_sha256 FROM acrobat_checks WHERE id=?', id);
  const { readBlob } = await import('../src/server/db.ts');
  const kept = readBlob(row.screenshot_sha256);
  assert.doesNotMatch(kept.toString('latin1'), /script/);
  assert.ok(kept.toString('latin1').includes(`GrowSigning Acrobat check ${id}`), 'the bytes carry the check id');
  const { decodePng, readPng } = await import('../src/server/png.ts');
  assert.deepEqual([...decodePng(kept)!.data], [10, 20, 30, 255]);
  assert.equal(readPng(kept)!.chunks.at(-1)!.end, kept.length, 'nothing after the end');
});

test('the tidy-up never deletes a file something else in the store still uses (a scan photo with the same bytes)', async () => {
  on();
  const { saveBlob } = await import('../src/server/db.ts');
  const sha = saveBlob(Buffer.from(`a customer photo ${Math.random()}`));
  s.db.run("INSERT INTO scan_photos (file_id, page, sha256, size, cleaned, created_at) VALUES ('fil_acrotidy', 1, ?, 10, 1, ?)", sha, new Date().toISOString());
  s.db.run("INSERT INTO acrobat_checks (id, created_at, tsa_host, pdf_sha256, screenshot_sha256) VALUES ('acr_tidyshared01', '1999-01-01T00:00:00.000Z', 'tsa-a.test', ?, ?)", 'x'.repeat(64), sha);
  const n = s.db.get('SELECT COUNT(*) n FROM acrobat_checks').n;
  assert.ok(n > 60, 'the shared one is the oldest and past the 60');
  acro.tidyAcrobatChecks();
  assert.ok(!s.db.get("SELECT 1 x FROM acrobat_checks WHERE id='acr_tidyshared01'"));
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR!, 'blobs', sha)), 'the scan photo keeps its file');
  s.db.run("DELETE FROM scan_photos WHERE file_id='fil_acrotidy'");
});

test('the verdict: warning words, an untrusted time stamp and a late report are not a quiet pass', async () => {
  on();
  s.db.run("DELETE FROM acrobat_marks WHERE key LIKE 'fail:%'");
  const cases: [any, RegExp][] = [
    [{ banner_text: 'Signed and all signatures are valid. (not really) At least one signature has problems' }, /the bar also says "problems"/],
    [{ panel_lines: ['Signature is INVALID', 'The signer identity is unknown'] }, /the signature panel says "Signature is INVALID"/],
    [{ panel_lines: ['Document has been altered or corrupted since it was signed'] }, /altered/],
  ];
  for (const [over, why] of cases) {
    const { id } = await fetched();
    const r = await report(pass(id, over));
    assert.equal(r.data.verdict, 'fail', JSON.stringify(over));
    assert.equal(r.data.alerted, true);
    assert.match(r.data.why.join('; '), why);
  }
  // The good lines Acrobat shows still pass, "has not been modified" among them.
  const { id: good } = await fetched();
  assert.equal((await report(pass(good, { panel_lines: ['Signature is valid:', 'Document has not been modified since this signature was applied.', 'Signature is a document timestamp signature', 'Source of Trust obtained from Adobe Approved Trust List (AATL)'] }))).data.verdict, 'pass');
  // A time stamp the server could not check against TSA_TRUST fails, whatever Acrobat showed.
  delete process.env.TSA_TRUST;
  const { id: untrusted } = await fetched();
  const u = await report(pass(untrusted));
  assert.equal(u.data.verdict, 'fail');
  assert.match(u.data.why.join(), /TSA_TRUST/);
  on();
  // A report after the missed-check alarm counts, and says so.
  const { id: slow } = await fetched();
  s.db.run('UPDATE acrobat_checks SET missed_alerted_at=? WHERE id=?', new Date().toISOString(), slow);
  const l = await report(pass(slow));
  assert.equal(l.data.verdict, 'pass');
  assert.equal(l.data.late, true);
});

test('fail alerts are capped at 5 emails a day; later fails are kept for the card', async () => {
  on();
  s.db.run("DELETE FROM acrobat_marks WHERE key LIKE 'fail:%'");
  const beforeMail = mails().length;
  const got: boolean[] = [];
  for (let i = 0; i < 7; i++) {
    const { id } = await fetched();
    const r = await report(pass(id, { banner_colour: 'yellow' }));
    assert.equal(r.data.verdict, 'fail');
    got.push(r.data.alerted);
    assert.equal(s.db.get('SELECT verdict FROM acrobat_checks WHERE id=?', id).verdict, 'fail');
  }
  assert.deepEqual(got, [true, true, true, true, true, false, false]);
  const m = mails().slice(beforeMail);
  assert.equal(m.length, 5);
  assert.match(m[4].html, /the most sent in one day/);
});

test('at most 40 samples are made in any 24 hours, from all addresses together', async () => {
  on();
  const recent = s.db.get('SELECT COUNT(*) n FROM acrobat_checks WHERE created_at > ?', new Date(Date.now() - 86400_000).toISOString()).n;
  const fill = Math.max(0, 40 - recent);
  for (let i = 0; i < fill; i++)
    s.db.run("INSERT INTO acrobat_checks (id, created_at, tsa_host, pdf_sha256, reported_at, verdict) VALUES (?,?,?,?,?,'pass')", `acr_capfill${String(i).padStart(5, '0')}`, new Date().toISOString(), 'tsa-a.test', 'x'.repeat(64), new Date().toISOString());
  const stub = goodTsa();
  try {
    const r = await sample();
    assert.equal(r.status, 429);
    assert.equal(r.data.code, 'too_many_samples');
    assert.equal(stub.calls.length, 0, 'no service was asked');
  } finally {
    stub.restore();
    s.db.run("DELETE FROM acrobat_checks WHERE id LIKE 'acr_capfill%'");
  }
});
