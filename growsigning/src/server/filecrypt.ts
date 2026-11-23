// Encryption of stored files by the app itself, switched on by FILE_ENCRYPTION_KEY. The format, the keys and the
// check of one stored file live here and nowhere else, so the server (filestore.ts) and the script that encrypts the
// files written before (scripts/encrypt-files.mjs) read and write exactly the same thing. Nothing here touches the
// database, mail or the settings beyond the two key variables.
//
// A stored file keeps the name it has always had: the SHA-256 of its readable contents. The same file stored twice is
// still one file, /verify still compares fingerprints, and the database rows that point at a file do not change. An
// encrypted file is
//   "\0enc" (4) | format version 1 (1) | key id (8) | salt (16) | nonce (12) | header check (4) | contents | GCM tag (16)
// The key for one file is HKDF-SHA256 of the server's key, with the random salt and the file's name. The header and
// the name are authenticated together with the contents, so one changed byte anywhere, a file cut short, or a file
// copied under another name fails the check and is never handed out. The key id is an HMAC of the key: it says which
// key wrote a file and nothing about the key. The header check tells a damaged header from a key this server does
// not hold, which matters because only the second one stops the server from storing files (see filestore.ts).
//
// The constant strings below are part of the format. Changing one makes every encrypted file unreadable, which is why
// none of them carries the product's name.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decodeFileKey, NEW_FILE_KEY_COMMAND } from '../lib/storedfiles.ts';

export const MAGIC = Buffer.from([0x00, 0x65, 0x6e, 0x63]);
export const FORMAT_VERSION = 1;
const HEAD = 41; // magic, version, key id, salt, nonce
export const HEADER_BYTES = HEAD + 4;
const TAG = 16;

export type FileKey = { id: string; key: Buffer };
export type FileKeys = {
  /** The key new files are written with. Null: new files are written as they are. */
  current: FileKey | null;
  /** Every key a file can be read with: the current one and FILE_ENCRYPTION_KEYS_OLD, by key id. */
  byId: Map<string, FileKey>;
  /** What is wrong with the settings, in words for the server log. Never contains a key. */
  problems: string[];
  /** FILE_ENCRYPTION_KEY is set and is not a key. The server then stores nothing (see filestore.ts). */
  badCurrent: boolean;
};

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest();
export const sha256hex = (b: Uint8Array) => sha(b).toString('hex');
export const isBlobName = (s: string) => /^[0-9a-f]{64}$/.test(s);
export const keyIdOf = (key: Buffer): string => crypto.createHmac('sha256', key).update('stored file key id').digest().subarray(0, 8).toString('hex');

/** The keys in the settings. FILE_ENCRYPTION_KEYS_OLD is a list separated by commas or spaces. */
export function fileKeys(env: Record<string, string | undefined> = process.env): FileKeys {
  const problems: string[] = [];
  const byId = new Map<string, FileKey>();
  let current: FileKey | null = null;
  const raw = (env.FILE_ENCRYPTION_KEY || '').trim();
  if (raw) {
    const k = decodeFileKey(raw);
    if (k) byId.set((current = { id: keyIdOf(k), key: k }).id, current);
    else problems.push(`FILE_ENCRYPTION_KEY is set but is not a key. A key is 32 random bytes written as base64, 44 characters ending in "=". Make one with: ${NEW_FILE_KEY_COMMAND}`);
  }
  const old = (env.FILE_ENCRYPTION_KEYS_OLD || '').split(/[\s,]+/).filter(Boolean);
  old.forEach((o, i) => {
    const k = decodeFileKey(o);
    if (!k) return void problems.push(`Entry ${i + 1} of the ${old.length} in FILE_ENCRYPTION_KEYS_OLD is not a key (32 bytes written as base64), so files written with it cannot be read. Copy it again from where the old key was kept.`);
    const id = keyIdOf(k);
    if (!byId.has(id)) byId.set(id, { id, key: k });
  });
  return { current, byId, problems, badCurrent: !!raw && !current };
}

const fileKey = (k: Buffer, salt: Buffer, name: string) => Buffer.from(crypto.hkdfSync('sha256', k, salt, `stored file v1 ${name}`, 32));

/** The encrypted form of a file whose name (the SHA-256 of `plain`) is `name`. */
export function sealFile(plain: Uint8Array, name: string, k: FileKey): Buffer {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const head = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), Buffer.from(k.id, 'hex'), salt, nonce]);
  const header = Buffer.concat([head, sha(head).subarray(0, 4)]);
  const c = crypto.createCipheriv('aes-256-gcm', fileKey(k.key, salt, name), nonce);
  c.setAAD(Buffer.concat([header, Buffer.from(name)]));
  return Buffer.concat([header, c.update(plain), c.final(), c.getAuthTag()]);
}

export type Header = { version: number; keyId: string; salt: Buffer; nonce: Buffer };
/** What the first bytes of a stored file say. null: it does not start like an encrypted file. 'damaged': it starts
 *  like one, but the header fails its check. Needs only the first HEADER_BYTES bytes. */
export function readHeader(b: Uint8Array): Header | 'damaged' | null {
  if (b.length < MAGIC.length || !MAGIC.equals(b.subarray(0, MAGIC.length))) return null;
  if (b.length < HEADER_BYTES || !sha(b.subarray(0, HEAD)).subarray(0, 4).equals(b.subarray(HEAD, HEADER_BYTES))) return 'damaged';
  return { version: b[4], keyId: Buffer.from(b.subarray(5, 13)).toString('hex'), salt: Buffer.from(b.subarray(13, 29)), nonce: Buffer.from(b.subarray(29, 41)) };
}

export type Problem = 'missing' | 'damaged' | 'no-key' | 'newer';
export class StoredFileProblem extends Error {
  why: Problem;
  keyId?: string;
  constructor(why: Problem, keyId?: string) {
    super(`stored file ${why}${keyId ? ` (key id ${keyId})` : ''}`);
    this.why = why;
    this.keyId = keyId;
  }
}

/** The readable contents of a stored file, checked. A file whose bytes are its own fingerprint is a file written
 *  without encryption (before it was switched on, or while it is off), and is handed out as it is. That is asked
 *  first, so an uploaded file that happens to start like an encrypted one is still just that file. Anything else has
 *  to open with a key we hold and come out with the fingerprint it is named by, or it is refused. */
export function openFile(raw: Buffer, name: string, keys: FileKeys): { data: Buffer; keyId: string | null } {
  if (sha256hex(raw) === name) return { data: raw, keyId: null };
  const h = readHeader(raw);
  if (!h || h === 'damaged' || raw.length < HEADER_BYTES + TAG) throw new StoredFileProblem('damaged');
  if (h.version !== FORMAT_VERSION) throw new StoredFileProblem('newer');
  const k = keys.byId.get(h.keyId);
  if (!k) throw new StoredFileProblem('no-key', h.keyId);
  let data: Buffer;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', fileKey(k.key, h.salt, name), h.nonce);
    d.setAAD(Buffer.concat([raw.subarray(0, HEADER_BYTES), Buffer.from(name)]));
    d.setAuthTag(raw.subarray(raw.length - TAG));
    data = Buffer.concat([d.update(raw.subarray(HEADER_BYTES, raw.length - TAG)), d.final()]);
  } catch {
    throw new StoredFileProblem('damaged');
  }
  if (sha256hex(data) !== name) throw new StoredFileProblem('damaged');
  return { data, keyId: h.keyId };
}

/** Writes a file so that, whatever happens, the name holds either what it held before or the whole new file: the
 *  bytes go to a file of their own next to it, are flushed to the disk, and only then take the name in one step. */
export function writeWhole(file: string, data: Uint8Array, tag = 'w') {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${tag}${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  syncDir(path.dirname(file));
}
export function syncDir(dir: string) {
  // So the new name survives a power cut too. Not every system can open a folder for this; there it is skipped.
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

const firstBytes = (file: string): Buffer => {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(HEADER_BYTES);
    return b.subarray(0, fs.readSync(fd, b, 0, HEADER_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
};

export type StoreScan = {
  /** Files written without encryption. */
  plain: number;
  /** Encrypted files, counted by the key id that wrote them, for keys this server holds. */
  byKey: Record<string, number>;
  /** The same for keys it does not hold. Any entry here stops the server from storing files. */
  unknownKeys: Record<string, number>;
  /** Files written by a newer version of the format. */
  newer: number;
  /** Names of files whose header is damaged. */
  damaged: string[];
};

/** What is in the folder of stored files, read from the first bytes of each (the whole file only where those bytes
 *  could also be the start of a file stored as it is). Hidden files (a write in progress) and other names are left
 *  out. A folder that does not exist holds nothing. */
export function scanStore(dir: string, keys: FileKeys): StoreScan {
  const s: StoreScan = { plain: 0, byKey: {}, unknownKeys: {}, newer: 0, damaged: [] };
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return s;
  }
  for (const name of names) {
    if (!isBlobName(name)) continue;
    const file = path.join(dir, name);
    let h: ReturnType<typeof readHeader>;
    try {
      h = readHeader(firstBytes(file));
    } catch {
      continue; // removed while we looked
    }
    if (!h) {
      s.plain++;
      continue;
    }
    if (h !== 'damaged' && h.version === FORMAT_VERSION && keys.byId.has(h.keyId)) {
      s.byKey[h.keyId] = (s.byKey[h.keyId] || 0) + 1;
      continue;
    }
    // Something we cannot open. It may be a file stored as it is that only starts like an encrypted one (anyone can
    // upload such a file), and then it is not a problem at all: its bytes are its own fingerprint.
    let whole: Buffer;
    try {
      whole = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (sha256hex(whole) === name) s.plain++;
    else if (h === 'damaged') s.damaged.push(name);
    else if (h.version !== FORMAT_VERSION) s.newer++;
    else s.unknownKeys[h.keyId] = (s.unknownKeys[h.keyId] || 0) + 1;
  }
  return s;
}
