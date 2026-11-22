// The text read from an uploaded PDF (storeUpload in routes-envelopes.ts). It is kept for the sender's own search
// (GET /envelopes?q=), for the check before sending (warnings.ts) and for the scam filter of click-to-agree pages
// (clickwrap.ts). It is the whole wording of the document, so with FILE_ENCRYPTION_KEY set it is kept encrypted
// with the same key as the files (files.text_sealed, with the key id in files.text_key) and never in the clear:
// otherwise a copy of the disk would show the words of every document in the database while /security says the
// documents are encrypted. A search opens the kept texts in memory, for the one account being searched and only
// while the search runs.
//
// A kept text is base64 of: version 1 (1) | key id (8) | salt (16) | nonce (12) | contents | GCM tag (16). Its key is
// HKDF-SHA256 of the server's key with the salt and the id of the file row, and the id is checked with the contents,
// so a text moved to another row fails. Text kept before the key was set (files.text) is sealed when the server
// starts with a key (sealKeptTexts), and text under an old key moves to the current one then. The constant strings
// are part of the format and carry no product name, so a rename cannot lock them.
import crypto from 'node:crypto';
import path from 'node:path';
import { all, run, db, tx, dataDir } from './db.ts';
import { keys, storeState } from './filestore.ts';
import type { FileKey } from './filecrypt.ts';

const VERSION = 1;
const HEAD = 37; // version, key id, salt, nonce
const TAG = 16;
const textKey = (k: Buffer, salt: Buffer, fileId: string) => Buffer.from(crypto.hkdfSync('sha256', k, salt, `kept text v1 ${fileId}`, 32));

export function sealText(text: string, fileId: string, k: FileKey): string {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const head = Buffer.concat([Buffer.from([VERSION]), Buffer.from(k.id, 'hex'), salt, nonce]);
  const c = crypto.createCipheriv('aes-256-gcm', textKey(k.key, salt, fileId), nonce);
  c.setAAD(Buffer.concat([head, Buffer.from(fileId)]));
  return Buffer.concat([head, c.update(text, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}

/** The kept text, or null when it is under a key this server does not hold or fails its check. */
export function openText(sealed: string, fileId: string): string | null {
  const b = Buffer.from(String(sealed || ''), 'base64');
  if (b.length < HEAD + TAG || b[0] !== VERSION) return null;
  const k = keys().byId.get(b.subarray(1, 9).toString('hex'));
  if (!k) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', textKey(k.key, b.subarray(9, 25), fileId), b.subarray(25, HEAD));
    d.setAAD(Buffer.concat([b.subarray(0, HEAD), Buffer.from(fileId)]));
    d.setAuthTag(b.subarray(b.length - TAG));
    return Buffer.concat([d.update(b.subarray(HEAD, b.length - TAG)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** What a new file row keeps of its text: in the clear with no key set, sealed with one. */
export function keepText(fileId: string, text: string | null | undefined): { text: string | null; sealed: string | null; key: string | null } {
  if (!text) return { text: null, sealed: null, key: null };
  const k = keys().current;
  return k ? { text: null, sealed: sealText(text, fileId, k), key: k.id } : { text, sealed: null, key: null };
}

/** The kept text of a file row (it needs id, text and text_sealed). Empty when there is none, or when it cannot be
 *  opened on this server: then a search does not find the document by its words, and nothing else is lost. */
export function keptText(row: any): string {
  if (!row) return '';
  if (row.text_sealed) return openText(row.text_sealed, row.id) ?? '';
  return row.text || '';
}
/** A file row with its kept text in `text`, for code that reads row.text. */
export const withKeptText = (row: any) => (row ? { ...row, text: keptText(row) } : row);

/**
 * For the search of one account's envelopes: for each word, the ids of the envelopes whose kept text holds it,
 * opened in memory from the sealed texts of this account only (of one sender, for a member). Texts kept in the clear
 * (before a key was set, or with none) are found by the query itself. Like the query, case does not matter.
 */
export function sealedTextHits(accountId: string, kind: string, words: string[], senderId?: string | string[]): string[][] {
  if (!words.length) return [];
  const hits = words.map(() => new Set<string>());
  // Several senders: a member's own documents and those colleagues share with them today (shares.ts).
  const senders = senderId == null ? null : Array.isArray(senderId) ? senderId : [senderId];
  const rows = all(`SELECT d.envelope_id eid, f.id, f.text_sealed FROM documents d JOIN files f ON f.id=d.file_id JOIN envelopes e ON e.id=d.envelope_id
    WHERE e.account_id=? AND e.kind=?${senders ? ' AND e.sender_id IN (SELECT value FROM json_each(?))' : ''} AND f.text_sealed IS NOT NULL`, accountId, kind, ...(senders ? [JSON.stringify(senders)] : []));
  const lower = words.map((w) => w.toLowerCase());
  // A file several envelopes use (a template and what was sent from it) is opened once.
  const open = new Map<string, string>();
  for (const r of rows) {
    let t = open.get(r.id);
    if (t === undefined) open.set(r.id, (t = (openText(r.text_sealed, r.id) ?? '').toLowerCase()));
    lower.forEach((w, i) => t!.includes(w) && hits[i].add(r.eid));
  }
  return hits.map((s) => [...s]);
}

/**
 * With a key set: seals every kept text that is still in the clear (kept before the key was set) and moves texts
 * under an old key to the current one, so FILE_ENCRYPTION_KEYS_OLD can be emptied later. Run when the server starts
 * (instrumentation.ts). The clear text is overwritten where it stood (secure_delete), because SQLite otherwise
 * leaves the old bytes in the free space of the database file. Nothing is done while storing files is stopped (the
 * key does not fit the files there, see filestore.ts): sealing texts under a key that may be the mistake would mix
 * keys the same way. A text under a key this server does not hold is left as it is. Answers how many were sealed.
 */
export function sealKeptTexts(): number {
  const k = keys().current;
  if (!k || storeState(path.join(dataDir(), 'blobs')).stop) return 0;
  const rows = all('SELECT id, text, text_sealed FROM files WHERE text IS NOT NULL OR (text_sealed IS NOT NULL AND (text_key IS NULL OR text_key != ?))', k.id);
  if (!rows.length) return 0;
  const d = db();
  const was = Number(d.prepare('PRAGMA secure_delete').get()?.secure_delete || 0);
  d.exec('PRAGMA secure_delete=ON');
  let n = 0;
  try {
    tx(() => {
      for (const r of rows) {
        const t = keptText(r);
        if (r.text_sealed && !t) continue;
        run('UPDATE files SET text=NULL, text_sealed=?, text_key=? WHERE id=?', t ? sealText(t, r.id, k) : null, t ? k.id : null, r.id);
        n++;
      }
    });
  } finally {
    d.exec(`PRAGMA secure_delete=${was ? 'ON' : 'OFF'}`);
  }
  // The changed pages are in the write-ahead log until a checkpoint copies them over the old ones in sign.db.
  try {
    d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {}
  if (n) console.error(`[files] The text kept from ${n} uploaded document(s) for search is now encrypted with the current key.`);
  return n;
}
