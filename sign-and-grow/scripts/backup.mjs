// A consistent copy of everything the server stores, made while it runs: the database (DATA_DIR/sign.db) and the
// folder of stored files (DATA_DIR/blobs), into a new dated folder with a manifest of SHA-256 sums.
//
//   node scripts/backup.mjs [destination]     destination defaults to ./backups
//
// It reads DATA_DIR from the environment, and from .env.local and .env in the folder it is started in, as the server
// does. Use the same settings as the server.
//
// How it stays consistent without stopping the server:
//   1. Every stored file is copied. Stored files never change once written (each is named by the SHA-256 of its
//      contents), so a copy is good whenever it is made.
//   2. The database is copied with SQLite's own online backup (node:sqlite backup(), Node 22.16 and later), in one
//      step, so the copy is the database as it was at one moment. On an older Node, VACUUM INTO does the same.
//   3. Files written while that happened are copied too. So every file the copied database points at is in the copy.
//   4. The manifest is written last and the folder only then gets its final name. A backup that was stopped half way
//      is a folder ending in ".partial" with no manifest, and scripts/restore.mjs refuses it.
//
// What it never copies: FILE_ENCRYPTION_KEY, FILE_ENCRYPTION_KEYS_OLD and APP_SECRET. They are settings, not data,
// and a backup that holds the key to its own files protects nothing. When APP_SECRET is not set, the server made one
// and keeps it in DATA_DIR/secret: that file is left out too, and this script says so loudly, because a server
// restored without it cannot read back what was made with it (see docs/runbooks.md, "Restoring a backup"). Keep the
// keys in a secret store of your own, apart from the backups. The manifest holds only a check value for APP_SECRET
// (an HMAC, from which the secret cannot be worked out) and the ids of the file keys, so a restore can tell you
// whether it was given the right ones.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;

export const MANIFEST = 'manifest.json';
export const FORMAT = 'growsigning-backup';
const BLOB = /^[0-9a-f]{64}$/;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** The check value for APP_SECRET kept in the manifest: it shows whether two secrets are the same, and nothing more. */
export const secretCheck = (secret) => crypto.createHmac('sha256', String(secret)).update('growsigning backup: is this the same APP_SECRET').digest('hex').slice(0, 24);

// The key id an encrypted stored file names in its header (the format is in src/server/filecrypt.ts): 4 bytes of
// magic, a version byte, then 8 bytes of key id. A plain file has no header.
const MAGIC = Buffer.from([0x00, 0x65, 0x6e, 0x63]);
const keyIdOf = (buf) => (buf.length > 13 && buf.subarray(0, 4).equals(MAGIC) ? buf.subarray(5, 13).toString('hex') : null);

export function loadSettings(dir = process.cwd()) {
  for (const f of ['.env.local', '.env']) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parseEnv(text))) if (process.env[k] === undefined) process.env[k] = v;
  }
}

function writeSynced(file, data) {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const stamp = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');

/**
 * Makes one backup of `dataDir` inside `dest`. Answers what it did. `onStep(step)` is told 'files', 'database' and
 * 'late-files' as each part is done (the tests stop a backup there to show a partial one is refused).
 */
export async function backup({ dataDir, dest, env = process.env, now = new Date(), onStep = () => {} }) {
  const src = path.resolve(dataDir);
  const dbFile = path.join(src, 'sign.db');
  if (!fs.existsSync(dbFile)) throw new Error(`There is no database at ${dbFile}. Is DATA_DIR right?`);
  fs.mkdirSync(dest, { recursive: true });
  const name = `backup-${stamp(now)}`;
  const final = path.join(dest, name);
  const work = `${final}.partial`;
  if (fs.existsSync(final) || fs.existsSync(work)) throw new Error(`${final} is there already. Wait a second and run it again.`);
  fs.mkdirSync(path.join(work, 'blobs'), { recursive: true, mode: 0o700 });

  const files = new Map();
  const keyIds = new Set();
  const blobDir = path.join(src, 'blobs');
  const copyFiles = () => {
    let names = [];
    try {
      names = fs.readdirSync(blobDir);
    } catch {}
    for (const n of names) {
      if (!BLOB.test(n) || files.has(n)) continue;
      let buf;
      try {
        buf = fs.readFileSync(path.join(blobDir, n));
      } catch (e) {
        if (e.code === 'ENOENT') continue; // deleted by the server meanwhile: nothing points at it any more
        throw e;
      }
      writeSynced(path.join(work, 'blobs', n), buf);
      files.set(n, { path: `blobs/${n}`, size: buf.length, sha256: sha(buf) });
      const kid = keyIdOf(buf);
      if (kid) keyIds.add(kid);
    }
  };
  copyFiles();
  await onStep('files');

  const { DatabaseSync, backup: sqliteBackup } = process.getBuiltinModule('node:sqlite');
  const source = new DatabaseSync(dbFile);
  const out = path.join(work, 'sign.db');
  let method;
  try {
    source.exec('PRAGMA busy_timeout=10000');
    if (typeof sqliteBackup === 'function') {
      await sqliteBackup(source, out, { rate: -1 });
      method = 'sqlite-online-backup';
    } else {
      source.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
      method = 'vacuum-into';
    }
  } finally {
    source.close();
  }
  const copy = new DatabaseSync(out);
  let check;
  try {
    check = copy.prepare('PRAGMA quick_check').get();
  } finally {
    copy.close();
  }
  const ok = check && Object.values(check)[0] === 'ok';
  if (!ok) throw new Error(`The copy of the database failed SQLite's own check (${JSON.stringify(check)}). Nothing was kept as a backup; the folder ${work} is left for a look.`);
  for (const extra of ['sign.db-wal', 'sign.db-shm']) fs.rmSync(path.join(work, extra), { force: true });
  await onStep('database');
  copyFiles();
  await onStep('late-files');

  const dbBuf = fs.readFileSync(out);
  // What is in DATA_DIR besides the database and the stored files, said by name, so nothing is left out unseen.
  const leftOut = fs.readdirSync(src).filter((n) => !['sign.db', 'sign.db-wal', 'sign.db-shm', 'blobs'].includes(n));
  const fileSecret = leftOut.includes('secret');
  const secretValue = (env.APP_SECRET || '').trim() ? env.APP_SECRET : fileSecret ? fs.readFileSync(path.join(src, 'secret'), 'utf8').trim() : null;
  const manifest = {
    format: FORMAT, version: 1, made_at: now.toISOString(),
    made_with: { node: process.version, method },
    database: { path: 'sign.db', size: dbBuf.length, sha256: sha(dbBuf) },
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    left_out: leftOut,
    keys: {
      app_secret: (env.APP_SECRET || '').trim() ? 'setting' : fileSecret ? 'file' : 'none',
      app_secret_check: secretValue ? secretCheck(secretValue) : null,
      file_key_ids: [...keyIds].sort(),
    },
  };
  writeSynced(path.join(work, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(work, final);
  return { dir: final, manifest };
}

/** The lines to print after a backup: where it is, what is in it, and where the keys must be kept instead. */
export function backupReport(r) {
  const m = r.manifest;
  const bytes = m.files.reduce((n, f) => n + f.size, 0) + m.database.size;
  const lines = [
    `Backup made: ${r.dir}`,
    `The database (${(m.database.size / 1e6).toFixed(1)} MB, copied with ${m.made_with.method}) and ${m.files.length} stored file${m.files.length === 1 ? '' : 's'}, ${(bytes / 1e6).toFixed(1)} MB in all. Every file is listed with its SHA-256 in ${MANIFEST}.`,
    'Not in the backup, on purpose: FILE_ENCRYPTION_KEY, FILE_ENCRYPTION_KEYS_OLD and APP_SECRET. Keep them in a secret store of your own, apart from the backups. A restore needs them.',
  ];
  if (m.keys.file_key_ids.length) lines.push(`The stored files are encrypted with the key${m.keys.file_key_ids.length === 1 ? '' : 's'} with id ${m.keys.file_key_ids.join(', ')}. "node scripts/encrypt-files.mjs --check" shows the id of each key you have.`);
  if (m.keys.app_secret === 'file')
    lines.push('', 'LOOK: APP_SECRET is not set. The server made one itself and keeps it in DATA_DIR/secret, which this backup leaves out. Copy that value into your secret store now and set APP_SECRET to it. A server restored without it cannot check the records of click-to-agree terms, links in emails already sent stop working, and people who were given the welcome signatures get them again.');
  const other = m.left_out.filter((n) => n !== 'secret');
  if (other.length) lines.push(`Also left out of DATA_DIR, because they are not the server's data: ${other.join(', ')}.`);
  return lines;
}

if (isMain) {
  loadSettings();
  const dest = path.resolve(process.argv[2] || './backups');
  if (process.argv.length > 3 || dest === '--help') {
    console.error('Usage: node scripts/backup.mjs [destination folder]');
    process.exit(2);
  }
  try {
    const r = await backup({ dataDir: process.env.DATA_DIR || './data', dest });
    for (const l of backupReport(r)) console.log(l);
  } catch (e) {
    console.error(`No backup was made: ${e.message}`);
    process.exit(1);
  }
}
