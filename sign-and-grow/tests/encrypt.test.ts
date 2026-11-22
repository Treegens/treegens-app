// Encryption of stored files by the app itself (FILE_ENCRYPTION_KEY): the format, the check on every read, the stop
// when the key does not fit the files that are there, changing the key, the script that encrypts what was stored
// before, and the whole product run with a key set. Then what the pages and the README say about it.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { boot, Client, PNG, signUp, simple, upload, tokenFor, signAll, type Server } from './helpers.ts';
import { storeFile, readStored, storeState, fileStoreWarning } from '../src/server/filestore.ts';
import { MAGIC, HEADER_BYTES, keyIdOf, sealFile, fileKeys, readHeader } from '../src/server/filecrypt.ts';
import { decodeFileKey, fileEncryptionOn, encryptedFilesPoint, notEncryptedPoint, PROCESSING_ENCRYPTED, NEW_FILE_KEY_COMMAND } from '../src/lib/storedfiles.ts';
import { HttpError } from '../src/server/util.ts';
// @ts-ignore: a plain JavaScript script, run by node
import { encryptFiles, report } from '../scripts/encrypt-files.mjs';

let db: Server['db'];
let env: Server['env'];
before(async () => {
  ({ db, env } = await boot());
});

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const newKey = () => crypto.randomBytes(32).toString('base64');
const K1 = newKey(), K2 = newKey(), K3 = newKey();
const id1 = keyIdOf(decodeFileKey(K1)!), id2 = keyIdOf(decodeFileKey(K2)!), id3 = keyIdOf(decodeFileKey(K3)!);
const setKeys = (current?: string, old: string[] = []) => {
  if (current === undefined) delete process.env.FILE_ENCRYPTION_KEY;
  else process.env.FILE_ENCRYPTION_KEY = current;
  if (old.length) process.env.FILE_ENCRYPTION_KEYS_OLD = old.join(',');
  else delete process.env.FILE_ENCRYPTION_KEYS_OLD;
};
afterEach(() => setKeys());
const made: string[] = [];
const folder = () => (made.push(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-encrypt-'))), made[made.length - 1]);
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const bytes = (text: string) => Buffer.from(`%PDF-1.7 ${text} ${crypto.randomBytes(8).toString('hex')}`);
const refused = (fn: () => any): HttpError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  assert.fail('expected a refusal');
};
const flip = (file: string, at: number) => {
  const b = fs.readFileSync(file);
  b[at < 0 ? b.length + at : at] ^= 0x01;
  fs.writeFileSync(file, b);
};
const tick = () => new Promise((r) => setImmediate(r));
const alerts = () => db.all("SELECT message FROM support_requests WHERE name='GrowSigning (automatic alert)'").map((r) => r.message as string);
const blobs = () => path.join(process.env.DATA_DIR!, 'blobs');
let ipn = 10;
const person = (name: string, email: string) => signUp(name, email, `198.18.${ipn}.${ipn++}`);
async function pdf(words: string) {
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText(`${words} ${Math.random()}`, { x: 72, y: 700 });
  return d.save();
}
async function pdfForm(words: string, name = 'file.pdf') {
  const f = new FormData();
  f.append('file', new Blob([await pdf(words)], { type: 'application/pdf' }), name);
  return f;
}
// The entries of a ZIP the export made (stored, not compressed).
function unzip(z: Uint8Array): Record<string, Buffer> {
  const b = Buffer.from(z);
  const out: Record<string, Buffer> = {};
  for (let i = 0; b.readUInt32LE(i) === 0x04034b50;) {
    const size = b.readUInt32LE(i + 18), nameLen = b.readUInt16LE(i + 26), extra = b.readUInt16LE(i + 28);
    const name = b.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    out[name] = b.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    i += 30 + nameLen + extra + size;
  }
  return out;
}

// ---- The format and the check -----------------------------------------------------------------------------------

test('with no key a file is stored as it is and read back as before, and every read is checked against its name', () => {
  const dir = folder();
  const b = bytes('plain');
  const name = storeFile(dir, b);
  assert.equal(name, sha(b), 'named by the fingerprint of what it holds, as always');
  assert.deepEqual(fs.readFileSync(path.join(dir, name)), b, 'on the disk exactly as it was given');
  assert.deepEqual(readStored(dir, name), b);
  assert.equal(storeFile(dir, b), name, 'the same file stored twice is one file');
  assert.deepEqual(fs.readdirSync(dir), [name], 'and nothing else is left in the folder');
  // A plain file that changed on the disk is refused, never handed out.
  flip(path.join(dir, name), 12);
  const e = refused(() => readStored(dir, name, true));
  assert.equal(e.status, 500);
  assert.equal(e.data?.code, 'file_damaged');
  assert.match(e.message, /failed its check, which means it was damaged or changed on the disk\. It was not shown/);
  // And storing the good copy again puts it right.
  assert.equal(storeFile(dir, b), name);
  assert.deepEqual(readStored(dir, name), b);
  const gone = refused(() => readStored(dir, sha(Buffer.from('never stored')), true));
  assert.equal(gone.status, 500);
  assert.match(gone.message, /We could not find this file on our server/);
});

test('with a key a file is encrypted under a header that says the format and the key, and reads back as it was', () => {
  setKeys(K1);
  const dir = folder();
  const b = bytes('secret contract wording');
  const name = storeFile(dir, b);
  assert.equal(name, sha(b), 'the name stays the fingerprint of the readable contents');
  const raw = fs.readFileSync(path.join(dir, name));
  assert.deepEqual(raw.subarray(0, 4), MAGIC);
  assert.equal(raw[4], 1, 'format version 1');
  assert.equal(raw.subarray(5, 13).toString('hex'), id1, 'the id of the key that wrote it');
  assert.ok(!raw.includes(Buffer.from('secret contract wording')) && !raw.includes(Buffer.from('%PDF')), 'nothing readable on the disk');
  assert.equal(raw.length, b.length + HEADER_BYTES + 16, 'a small header and the check at the end');
  assert.deepEqual(readStored(dir, name), b);
  // Stored again: left as it is, not written a second time.
  const before = fs.statSync(path.join(dir, name));
  assert.equal(storeFile(dir, b), name);
  assert.equal(fs.statSync(path.join(dir, name)).mtimeMs, before.mtimeMs);
  // Every file has a key of its own: the same contents sealed twice come out different, and neither key id nor
  // anything else in the header says anything about the server's key.
  const k = fileKeys().current!;
  assert.notDeepEqual(sealFile(b, name, k), sealFile(b, name, k));
  assert.ok(!raw.includes(decodeFileKey(K1)!.subarray(0, 8)));
  assert.equal(fileEncryptionOn(), true);
});

test('files written before the key was set stay readable beside new encrypted ones, and are left as they are', () => {
  const dir = folder();
  const old = bytes('written before');
  const a = storeFile(dir, old);
  setKeys(K1);
  const b = storeFile(dir, bytes('written after'));
  assert.deepEqual(fs.readFileSync(path.join(dir, a)), old, 'the old file is untouched');
  assert.equal((readHeader(fs.readFileSync(path.join(dir, b)).subarray(0, HEADER_BYTES)) as any).keyId, id1, 'the new one is encrypted');
  assert.deepEqual(readStored(dir, a), old);
  assert.equal(readStored(dir, b).subarray(0, 4).toString(), '%PDF');
  assert.equal(storeState(dir, true).stop, null);
  assert.deepEqual(storeState(dir).scan.byKey, { [id1]: 1 });
  assert.equal(storeState(dir).scan.plain, 1);
});

test('a changed byte anywhere, a file cut short, or a file under another name is refused and reported, never served', async () => {
  setKeys(K1);
  const dir = folder();
  const good = bytes('the real document');
  const name = storeFile(dir, good);
  const file = path.join(dir, name);
  const sealed = fs.readFileSync(file);
  const cases: [string, (f: string) => void][] = [
    ['a byte of the contents', (f) => flip(f, HEADER_BYTES + 3)],
    ['a byte of the check at the end', (f) => flip(f, -1)],
    ['a byte of the salt', (f) => flip(f, 20)],
    ['a byte of the key id', (f) => flip(f, 6)],
    ['the version', (f) => flip(f, 4)],
    ['cut short by ten bytes', (f) => fs.writeFileSync(f, sealed.subarray(0, sealed.length - 10))],
    ['cut short inside the header', (f) => fs.writeFileSync(f, sealed.subarray(0, 30))],
    ['empty', (f) => fs.writeFileSync(f, '')],
  ];
  for (const [what, damage] of cases) {
    fs.writeFileSync(file, sealed);
    damage(file);
    const e = refused(() => readStored(dir, name, true));
    assert.equal(e.data?.code, 'file_damaged', what);
    assert.equal(e.status, 500, what);
  }
  // A whole encrypted file copied under the name of another one fails too: the name is part of what is checked.
  fs.writeFileSync(file, sealed);
  const other = storeFile(dir, bytes('another document'));
  fs.copyFileSync(file, path.join(dir, other));
  assert.equal(refused(() => readStored(dir, other, true)).data?.code, 'file_damaged');
  // Reported once to the people who run the server, however often it is asked for.
  const before = alerts().length;
  for (let i = 0; i < 3; i++) refused(() => readStored(dir, other));
  await tick();
  const filed = alerts().slice(before);
  assert.equal(filed.length, 1);
  assert.match(filed[0], new RegExp(`A stored file could not be read \\(damaged\\)[\\s\\S]*${other}[\\s\\S]*Put it back from a backup`));
  assert.ok(!filed[0].includes(K1), 'never the key');
  // With an address to tell, it is emailed too.
  process.env.SUPPORT_EMAIL = 'files-help@crypt.example';
  try {
    refused(() => readStored(dir, other)); // reported above already
    fs.writeFileSync(file, Buffer.alloc(0));
    refused(() => readStored(dir, name)); // newly damaged
    await new Promise((r) => setTimeout(r, 300));
    const mails = db.all("SELECT subject FROM emails WHERE to_email='files-help@crypt.example'").map((m) => m.subject);
    assert.deepEqual(mails, ['A stored file could not be read (damaged)'], 'one email for the newly damaged file, none again for the one already reported');
  } finally {
    delete process.env.SUPPORT_EMAIL;
    fs.writeFileSync(file, sealed);
  }
  // A damaged header does not stop the server from storing files: that is one bad file, not a wrong key.
  fs.writeFileSync(file, sealed.subarray(0, 30));
  const st = storeState(dir, true);
  assert.equal(st.stop, null);
  assert.deepEqual(st.scan.damaged, [name]);
  assert.match(fileStoreWarning(dir)!, /a damaged header and cannot be read/);
  // And storing the good copy again repairs it.
  assert.equal(storeFile(dir, good), name);
  assert.deepEqual(readStored(dir, name), good);
});

test('an uploaded file that only looks like an encrypted one is just that file, and stops nothing', () => {
  // Anyone can upload any bytes. These start with our header, a valid header check and a key nobody has.
  const head = Buffer.concat([MAGIC, Buffer.from([1]), crypto.randomBytes(8), crypto.randomBytes(16), crypto.randomBytes(12)]);
  const trick = Buffer.concat([head, crypto.createHash('sha256').update(head).digest().subarray(0, 4), crypto.randomBytes(200)]);
  const dir = folder();
  const name = storeFile(dir, trick);
  assert.deepEqual(readStored(dir, name), trick);
  const st = storeState(dir, true);
  assert.equal(st.stop, null, 'one upload cannot stop every upload after it');
  assert.equal(st.scan.plain, 1);
  setKeys(K1);
  const again = storeFile(folder(), trick);
  assert.equal(again, name);
});

// ---- Mistakes with the key ---------------------------------------------------------------------------------------

test('a server started with a key that cannot read the files there says so loudly and stores nothing new until the old key is listed', async () => {
  setKeys(K1);
  const dir = folder();
  const kept = bytes('written with the first key');
  const name = storeFile(dir, kept);
  // Someone made a new key instead of copying the old one.
  setKeys(K2);
  const warning = fileStoreWarning(dir)!;
  assert.match(warning, /STORING FILES IS STOPPED\. 1 stored file was encrypted with a key this server does not have/);
  assert.ok(warning.includes(`key id ${id1}: 1 file`) && warning.includes(`key id ${id2}`), 'the key ids, so the right key can be found');
  assert.match(warning, /Nothing was changed and those files are still on the disk\. No new file is stored until the key they were written with is set again: add it to FILE_ENCRYPTION_KEYS_OLD/);
  assert.ok(!warning.includes(K1) && !warning.includes(K2), 'never a key itself');
  const locked = refused(() => readStored(dir, name, true));
  assert.deepEqual([locked.status, locked.data?.code], [503, 'file_locked']);
  assert.match(locked.message, /locked with an encryption key this server has not been given\. The file is still there and nothing was changed/);
  const files = fs.readdirSync(dir);
  const stop = refused(() => storeFile(dir, bytes('a new upload')));
  assert.deepEqual([stop.status, stop.data?.code], [503, 'storage_stopped']);
  assert.match(stop.message, /We cannot store files at the moment, so nothing was saved\./);
  assert.ok(!/key id|FILE_ENCRYPTION/.test(stop.message), 'a person is not given settings to fix');
  assert.deepEqual(fs.readdirSync(dir), files, 'nothing was written with the wrong key');
  assert.deepEqual(fs.readFileSync(path.join(dir, name)).subarray(5, 13).toString('hex'), id1, 'and the old file was not touched');
  await tick();
  assert.ok(alerts().some((a) => a.startsWith('Storing files is stopped: the encryption key cannot read the files that are there')));
  // The key left out altogether, after a move: the same stop.
  setKeys();
  assert.match(fileStoreWarning(dir)!, /It has no key at all: FILE_ENCRYPTION_KEY is not set\./);
  assert.equal(refused(() => storeFile(dir, bytes('x'))).data?.code, 'storage_stopped');
  // Listing the old key puts everything right: it reads, and new files are written with the new key.
  setKeys(K2, [K1]);
  assert.equal(fileStoreWarning(dir), null);
  assert.deepEqual(readStored(dir, name), kept);
  const fresh = storeFile(dir, bytes('after the fix'));
  assert.equal(fs.readFileSync(path.join(dir, fresh)).subarray(5, 13).toString('hex'), id2);
  // A file under a key nobody listed that turns up after the start (put back from a backup) stops storing from then on.
  setKeys(K3);
  const elsewhere = folder();
  const strayName = storeFile(elsewhere, bytes('from another server'));
  setKeys(K2, [K1]);
  assert.equal(storeState(dir).stop, null);
  fs.copyFileSync(path.join(elsewhere, strayName), path.join(dir, strayName));
  assert.equal(refused(() => readStored(dir, strayName, true)).data?.code, 'file_locked');
  assert.ok(storeState(dir).stop!.includes(`key id ${id3}: 1 file`));
  assert.equal(refused(() => storeFile(dir, bytes('y'))).data?.code, 'storage_stopped');
  // That key is lost for good. The warning says what to do, and doing it lets the server store files again.
  assert.match(fileStoreWarning(dir)!, /If that key is lost for good, nobody can read those files again: move them out of the folder \(keep them, in case the key turns up\) and restart/);
  fs.renameSync(path.join(dir, strayName), path.join(elsewhere, `kept-${strayName}`));
  assert.equal(storeState(dir, true).stop, null);
  assert.ok(storeFile(dir, bytes('stored again')));
});

test('a FILE_ENCRYPTION_KEY that is not a key stops storing files and says how to make one, and the pages never claim encryption', async () => {
  const dir = folder();
  storeFile(dir, bytes('before'));
  for (const bad of ['change-me', K1.slice(0, -2), crypto.randomBytes(32).toString('hex'), crypto.randomBytes(16).toString('base64'), `${K1.slice(0, 10)}!${K1.slice(11)}`]) {
    setKeys(bad);
    assert.equal(decodeFileKey(bad), null, bad);
    assert.equal(fileKeys().badCurrent, true);
    assert.equal(fileEncryptionOn(), false, 'a page does not say files are encrypted');
    const w = fileStoreWarning(dir)!;
    assert.match(w, /STORING FILES IS STOPPED\. FILE_ENCRYPTION_KEY is set but is not a key/);
    assert.ok(w.includes(NEW_FILE_KEY_COMMAND));
    assert.ok(!w.includes(bad), 'the wrong value is not printed either');
    assert.equal(refused(() => storeFile(dir, bytes('new'))).data?.code, 'storage_stopped', 'never stored as it is while the operator believes it is encrypted');
  }
  await tick();
  assert.ok(alerts().some((a) => a.startsWith('Storing files is stopped: FILE_ENCRYPTION_KEY is not a key') && !a.includes('change-me')), 'filed for the people who run the server, without the value');
  // Both ways of writing base64 are keys, and a key with spaces around it is the same key.
  const raw = crypto.randomBytes(32);
  assert.deepEqual(decodeFileKey(raw.toString('base64url')), raw);
  assert.deepEqual(decodeFileKey(` ${raw.toString('base64')}\n`), raw);
  // An old key that is not a key is named in the log; it stops nothing by itself.
  setKeys(K1, ['oops', K2]);
  const k = fileKeys();
  assert.deepEqual([...k.byId.keys()].sort(), [id1, id2].sort());
  assert.match(k.problems[0], /Entry 1 of the 2 in FILE_ENCRYPTION_KEYS_OLD is not a key/);
  assert.equal(storeState(dir, true).stop, null);
  assert.match(fileStoreWarning(dir)!, /STORED FILES NEED A LOOK/);
});

// ---- The script ---------------------------------------------------------------------------------------------------

const envOf = (current?: string, old: string[] = []) => ({ FILE_ENCRYPTION_KEY: current, FILE_ENCRYPTION_KEYS_OLD: old.join(',') });
const keyOn = (dir: string, name: string) => (readHeader(fs.readFileSync(path.join(dir, name)).subarray(0, HEADER_BYTES)) as any)?.keyId ?? 'plain';
// Puts a file in a folder as a server with that key would have written it, whatever else is in the folder.
const storeWith = (dir: string, key: string | undefined, b: Buffer) => {
  const n = sha(b);
  fs.writeFileSync(path.join(dir, n), key ? sealFile(b, n, fileKeys({ FILE_ENCRYPTION_KEY: key }).current!) : b);
  return n;
};

test('the script encrypts a folder with every kind of file, leaves what it cannot read alone, and a second run finds nothing to do', () => {
  const dir = folder();
  const want: Record<string, Buffer> = {};
  const put = (key: string | undefined, label: string) => {
    const b = bytes(label);
    const n = storeWith(dir, key, b);
    want[n] = b;
    return n;
  };
  const p1 = put(undefined, 'plain one'), p2 = put(undefined, 'plain two');
  const c1 = put(K2, 'already current');
  const o1 = put(K1, 'old key');
  const u1 = put(K3, 'key nobody listed');
  const d1 = put(K2, 'damaged encrypted');
  flip(path.join(dir, d1), HEADER_BYTES + 1);
  const d2 = put(undefined, 'damaged plain');
  flip(path.join(dir, d2), 2);
  const untouched = Object.fromEntries([u1, d1, d2].map((n) => [n, fs.readFileSync(path.join(dir, n))]));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'someone left this here');
  const ownLeft = `.${p1}.e4242-aaaaaaaaaaaa`;
  fs.writeFileSync(path.join(dir, ownLeft), 'half written');
  const serverOld = `.${p2}.w4243-bbbbbbbbbbbb`, serverNew = `.${p2}.w4244-cccccccccccc`;
  fs.writeFileSync(path.join(dir, serverOld), 'crashed long ago');
  fs.utimesSync(path.join(dir, serverOld), new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
  fs.writeFileSync(path.join(dir, serverNew), 'being written right now');

  const check = encryptFiles({ dir, env: envOf(K2, [K1]), check: true });
  assert.deepEqual([check.wouldEncrypt, check.wouldReencrypt, check.already], [2, 1, 1]);
  assert.equal(keyOn(dir, p1), 'plain', '--check changes nothing');
  assert.ok(fs.existsSync(path.join(dir, ownLeft)));

  const r = encryptFiles({ dir, env: envOf(K2, [K1]) });
  assert.deepEqual([r.encrypted, r.reencrypted, r.already, r.leftovers], [2, 1, 1, 2]);
  assert.deepEqual(r.unknown, [{ name: u1, keyId: id3 }]);
  assert.deepEqual(r.damaged.sort(), [d1, d2].sort());
  assert.deepEqual(r.other, ['notes.txt']);
  for (const n of [p1, p2, c1, o1]) assert.equal(keyOn(dir, n), id2, 'everything readable is now under the current key');
  for (const [n, b] of Object.entries(untouched)) assert.deepEqual(fs.readFileSync(path.join(dir, n)), b, 'what it cannot read is left exactly as it was');
  assert.ok(!fs.existsSync(path.join(dir, ownLeft)) && !fs.existsSync(path.join(dir, serverOld)), 'half-written copies are cleared');
  assert.ok(fs.existsSync(path.join(dir, serverNew)), 'but not one the server may be writing now');
  assert.ok(!fs.existsSync(path.join(dir, '.encrypt-files.lock')));
  setKeys(K2, [K1]);
  for (const n of [p1, p2, c1, o1]) assert.deepEqual(readStored(dir, n), want[n]);
  const said = report(r);
  assert.equal(said.ok, false, 'it does not say it is done while files need a look');
  const text = said.lines.join('\n');
  assert.match(text, /Encrypted now: 2\. Moved from an old key to the current one: 1\. Already done before: 1\./);
  assert.match(text, new RegExp(`encrypted with a key that is not in the settings \\(key id ${id3}: 1\\)\\. They were left as they are\\. Add that key to FILE_ENCRYPTION_KEYS_OLD`));
  assert.match(text, /2 files fail its check and cannot be read with any key: .*Put them back from a backup\./);
  assert.ok(![K1, K2, K3].some((k) => text.includes(k)), 'no key is ever printed');
  assert.doesNotMatch(text, /\u2014/);

  const again = encryptFiles({ dir, env: envOf(K2, [K1]) });
  assert.deepEqual([again.encrypted, again.reencrypted, again.already, again.leftovers], [0, 0, 4, 0], 'run again, it skips what is done');
  // With the missing key listed and the damaged files put back, it is done.
  for (const n of [d1, d2]) fs.writeFileSync(path.join(dir, n), want[n]);
  const done = encryptFiles({ dir, env: envOf(K2, [K1, K3]) });
  assert.deepEqual([done.encrypted, done.reencrypted, done.already, done.damaged.length], [2, 1, 4, 0]);
  fs.rmSync(path.join(dir, 'notes.txt'));
  assert.equal(report(encryptFiles({ dir, env: envOf(K2) })).ok, true);
  assert.match(report(encryptFiles({ dir, env: envOf(K2) })).lines.join(' '), /Every stored file is now encrypted with the current key\./);
});

test('the script can be stopped at any point and run again, and never loses a file', () => {
  const dir = folder();
  const want: Record<string, Buffer> = {};
  for (let i = 0; i < 5; i++) {
    const b = bytes(`file ${i}`);
    want[storeWith(dir, undefined, b)] = b;
  }
  const names = Object.keys(want).sort();
  const intact = () => {
    setKeys(K1);
    for (const n of names) assert.deepEqual(readStored(dir, n), want[n], n);
    setKeys();
  };
  // Stopped after the third encrypted copy is on the disk, before it takes the name: a crash, as far as the folder can tell.
  let n = 0;
  assert.throws(() => encryptFiles({ dir, env: envOf(K1), onStep: (step: string) => { if (step === 'written' && ++n === 3) throw new Error('power cut'); } }), /power cut/);
  assert.deepEqual(names.map((x) => keyOn(dir, x)), [id1, id1, 'plain', 'plain', 'plain']);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith(`.${names[2]}.e`)).length, 1, 'the half-done copy is still there, beside the untouched original');
  assert.ok(!fs.existsSync(path.join(dir, '.encrypt-files.lock')), 'and the next run is not locked out');
  intact();
  // Stopped after the copy was read back and checked, just before the swap.
  assert.throws(() => encryptFiles({ dir, env: envOf(K1), onStep: (step: string) => { if (step === 'checked') throw new Error('killed'); } }), /killed/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.')).map((f) => f.slice(1, 65)), [names[2]], 'the first run\'s leftover was cleared, and this run left one of its own');
  intact();
  const r = encryptFiles({ dir, env: envOf(K1) });
  assert.deepEqual([r.encrypted, r.already, r.leftovers], [3, 2, 1]);
  assert.deepEqual(fs.readdirSync(dir).sort(), names, 'nothing half done is left');
  intact();
});

test('the script keeps the original when the copy does not read back, leaves a file the server deleted meanwhile deleted, and runs one at a time', () => {
  const dir = folder();
  const a = bytes('copy goes bad'), b = bytes('deleted meanwhile');
  const na = storeWith(dir, undefined, a), nb = storeWith(dir, undefined, b);
  const r = encryptFiles({
    dir, env: envOf(K1),
    onStep: (step: string, name: string) => {
      if (step === 'written' && name === na) for (const f of fs.readdirSync(dir).filter((f) => f.startsWith(`.${na}.e`))) flip(path.join(dir, f), -3);
      if (step === 'checked' && name === nb) fs.rmSync(path.join(dir, nb));
    },
  });
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].why, /did not read back the same, so the original was kept/);
  assert.deepEqual(fs.readFileSync(path.join(dir, na)), a);
  assert.equal(r.gone, 1);
  assert.ok(!fs.existsSync(path.join(dir, nb)), 'a file nothing points at any more does not come back');
  assert.deepEqual(fs.readdirSync(dir), [na]);
  // Another run going: refused. A lock left by a run that was killed: taken over.
  fs.writeFileSync(path.join(dir, '.encrypt-files.lock'), String(process.ppid));
  assert.throws(() => encryptFiles({ dir, env: envOf(K1) }), /Another run of this script is going/);
  fs.writeFileSync(path.join(dir, '.encrypt-files.lock'), '2147480000');
  assert.equal(encryptFiles({ dir, env: envOf(K1) }).encrypted, 1);
  assert.ok(!fs.existsSync(path.join(dir, '.encrypt-files.lock')));
});

test('the script from the command line: a new key, --check, the settings from DATA_DIR, and exit codes', () => {
  const data = folder();
  const dir = path.join(data, 'blobs');
  fs.mkdirSync(dir);
  const b = bytes('on the command line');
  const name = storeWith(dir, undefined, b);
  const cwd = folder(); // no .env.local of this checkout gets in the way
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/encrypt-files.mjs'), ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, DATA_DIR: data, ...extra } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const made = run(['--new-key']);
  assert.equal(made.code, 0);
  const key = made.out.split('\n')[0].trim();
  assert.ok(decodeFileKey(key), 'prints a key the server accepts');
  assert.match(made.out, /Keep a copy somewhere safe and apart from the server and its backups/);
  const none = run([]);
  assert.equal(none.code, 2);
  assert.match(none.out, /FILE_ENCRYPTION_KEY is not set, so there is no key to encrypt with\.\nNothing was changed\./);
  const look = run(['--check'], { FILE_ENCRYPTION_KEY: key });
  assert.equal(look.code, 0, look.out);
  assert.match(look.out, /1 file is not encrypted and would be encrypted by a run without --check\./);
  assert.equal(keyOn(dir, name), 'plain');
  const go = run([], { FILE_ENCRYPTION_KEY: key });
  assert.equal(go.code, 0, go.out);
  assert.match(go.out, /Encrypted now: 1\./);
  assert.equal(keyOn(dir, name), keyIdOf(decodeFileKey(key)!));
  // The settings read from .env.local in the folder it is started in, as the server reads them.
  fs.writeFileSync(path.join(cwd, '.env.local'), `FILE_ENCRYPTION_KEY=${K2}\nFILE_ENCRYPTION_KEYS_OLD=${key}\n`);
  const moved = run([]);
  assert.equal(moved.code, 0, moved.out);
  assert.match(moved.out, /Moved from an old key to the current one: 1\./);
  fs.rmSync(path.join(cwd, '.env.local'));
  const lost = run(['--check'], { FILE_ENCRYPTION_KEY: K3 });
  assert.equal(lost.code, 1, 'a file it has no key for is not "done"');
  assert.doesNotMatch(lost.out, new RegExp(K3.replace(/[+/=]/g, '.')));
  assert.equal(run(['--everything']).code, 2);
});

// ---- The whole product with a key set --------------------------------------------------------------------------------

const PW = 'correct horse battery';
const onDisk = (s: string) => fs.readFileSync(path.join(blobs(), s));
const encryptedOnDisk = (s: string, kid = id1) => {
  const raw = onDisk(s);
  return MAGIC.equals(raw.subarray(0, 4)) && raw.subarray(5, 13).toString('hex') === kid && !raw.includes(Buffer.from('%PDF'));
};
async function withAttachment(c: Client, signer: string, subject: string) {
  const file = (await c.call('POST', '/files', await pdfForm('Unique contract', 'Unique.pdf'))).data;
  const e = (await c.post('/envelopes', {
    subject, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sig Ner', email: signer }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'a', document_id: 'd', recipient_id: 'r', type: 'attachment', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.06, required: false }],
  })).data.envelope;
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  return { file, e };
}

test('a whole send, sign, download, verify, export and delete with the key set: every reader of files works, and the disk shows nothing', async () => {
  setKeys(K1);
  const jo = await person('Jo Crypt', 'jo@crypt.example');
  const { file, e } = await withAttachment(jo, 'sig@crypt.example', 'Encrypted agreement');
  const src = db.get('SELECT sha256 s FROM files WHERE id=?', file.id).s;
  assert.ok(encryptedOnDisk(src), 'the upload is encrypted on the disk');
  const shown = (await jo.get(`/files/${file.id}/content`)).data as Uint8Array;
  assert.equal(sha(shown), src, 'and the editor gets the document back as it was uploaded');
  // The signer opens it, attaches a file of their own and signs.
  const tok = tokenFor(e.id, 'sig@crypt.example');
  const s = Object.assign(new Client(), { ip: '198.18.200.1' });
  await s.post(`/sign/${tok}/consent`);
  const v = (await s.get(`/sign/${tok}`)).data;
  assert.equal(sha((await s.get(`/sign/${tok}/doc/${v.documents[0].id}`)).data), src);
  const up = await s.call('POST', `/sign/${tok}/upload`, await pdfForm('Passport scan', 'passport.pdf'));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const att = db.get('SELECT sha256 s FROM files WHERE id=?', up.data.id).s;
  assert.ok(encryptedOnDisk(att), 'the signer\'s attachment too');
  const values: any = {};
  for (const x of v.fields) values[x.id] = x.type === 'attachment' ? up.data.id : '1';
  assert.equal((await s.post(`/sign/${tok}/complete`, { values, signature_png: PNG })).data.envelope_status, 'completed');
  const fin = db.get('SELECT final_sha256 s FROM envelopes WHERE id=?', e.id).s;
  assert.ok(fin && encryptedOnDisk(fin), 'and the signed PDF, which takes the attachment in from the disk');
  // Every way out gives the same signed file, and /verify recognises it.
  const dl = (await jo.get(`/envelopes/${e.id}/download`)).data as Uint8Array;
  assert.equal(sha(dl), fin);
  assert.equal(Buffer.from(dl.subarray(0, 5)).toString(), '%PDF-');
  assert.equal(sha((await s.get(`/sign/${tok}/download`)).data), fin);
  const f = new FormData();
  f.append('file', new Blob([dl], { type: 'application/pdf' }), 'signed.pdf');
  assert.equal((await new Client().call('POST', '/public/verify', f)).data.match, true);
  const zip = unzip((await jo.get('/export')).data);
  const signed = Object.keys(zip).filter((n) => n.startsWith('signed/'));
  assert.equal(signed.length, 1);
  assert.equal(sha(zip[signed[0]]), fin, 'the export carries the readable signed PDF');
  // Without the key the bytes on the disk are nothing anyone can read, and the app says so instead of serving them.
  setKeys();
  const locked = await jo.get(`/envelopes/${e.id}/download`);
  assert.equal(locked.status, 503);
  assert.match(locked.data.error, /locked with an encryption key this server has not been given/);
  setKeys(K1);
  // Deleting the account takes every one of those files off the disk.
  assert.equal((await jo.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
  for (const x of [src, att, fin]) assert.equal(fs.existsSync(path.join(blobs(), x)), false, x);
});

test('with the key set and a mail server, the signed PDF attached to the completion email is the readable one', async () => {
  setKeys(K1);
  const g = globalThis as any;
  const taken: any[] = [];
  process.env.SMTP_URL = 'smtp://stub.invalid';
  g.__tsmail = { sendMail: async (m: any) => void taken.push(m) };
  try {
    const ama = await person('Ama Mail', 'ama@crypt.example');
    const e = await simple(ama, 'mailed@crypt.example', { subject: 'Mailed encrypted' });
    assert.equal((await ama.post(`/envelopes/${e.id}/send`)).status, 200);
    assert.equal((await signAll(e.id, 'mailed@crypt.example')).status, 200);
    const fin = db.get('SELECT final_sha256 s FROM envelopes WHERE id=?', e.id).s;
    const sent = taken.filter((m) => m.subject === 'Completed: Mailed encrypted');
    assert.ok(sent.length >= 1);
    for (const m of sent) assert.equal(sha(m.attachments[0].content), fin);
    assert.ok(encryptedOnDisk(fin));
  } finally {
    delete g.__tsmail;
    delete process.env.SMTP_URL;
  }
});

test('while storing is stopped, uploads are refused in words, a correction that needs a new signature waits, and signing finishes with its PDF made once the key is back', async () => {
  setKeys(K1);
  const ann = await person('Ann Stop', 'ann@crypt.example');
  const file = await upload(ann, 1);
  const body = {
    subject: 'Two in order', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r1', role: 'signer', name: 'First Person', email: 'first@crypt.example', routing_order: 1 }, { id: 'r2', role: 'signer', name: 'Second Person', email: 'second@crypt.example', routing_order: 2 }],
    fields: [{ id: 'f1', document_id: 'd', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 }, { id: 'f2', document_id: 'd', recipient_id: 'r2', type: 'signature', page: 0, x: 0.5, y: 0.8, w: 0.25, h: 0.06 }],
  };
  const e = (await ann.post('/envelopes', body)).data.envelope;
  assert.equal((await ann.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'first@crypt.example')).status, 200);
  // The operator set a new key in place of the old one.
  setKeys(K2);
  const filesBefore = db.get('SELECT COUNT(*) n FROM files').n;
  const up = await ann.call('POST', '/files', await pdfForm('New upload'));
  assert.equal(up.status, 503);
  assert.equal(up.data.code, 'storage_stopped');
  assert.match(up.data.error, /^We cannot store files at the moment, so nothing was saved\./);
  const tok2 = tokenFor(e.id, 'second@crypt.example');
  const signer = Object.assign(new Client(), { ip: '198.18.201.1' });
  await signer.post(`/sign/${tok2}/consent`);
  assert.equal((await signer.call('POST', `/sign/${tok2}/upload`, await pdfForm('Attachment'))).status, 503);
  assert.equal(db.get('SELECT COUNT(*) n FROM files').n, filesBefore, 'nothing was stored');
  // A change that asks the first person to sign again would lose the copy of what they signed: it waits.
  const cur = (await ann.get(`/envelopes/${e.id}`)).data.envelope;
  const changed = { subject: cur.subject, message: cur.message, ordered: cur.ordered, documents: cur.documents, recipients: cur.recipients, fields: [...cur.fields, { id: 'note', document_id: cur.documents[0].id, recipient_id: cur.recipients.find((r: any) => r.email === 'second@crypt.example').id, type: 'text', readonly: true, required: false, value: 'A new line', page: 0, x: 0.1, y: 0.5, w: 0.5, h: 0.03 }], resign: true };
  const corr = await ann.put(`/envelopes/${e.id}`, changed);
  assert.equal(corr.status, 503, JSON.stringify(corr.data));
  assert.equal(corr.data.code, 'storage_stopped');
  assert.equal(db.get("SELECT status FROM recipients WHERE envelope_id=? AND email='first@crypt.example'", e.id).status, 'completed', 'nothing of the correction was saved');
  assert.equal(db.get("SELECT COUNT(*) n FROM fields WHERE envelope_id=? AND id='note'", e.id)?.n ?? 0, 0);
  // Signing still finishes. The signed PDF cannot be stored yet, and nobody is told it is ready when it is not.
  assert.equal((await signAll(e.id, 'second@crypt.example')).status, 200);
  assert.equal(db.get('SELECT status, final_sha256 s FROM envelopes WHERE id=?', e.id).s, null);
  const done = db.all("SELECT html FROM emails WHERE envelope_id=? AND subject LIKE 'Completed:%'", e.id);
  assert.ok(done.length && done.every((m) => /being prepared and will be at the link below shortly/.test(m.html)));
  // The old key is listed again: the timer makes the signed PDF, with the new key.
  setKeys(K2, [K1]);
  await env.cronTick();
  const fin = db.get('SELECT final_sha256 s FROM envelopes WHERE id=?', e.id).s;
  assert.ok(fin && encryptedOnDisk(fin, id2));
  assert.equal(sha((await ann.get(`/envelopes/${e.id}/download`)).data), fin);
  assert.equal((await ann.call('POST', '/files', await pdfForm('Now it works'))).status, 200);
});

test('the export leaves out a signed PDF that fails its check and says so, and the rest of it is whole', async () => {
  setKeys(K2, [K1]); // the folder holds files under both by now
  const ezra = await person('Ezra Export', 'ezra@crypt.example');
  const ids: string[] = [];
  for (const who of ['one', 'two']) {
    const e = await simple(ezra, `${who}@export.example`, { subject: `Export ${who}` });
    assert.equal((await ezra.post(`/envelopes/${e.id}/send`)).status, 200);
    assert.equal((await signAll(e.id, `${who}@export.example`)).status, 200);
    ids.push(e.id);
  }
  const [good, bad] = ids.map((x) => db.get('SELECT final_sha256 s FROM envelopes WHERE id=?', x).s);
  flip(path.join(blobs(), bad), HEADER_BYTES + 40);
  const res = await ezra.get('/export');
  assert.equal(res.status, 200);
  const zip = unzip(res.data);
  const signed = Object.keys(zip).filter((n) => n.startsWith('signed/'));
  assert.equal(signed.length, 1);
  assert.equal(sha(zip[signed[0]]), good);
  assert.equal(Object.keys(zip).filter((n) => n.startsWith('audit/')).length, 2, 'both audit trails are there');
  const readme = zip['README.txt'].toString();
  assert.match(readme, /1 signed document\(s\) could not be read from storage and are not in this file\. Their stored copy failed its check, so nothing damaged was put in\./);
  assert.ok(readme.includes(`Export two (envelope ${ids[1]})`));
  assert.equal((await ezra.get(`/envelopes/${ids[1]}/download`)).status, 500, 'and the download says it is damaged rather than handing it out');
});

// ---- What is said about it -----------------------------------------------------------------------------------------

test('the pages say what is encrypted and what is not, from the setting the server runs on, and promise nothing more', () => {
  setKeys();
  assert.equal(encryptedFilesPoint(), null, 'nothing about encrypted files where they are not');
  const off = notEncryptedPoint();
  assert.equal(off.title, 'Stored files and the database are not encrypted by the software on this server.');
  // Said of new files: a server where it was switched off still holds files encrypted while it was on (tests/qr-encrypt-repair.test.ts).
  assert.match(off.text, /The software can encrypt the uploaded documents, signed PDFs and the files signers attach, and it is not switched on here, so new files are kept on the disk as they were uploaded and signed/);
  setKeys(K1);
  const on = encryptedFilesPoint()!;
  assert.equal(on.title, 'Stored files are encrypted by the software.');
  assert.match(on.text, /AES-256-GCM and a key of its own for each file/);
  // The files are unreadable on a copy of the disk; the copy is not safe by itself, because the database is not encrypted.
  assert.match(on.text, /keeps those files unreadable on a copy of the disk or of a backup taken without the server's settings\. It does not make such a copy safe by itself, because only part of the database on the same disk is encrypted/);
  assert.match(on.text, /It does not protect against someone who gets into the running server either, because the key is in those settings/);
  assert.match(on.text, /Files stored before encryption was switched on are encrypted when the people who run this server run the script/);
  const dbOnly = notEncryptedPoint();
  assert.equal(dbOnly.title, 'The database is only partly encrypted by the software.');
  // With the key, what stays readable is CLEAR_WORDS (tests/ds-db-encrypt.test.ts); without it the whole list below.
  assert.match(dbOnly.text, /The rest of the database stays readable to whoever has a copy of the disk or of a backup: the names, email addresses and phone numbers/);
  for (const t of [off.text]) {
    // The whole list of what stays readable is DATABASE_HOLDS (checked item by item in tests/qr-encrypt-repair.test.ts).
    assert.match(t, /The software does not encrypt the database\. Whoever has a copy of the disk or of a backup can read what it holds: the names, email addresses and phone numbers of everyone on a document/);
    assert.match(t, /what people typed into fields, and their signatures and initials as pictures/);
    assert.match(t, /every audit trail, with the IP addresses and browsers it records/);
    assert.match(t, /So encrypt the disk itself as well\./);
  }
  assert.match(PROCESSING_ENCRYPTED, /The rest of the database is not/);
  for (const t of [on.title, on.text, off.title, off.text, dbOnly.text, PROCESSING_ENCRYPTED])
    assert.doesNotMatch(t, /\u2014|bank-grade|military|fully secure|unbreakable|compliant|is valid|will hold up/i);
  // The pages print those sentences, and the old one that is no longer true everywhere is gone.
  const security = read('src/app/security/page.tsx');
  assert.match(security, /const encrypted = encryptedFilesPoint\(\);/);
  assert.match(security, /\{encrypted && <Point title=\{encrypted\.title\}>\{encrypted\.text\}<\/Point>\}/);
  assert.match(security, /<Point title=\{notEncrypted\.title\}>\{notEncrypted\.text\}<\/Point>/);
  assert.ok(security.indexOf('notEncrypted.title') > security.indexOf('id="not"'), 'under "What this is not"');
  assert.doesNotMatch(security, /No claim about encrypted storage/);
  const processing = read('src/app/security/processing/page.tsx');
  assert.match(processing, /\{fileEncryptionOn\(\) && <li>\{PROCESSING_ENCRYPTED\}<\/li>\}/);
  assert.match(processing, /<b>What the software does not do:<\/b> \{processingNotDone\(\)\}/);
  const policy = read('src/lib/policy.ts');
  assert.match(policy, /the key to the stored files, where it encrypts them, is in the server\\'s settings, so whoever has the disk, the database and the settings of the server can read everything on them/);
  assert.match(policy, /'The database encrypted by the software itself, not only the stored files\. Today the software can encrypt the files/);
  assert.doesNotMatch(policy, /saveBlob\(\) in src\/server\/db\.ts writes them as they are/);
  assert.match(read('src/instrumentation.ts'), /const files = fileStoreWarning\(\);\n\s+if \(files\) console\.error\(files\);/);
});

test('the README, the settings example and the API description say how to switch it on, what it protects, and what the errors mean', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /A security certification, or encryption of stored files by the app itself/);
  assert.match(readme, /- A security certification, and encryption of the whole database by the app itself\. With `FILE_ENCRYPTION_KEY` the\n  app encrypts the stored files/);
  assert.match(readme, /\| `FILE_ENCRYPTION_KEY` \| Encrypts every file the app stores from now on .*`openssl rand -base64 32`.* \| off: files are stored as they are \|/);
  assert.match(readme, /\| `FILE_ENCRYPTION_KEYS_OLD` \| Earlier keys, separated by commas/);
  assert.match(readme, /### Encrypting stored files/);
  assert.match(readme, /\*\*What is not protected\.\*\* The rest of the database \(`DATA_DIR\/sign\.db`\) is not encrypted by the app/);
  assert.match(readme, /not a break-in\n  to the running server or to its settings\. Encrypt the disk as well\./);
  assert.match(readme, /\*\*What the names give away\.\*\* A stored file is still named by the SHA-256 of its readable contents/);
  assert.match(readme, /sees which\n  stored files are the same as each other/);
  assert.match(readme, /Nobody learns from a name what a file says\./);
  assert.match(readme, /\| `tests\/encrypt\.test\.ts` \|/);
  const example = read('.env.example');
  assert.match(example, /# FILE_ENCRYPTION_KEY=\n/);
  assert.match(example, /# FILE_ENCRYPTION_KEYS_OLD=\n/);
  assert.match(example, /openssl rand -base64 32/);
  assert.match(example, /The database is NOT encrypted/);
  const api = read('src/server/openapi.ts');
  for (const code of ['file_damaged', 'file_locked', 'storage_stopped']) assert.ok(api.includes(`"code": "${code}"`), code);
  for (const f of ['src/server/filecrypt.ts', 'src/server/filestore.ts', 'src/lib/storedfiles.ts', 'scripts/encrypt-files.mjs', 'tests/encrypt.test.ts']) assert.doesNotMatch(read(f), /\u2014/, f);
  // The format must not carry the product's name: the rename would change it and lock every file.
  assert.doesNotMatch(read('src/server/filecrypt.ts').split('\nimport')[1], /GrowSigning|growsigning/i);
});
