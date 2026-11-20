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
const alerts = () => db.all("SELECT message FROM support_requests WHERE name='Sign&Grow (automatic alert)'").map((r) => r.message as string);
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
  assert.match(on.text, /It does not make such a copy safe by itself, because the database on the same disk is not encrypted/);
  assert.match(on.text, /Their earlier readable copies stay in backups made before that, and can stay in the free space of the disk/);
  assert.doesNotMatch(on.text, /That protects a copy of the disk/);
  const dbOn = notEncryptedPoint();
  for (const h of DATABASE_HOLDS) assert.ok(dbOn.text.includes(h), h);
  assert.match(dbOn.text, /Only the text read from uploaded PDFs for search is kept encrypted there/);
  assert.match(dbOn.text, /So encrypt the disk itself as well\./);
  assert.match(PROCESSING_ENCRYPTED, /and the text read from uploaded PDFs for search are encrypted/);
  setKeys();
  const off = notEncryptedPoint();
  assert.match(off.text, /the text read from every uploaded PDF, kept for search and for the check before sending/);
  assert.match(off.text, /so new files are kept on the disk as they were uploaded and signed\. The software does not encrypt/);
  // Switched off the way the README says (the key moved to the old list): the files stored while it was on stay encrypted.
  setKeys(undefined, [K1]);
  assert.match(notEncryptedPoint().text, /new files are kept on the disk as they were uploaded and signed\. Files stored while it was switched on stay encrypted\./);
  assert.doesNotMatch(notEncryptedPoint().text, /those files are on the disk as they were uploaded/);
  assert.match(processingNotDone(false), /does not encrypt the files it stores now, and it never encrypts the database/);
  for (const t of [on.text, dbOn.text, off.text, databaseText(true), databaseText(false), PROCESSING_ENCRYPTED, processingNotDone(true), processingNotDone(false), ...DATABASE_HOLDS])
    assert.doesNotMatch(t, /—|bank-grade|military|fully secure|unbreakable|compliant|is valid|will hold up/i);
  // Both pages print the list, whatever the setting.
  const processing = read('src/app/security/processing/page.tsx');
  assert.match(processing, /<li>\{databaseText\(\)\}<\/li>/);
  assert.match(processing, /\{processingNotDone\(\)\}/);
  assert.match(read('src/app/security/page.tsx'), /<Point title=\{notEncrypted\.title\}>\{notEncrypted\.text\}<\/Point>/);
});
