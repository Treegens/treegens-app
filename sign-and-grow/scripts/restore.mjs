// Puts a backup made by scripts/backup.mjs into a new, empty folder, after checking that it is whole, and then checks
// what was put there the way the server reads it.
//
//   node scripts/restore.mjs <backup folder> <new DATA_DIR>          check, copy, then check the copy
//   node scripts/restore.mjs <backup folder> <new DATA_DIR> --no-check   the same without the last check
//   node scripts/restore.mjs --verify <backup folder>                 only check the backup, copy nothing
//
// It refuses, and copies nothing, when the backup is not whole: a folder that ends in ".partial" (a backup that was
// stopped half way), no manifest, a file the manifest lists that is missing, shorter, longer or different from its
// SHA-256. It never writes into a folder that has anything in it, so a restore cannot overwrite a running server's
// data. The copy is made in "<new DATA_DIR>.restoring" and only takes its name when every file is in and checked.
//
// The check afterwards, with the settings in the environment (and .env.local and .env, as the server reads them):
// every audit trail's hash chain and every account's security record chain is recomputed by the server's own code,
// every stored file is opened with FILE_ENCRYPTION_KEY (and FILE_ENCRYPTION_KEYS_OLD) and must give back the SHA-256
// it is named by, and APP_SECRET is compared with the check value in the manifest. Give it the same keys as the
// server that made the backup: they are never in a backup (scripts/backup.mjs says why).
//
// Exit codes: 0 restored and every check passed; 1 refused, nothing restored; 3 restored, but a check found something
// to put right before the server is started on it (it says what).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MANIFEST, FORMAT, secretCheck, loadSettings } from './backup.mjs';

const SELF = fileURLToPath(import.meta.url);
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const BLOB = /^[0-9a-f]{64}$/;

/** Whether a backup folder is whole. Answers the manifest and every reason it is not. Reads every file once. */
export function verifyBackup(dir) {
  const problems = [];
  const warnings = [];
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return { ok: false, problems: [`There is no folder at ${abs}.`], warnings, manifest: null };
  if (abs.endsWith('.partial')) problems.push('This backup was stopped before it finished (its folder still ends in ".partial"). Make a new one.');
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(abs, MANIFEST), 'utf8'));
  } catch (e) {
    problems.push(e.code === 'ENOENT' ? `There is no ${MANIFEST} in it, so it is not a whole backup: the manifest is written last, and a backup that stopped half way has none.` : `${MANIFEST} cannot be read (${e.message}).`);
    return { ok: false, problems, warnings, manifest: null };
  }
  if (manifest?.format !== FORMAT || manifest?.version !== 1 || !manifest.database || !Array.isArray(manifest.files)) {
    problems.push(`${MANIFEST} is not one this script made, or is from a newer version of it.`);
    return { ok: false, problems, warnings, manifest: null };
  }
  const listed = [manifest.database, ...manifest.files];
  for (const f of listed) {
    if (typeof f?.path !== 'string' || !(f.path === 'sign.db' || /^blobs\/[0-9a-f]{64}$/.test(f.path))) {
      problems.push(`${MANIFEST} lists a file this script never writes: ${JSON.stringify(f?.path)}.`);
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(path.join(abs, f.path));
    } catch {
      problems.push(`${f.path} is missing.`);
      continue;
    }
    if (buf.length !== f.size) problems.push(`${f.path} is ${buf.length} bytes, and the manifest says ${f.size}: it was cut short or changed.`);
    else if (sha(buf) !== f.sha256) problems.push(`${f.path} is not the file that was backed up: its SHA-256 differs from the manifest.`);
  }
  try {
    const have = new Set(manifest.files.map((f) => f.path.slice(6)));
    const extra = fs.readdirSync(path.join(abs, 'blobs')).filter((n) => !have.has(n));
    if (extra.length) warnings.push(`${extra.length} file${extra.length === 1 ? '' : 's'} in blobs/ ${extra.length === 1 ? 'is' : 'are'} not in the manifest and will not be restored: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ' and more' : ''}.`);
  } catch {
    if (manifest.files.length) problems.push('The folder blobs/ is missing.');
  }
  return { ok: problems.length === 0, problems, warnings, manifest };
}

function copySynced(from, to) {
  const buf = fs.readFileSync(from);
  const fd = fs.openSync(to, 'w', 0o600);
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

/** Copies a whole backup into `target`, which must not exist or be empty. Throws, having changed nothing, when it may not. */
export function restoreInto(backupDir, target) {
  const v = verifyBackup(backupDir);
  if (!v.ok) throw Object.assign(new Error(v.problems.join(' ')), { code: 'NOT_WHOLE', problems: v.problems });
  const dest = path.resolve(target);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw Object.assign(new Error(`${dest} is not empty. Restore into a new, empty folder, then point DATA_DIR at it. Nothing was copied.`), { code: 'NOT_EMPTY' });
  const work = `${dest}.restoring`;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'blobs'), { recursive: true, mode: 0o700 });
  for (const f of [v.manifest.database, ...v.manifest.files]) {
    const buf = copySynced(path.join(path.resolve(backupDir), f.path), path.join(work, f.path));
    if (sha(buf) !== f.sha256) throw new Error(`${f.path} changed while it was being copied. Nothing was restored; ${work} is left for a look.`);
  }
  if (fs.existsSync(dest)) fs.rmdirSync(dest);
  fs.renameSync(work, dest);
  return { dir: dest, manifest: v.manifest, warnings: v.warnings };
}

/**
 * Checks a restored folder the way the server reads it: every audit chain, every security record chain, every stored
 * file with the keys in `env`, and APP_SECRET against the manifest. Uses the server's own code with DATA_DIR set to
 * `dir`, so run it in a process of its own (the CLI does).
 */
export async function checkRestored(dir, manifest, env = process.env) {
  process.env.DATA_DIR = path.resolve(dir);
  const { all } = await import('../src/server/db.ts');
  const { verifyChain } = await import('../src/server/envelopes.ts');
  const { verifySecurityChain } = await import('../src/server/seclog.ts');
  const { fileKeys, openFile, StoredFileProblem, sha256hex } = await import('../src/server/filecrypt.ts');
  const out = { envelopes: 0, chains_broken: [], accounts: 0, security_broken: [], files: 0, files_ok: 0, files_locked: [], files_damaged: [], secret: 'ok', problems: [] };
  const ids = all('SELECT id FROM envelopes UNION SELECT DISTINCT envelope_id id FROM audit').map((r) => r.id);
  for (const id of ids) {
    out.envelopes++;
    if (!verifyChain(id).ok) out.chains_broken.push(id);
  }
  for (const { account_id } of all('SELECT DISTINCT account_id FROM security_events')) {
    out.accounts++;
    if (!verifySecurityChain(account_id).ok) out.security_broken.push(account_id);
  }
  const keys = fileKeys(env);
  for (const n of fs.readdirSync(path.join(dir, 'blobs')).filter((x) => BLOB.test(x))) {
    out.files++;
    try {
      const { data } = openFile(fs.readFileSync(path.join(dir, 'blobs', n)), n, keys);
      if (sha256hex(data) === n) out.files_ok++;
      else out.files_damaged.push(n);
    } catch (e) {
      if (!(e instanceof StoredFileProblem)) throw e;
      (e.why === 'no-key' || e.why === 'newer' ? out.files_locked : out.files_damaged).push(n);
    }
  }
  const want = manifest.keys?.app_secret_check;
  const given = (env.APP_SECRET || '').trim() ? env.APP_SECRET : fs.existsSync(path.join(dir, 'secret')) ? fs.readFileSync(path.join(dir, 'secret'), 'utf8').trim() : null;
  if (want && !given) out.secret = 'missing';
  else if (want && secretCheck(given) !== want) out.secret = 'different';
  if (out.chains_broken.length) out.problems.push(`${out.chains_broken.length} audit trail${out.chains_broken.length === 1 ? ' does' : 's do'} not check: ${out.chains_broken.slice(0, 5).join(', ')}. The backup holds them as they were on the disk it was made from.`);
  if (out.security_broken.length) out.problems.push(`The security record of ${out.security_broken.length} account${out.security_broken.length === 1 ? '' : 's'} does not check: ${out.security_broken.slice(0, 5).join(', ')}.`);
  if (out.files_locked.length) out.problems.push(`${out.files_locked.length} stored file${out.files_locked.length === 1 ? ' needs' : 's need'} a key that was not given${manifest.keys?.file_key_ids?.length ? ` (the backup's files use key id ${manifest.keys.file_key_ids.join(', ')})` : ''}. Set FILE_ENCRYPTION_KEY (and FILE_ENCRYPTION_KEYS_OLD) as on the server that made the backup, and run this check again.`);
  if (out.files_damaged.length) out.problems.push(`${out.files_damaged.length} stored file${out.files_damaged.length === 1 ? ' does' : 's do'} not open to the contents it is named by: ${out.files_damaged.slice(0, 5).join(', ')}.`);
  if (out.secret === 'missing') out.problems.push(`APP_SECRET is not set. The server that made this backup used ${manifest.keys.app_secret === 'file' ? 'a secret it made itself and kept in DATA_DIR/secret, which a backup never holds' : 'APP_SECRET'}. Set APP_SECRET to that value before you start the server on this folder: without it, click-to-agree records cannot be checked, links in emails already sent stop working, and welcome signatures are given again.`);
  if (out.secret === 'different') out.problems.push('APP_SECRET is not the one the backup was made with. Set the one from the server that made it before you start the server on this folder.');
  return out;
}

if (isMain) {
  const args = process.argv.slice(2);
  loadSettings();
  if (args[0] === '--verify' && args.length === 2) {
    const v = verifyBackup(args[1]);
    for (const l of [...v.problems, ...v.warnings]) console.error(l);
    console.log(v.ok ? `The backup in ${path.resolve(args[1])} is whole: every file the manifest lists is there with its SHA-256.` : 'The backup is not whole. Do not rely on it.');
    process.exit(v.ok ? 0 : 1);
  }
  const noCheck = args.includes('--no-check');
  const rest = args.filter((a) => a !== '--no-check');
  if (rest.length !== 2 || rest.some((a) => a.startsWith('--'))) {
    console.error('Usage: node scripts/restore.mjs <backup folder> <new DATA_DIR> [--no-check]\n       node scripts/restore.mjs --verify <backup folder>');
    process.exit(2);
  }
  let r;
  try {
    r = restoreInto(rest[0], rest[1]);
  } catch (e) {
    console.error(`Nothing was restored. ${e.message}`);
    process.exit(1);
  }
  for (const w of r.warnings) console.error(w);
  console.log(`Restored into ${r.dir}: the database and ${r.manifest.files.length} stored file${r.manifest.files.length === 1 ? '' : 's'}, each checked against the manifest.`);
  if (noCheck) process.exit(0);
  // The check uses the server's code, which reads TypeScript: Node before 22.18 needs a flag for that.
  const flags = process.features?.typescript ? [] : ['--experimental-strip-types'];
  const child = spawnSync(process.execPath, [...flags, '--no-warnings', '--input-type=module', '-e',
    `const m = await import(${JSON.stringify(SELF)}); const r = await m.checkRestored(${JSON.stringify(r.dir)}, ${JSON.stringify(r.manifest)}); console.log(JSON.stringify(r));`], { encoding: 'utf8', env: process.env });
  const line = (child.stdout || '').trim().split('\n').pop();
  let c;
  try {
    c = JSON.parse(line);
  } catch {
    console.error(`The check could not run: ${(child.stderr || child.stdout || '').trim().slice(-800)}`);
    process.exit(3);
  }
  console.log(`Checked: ${c.envelopes} audit trail${c.envelopes === 1 ? '' : 's'}, the security records of ${c.accounts} account${c.accounts === 1 ? '' : 's'}, ${c.files_ok} of ${c.files} stored files opened to their SHA-256.`);
  for (const p of c.problems) console.error(p);
  if (!c.problems.length) console.log(`Everything checks. Point DATA_DIR at ${r.dir} and start the server with the same keys.`);
  process.exit(c.problems.length ? 3 : 0);
}
