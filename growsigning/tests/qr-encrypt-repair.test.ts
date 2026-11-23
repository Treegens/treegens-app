// What a skeptic proved broken in the QR codes and the encryption of stored files (research/verify-new.json,
// "verify:qr-encrypt"), each with the case that showed it. The text kept from documents is encrypted with the file
// key; the timer never lets one stuck signed PDF hold up the others; a code shown again shows the link that works now;
// and the words around a file that cannot be read say what happened and what to do.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { boot, Client, signUp, signAll, tokenFor, type Server } from './helpers.ts';
import { keyIdOf } from '../src/server/filecrypt.ts';
import { decodeFileKey, encryptedFilesPoint, notEncryptedPoint, databaseText, DATABASE_HOLDS, PROCESSING_ENCRYPTED, processingNotDone } from '../src/lib/storedfiles.ts';
import { keptText, sealKeptTexts, openText } from '../src/server/searchtext.ts';

let db: Server['db'];
let env: Server['env'];
before(async () => {
  ({ db, env } = await boot());
});

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DASH = String.fromCharCode(0x2014); // written this way so this file holds none itself
const newKey = () => crypto.randomBytes(32).toString('base64');
const K1 = newKey(), K2 = newKey(), K3 = newKey();
const id1 = keyIdOf(decodeFileKey(K1)!), id2 = keyIdOf(decodeFileKey(K2)!);
const setKeys = (current?: string, old: string[] = []) => {
  if (current === undefined) delete process.env.FILE_ENCRYPTION_KEY;
  else process.env.FILE_ENCRYPTION_KEY = current;
  if (old.length) process.env.FILE_ENCRYPTION_KEYS_OLD = old.join(',');
  else delete process.env.FILE_ENCRYPTION_KEYS_OLD;
};
afterEach(() => setKeys());
const blobs = () => path.join(process.env.DATA_DIR!, 'blobs');
const flip = (name: string, at = 300) => {
  const f = path.join(blobs(), name);
  const b = fs.readFileSync(f);
  b[at] ^= 1;
  fs.writeFileSync(f, b);
};
const tick = () => new Promise((r) => setImmediate(r));
const alerts = () => db.all("SELECT message FROM support_requests WHERE name='GrowSigning (automatic alert)'").map((r) => r.message as string);
let ipn = 10;
const person = (name: string, email: string) => signUp(name, email, `198.19.${ipn}.${ipn++}`);
// Everything on the disk that holds the database: the file itself, its write-ahead log and its index of that log.
const onDisk = () => {
  db.db().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const dir = process.env.DATA_DIR!;
  return Buffer.concat(fs.readdirSync(dir).filter((n) => n.startsWith('sign.db')).map((n) => fs.readFileSync(path.join(dir, n))));
};

async function pdfWith(words: string) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([612, 792]).drawText(`${words} ${Math.random()}`, { x: 40, y: 700, size: 10, font });
  return d.save();
}
async function uploadWith(c: Client, words: string, name = 'Agreement.pdf') {
  const f = new FormData();
  f.append('file', new Blob([await pdfWith(words)], { type: 'application/pdf' }), name);
  const r = await c.call('POST', '/files', f);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function envelopeWith(c: Client, file: any, email: string, subject: string) {
  const r = await c.post('/envelopes', { subject, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const found = async (c: Client, q: string) => (await c.get(`/envelopes?q=${encodeURIComponent(q)}`)).data.envelopes.map((e: any) => e.id);

// ---- 1. The text kept from documents (high) ------------------------------------------------------------------------

test('with a key the words read from an uploaded PDF are kept encrypted: the database on the disk holds none of them, and search and the check before sending still read them', async () => {
  setKeys(K1);
  const jo = await person('Jo Text', 'jo@keptext.example');
  const secret = 'SALARY-OF-MARTA-IS-987654';
  const file = await uploadWith(jo, `Employment contract. ${secret}. Bank account NL91ABNA0417164300. Lasting power of attorney.`, 'Contract Marta.pdf');
  const row = db.get('SELECT text, text_sealed, text_key FROM files WHERE id=?', file.id);
  assert.equal(row.text, null, 'nothing of the text is kept in the clear');
  assert.ok(row.text_sealed && row.text_key === id1);
  const e = await envelopeWith(jo, file, 'marta@keptext.example', 'Contract');
  // The check before sending reads the text it no longer finds in the clear.
  const w = (await jo.get(`/envelopes/${e.id}/warnings`)).data.warnings;
  assert.ok(w.some((x: any) => x.kind === 'attorney' && x.where === 'document text'), JSON.stringify(w));
  assert.equal((await jo.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'marta@keptext.example')).status, 200);
  // The search finds it by a word inside, in any case, and two words must both be there.
  assert.deepEqual(await found(jo, 'salary-of-marta'), [e.id]);
  assert.deepEqual(await found(jo, 'NL91ABNA0417164300 attorney'), [e.id]);
  assert.deepEqual(await found(jo, 'NL91ABNA0417164300 nowhere-at-all'), []);
  // Only for its own account: another team searching for the same words finds nothing of it.
  const ann = await person('Ann Other', 'ann@keptext.example');
  assert.deepEqual(await found(ann, secret), []);
  // Someone with a copy of the disk finds the words in neither the stored files nor the database.
  const disk = onDisk();
  for (const s of [secret, 'NL91ABNA0417164300']) {
    assert.ok(!disk.includes(Buffer.from(s)), `${s} is not in the database files`);
    for (const n of fs.readdirSync(blobs())) assert.ok(!fs.readFileSync(path.join(blobs(), n)).includes(Buffer.from(s)), `${s} is not in ${n}`);
  }
  // Without the key the text cannot be opened: the search still works and finds it by what is in the clear.
  setKeys();
  assert.deepEqual(await found(jo, secret), []);
  assert.deepEqual(await found(jo, 'Contract'), [e.id]);
});

test('text kept before the key was set is sealed when the server starts with it, overwritten where it stood, and moves to a new key with the old one listed', async () => {
  // No current key (the files of the test before are under K1, which is listed so storing goes on).
  setKeys(undefined, [K1]);
  const kim = await person('Kim Before', 'kim@keptext.example');
  const secret = 'OLD-TEXT-QUARTZ-55117';
  // Long enough to spill over several pages of the database file, where SQLite keeps freed bytes until reused.
  const file = await uploadWith(kim, `Lease. ${Array.from({ length: 120 }, (_, i) => `Clause ${i} ${secret}-${i}.`).join(' ')}`);
  const e = await envelopeWith(kim, file, 'tenant@keptext.example', 'Lease');
  assert.equal(db.get('SELECT text FROM files WHERE id=?', file.id).text.includes(secret), true, 'with no key it is kept as before');
  assert.ok(onDisk().includes(Buffer.from(secret)));
  // The server starts with a key.
  setKeys(K1);
  assert.ok(sealKeptTexts() >= 1);
  const row = db.get('SELECT id, text, text_sealed, text_key FROM files WHERE id=?', file.id);
  assert.equal(row.text, null);
  assert.equal(row.text_key, id1);
  assert.ok(keptText(row).includes(secret));
  assert.ok(!onDisk().includes(Buffer.from(secret)), 'the clear text was overwritten in the database file, not only unlinked');
  assert.deepEqual(await found(kim, secret.toLowerCase()), [e.id]);
  assert.equal(sealKeptTexts(), 0, 'a second start finds nothing to do');
  // A new key with the old one listed: the texts move to the new key, so the old one can be taken out later.
  setKeys(K2, [K1]);
  assert.ok(sealKeptTexts() >= 1);
  assert.equal(db.get('SELECT text_key FROM files WHERE id=?', file.id).text_key, id2);
  setKeys(K2);
  assert.deepEqual(await found(kim, secret), [e.id], 'readable with the new key alone');
  // A key that does not fit the stored files is the stop of filestore.ts: no text is sealed under what may be the mistake.
  setKeys(K3);
  const before = db.get('SELECT text_sealed, text_key FROM files WHERE id=?', file.id);
  assert.equal(sealKeptTexts(), 0);
  assert.deepEqual(db.get('SELECT text_sealed, text_key FROM files WHERE id=?', file.id), before);
  // A sealed text belongs to its own file row: copied onto another row it opens as nothing, never as that row's words.
  setKeys(K2);
  assert.equal(openText(before.text_sealed, 'fil_another_row'), null);
});

test('click-to-agree terms in a PDF are still read by the filter when their text is kept encrypted', async () => {
  setKeys(K1);
  const ola = await person('Ola Terms', 'ola@keptext.example');
  const plain = await uploadWith(ola, 'Terms of the garden club. Be kind to the plants and to each other.', 'terms.pdf');
  const made = await ola.post('/clickwraps', { name: 'Garden terms', format: 'pdf', file_id: plain.id });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const pub = await ola.post(`/clickwraps/${made.data.id}/publish`, {});
  assert.equal(pub.status, 200, `a PDF with words is not taken for a scan: ${JSON.stringify(pub.data)}`);
  // And what the filter is there for still works on the encrypted text.
  const lure = await uploadWith(ola, 'Your PayPal invoice of $499.99 has been paid. To cancel call +1 (888) 555-0199 now.', 'notice.pdf');
  const made2 = await ola.post('/clickwraps', { name: 'Billing terms', format: 'pdf', file_id: lure.id });
  const pub2 = await ola.post(`/clickwraps/${made2.data.id}/publish`, {});
  assert.equal(pub2.status, 422, JSON.stringify(pub2.data));
  assert.match(pub2.data.error, /read like a payment notice/);
});

test('/security and the data processing summary list what stays readable in the database and say to encrypt the disk, in both states', () => {
  setKeys(K1);
  const on = encryptedFilesPoint()!;
  assert.match(on.text, /and so is the text read from uploaded PDFs that is kept for search/);
  assert.match(on.text, /It does not make such a copy safe by itself, because only part of the database on the same disk is encrypted/);
  assert.match(on.text, /Their earlier readable copies stay in backups made before that, and can stay in the free space of the disk/);
  assert.doesNotMatch(on.text, /That protects a copy of the disk/);
  const dbOn = notEncryptedPoint();
  // With the key, part of the database is encrypted too (tests/ds-db-encrypt.test.ts); without it the whole list stays readable.
  for (const h of DATABASE_HOLDS) assert.ok(databaseText(false).includes(h), h);
  assert.ok(dbOn.lists![0].items.includes('the text read from uploaded PDFs for search'));
  assert.match(dbOn.after!, /So encrypt the disk itself as well\./);
  assert.match(PROCESSING_ENCRYPTED, /and the text read from uploaded PDFs for search are encrypted/);
  setKeys();
  const off = notEncryptedPoint();
  assert.match(off.text, /the text read from every uploaded PDF, kept for search and for the check before sending/);
  assert.match(off.text, /so new files are kept on the disk as they were uploaded and signed\. The software does not encrypt/);
  // Switched off the way the README says (the key moved to the old list): the files stored while it was on stay encrypted.
  setKeys(undefined, [K1]);
  assert.match(notEncryptedPoint().text, /new files are kept on the disk as they were uploaded and signed\. Files stored while it was switched on stay encrypted\./);
  assert.doesNotMatch(notEncryptedPoint().text, /those files are on the disk as they were uploaded/);
  assert.match(processingNotDone(false), /does not encrypt the files it stores now or any of the database/);
  for (const t of [on.text, dbOn.text, off.text, databaseText(true), databaseText(false), PROCESSING_ENCRYPTED, processingNotDone(true), processingNotDone(false), ...DATABASE_HOLDS])
    assert.doesNotMatch(t, new RegExp(`${DASH}|bank-grade|military|fully secure|unbreakable|compliant|is valid|will hold up`, 'i'));
  // Both pages print the list, whatever the setting.
  const processing = read('src/app/security/processing/page.tsx');
  assert.match(processing, /<li>\{databaseText\(\)\}<\/li>/);
  assert.match(processing, /\{processingNotDone\(\)\}/);
  assert.match(read('src/app/security/page.tsx'), /<Point title=\{notEncrypted\.title\}>\{notEncrypted\.text\}<DatabaseLists lists=\{notEncrypted\.lists\} after=\{notEncrypted\.after\} \/><\/Point>/);
});

// ---- 2. A signed PDF that cannot be made (medium) ------------------------------------------------------------------

// As if time had passed for the timer: every envelope's next try comes `ms` earlier, in the same order.
const later = (ms: number) => {
  for (const r of db.all('SELECT id, final_due_at FROM envelopes WHERE final_due_at IS NOT NULL')) db.run('UPDATE envelopes SET final_due_at=? WHERE id=?', new Date(Date.parse(r.final_due_at) - ms).toISOString(), r.id);
};
const finalOf = (eid: string) => db.get('SELECT final_sha256, final_tries, final_told_at FROM envelopes WHERE id=?', eid);

test('five envelopes whose signed PDF cannot be made never hold up the others: the timer skips them after their tries, tells the sender and the operators once, and goes on', async () => {
  setKeys(K1);
  const jo = await person('Jo Timer', 'jo@timer.example');
  const stuck: { id: string; src: string }[] = [];
  for (let i = 0; i < 5; i++) {
    const file = await uploadWith(jo, `Stuck ${i}`);
    const e = await envelopeWith(jo, file, `s${i}@timer.example`, `Stuck ${i}`);
    assert.equal((await jo.post(`/envelopes/${e.id}/send`)).status, 200);
    const src = db.get('SELECT sha256 s FROM files WHERE id=?', file.id).s;
    flip(src);
    assert.equal((await signAll(e.id, `s${i}@timer.example`)).status, 200, 'signing finishes whatever happens to the PDF');
    stuck.push({ id: e.id, src });
    assert.equal(finalOf(e.id).final_tries, 1, 'the failed try at completion counts');
  }
  // One more completes while storing is stopped (a new key in place of the old one): not its fault, so not counted.
  const wf = await uploadWith(jo, 'Waits for storage');
  const w = await envelopeWith(jo, wf, 'wait@timer.example', 'Waits for storage');
  assert.equal((await jo.post(`/envelopes/${w.id}/send`)).status, 200);
  setKeys(K2);
  assert.equal((await signAll(w.id, 'wait@timer.example')).status, 200);
  assert.deepEqual(finalOf(w.id), { final_sha256: null, final_tries: 0, final_told_at: null });
  // Nothing is tried while storing is stopped.
  const before = stuck.map((s) => finalOf(s.id).final_tries);
  later(3600_000);
  await env.cronTick();
  assert.deepEqual(stuck.map((s) => finalOf(s.id).final_tries), before);
  // The old key is listed again: the next tick makes the waiting one first, ahead of the five that keep failing.
  setKeys(K2, [K1]);
  later(3600_000);
  await env.cronTick();
  assert.ok(finalOf(w.id).final_sha256, 'the waiting envelope got its signed PDF');
  // Time passes. Each stuck one is tried less often, and after its fifth try its sender and the operators are told.
  for (let i = 0; i < 6; i++) (later(86_400_000), await env.cronTick());
  await tick();
  for (const s of stuck) {
    const f = finalOf(s.id);
    assert.equal(f.final_sha256, null);
    assert.ok(f.final_told_at, `told about ${s.id}`);
    assert.ok(f.final_tries >= 5);
  }
  const delayed = db.all("SELECT envelope_id, subject, html FROM emails WHERE to_email='jo@timer.example' AND subject LIKE 'Signed PDF delayed:%'");
  assert.equal(delayed.length, 5, 'one email for each, not one each tick');
  assert.match(delayed[0].html, /Everyone has finished/);
  assert.match(delayed[0].html, /We try again once a day, and we email you as soon as the signed PDF is ready/);
  const ops = alerts().filter((a) => a.startsWith('A signed PDF cannot be made'));
  assert.equal(ops.length, 5, 'one alert for each, in the operator queue');
  // A new one that failed once for a passing reason is not kept waiting behind them.
  const nf = await uploadWith(jo, 'Passing trouble');
  const n = await envelopeWith(jo, nf, 'new@timer.example', 'Passing trouble');
  assert.equal((await jo.post(`/envelopes/${n.id}/send`)).status, 200);
  const nsrc = db.get('SELECT sha256 s FROM files WHERE id=?', nf.id).s;
  flip(nsrc);
  assert.equal((await signAll(n.id, 'new@timer.example')).status, 200);
  flip(nsrc); // put back as it was
  later(3600_000);
  await env.cronTick();
  assert.ok(finalOf(n.id).final_sha256, 'made on the next tick after its short wait');
  // More ticks tell nobody again.
  for (let i = 0; i < 3; i++) (later(86_400_000), await env.cronTick());
  await tick();
  assert.equal(db.all("SELECT 1 FROM emails WHERE to_email='jo@timer.example' AND subject LIKE 'Signed PDF delayed:%'").length, 5);
  assert.equal(alerts().filter((a) => a.startsWith('A signed PDF cannot be made')).length, 5);
  // The file is put back from a backup: the daily try makes the PDF, and the sender hears that it is ready.
  flip(stuck[0].src);
  later(86_400_000);
  await env.cronTick();
  assert.ok(finalOf(stuck[0].id).final_sha256);
  assert.equal(db.all("SELECT 1 FROM emails WHERE to_email='jo@timer.example' AND subject=?", 'Signed PDF ready: Stuck 0').length, 1);
});

// ---- 3. QR codes (medium) ------------------------------------------------------------------------------------------

test('a code or a link shown again after a correction, a reassignment or a new role is the link that works now', () => {
  const people = read('src/components/sender/Recipients.tsx');
  const linkFor = people.slice(people.indexOf('const linkFor = async (r: any) => {'), people.indexOf('// The whole name as the sender wrote it.'));
  assert.ok(linkFor.length > 40, 'linkFor is where it was');
  assert.doesNotMatch(linkFor, /if \(links\[r\.id\]\) return/, 'never the link fetched before: it may have been replaced since');
  assert.match(linkFor, /await api\(`\/envelopes\/\$\{e\.id\}\/recipient-view`/);
  // What is on the screen goes when the people on the envelope change: a link under a name, and an open code.
  assert.match(people, /const who = e\.recipients\.map\(\(r: any\) => `\$\{r\.id\}:\$\{r\.email\}:\$\{r\.name\}:\$\{r\.role\}:\$\{r\.phone \|\| ''\}`\)\.join\('\|'\);/);
  assert.match(people, /useEffect\(\(\) => \{\n\s*setLinks\(\{\}\);\n\s*setShown\(''\);\n\s*setQr\(''\);\n\s*\}, \[who\]\);/);
  // The QR dialog only opens after the link was asked for at that moment.
  assert.match(people, /async function showQr\(r: any, from\?: HTMLButtonElement\) \{\n\s*qrFrom\.current = from \|\| null;\n\s*setBusy\(`qr:\$\{r\.id\}`\);\n\s*try \{\n\s*await linkFor\(r\);\n\s*setQr\(r\.id\);/);
});

test('the QR dialog says what the link lets its holder do, for every role a code is shown for, a witness included', async () => {
  const { personScanLine, personCodeWarning } = await import('../src/lib/qrlink.ts');
  const { ROLES } = await import('../src/server/envelopes.ts');
  assert.equal(personScanLine('Will Witness', 'witness'), 'Ask Will Witness to point the camera of their phone at this code and tap the link it shows. The document opens on their own phone, and they read it and witness the signature there.');
  assert.equal(personCodeWarning('Will Witness', 'witness'), 'This code is the link. Whoever scans it, or takes a photo of it, can open the document and witness the signature on it as Will Witness. Show it only to Will Witness, and close this window when they have scanned it.');
  // A role whose link acts (signs, approves, witnesses) never reads as if the link only opened the document.
  const acts: Record<string, RegExp> = { signer: /sign it/, approver: /approve it/, witness: /witness the signature/, inperson: /sign it/ };
  for (const role of ROLES) {
    const w = personCodeWarning('A Person', role);
    if (acts[role] && role !== 'inperson') assert.match(w, acts[role], role);
    if (role === 'viewer' || role === 'cc') assert.match(w, /can open the document as A Person\./, role);
    assert.doesNotMatch(`${w} ${personScanLine('A Person', role)}`, new RegExp(`${DASH}|undefined`), role);
  }
  // In-person signers sign on the sender's own device: no code is offered for them at all.
  assert.match(read('src/components/sender/Recipients.tsx'), /const reachable = turn && !isMe && r\.role !== 'inperson' && !own;/);
});

// ---- 4. When a stored file cannot be read (low) --------------------------------------------------------------------

// The folder holds files under K1 and K2 from the tests above: both listed, so storing goes on.
const both = () => setKeys(K2, [K1]);
async function sentAndSigned(c: Client, email: string, subject: string) {
  const file = await uploadWith(c, subject);
  const e = await envelopeWith(c, file, email, subject);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, email)).status, 200);
  return e;
}

test('a completion email waiting for another try goes out without an attachment that cannot be read, says so, and keeps what went out', async () => {
  both();
  const g = globalThis as any;
  let fails = 0;
  const taken: any[] = [];
  process.env.SMTP_URL = 'smtp://stub.invalid';
  g.__tsmail = { sendMail: async (m: any) => { if (fails-- > 0) throw new Error('mail server down'); taken.push(m); } };
  try {
    const mo = await person('Mo Mail', 'mo@retry.example');
    const cases: [string, () => void][] = [
      ['damaged', () => flip(db.get("SELECT final_sha256 s FROM envelopes WHERE subject='Retry damaged'").s, 120)],
      // Locked: the server is given a key that is not the one the signed PDF was written with.
      // The emails themselves are made readable first (as if written before the key was set): with the key they are
      // sealed too (tests/ds-db-encrypt.test.ts), and this case is about the attachment alone.
      ['locked', () => (db.run("UPDATE emails SET html=col_find(html), payload=col_find(payload) WHERE status='failed'"), setKeys(K3))],
    ];
    for (const [kind, spoil] of cases) {
      both();
      const subject = `Retry ${kind}`;
      fails = 99; // every completion email fails on its first try
      const e = await sentAndSigned(mo, `${kind}@retry.example`, subject);
      const waiting = db.all("SELECT id, payload FROM emails WHERE envelope_id=? AND subject=? AND status='failed'", e.id, `Completed: ${subject}`);
      assert.ok(waiting.length >= 1 && waiting.every((m) => JSON.parse(m.payload).attachments.length === 1), 'they wait with the signed PDF attached');
      spoil();
      fails = 0;
      db.run("UPDATE emails SET next_try_at=? WHERE envelope_id=? AND status='failed'", new Date(Date.now() - 1000).toISOString(), e.id);
      await (await import('../src/server/cron.ts')).tick();
      const after = db.all('SELECT status, html FROM emails WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(waiting.map((m) => m.id)));
      assert.ok(after.every((m) => m.status === 'sent'), `${kind}: they went out (${JSON.stringify(after.map((m) => m.status))})`);
      const out = taken.filter((m) => m.subject === `Completed: ${subject}`);
      assert.equal(out.length, waiting.length);
      for (const m of out) {
        assert.equal(m.attachments.length, 0, 'without the file that could not be read');
        assert.match(m.html, /<\/h1>\n\s*<p [^>]*>We could not attach &quot;Retry [a-z]+\.pdf&quot; to this email: our stored copy could not be read when it went out/, 'at the top');
        assert.match(m.text, /^We could not attach "Retry [a-z]+\.pdf" to this email: our stored copy could not be read when it went out, and the people who run this service have been told\. Use the link in this email instead\./);
      }
      assert.ok(after.every((m) => /We could not attach/.test(m.html)), 'the copy we keep is what went out');
    }
  } finally {
    delete g.__tsmail;
    delete process.env.SMTP_URL;
  }
});

test('the export calls a locked signed PDF locked, not damaged, and names a completed envelope whose signed PDF is not made yet', async () => {
  both();
  const ez = await person('Ez Export', 'ez@export2.example');
  const ok = await sentAndSigned(ez, 'one@export2.example', 'Export locked');
  // One whose signed PDF could not be made.
  const file = await uploadWith(ez, 'Export not made');
  const nm = await envelopeWith(ez, file, 'two@export2.example', 'Export not made');
  assert.equal((await ez.post(`/envelopes/${nm.id}/send`)).status, 200);
  flip(db.get('SELECT sha256 s FROM files WHERE id=?', file.id).s);
  assert.equal((await signAll(nm.id, 'two@export2.example')).status, 200);
  assert.equal(finalOf(nm.id).final_sha256, null);
  setKeys(K3); // the signed PDF of the first is under K2, which this server is not given now
  const res = await ez.get('/export');
  assert.equal(res.status, 200);
  const zip = Buffer.from(res.data);
  const at = zip.indexOf(Buffer.from('README.txt'));
  const readme = zip.subarray(at).toString('utf8');
  assert.match(readme, /1 signed document\(s\) are locked with an encryption key this server was not given, so they are not in this file\. They are not damaged and not lost/);
  assert.ok(readme.includes(`Export locked (envelope ${ok.id})`));
  assert.doesNotMatch(readme, /failed its check/, 'a locked file is not called damaged');
  assert.match(readme, /1 completed document\(s\) have no signed PDF yet, because it could not be made so far/);
  assert.ok(readme.includes(`Export not made (envelope ${nm.id})`));
});

test('a click-to-agree record says the terms could not be read when their PDF fails its check, instead of saying they follow', async () => {
  both();
  const pia = await person('Pia Record', 'pia@record.example');
  const file = await uploadWith(pia, 'Terms of the reading circle. Return the books on time.', 'terms.pdf');
  const made = await pia.post('/clickwraps', { name: 'Reading terms', format: 'pdf', file_id: file.id });
  assert.equal((await pia.post(`/clickwraps/${made.data.id}/publish`, {})).status, 200);
  const slug = (await pia.get(`/clickwraps/${made.data.id}`)).data.agreement.slug;
  const visitor = Object.assign(new Client(), { ip: '198.19.250.1' });
  const page = await visitor.get(`/public/agree/${slug}`);
  const res = await visitor.post(`/public/agree/${slug}/accept`, { view: page.data.view, agree: true, name: 'Rae Reader', email: 'rae@record.example' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const aid = res.data.acceptance.id;
  const { extractText } = await import('../src/server/text.ts');
  const good = await pia.get(`/clickwrap-acceptances/${aid}/certificate`);
  assert.match(await extractText(good.data), /They follow this page, exactly as they were stored/);
  flip(db.get('SELECT sha256 s FROM files WHERE id=?', file.id).s);
  const cert = await pia.get(`/clickwrap-acceptances/${aid}/certificate`);
  assert.equal(cert.status, 200, 'the record itself is still made');
  const t = (await extractText(cert.data)).replace(/\s+/g, ' ');
  assert.doesNotMatch(t, /They follow this page/);
  assert.match(t, /They could not be read from storage when this record was made \(the stored copy failed its check\), so they are not in this file/);
  assert.equal((await PDFDocument.load(cert.data)).getPageCount() < (await PDFDocument.load(good.data)).getPageCount(), true);
});

test('a signed PDF is never sealed without a signer\'s attachment that fails its check: it is made once the file is back', async () => {
  both();
  const al = await person('Al Attach', 'al@attach2.example');
  const file = await uploadWith(al, 'With an attachment');
  const e = (await al.post('/envelopes', {
    subject: 'With an attachment', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sig Ner', email: 'sig@attach2.example' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'a', document_id: 'd', recipient_id: 'r', type: 'attachment', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.06, required: false }],
  })).data.envelope;
  assert.equal((await al.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, 'sig@attach2.example');
  const s = Object.assign(new Client(), { ip: '198.19.251.1' });
  await s.post(`/sign/${tok}/consent`);
  const v = (await s.get(`/sign/${tok}`)).data;
  const f = new FormData();
  const two = await PDFDocument.create();
  two.addPage([300, 300]);
  two.addPage([300, 300]);
  f.append('file', new Blob([await two.save()], { type: 'application/pdf' }), 'passport.pdf');
  const up = await s.call('POST', `/sign/${tok}/upload`, f);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const att = db.get('SELECT sha256 s FROM files WHERE id=?', up.data.id).s;
  flip(att, 200);
  const values: any = {};
  for (const x of v.fields) values[x.id] = x.type === 'attachment' ? up.data.id : '1';
  assert.equal((await s.post(`/sign/${tok}/complete`, { values, signature_png: (await import('./helpers.ts')).PNG })).data.envelope_status, 'completed');
  assert.equal(finalOf(e.id).final_sha256, null, 'not sealed without it');
  assert.equal(finalOf(e.id).final_tries, 1);
  // The file is put back: the timer makes the signed PDF, with the attachment's two pages in it.
  flip(att, 200);
  later(3600_000);
  await env.cronTick();
  const fin = finalOf(e.id).final_sha256;
  assert.ok(fin);
  const pages = (await PDFDocument.load((await al.get(`/envelopes/${e.id}/download`)).data)).getPageCount();
  assert.ok(pages >= 1 + 2 + 1, `document, attachment and certificate: ${pages}`);
});

test('a signer facing a document the server cannot hand over is shown the server\'s words and no download that would fail the same way', async () => {
  const { readServerSaid, STORED_FILE_CODES } = await import('../src/components/viewFailure.ts');
  assert.deepEqual(STORED_FILE_CODES, ['file_damaged', 'file_locked']);
  assert.deepEqual(readServerSaid({ code: 'file_locked', error: 'We could not open this file at the moment.' }), { code: 'file_locked', text: 'We could not open this file at the moment.' });
  assert.equal(readServerSaid({ code: 'not_found', error: 'x' }), null, 'only the two the page knows what to do about');
  assert.equal(readServerSaid(null), null);
  // The server's own answer for both, which the page shows as it is.
  both();
  const lo = await person('Lo Locked', 'lo@locked.example');
  const file = await uploadWith(lo, 'Locked for the signer');
  const e = await envelopeWith(lo, file, 'signer@locked.example', 'Locked for the signer');
  assert.equal((await lo.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, 'signer@locked.example');
  const s = Object.assign(new Client(), { ip: '198.19.252.1' });
  await s.post(`/sign/${tok}/consent`);
  const doc = (await s.get(`/sign/${tok}`)).data.documents[0].id;
  setKeys(K3);
  const r = await s.get(`/sign/${tok}/doc/${doc}`);
  assert.equal(r.status, 503);
  assert.deepEqual(readServerSaid(r.data)?.code, 'file_locked');
  assert.match(readServerSaid(r.data)!.text, /locked with an encryption key this server has not been given/);
  const viewer = read('src/components/PdfDoc.tsx');
  assert.match(viewer, /if \(live && e\?\.name === 'UnexpectedResponseException' && e\?\.status >= 500\)\n\s*serverSaid\(url\)\.then\(\(s\) => live && setSaid\(s\)\);/);
  assert.match(viewer, /failed\(error, \(\) => setAttempt\(\(n\) => n \+ 1\), said\)/);
  const nv = read('src/components/sign/NoViewer.tsx');
  const block = nv.slice(nv.indexOf("if (why === 'file' && said)"), nv.indexOf("if (why === 'file')\n"));
  assert.match(block, /\{said\.text\}/);
  assert.doesNotMatch(block, /download/i, 'no download offered when it would fail the same way');
  assert.match(block, /Try again<\/button>/);
  assert.match(block, /Ask \{sender\}/);
  assert.match(read('src/app/sign/[token]/page.tsx'), /failed=\{\(why, retry, said\) => <NoViewer why=\{why\} retry=\{retry\} said=\{said\}/);
  // The toolbar and the Other actions menu offer the same download: hidden while that notice is up (measured in a
  // browser at 390x844: no visible link to a download, tests/out/repair-qr-encrypt/locked.cjs).
  assert.match(block, /data-stored=\{said\.code\}/);
  assert.match(read('src/app/styles/signphone.css'), /body:has\(\.sg-noview\[data-stored\]\) a\[href\*="\/download"\]:not\(\[href\*="earlier=1"\]\) \{ display: none; \}/);
});

test('every member of a group can be handed their own link as a QR code, asked for at that moment', () => {
  const gm = read('src/components/sender/GroupMembers.tsx');
  assert.match(gm, /<button type="button" className="btn sm qr-tap" disabled=\{!!busy\} onClick=\{\(ev\) => showQr\(m, ev\.currentTarget\)\} aria-haspopup="dialog" aria-label=\{`Show a QR code with the signing link of \$\{m\.name\}`\}>Show QR code<\/button>/);
  assert.match(gm, /await api\(`\/envelopes\/\$\{e\.id\}\/recipient-view`, \{ body: \{ recipient_id: r\.id, member_id: m\.id \} \}\);\n\s*setQr\(\{ m, url \}\);/);
  assert.match(gm, /\{qr && turn && open && <QrDialog recipient=\{\{ name: qr\.m\.name, role: r\.role, status: r\.status, access_code: r\.access_code, verify: r\.verify \}\} link=\{qr\.url\} opener=\{qrFrom\} onClose=\{\(\) => setQr\(null\)\} \/>\}/);
  // Only while the group's turn is on and nobody has taken it on: then every member's own link still works.
  assert.ok(gm.indexOf('Show QR code') > gm.indexOf('{turn && open && ('));
});
