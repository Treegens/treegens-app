// The folder of stored files (DATA_DIR/blobs), as saveBlob and readBlob in db.ts use it. The format of an encrypted
// file is in filecrypt.ts. What this file adds is the rule that nothing is lost by a mistake with the key:
//   - Every file is checked when it is read. One that fails is refused with words that say so and is reported to the
//     people who run the server, never handed out as garbage.
//   - A server whose folder holds files written with a key it does not have (a new key set in place of the old one,
//     or the key left out after a move) says so loudly when it starts and stores no new file until that key is
//     listed again, in FILE_ENCRYPTION_KEYS_OLD or back in FILE_ENCRYPTION_KEY. Otherwise new files would be written
//     with one key while older ones need another that nobody can find any more, and nobody could sort them out later.
//     It still reads everything it can.
//   - The same happens when FILE_ENCRYPTION_KEY is set and is not a key: storing files as they are while the operator
//     believes they are encrypted would be a promise the server does not keep.
// With no key set and no encrypted file in the folder, files are written and read as they always were.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, id, now, isEmail, baseUrl } from './util.ts';
import { get, run, dataDir } from './db.ts';
import { fileKeys, openFile, sealFile, sha256hex, scanStore, writeWhole, StoredFileProblem, type FileKeys, type StoreScan } from './filecrypt.ts';
import { NEW_FILE_KEY_COMMAND } from '../lib/storedfiles.ts';

const g = globalThis as any;
const sig = () => `${process.env.FILE_ENCRYPTION_KEY || ''}\n${process.env.FILE_ENCRYPTION_KEYS_OLD || ''}`;

// The keys are read again only when the settings change, which on a real server means a restart.
export function keys(): FileKeys {
  if (g.__tsfilekeys?.sig !== sig()) g.__tsfilekeys = { sig: sig(), keys: fileKeys() };
  return g.__tsfilekeys.keys;
}

export type StoreState = { dir: string; scan: StoreScan; stop: string | null; warning: string | null };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What the folder holds and whether new files may be written to it. Worked out once for each folder and each value of
// the settings (when the server starts: see instrumentation.ts), not for every file.
export function storeState(dir: string, fresh = false): StoreState {
  const k = keys();
  const cacheKey = `${dir}\n${sig()}`;
  if (!fresh && g.__tsfilestate?.cacheKey === cacheKey) return g.__tsfilestate.state;
  const scan = scanStore(dir, k);
  const unknown = Object.entries(scan.unknownKeys);
  const held = [...k.byId.keys()];
  let stop: string | null = null;
  if (k.badCurrent) stop = `FILE_ENCRYPTION_KEY is set but is not a key, so no new file is stored until it is corrected. Make a key with: ${NEW_FILE_KEY_COMMAND}`;
  else if (unknown.length)
    stop = `${plural(unknown.reduce((n, [, c]) => n + c, 0), 'stored file was', 'stored files were')} encrypted with a key this server does not have (${unknown.map(([kid, c]) => `key id ${kid}: ${plural(c, 'file')}`).join(', ')}). `
      + `${held.length ? `The keys it has are ${held.map((x) => `key id ${x}`).join(', ')}.` : 'It has no key at all: FILE_ENCRYPTION_KEY is not set.'} `
      + 'Nothing was changed and those files are still on the disk. No new file is stored until the key they were written with is set again: add it to FILE_ENCRYPTION_KEYS_OLD (or put it back in FILE_ENCRYPTION_KEY) and restart. '
      + '"node scripts/encrypt-files.mjs --check" shows the key id of every key in the settings and what the folder holds. '
      + 'If that key is lost for good, nobody can read those files again: move them out of the folder (keep them, in case the key turns up) and restart, and the server stores files again.';
  const notes = [...k.problems.filter((p) => !k.badCurrent || !p.startsWith('FILE_ENCRYPTION_KEY is set')),
    ...(scan.damaged.length ? [`${plural(scan.damaged.length, 'stored file has', 'stored files have')} a damaged header and cannot be read: ${scan.damaged.slice(0, 5).join(', ')}${scan.damaged.length > 5 ? ' and more' : ''}. Put them back from a backup.`] : []),
    ...(scan.newer ? [`${plural(scan.newer, 'stored file was', 'stored files were')} written by a newer version of the software and cannot be read by this one.`] : [])];
  const warning = stop || notes.length ? `\n[files] ${stop ? `STORING FILES IS STOPPED. ${stop}` : 'STORED FILES NEED A LOOK.'}${notes.length ? `\n[files] ${notes.join('\n[files] ')}` : ''}\n` : null;
  const state = { dir, scan, stop, warning };
  g.__tsfilestate = { cacheKey, state };
  if (stop) tell(`stop:${dir}:${sha256hex(Buffer.from(sig()))}`, k.badCurrent ? 'Storing files is stopped: FILE_ENCRYPTION_KEY is not a key' : 'Storing files is stopped: the encryption key cannot read the files that are there', [stop, 'Until this is fixed nobody can upload a document or attach a file, and signed PDFs are made later, once files can be stored again. Everything already stored that can be read is still served.']);
  return state;
}

/** What the server says about its stored files when it starts. Null when there is nothing to say. */
export function fileStoreWarning(dir = path.join(dataDir(), 'blobs')): string | null {
  return storeState(dir).warning;
}

// The people who run the server hear about a file that cannot be read, or a stop, in the server log, in the operator
// queue (like the payment alerts, see tellOperators in routes-billing.ts) and by email to SUPPORT_EMAIL and
// OPERATOR_EMAILS. Once for each file or stop, however often it is asked for, and never twice while an alert about
// it is still open in the queue.
function tell(key: string, subject: string, lines: string[]) {
  console.error(`\n[files] ${subject}\n[files] ${lines.join('\n[files] ')}\n`);
  const told: Set<string> = (g.__tsfiletold ??= new Set());
  if (told.has(key)) return;
  told.add(key);
  // Filed a moment later, outside whatever transaction asked for the file: a refusal rolls that transaction back,
  // and the alert must not go with it.
  setImmediate(() => fileAlert(subject, lines));
}
function fileAlert(subject: string, lines: string[]) {
  try {
    const to = [...new Set([process.env.SUPPORT_EMAIL || '', ...(process.env.OPERATOR_EMAILS || '').split(',')].map((s) => s.trim().toLowerCase()).filter(isEmail))];
    const message = `${subject}\n\n${lines.join('\n')}`.slice(0, 5000);
    if (get("SELECT 1 x FROM support_requests WHERE name=? AND status!='closed' AND col_find(message)=?", 'GrowSigning (automatic alert)', message)) return;
    run("INSERT INTO support_requests (id, email, name, topic, message, status, at) VALUES (?,?,?,'other',?,'open',?)", id('sup'), to[0] || 'files-alert@localhost', 'GrowSigning (automatic alert)', message, now());
    if (to.length)
      import('./mail.ts').then(async ({ sendMail }) => {
        for (const t of to) await sendMail({ to: t, subject, heading: subject, lines, cta: { label: 'Open the queue', url: `${baseUrl()}/app/operator` } });
      }).catch((e) => console.error('[files] could not email the operators', e?.message));
    else console.error('[files] NOBODY WAS TOLD BY EMAIL (set SUPPORT_EMAIL or OPERATOR_EMAILS). The alert is in the operator queue.');
  } catch (e: any) {
    console.error('[files] could not file the alert', e?.message);
  }
}

// What a person is told. Each says what happened and that nothing was changed, and none of them names a key.
const RECORDED = 'This is a fault on our side, and it has been recorded for the people who run this server.';
const SAY: Record<StoredFileProblem['why'], [number, string]> = {
  missing: [500, `We could not find this file on our server, so it cannot be shown. Nothing was changed. ${RECORDED} Please try again later.`],
  damaged: [500, `We could not open this file: the copy stored on our server failed its check, which means it was damaged or changed on the disk. It was not shown, so you are not looking at anything wrong, and nothing was changed. ${RECORDED} They can put it back from a backup. Please try again later.`],
  'no-key': [503, `We could not open this file at the moment: it is locked with an encryption key this server has not been given. The file is still there and nothing was changed. ${RECORDED} Please try again later.`],
  newer: [503, `We could not open this file at the moment: it was stored by a newer version of our software than the one running now. The file is still there and nothing was changed. ${RECORDED} Please try again later.`],
};
// Why storing stopped (a key that does not fit the files there) is for the operator, in the log and the queue. The
// person in front of the screen needs to know that nothing was saved, that nothing is lost, and what to do.
const STOPPED = 'We cannot store files at the moment, so nothing was saved. Everything already stored is safe. A setting on our server has to be put right first, and the people who run it have been told. Please try again later.';

const DETAIL: Record<StoredFileProblem['why'], string> = {
  missing: 'The file is not in the folder of stored files.',
  damaged: 'It is in the folder of stored files but fails its check: changed, cut short or overwritten on the disk. It was not handed out. Put it back from a backup.',
  'no-key': 'It was encrypted with a key this server does not have. Add that key to FILE_ENCRYPTION_KEYS_OLD and restart.',
  newer: 'It was written by a newer version of the software. Run that version again.',
};

/** The readable contents of a stored file, or an error that says in words why there are none. */
export function readStored(dir: string, name: string, quiet = false): Buffer {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(path.join(dir, name));
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
    return fail(new StoredFileProblem('missing'), dir, name, quiet);
  }
  try {
    return openFile(raw, name, keys()).data;
  } catch (e) {
    if (!(e instanceof StoredFileProblem)) throw e;
    return fail(e, dir, name, quiet);
  }
}

function fail(e: StoredFileProblem, dir: string, name: string, quiet: boolean): never {
  // A key we do not hold, found after the server started (a file restored from a backup, say): the same stop as at
  // the start, from now on.
  if (e.why === 'no-key' && e.keyId) {
    const st = storeState(dir);
    if (!st.scan.unknownKeys[e.keyId]) storeState(dir, true);
  }
  if (!quiet) tell(`file:${name}:${e.why}`, `A stored file could not be read (${e.why})`, [`File ${name} in ${dir}.`, DETAIL[e.why], 'Whoever asked for it was told that it could not be opened, and was given nothing.']);
  const [status, message] = SAY[e.why];
  throw new HttpError(status, message, { code: e.why === 'damaged' || e.why === 'missing' ? 'file_damaged' : 'file_locked' });
}

/** For work that must not go ahead unless a file can be kept with it, asked before anything is changed: a correction
 *  that asks someone to sign again keeps a copy of what they signed, and without it that copy would be lost. */
export function assertCanStore(dir = path.join(dataDir(), 'blobs')) {
  if (storeState(dir).stop) throw new HttpError(503, STOPPED, { code: 'storage_stopped' });
}

/** Stores a file under the fingerprint of its contents and answers that fingerprint. With a key set the file is
 *  encrypted. A file with the same contents that is already there and reads back is left as it is; one that does not
 *  read back is replaced by this good copy. */
export function storeFile(dir: string, buf: Uint8Array): string {
  const name = sha256hex(buf);
  const file = path.join(dir, name);
  if (fs.existsSync(file)) {
    try {
      readStored(dir, name, true);
      return name;
    } catch (e: any) {
      if (!(e instanceof HttpError)) throw e;
      if (e.data?.code === 'file_damaged') console.error(`[files] ${name} was damaged on the disk and is replaced by the good copy that was just stored again.`);
    }
  }
  if (storeState(dir).stop) {
    console.error(`[files] refused to store ${name}: storing files is stopped (see the warning when the server started).`);
    throw new HttpError(503, STOPPED, { code: 'storage_stopped' });
  }
  const k = keys().current;
  writeWhole(file, k ? sealFile(buf, name, k) : buf);
  return name;
}
