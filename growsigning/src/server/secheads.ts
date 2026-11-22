// The daily note of where every account's security record stood, written OUTSIDE the database (SECURITY_HEADS_DIR).
//
// The security record (seclog.ts) is a chain of keyed fingerprints, and security_heads holds the newest line of each
// account. Both live in the database. So two things stay unseen from inside it: an older copy of the whole database
// put back, and a record rewritten by someone who holds the database and APP_SECRET together. This file closes
// those two as far as a folder can: once a day the timer writes one line per account (the day, the account's id, the
// number of its newest line, that line's fingerprint and its time) to a new file in a folder the operator names.
// Opening Settings, Security then also compares the record with the newest of those files.
//
// What it is worth depends on the folder: keep it on storage the app's own user can add to but that is copied away
// or made write-once by the operator (docs/runbooks.md). Someone who can rewrite the folder too is not shown. With
// SECURITY_HEADS_DIR unset nothing is written, nothing is compared, and nothing on any screen mentions it.
//
// A file holds no name, no address and nothing of a line's words: ids, numbers, fingerprints and times only.
import fs from 'node:fs';
import path from 'node:path';
import { all, get } from './db.ts';
import { securityLogDays } from '../lib/policy.ts';

/** The folder the daily notes go to, or null when the setting is not there. */
export const headsDir = (env: Record<string, string | undefined> = process.env): string | null => (env.SECURITY_HEADS_DIR || '').trim() || null;

const NAME = /^security-heads-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** How many of the newest daily files the check on the screen reads. */
export const HEAD_FILES_CHECKED = 7;

let saidWhy = '';
const complain = (e: any) => {
  const why = String(e?.code || e?.message || e);
  if (why !== saidWhy) console.error(`[security record] The daily note could not be written to SECURITY_HEADS_DIR (${why}). The record itself is not affected.`);
  saidWhy = why;
};

/**
 * Writes today's file if it is not there yet: one line per account that has a record. Returns how many lines were
 * written, 0 when today's file exists already, null when the setting is not there or the folder cannot be written
 * to (said once in the server's log, never thrown: the timer goes on).
 */
export function exportSecurityHeads(at: Date = new Date()): number | null {
  const dir = headsDir();
  if (!dir) return null;
  const day = at.toISOString().slice(0, 10);
  const file = path.join(dir, `security-heads-${day}.jsonl`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) return 0;
    const rows = all('SELECT account_id, seq, hash, at FROM security_heads ORDER BY account_id');
    const text = rows.map((r) => JSON.stringify({ day, account: r.account_id, seq: r.seq, hash: r.hash, at: r.at })).join('\n') + (rows.length ? '\n' : '');
    // Written whole under another name and then given its name, and never over a file that is there.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    try {
      fs.linkSync(tmp, file);
    } catch (e: any) {
      if (e?.code === 'EEXIST') return 0;
      // A file store without hard links: copied instead, still never over a file that is there.
      fs.copyFileSync(tmp, file, fs.constants.COPYFILE_EXCL);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    saidWhy = '';
    return rows.length;
  } catch (e) {
    complain(e);
    return null;
  }
}

/**
 * Compares one account's record with the newest daily notes. null: nothing to compare with (no setting, no file, or
 * no line about this account). Otherwise ok, or why not: "line" when a line that was noted now has another
 * fingerprint, "missing" when a line that was noted is not there though it is too new for the purge.
 */
export function checkSecurityHeads(accountId: string): { ok: boolean; why: 'line' | 'missing' | null; day: string | null; seq: number | null } | null {
  const dir = headsDir();
  if (!dir) return null;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => NAME.test(f)).sort().slice(-HEAD_FILES_CHECKED);
  } catch {
    return null;
  }
  const keptSince = Date.now() - securityLogDays() * 864e5;
  let seen = false;
  for (const f of files.reverse()) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes(accountId)) continue;
      let note: any;
      try {
        note = JSON.parse(line);
      } catch {
        continue;
      }
      if (note?.account !== accountId || !Number.isInteger(note.seq) || typeof note.hash !== 'string') continue;
      seen = true;
      const day = NAME.exec(f)![1];
      const row = get('SELECT hash FROM security_events WHERE account_id=? AND seq=?', accountId, note.seq);
      if (row) {
        if (row.hash !== note.hash) return { ok: false, why: 'line', day, seq: note.seq };
        continue;
      }
      // Not there. Fine only when the timer deleted it for its age.
      if (!(Date.parse(note.at) < keptSince)) return { ok: false, why: 'missing', day, seq: note.seq };
    }
  }
  return seen ? { ok: true, why: null, day: null, seq: null } : null;
}
