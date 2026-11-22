// Encryption of single values in the database, switched on by the same FILE_ENCRYPTION_KEY as the stored files
// (src/server/filecrypt.ts) and read with the same list of old keys (FILE_ENCRYPTION_KEYS_OLD). Which columns are
// encrypted, and why the others are not, is in SEALED_COLUMNS below and in words in src/lib/sealedcolumns.ts.
//
// Two functions carry every value:
//   seal(label, value)   on the way in: every write of a listed column passes its value through it (or sealField
//                        for fields.value and fields.prefill, which keep ids of files and stamps in the clear)
//   openValue(value)     on the way out: get() and all() in db.ts open every sealed value in the rows they answer,
//                        so code that reads a row sees what was written and nothing else changes for it
// SQL that has to look inside a value (a search, a check that a file is still used by an email, a code taken out of
// an email once it is used) uses the functions registered on the database: col_find(x) (the readable value, or
// NULL when it cannot be opened) and col_replace(x, find, with) (replaces inside the readable value and seals the
// result again). A value written while no key is set stays readable and is sealed later (src/server/colsweep.ts).
//
// A sealed value is the text
//   "\x01c1|" label "|" base64( key id (8) | nonce (12) | contents | GCM tag (16) )
// label is the table and column it was written for, such as "recipients.signature_png". Its key is HKDF-SHA256 of
// the server's key with that label, so each column has a key of its own. The label and the key id are checked with
// the contents, so a changed byte, a value cut short, or a value given another label fails and is never handed out.
// The label travels with the value, so SQL that copies a value to another row or column (value=prefill) keeps it
// readable. The leading control character (U+0001, never NUL: the database driver cuts text at a NUL) cannot come
// from a person: seal() removes it, and NUL, from everything it is given.
//
// The constant strings are part of the format and carry no product name, so a rename cannot lock them.
import crypto from 'node:crypto';
import { fileKeys, type FileKey, type FileKeys } from './filecrypt.ts';
import { HttpError } from './util.ts';

export const PREFIX = '\u0001c1|';
const NONCE = 12;
const TAG = 16;
const ID = 8;
const LABEL = /^[a-z_]+\.[a-z_]+$/;

/** The columns that are kept encrypted. `where` leaves out the rows whose value must stay readable to SQL. */
export const SEALED_COLUMNS: { table: string; column: string; where?: string }[] = [
  { table: 'recipients', column: 'signature_png' },
  { table: 'recipients', column: 'initials_png' },
  { table: 'recipients', column: 'decline_reason' },
  { table: 'users', column: 'signature_png' },
  { table: 'users', column: 'initials_png' },
  { table: 'earlier_signatures', column: 'signature_png' },
  { table: 'earlier_signatures', column: 'initials_png' },
  { table: 'earlier_signatures', column: 'answers' },
  // An attachment field holds the id of a file row and a stamp field the fingerprint of a stamp picture: ids that
  // other tables are joined on, not anything a person wrote.
  { table: 'fields', column: 'value', where: "type NOT IN ('attachment','stamp')" },
  { table: 'fields', column: 'prefill', where: "type NOT IN ('attachment','stamp')" },
  { table: 'comments', column: 'body' },
  { table: 'emails', column: 'html' },
  { table: 'emails', column: 'payload' },
  { table: 'support_requests', column: 'message' },
  { table: 'support_messages', column: 'body' },
];
const CLEAR_FIELD_TYPES = new Set(['attachment', 'stamp']);

const g = globalThis as any;
const sig = () => `${process.env.FILE_ENCRYPTION_KEY || ''}\n${process.env.FILE_ENCRYPTION_KEYS_OLD || ''}`;
/** The keys in the settings, read again only when they change (on a real server, at a restart). */
export function colKeys(): FileKeys {
  if (g.__tscolkeys?.sig !== sig()) g.__tscolkeys = { sig: sig(), keys: fileKeys(), derived: new Map() };
  return g.__tscolkeys.keys;
}
function columnKey(k: FileKey, label: string): Buffer {
  colKeys();
  const m: Map<string, Buffer> = g.__tscolkeys.derived;
  const at = `${k.id}|${label}`;
  let d = m.get(at);
  if (!d) m.set(at, (d = Buffer.from(crypto.hkdfSync('sha256', k.key, Buffer.from('column'), `column v1 ${label}`, 32))));
  return d;
}
const aad = (label: string, keyId: string) => Buffer.from(`c1|${label}|${keyId}`);

export const isSealed = (v: unknown): boolean => typeof v === 'string' && v.charCodeAt(0) === 1 && v.startsWith(PREFIX);

/** The sealed form of a value with a given key. Exported for the tests and the migration only. */
export function sealWith(label: string, text: string, k: FileKey): string {
  const nonce = crypto.randomBytes(NONCE);
  const c = crypto.createCipheriv('aes-256-gcm', columnKey(k, label), nonce);
  c.setAAD(aad(label, k.id));
  const body = Buffer.concat([Buffer.from(k.id, 'hex'), nonce, c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
  return `${PREFIX}${label}|${body.toString('base64')}`;
}

/** What a value is written as. With a key it is sealed; without one it is kept as it is (and sealed later). NULL,
 *  an empty text and anything that is not text are kept as they are. U+0000 and U+0001 are removed in both cases. */
export function seal<T>(label: string, value: T): T | string {
  if (typeof value !== 'string') return value;
  // Never passed through as "already sealed": code only ever holds opened values (get and all open them), so a
  // value that starts like a sealed one came from a person, and loses its marker below.
  const s = /[\u0000\u0001]/.test(value) ? value.replace(/[\u0000\u0001]/g, '') : value;
  if (!s) return s;
  const k = colKeys().current;
  return k ? sealWith(label, s, k) : s;
}
/** For fields.value and fields.prefill: the id of a file (attachment) or of a stamp picture stays readable. */
export const sealField = <T>(type: string | null | undefined, value: T, column: 'value' | 'prefill' = 'value'): T | string =>
  CLEAR_FIELD_TYPES.has(String(type || '')) ? value : seal(`fields.${column}`, value);

export type ColumnProblem = 'no-key' | 'damaged';
export class SealedValueProblem extends Error {
  why: ColumnProblem;
  keyId?: string;
  label?: string;
  constructor(why: ColumnProblem, label?: string, keyId?: string) {
    super(`sealed value ${why}${label ? ` in ${label}` : ''}${keyId ? ` (key id ${keyId})` : ''}`);
    this.why = why;
    this.label = label;
    this.keyId = keyId;
  }
}

/** The parts of a sealed value, or null when it is not one. Never opens anything. */
export function parseSealed(v: string): { label: string; keyId: string; body: Buffer } | null {
  if (!isSealed(v)) return null;
  const bar = v.indexOf('|', PREFIX.length);
  if (bar < 0) return null;
  const label = v.slice(PREFIX.length, bar);
  if (!LABEL.test(label)) return null;
  const body = Buffer.from(v.slice(bar + 1), 'base64');
  if (body.length < ID + NONCE + TAG) return null;
  return { label, keyId: body.subarray(0, ID).toString('hex'), body };
}

/** The readable value, or a SealedValueProblem. A value that is not sealed is answered as it is. */
export function openStrict(v: string, keys = colKeys()): string {
  if (!isSealed(v)) return v;
  const p = parseSealed(v);
  if (!p) throw new SealedValueProblem('damaged');
  const k = keys.byId.get(p.keyId);
  if (!k) throw new SealedValueProblem('no-key', p.label, p.keyId);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', columnKey(k, p.label), p.body.subarray(ID, ID + NONCE));
    d.setAAD(aad(p.label, p.keyId));
    d.setAuthTag(p.body.subarray(p.body.length - TAG));
    return Buffer.concat([d.update(p.body.subarray(ID + NONCE, p.body.length - TAG)), d.final()]).toString('utf8');
  } catch {
    throw new SealedValueProblem('damaged', p.label);
  }
}

// What a person is told when a row they asked for holds a value this server cannot open. Like a stored file that
// cannot be opened (filestore.ts), nothing is handed out in its place, and no key is named.
const LOCKED = 'We could not open part of this record at the moment: the copy stored on our server failed its check, which means it was damaged or changed on the disk. Nothing was shown in its place, nothing was changed and nothing is lost. This is a fault on our side, and it has been recorded in the server log for the people who run this server. Please try again later.';
function told(e: SealedValueProblem) {
  const seen: Set<string> = (g.__tscoltold ??= new Set());
  const at = `${e.why}|${e.label || ''}|${e.keyId || ''}`;
  if (seen.has(at)) return;
  seen.add(at);
  console.error(`\n[database] A value in ${e.label || 'the database'} could not be opened (${e.why === 'no-key' ? `it was encrypted with key id ${e.keyId}, which is not in FILE_ENCRYPTION_KEY or FILE_ENCRYPTION_KEYS_OLD. Add that key to FILE_ENCRYPTION_KEYS_OLD and restart` : 'it fails its check: changed or damaged on the disk. Put the database back from a backup'}). Whoever asked for it was given nothing. "node scripts/encrypt-columns.mjs --check" counts every such value.\n`);
}

/** The readable value for code: a refusal in plain words when it cannot be opened. */
export function openValue<T>(v: T): T | string {
  if (!isSealed(v)) return v;
  try {
    return openStrict(v as string);
  } catch (e) {
    if (!(e instanceof SealedValueProblem)) throw e;
    told(e);
    // A key this server was not given (a new key set in place of the old one): like stored files, everything else is
    // still served, and this value reads as empty, never as something else. It stays on the disk untouched, the log
    // and /app/operator name the missing key, and storing files is stopped meanwhile (filestore.ts), so no signed
    // PDF is made from a record with a part missing. A value damaged on the disk is refused outright.
    if (e.why === 'no-key') return '';
    throw new HttpError(503, LOCKED, { code: 'data_locked' });
  }
}
/** The readable value, or null when it cannot be opened. For SQL that searches: what cannot be opened is not found. */
export function findValue(v: unknown): unknown {
  if (!isSealed(v)) return v;
  try {
    return openStrict(v as string);
  } catch (e) {
    if (e instanceof SealedValueProblem) told(e);
    return null;
  }
}

/** Opens every sealed value of one row from the database, in place. */
export function openRow<T extends Record<string, any>>(r: T): T {
  for (const k in r) if (isSealed(r[k])) (r as any)[k] = openValue(r[k]);
  return r;
}

/** The SQL functions col_find(x) and col_replace(x, find, with), on one database connection. */
export function registerSql(d: any) {
  d.function('col_find', { deterministic: false }, (v: unknown) => findValue(v) as any);
  d.function('col_replace', { deterministic: false }, (v: unknown, find: unknown, to: unknown) => {
    if (typeof v !== 'string' || typeof find !== 'string' || !find) return v as any;
    if (!isSealed(v)) return v.split(find).join(String(to ?? ''));
    const p = parseSealed(v);
    let open: string;
    try {
      open = openStrict(v);
    } catch (e) {
      if (e instanceof SealedValueProblem) told(e);
      return v; // left as it was: it cannot be read, so there is nothing readable in it to take out
    }
    if (!open.includes(find)) return v;
    const k = colKeys().current;
    const out = open.split(find).join(String(to ?? ''));
    return k && p ? sealWith(p.label, out, k) : out;
  });
}
