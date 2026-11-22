// Encrypts the values in the database that were written before FILE_ENCRYPTION_KEY was set, and moves values sealed
// with an old key (one listed in FILE_ENCRYPTION_KEYS_OLD) to the current key. Which columns those are, and the
// format, are the server's own (src/server/colcrypt.ts, src/server/colsweep.ts), so what this writes is exactly what
// the server reads. The server does the same a batch at a time when it starts and on its timer; this does all of it
// at once. It is the companion of scripts/encrypt-files.mjs, which does the stored files.
//
//   node scripts/encrypt-columns.mjs             encrypt what is not encrypted with the current key yet
//   node scripts/encrypt-columns.mjs --check     only look: count every value, change nothing
//   node scripts/encrypt-columns.mjs --new-key   print a new key to put in FILE_ENCRYPTION_KEY
//
// It reads DATA_DIR, FILE_ENCRYPTION_KEY and FILE_ENCRYPTION_KEYS_OLD from the environment, and from .env.local and
// .env in the folder it is started in, as the server does (a value already in the environment wins). It can run while
// the server runs: a row is changed only if it still holds exactly what was read, so nothing a person saves
// meanwhile is lost. A value it cannot open (a key that is not in the settings, or a damaged value) is counted and
// left exactly as it is.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;
const args = process.argv.slice(2);

if (isMain && args.includes('--new-key')) {
  console.log(crypto.randomBytes(32).toString('base64'));
  console.error('A new key. Keep a copy somewhere safe and apart from the server and its backups: without it nobody can read what was encrypted with it, not even the people who wrote this software. Put it in FILE_ENCRYPTION_KEY. If a key was set before, move that one to FILE_ENCRYPTION_KEYS_OLD.');
  process.exit(0);
}
if (isMain && args.some((a) => a !== '--check')) {
  console.error('Usage: node scripts/encrypt-columns.mjs [--check | --new-key]');
  process.exit(2);
}

// The settings, as the server would see them: the environment first, then .env.local, then .env. Read before the
// database is opened, because DATA_DIR says where it is.
for (const f of ['.env.local', '.env']) {
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const [k, v] of Object.entries(parseEnv(text))) if (process.env[k] === undefined) process.env[k] = v;
}

let sweep;
try {
  sweep = await import('../src/server/colsweep.ts');
} catch (e) {
  // Node before 22.18 needs a flag to read the TypeScript the server is written in. Run again with it.
  if (e?.code !== 'ERR_UNKNOWN_FILE_EXTENSION' || !isMain) throw e;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SELF, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const { scanColumns, sealColumns } = sweep;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

if (isMain) {
  const check = args.includes('--check');
  const dbFile = path.join(path.resolve(process.env.DATA_DIR || './data'), 'sign.db');
  if (!fs.existsSync(dbFile)) {
    console.error(`There is no database at ${dbFile}. Is DATA_DIR right? Nothing was changed.`);
    process.exit(2);
  }
  const lines = [`Database: ${dbFile}`];
  let r = null;
  try {
    if (!check) r = sealColumns();
  } catch (e) {
    console.error(`Stopped: ${e.message}. Every value is either as it was or fully encrypted. Run this again.`);
    process.exit(1);
  }
  const s = scanColumns(true);
  lines.push(s.current ? `Current key: key id ${s.current}.` : 'No key in the settings (FILE_ENCRYPTION_KEY is not set).');
  if (r?.skipped) lines.push(r.skipped, 'Nothing was changed.');
  else if (r) lines.push(`Encrypted now: ${r.sealed}. Moved from an old key to the current one: ${r.moved}.`);
  lines.push(`${plural(s.current_key, 'value is', 'values are')} encrypted with the current key and read back correctly.`);
  lines.push(`${plural(s.plain, 'value is', 'values are')} not encrypted${s.current && check ? ' and would be encrypted by a run without --check' : ''}.`);
  if (s.old_key) lines.push(`${plural(s.old_key, 'value is', 'values are')} encrypted with an old key${s.current ? ' and would be moved to the current one' : ''}.`);
  if (s.unknown) lines.push(`${plural(s.unknown, 'value was', 'values were')} encrypted with a key that is not in the settings (key id ${s.unknownKeys.join(', key id ')}). They were left as they are. Add that key to FILE_ENCRYPTION_KEYS_OLD and run this again.`);
  if (s.damaged) lines.push(`${plural(s.damaged, 'value fails', 'values fail')} its check and cannot be read with any key. They were left as they are. Put the database back from a backup.`);
  for (const c of s.columns) if (c.plain || c.old || c.unknown || c.damaged) lines.push(`  ${c.table}.${c.column}: ${c.plain} not encrypted, ${c.old} under an old key, ${c.unknown} under a missing key, ${c.damaged} damaged.`);
  const ok = !s.unknown && !s.damaged && (check || (!!s.current && !r?.skipped && !s.plain && !s.old_key));
  if (ok && !check) lines.push('Every value in the listed columns is now encrypted with the current key.');
  for (const l of lines) (ok ? console.log : console.error)(l);
  process.exit(r?.skipped ? 2 : ok ? 0 : 1);
}
