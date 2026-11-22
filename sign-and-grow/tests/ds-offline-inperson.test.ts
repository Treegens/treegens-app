// Signing in person where there is no signal (research/docusign-gaps.json, batch "offline-inperson"): getting one
// in-person signer's part ready on the host's device, the copy kept there under a PIN (a pretend IndexedDB and Node's
// WebCrypto), a wrong PIN, signing on the device, sending it back, a changed envelope refused, the certificate line,
// the copy wiped after 7 days, and everything this is not for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, signUp, Client, simple, PNG } from './helpers.ts';

const S = await boot();
const dev = await import('../src/components/sign/offlineInPerson.ts');
const words = await import('../src/lib/offlinesign.ts');
const { offlineCertLines } = await import('../src/server/offlinesign.ts');
const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

let n = 0;
const ip = () => `198.51.100.${(n = (n % 250) + 1)}`;
const ROUNDS = 1000; // the real PIN_ROUNDS is slow on purpose; one test below uses it
const PIN = '482915';

/** A pretend IndexedDB database: values by name, cleared all at once. */
const box = () => {
  const m = new Map<string, any>();
  return { m, get: async (k: string) => structuredClone(m.get(k)), put: async (k: string, v: any) => void m.set(k, structuredClone(v)), clear: async () => m.clear() } as dev.Box & { m: Map<string, any> };
};

async function hosted(tag: string, over: any = {}) {
  const email = `${tag}@example.com`;
  const host = await signUp(`Host ${tag}`, email, ip());
  const e = await simple(host, email, {
    recipients: [{ id: 'r', role: 'inperson', name: 'Pat Present', email: `${tag}-pat@example.com` }, { id: 's', role: 'signer', name: 'Sol Link', email: `${tag}-sol@example.com` }],
    fields: [
      { id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'g', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Field number', page: 0, x: 0.1, y: 0.4, w: 0.3, h: 0.03 },
      { id: 'h', document_id: 'd', recipient_id: 's', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 },
    ],
    send: true,
    ...over,
  });
  const r = e.recipients.find((x: any) => x.role === 'inperson');
  return { host, e, r, email };
}
const ready = (c: Client, e: any, rid: string) => c.post(`/envelopes/${e.id}/offline`, { recipient_id: rid });
const valuesFor = (pack: any) => Object.fromEntries(pack.view.fields.map((f: any) => [f.id, f.type === 'text' ? 'Plot 14' : '1']));
const result = (pack: any): dev.Result => ({ values: valuesFor(pack), signature_png: PNG, initials_png: null, consent: { wording: undefined, page_language: 'en', tz: 'Africa/Nairobi' }, device_at: '2026-11-20T09:15:00.000Z' });
/** The device's post, against the test server, from a browser that is not signed in (the signing link is all it needs). */
const poster = (c = new Client()) => async (url: string, body: any) => c.post(url.replace(/^\/api/, ''), body);

test('1. getting ready: only the sender, only for someone who signs in person, while it is out; nothing marked or locked', async () => {
  const { host, e, r } = await hosted('prep1');
  const res = await ready(host, e, r.id);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const p = res.data;
  assert.match(p.prep_id, /^ofl_/);
  assert.equal(p.token, r.token ?? S.db.get('SELECT token FROM recipients WHERE id=?', r.id).token);
  assert.equal(p.view.recipient.name, 'Pat Present');
  assert.deepEqual(p.view.fields.map((f: any) => f.type).sort(), ['signature', 'text']);
  assert.equal(p.files.length, 1);
  assert.equal(Buffer.from(p.files[0].pdf, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.ok(Date.parse(p.expires_at) - Date.parse(p.created_at) === words.OFFLINE_DAYS * 864e5);
  // Quiet: not marked viewed, the account not locked, and a line in the record.
  assert.equal(S.db.get('SELECT status FROM recipients WHERE id=?', r.id).status, 'sent');
  assert.equal((await host.get('/envelopes')).status, 200);
  assert.ok(S.db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Got ready to sign in person without a connection'", e.id));
  assert.equal((await host.get(`/envelopes/${e.id}/offline`)).data.waiting.length, 1);

  // Not for someone who signs by link.
  const link = e.recipients.find((x: any) => x.role === 'signer');
  const no = await ready(host, e, link.id);
  assert.equal(no.status, 409);
  assert.equal(no.data.code, 'not_in_person');
  // Not for another account, and not with an API key.
  const other = await signUp('Other prep1', 'other-prep1@example.com', ip());
  assert.equal((await ready(other, e, r.id)).status, 404);
  const made = await host.post('/api-keys', { name: 'Field app' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const k = await new Client().call('POST', `/envelopes/${e.id}/offline`, { recipient_id: r.id }, { authorization: `Bearer ${made.data.key}` });
  assert.equal(k.status, 403);
  assert.equal(k.data.code, 'session_only');
});

test('1. a part that needs a connection is not got ready, and says why', async () => {
  const one = (extra: any[] = []) => [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, ...extra];
  const a = await hosted('prep2', { recipients: [{ id: 'r', role: 'inperson', name: 'Pat Present', email: 'prep2-pat@example.com', access_code: '9911' }], fields: one() });
  const res = await ready(a.host, a.e, a.r.id);
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'needs_signal');
  assert.match(res.data.error, /access code.*Host it with a connection instead\./);
  const b = await hosted('prep3', { recipients: [{ id: 'r', role: 'inperson', name: 'Pat Present', email: 'prep3-pat@example.com' }], fields: one([{ id: 'a', document_id: 'd', recipient_id: 'r', type: 'attachment', label: 'Photo of ID', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.05 }]) });
  const res2 = await ready(b.host, b.e, b.r.id);
  assert.equal(res2.status, 409);
  assert.match(res2.data.error, /Photo of ID field, which needs a connection/);
  // A draft is not out.
  const c = await hosted('prep4', { send: false });
  const res3 = await c.host.post(`/envelopes/${c.e.id}/offline`, { recipient_id: 'r' });
  assert.ok(res3.status === 404 || res3.status === 409);
});

test('1-2. the device keeps it under a PIN; a wrong PIN is counted and the fifth wipes it', async () => {
  const { host, e, r } = await hosted('dev1');
  const pack = (await ready(host, e, r.id)).data;
  const b = box();
  assert.match(dev.pinProblem('123'), /at least 6/);
  assert.match(dev.pinProblem('111111'), /easy to guess/);
  assert.match(dev.pinProblem('123456'), /easy to guess/);
  assert.match(dev.pinProblem('482915', '482916'), /not the same/);
  await assert.rejects(dev.keep(b, '1234', pack, ROUNDS), /at least 6/);
  await dev.keep(b, PIN, pack, ROUNDS);
  // Nothing about the person or the document is readable without the PIN.
  const raw = JSON.stringify(b.m.get('copy'));
  for (const secret of ['Pat Present', pack.token, 'Field number', pack.files[0].pdf.slice(0, 40)]) assert.equal(raw.includes(secret), false, secret);
  assert.equal((await dev.peek(b)).state, 'ready');
  for (let i = 1; i < words.PIN_TRIES; i++) {
    await assert.rejects(dev.unlock(b, '000001'), (err: any) => err.code === 'wrong_pin' && err.left === words.PIN_TRIES - i && /That PIN is not right\./.test(err.message));
  }
  // A right PIN in between starts the count again.
  const open = await dev.unlock(b, PIN);
  assert.equal(open.pack.view.recipient.name, 'Pat Present');
  assert.equal(open.result, null);
  for (let i = 1; i < words.PIN_TRIES; i++) await assert.rejects(dev.unlock(b, '000001'), (err: any) => err.code === 'wrong_pin');
  await assert.rejects(dev.unlock(b, '000001'), (err: any) => err.code === 'wiped' && /wiped\. Nothing was signed\./.test(err.message));
  assert.equal(b.m.size, 0);
  assert.equal((await dev.peek(b)).state, 'none');
});

test('1. the real key is PBKDF2 with SHA-256 and many rounds', async () => {
  assert.ok(words.PIN_ROUNDS >= 600_000);
  const src = read('src/components/sign/offlineInPerson.ts');
  assert.match(src, /name: 'PBKDF2', salt: salt as BufferSource, iterations: rounds, hash: 'SHA-256'/);
  assert.match(src, /name: 'AES-GCM', length: 256/);
  const salt = new Uint8Array(16);
  const t = Date.now();
  const k = await dev.keyFrom(PIN, salt);
  assert.ok(Date.now() - t > 20, 'slow on purpose');
  assert.deepEqual(await dev.unseal(k, await dev.seal(k, { a: 1 })), { a: 1 });
});

test('2-4. signing on the device, saved with its clock, sent once there is signal, the record and the certificate', async () => {
  const { host, e, r } = await hosted('sync1');
  const pack = (await ready(host, e, r.id)).data;
  const b = box();
  const key = await dev.keep(b, PIN, pack, ROUNDS);
  // Handing over locks the account in that browser, as Host signing now does.
  assert.equal((await host.post(`/offline/${pack.prep_id}/hand-over`)).status, 200);
  assert.equal((await host.get('/envelopes')).data.code, 'handed_over');
  // No signal: the result is kept, encrypted, and nothing is signed.
  const res = result(pack);
  await dev.saveResult(b, key, res);
  assert.equal(JSON.stringify(b.m.get('copy')).includes('Plot 14'), false);
  assert.equal((await dev.peek(b)).state, 'saved');
  const offline = await dev.sendResult(b, pack, res, async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(offline, { state: 'waiting', text: 'Saved on this phone. It is sent when the phone has signal again. Nothing is signed until then.' });
  // A page from something in between (a Wi-Fi sign-in page) is no answer either.
  assert.equal((await dev.sendResult(b, pack, res, async () => ({ status: 200 - 0 + 302, data: '<html>' }))).state, 'waiting');
  assert.equal(S.db.get('SELECT status FROM recipients WHERE id=?', r.id).status, 'sent');
  // The PIN opens it again after a reload, with the result.
  const again = await dev.unlock(b, PIN);
  assert.ok(Object.values(again.result!.values).includes('Plot 14'));
  // Signal again: sent, accepted, and the copy wiped.
  const sent = await dev.sendResult(b, again.pack, again.result!, poster());
  assert.equal(sent.state, 'sent', sent.text);
  assert.equal(b.m.size, 0);
  const row = S.db.get('SELECT status, completed_at FROM recipients WHERE id=?', r.id);
  assert.equal(row.status, 'completed');
  assert.equal(S.db.get("SELECT value FROM fields WHERE envelope_id=? AND label='Field number'", e.id).value, 'Plot 14');
  const prep = S.db.get('SELECT * FROM offline_preps WHERE id=?', pack.prep_id);
  assert.equal(prep.state, 'signed');
  assert.equal(prep.device_at, '2026-11-20T09:15:00.000Z');
  assert.ok(prep.received_at >= prep.created_at);
  // The record: received now, the device's clock said earlier and nobody checked it.
  const line = S.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Signed in person without a connection'", e.id).detail;
  assert.match(line, /^Pat Present\. Signed in person on the host's device without a connection\. The device's clock said 20 November 2026 at 09:15 UTC; this was not checked\. The server received it at .+\.$/);
  assert.ok(S.db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Agreed to electronic records and signatures' AND detail LIKE '%without a connection%'", e.id));
  // The certificate line, under this person only.
  const env = S.env.loadEnvelope(e.id);
  const ts = (s: string) => `[${s}]`;
  const lines = offlineCertLines(env, env.recipients.find((x: any) => x.id === r.id), ts);
  assert.deepEqual(lines, [['Without a connection', `Signed in person on the host's device without a connection. The device's clock said [2026-11-20T09:15:00.000Z]; this was not checked. The server received it at [${prep.received_at}].`]]);
  assert.deepEqual(offlineCertLines(env, env.recipients.find((x: any) => x.role === 'signer'), ts), []);
  assert.match(read('src/server/pdf.ts'), /for \(const \[k, v\] of offlineCertLines\(e, r, ts\)\) s\.kv\(k, known\(v\)\);/);
  // Sent twice (a retry after a lost answer): done, nothing signed twice.
  const twice = await poster()(`/api/sign/${pack.token}/offline-finish`, { prep_id: pack.prep_id, device_at: res.device_at, values: res.values, signature_png: PNG, consent: {} });
  assert.equal(twice.status, 200);
  assert.equal(twice.data.already, true);
  assert.equal(S.db.all("SELECT 1 FROM audit WHERE envelope_id=? AND action='Signed'", e.id).length, 1);
});

test('3. a document changed after it was got ready is refused: nothing signed, and the host is told plainly', async () => {
  const { host, e, r } = await hosted('chg1');
  const pack = (await ready(host, e, r.id)).data;
  const b = box();
  const key = await dev.keep(b, PIN, pack, ROUNDS);
  await dev.saveResult(b, key, result(pack));
  // The sender corrects the envelope meanwhile (its content version moves on).
  S.db.run('UPDATE envelopes SET content_version=content_version+1 WHERE id=?', e.id);
  const sent = await dev.sendResult(b, pack, result(pack), poster());
  assert.equal(sent.state, 'refused');
  assert.equal(sent.text, 'Nothing was signed for Pat Present, because the document was changed after this phone got it ready. Open the envelope with a connection and let Pat Present sign it again.');
  assert.equal(b.m.size, 0, 'a refused copy can never be accepted later, so it is not kept');
  assert.equal(S.db.get('SELECT status FROM recipients WHERE id=?', r.id).status, 'sent');
  assert.equal(S.db.get('SELECT state FROM offline_preps WHERE id=?', pack.prep_id).state, 'ended');
  assert.ok(S.db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Signing without a connection not accepted'", e.id));
});

test('3. refused too: an unknown copy, a cancelled one, one replaced by another envelope on the same device, a closed envelope', async () => {
  const { host, e, r } = await hosted('ref1');
  const pack = (await ready(host, e, r.id)).data;
  const post = poster();
  const send = (p: any, extra: any = {}) => post(`/api/sign/${p.token}/offline-finish`, { prep_id: p.prep_id, device_at: '2026-11-20T09:15:00Z', values: valuesFor(p), signature_png: PNG, consent: {}, ...extra });
  const unknown = await send(pack, { prep_id: 'ofl_made_up' });
  assert.equal(unknown.status, 404);
  assert.match(unknown.data.error, /not known to GrowSigning, so nothing was signed\. Open the envelope/);
  // Cancelled from the envelope page (a lost phone).
  assert.equal((await host.call('DELETE', `/envelopes/${e.id}/offline/${pack.prep_id}`)).status, 200);
  const cancelled = await send(pack);
  assert.equal(cancelled.status, 409);
  assert.equal(cancelled.data.code, 'offline_ended');
  assert.match(cancelled.data.error, /cancelled it\. Open the envelope with a connection/);
  // One envelope per device: getting a second one ready on the same browser ends the first.
  const p1 = (await ready(host, e, r.id)).data;
  const two = await hosted('ref2');
  // the same browser (session) as host for the second envelope: sign in as that host in the first client
  const p2 = (await ready(two.host, two.e, two.r.id)).data;
  assert.equal(p2.prep_id.length > 0, true);
  const p3 = (await ready(host, e, r.id)).data; // again on the same device: p1 ends
  assert.equal(S.db.get('SELECT state FROM offline_preps WHERE id=?', p1.prep_id).state, 'ended');
  assert.equal((await send(p1)).data.code, 'offline_ended');
  // A voided envelope signs nothing.
  assert.equal((await host.post(`/envelopes/${e.id}/void`, { reason: 'Wrong plot' })).status, 200);
  const voided = await send(p3);
  assert.equal(voided.status === 409 || voided.status === 400 || voided.status === 403, true, JSON.stringify(voided.data));
  assert.equal(S.db.get('SELECT status FROM recipients WHERE id=?', r.id).status !== 'completed', true);
});

test('5. at most 7 days: the device wipes its copy, and the server refuses one that is older', async () => {
  const { host, e, r } = await hosted('old1');
  const pack = (await ready(host, e, r.id)).data;
  const b = box();
  const key = await dev.keep(b, PIN, pack, ROUNDS);
  await dev.saveResult(b, key, result(pack));
  const later = Date.parse(pack.created_at) + words.OFFLINE_DAYS * 864e5 + 60_000;
  assert.equal((await dev.peek(b, later)).state, 'none');
  assert.equal(b.m.size, 0);
  await assert.rejects(dev.unlock(b, PIN, later), (err: any) => err.code === 'none' && /7 days at most/.test(err.message));
  // A device whose clock is wrong does not keep it longer: the server refuses after its own 7 days.
  S.db.run("UPDATE offline_preps SET expires_at=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), pack.prep_id);
  const res = await poster()(`/api/sign/${pack.token}/offline-finish`, { prep_id: pack.prep_id, device_at: '2026-11-20T09:15:00Z', values: valuesFor(pack), signature_png: PNG, consent: {} });
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'offline_too_old');
  assert.match(res.data.error, /more than 7 days old, so nothing was signed\. Open the envelope with a connection/);
});

test('5. one envelope per device: a copy with a result not sent yet is never replaced', async () => {
  const { host, e, r } = await hosted('one1');
  const pack = (await ready(host, e, r.id)).data;
  const b = box();
  const key = await dev.keep(b, PIN, pack, ROUNDS);
  await dev.keep(b, '739204', pack, ROUNDS); // a copy without a result is replaced
  await assert.rejects(dev.unlock(b, PIN), (err: any) => err.code === 'wrong_pin');
  const k2 = (await dev.unlock(b, '739204')).key;
  await dev.saveResult(b, k2, result(pack));
  await assert.rejects(dev.keep(b, PIN, pack, ROUNDS), /still holds a signature that has not been sent/);
  void key;
});

test('words: plain, no em dashes, each refusal says what happened and what to do', () => {
  const said = [words.OFFLINE_WORDS.unknown('Pat'), words.OFFLINE_WORDS.ended('Pat', 'It was cancelled.'), words.OFFLINE_WORDS.tooOld('Pat'), words.OFFLINE_WORDS.closed('Pat'), words.OFFLINE_WORDS.changed('Pat')];
  for (const s of said) {
    const parts = s.split(/(?<=\.) /);
    assert.ok(parts.length >= 2, s);
    assert.match(parts[parts.length - 1], /^Open /, s);
  }
  for (const f of ['src/lib/offlinesign.ts', 'src/server/offlinesign.ts', 'src/server/routes-offline.ts', 'src/components/sign/offlineInPerson.ts', 'src/app/in-person/page.tsx', 'public/offline.html', 'public/sw.js']) {
    if (fs.existsSync(path.join(root, f))) assert.doesNotMatch(read(f), /—/, f);
  }
  assert.doesNotMatch(JSON.stringify(words.OFFLINE_WORDS.kept('Pat')), /valid|hold up|offline mode|sync/i);
});

test('4. a device clock that sends nonsense is recorded as not said, and the certificate never trusts it', async () => {
  const { host, e, r } = await hosted('clock1');
  const pack = (await ready(host, e, r.id)).data;
  const res = await poster()(`/api/sign/${pack.token}/offline-finish`, { prep_id: pack.prep_id, device_at: 'yesterday-ish', values: valuesFor(pack), signature_png: PNG, consent: {} });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const line = S.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Signed in person without a connection'", e.id).detail;
  assert.match(line, /The device did not say what its clock said\. The server received it at /);
  // The date of signing is the server's: completed_at is when it was received.
  const row = S.db.get('SELECT completed_at FROM recipients WHERE id=?', r.id);
  assert.equal(row.completed_at, S.db.get('SELECT received_at FROM offline_preps WHERE id=?', pack.prep_id).received_at);
});

test('the screens: the action only in the More of someone who signs in person, the page and the lock', () => {
  const rec = read('src/components/sender/Recipients.tsx');
  assert.match(rec, /\{turn && r\.role === 'inperson' && may\('links'\) && <OfflineReadyButton envelopeId=\{e\.id\} r=\{r\} \/>\}/);
  assert.match(read('src/components/sender/OfflineReady.tsx'), /if \(!ok\) return null;/);
  assert.match(read('src/components/AppShell.tsx'), /lockIfHanded\(\)\.then/);
  const page = read('src/app/in-person/page.tsx');
  assert.match(page, /OFFLINE_WORDS\.saved/);
  assert.match(page, /I do not want to sign/);
  const sw = read('public/sw.js');
  assert.match(sw, /const IN_PERSON = '\/in-person';/);
  assert.match(sw, /pdfjs/);
  assert.match(read('public/offline.html'), /id="in-person" hidden/);
});
