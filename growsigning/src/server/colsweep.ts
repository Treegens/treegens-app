// The values of the encrypted columns (SEALED_COLUMNS in colcrypt.ts) that are not yet sealed with the current key:
// written before FILE_ENCRYPTION_KEY was set, written while it was missing, or sealed with a key that is now in
// FILE_ENCRYPTION_KEYS_OLD. sealColumns() seals them with the current key. It runs when the server starts and on
// the timer (cron.ts), a batch at a time, and scripts/encrypt-columns.mjs runs the same function to do a whole
// database at once (or with --check, only to count).
//
// Why it cannot lose a value: each value is opened and checked before anything is written; the new sealed value is
// opened again and must give back the same text; and the row is changed only if it still holds exactly what was
// read (a person who saved something new meanwhile wins). A value under a key this server does not hold, or one
// that fails its check, is counted and left exactly as it is. The readable copy is overwritten where it stood
// (secure_delete), because SQLite otherwise leaves the old bytes in the free space of the database file.
//
// Nothing is changed while the key does not fit what is already encrypted (stored files or values under a key this
// server has not been given): sealing more under a key that may be the mistake would only mix keys further.
import path from 'node:path';
import { db, dataDir } from './db.ts';
import { storeState } from './filestore.ts';
import { SEALED_COLUMNS, colKeys, isSealed, openStrict, parseSealed, sealWith, SealedValueProblem } from './colcrypt.ts';
import { decodeFileKey } from '../lib/storedfiles.ts';

export type ColumnCount = { table: string; column: string; plain: number; current: number; old: number; unknown: number; damaged: number };
export type ColumnScan = {
  /** The key new values are sealed with, by id. Null: none is set. */
  current: string | null;
  columns: ColumnCount[];
  plain: number; current_key: number; old_key: number; unknown: number; damaged: number;
  /** Key ids of sealed values this server cannot open. */
  unknownKeys: string[];
};

const raw = (sql: string, ...p: any[]): any[] => db().prepare(sql).all(...p); // never opened: these are the stored bytes
const whereOf = (c: (typeof SEALED_COLUMNS)[number]) => `${c.column} IS NOT NULL AND ${c.column} != ''${c.where ? ` AND ${c.where}` : ''}`;

/** What the encrypted columns hold, counted. Reads every listed value, opens none but those it must check. */
export function scanColumns(deep = false): ColumnScan {
  const keys = colKeys();
  const cur = keys.current?.id || null;
  const out: ColumnScan = { current: cur, columns: [], plain: 0, current_key: 0, old_key: 0, unknown: 0, damaged: 0, unknownKeys: [] };
  const unknown = new Set<string>();
  for (const c of SEALED_COLUMNS) {
    const n: ColumnCount = { table: c.table, column: c.column, plain: 0, current: 0, old: 0, unknown: 0, damaged: 0 };
    for (const r of raw(`SELECT ${c.column} v FROM ${c.table} WHERE ${whereOf(c)}`)) {
      if (!isSealed(r.v)) { n.plain++; continue; }
      const p = parseSealed(r.v);
      if (!p) { n.damaged++; continue; }
      if (!keys.byId.has(p.keyId)) { n.unknown++; unknown.add(p.keyId); continue; }
      if (deep) {
        try {
          openStrict(r.v, keys);
        } catch {
          n.damaged++;
          continue;
        }
      }
      if (p.keyId === cur) n.current++;
      else n.old++;
    }
    out.columns.push(n);
    out.plain += n.plain; out.current_key += n.current; out.old_key += n.old; out.unknown += n.unknown; out.damaged += n.damaged;
  }
  out.unknownKeys = [...unknown];
  return out;
}

export type SweepResult = { sealed: number; moved: number; left: number; skipped: string | null };

/**
 * Seals every listed value that is in the clear, and moves values under an old key to the current one. At most
 * `limit` values in one call (the timer does a batch every tick; the script passes no limit). Answers what it did.
 */
export function sealColumns(o: { limit?: number; blobs?: string } = {}): SweepResult {
  const res: SweepResult = { sealed: 0, moved: 0, left: 0, skipped: null };
  const keys = colKeys();
  const k = keys.current;
  if (!k) return { ...res, skipped: 'FILE_ENCRYPTION_KEY is not set, so there is no key to encrypt with.' };
  if (storeState(o.blobs || path.join(dataDir(), 'blobs')).stop) return { ...res, skipped: 'Storing files is stopped because the key does not fit the stored files (see the warning when the server started). Nothing in the database was changed either.' };
  let budget = o.limit ?? Infinity;
  const d = db();
  const was = Number(d.prepare('PRAGMA secure_delete').get()?.secure_delete || 0);
  d.exec('PRAGMA secure_delete=ON');
  try {
    for (const c of SEALED_COLUMNS) {
      if (budget <= 0) break;
      // A value under a key we hold that is not the current one, or one in the clear. Sealed values carry their
      // key id inside, so all sealed values are read and the current ones passed over here.
      let after = 0;
      for (;;) {
        if (budget <= 0) break;
        const rows = raw(`SELECT rowid id, ${c.column} v FROM ${c.table} WHERE rowid > ? AND ${whereOf(c)} ORDER BY rowid LIMIT 500`, after);
        if (!rows.length) break;
        after = rows[rows.length - 1].id;
        const label = `${c.table}.${c.column}`;
        const work: { id: number; old: string; next: string; moved: boolean }[] = [];
        for (const r of rows) {
          let text: string;
          let moved = false;
          if (isSealed(r.v)) {
            const p = parseSealed(r.v);
            if (!p || p.keyId === k.id) continue;
            if (!keys.byId.has(p.keyId)) { res.left++; continue; }
            try {
              text = openStrict(r.v, keys);
            } catch (e) {
              if (!(e instanceof SealedValueProblem)) throw e;
              res.left++;
              continue;
            }
            moved = true;
          } else text = String(r.v).replace(/[\u0000\u0001]/g, '');
          if (!text) continue;
          // Values copied by SQL from another column keep the label they were written with; a value in the clear
          // takes the label of the column it is in.
          const next = sealWith(moved ? parseSealed(r.v)!.label : label, text, k);
          if (openStrict(next, keys) !== text) { res.left++; continue; }
          work.push({ id: r.id, old: r.v, next, moved });
          if (--budget <= 0) break;
        }
        if (work.length) {
          d.exec('BEGIN IMMEDIATE');
          try {
            const up = d.prepare(`UPDATE ${c.table} SET ${c.column}=? WHERE rowid=? AND ${c.column}=?`);
            for (const w of work) if (up.run(w.next, w.id, w.old).changes) res[w.moved ? 'moved' : 'sealed']++;
            d.exec('COMMIT');
          } catch (e) {
            d.exec('ROLLBACK');
            throw e;
          }
        }
      }
    }
  } finally {
    d.exec(`PRAGMA secure_delete=${was ? 'ON' : 'OFF'}`);
  }
  if (res.sealed || res.moved) {
    // The changed pages are in the write-ahead log until a checkpoint copies them over the old ones in sign.db.
    try {
      d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    console.error(`[database] ${values(res.sealed)} in the database encrypted with the current key, ${res.moved} moved from an old key to it.`);
  }
  return res;
}

const g = globalThis as any;
/** What the server says about the database when it starts, and on /app/operator. Null when there is nothing to say. */
export function databaseWarning(scan?: ColumnScan): string | null {
  const raw = (process.env.FILE_ENCRYPTION_KEY || '').trim();
  if (!raw) return 'Stored files and the signatures, typed answers, comments and emails in the database are kept readable on the disk. Run "npm run setup" (it writes FILE_ENCRYPTION_KEY into .env), restart, and keep a copy of the key apart from the backups.';
  if (!decodeFileKey(raw)) return 'The value of FILE_ENCRYPTION_KEY is not a key (a key is 32 bytes written in base64, like "npm run setup" makes), so storing files is stopped and nothing new is encrypted. Put back the key this server had and restart.';
  const s = scan ?? scanColumns();
  const lines: string[] = [];
  if (s.unknown) lines.push(`${values(s.unknown)} in the database ${s.unknown === 1 ? 'was' : 'were'} encrypted with a key this server does not have (key id ${s.unknownKeys.join(', key id ')}). ${s.unknown === 1 ? 'It cannot be shown and was' : 'They cannot be shown and were'} not changed. Add that key to FILE_ENCRYPTION_KEYS_OLD and restart.`);
  if (s.damaged) lines.push(`${values(s.damaged, 'encrypted ')} in the database ${s.damaged === 1 ? 'fails its' : 'fail their'} check and cannot be read with any key. Put the database back from a backup.`);
  return lines.length ? lines.join(' ') : null;
}
const values = (n: number, kind = '') => `${n} ${kind}${n === 1 ? 'value' : 'values'}`;

/** Once when the server starts: the warning in the log, then a first batch of the sweep. */
export function columnsAtStart(): void {
  if (g.__tscolstart) return;
  g.__tscolstart = true;
  try {
    const w = databaseWarning();
    if (w) console.error(`\n[database] ${w}\n`);
    sealColumns({ limit: 20_000 });
  } catch (e: any) {
    console.error('[database] could not look at the encrypted columns', e?.message);
  }
}

/** For the timer: a batch of the sweep. Answers how many values it sealed or moved. */
export function columnsTick(): number {
  if (!colKeys().current) return 0;
  const r = sealColumns({ limit: 5_000 });
  return r.sealed + r.moved;
}
