// Encrypts the stored files that were written before FILE_ENCRYPTION_KEY was set, and moves files written with an old
// key (one listed in FILE_ENCRYPTION_KEYS_OLD) to the current key. The format is the server's own, from
// src/server/filecrypt.ts, so what this writes is exactly what the server reads.
//
//   node scripts/encrypt-files.mjs             encrypt what is not encrypted with the current key yet
//   node scripts/encrypt-files.mjs --check     only look: count, check every file, change nothing
//   node scripts/encrypt-files.mjs --new-key   print a new key to put in FILE_ENCRYPTION_KEY
//
// It reads DATA_DIR, FILE_ENCRYPTION_KEY and FILE_ENCRYPTION_KEYS_OLD from the environment, and from .env.local and
// .env in the folder it is started in, as the server does (a value already in the environment wins). Use the same
// settings as the server. Stop the server first: a file the server deletes while this runs (because nothing points at
// it any more) is then not brought back.
//
// Why it cannot lose a file: each file is encrypted into a new file next to it, that file is flushed to the disk,
// read back and checked (it must open with the current key and come out with the fingerprint the file is named by),
// and only then does it take the name of the plain copy, in one step. At every moment the name holds either the old
// file or the whole new one. Stopping it at any point, or a crash, leaves at most a half-written hidden file, which
// the next run removes. Running it again skips what is done. Files it cannot read are listed and left as they are.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;

let fc;
try {
  fc = await import('../src/server/filecrypt.ts');
} catch (e) {
  // Node before 22.18 needs a flag to read the TypeScript the server is written in. Run again with it.
  if (e?.code !== 'ERR_UNKNOWN_FILE_EXTENSION' || !isMain) throw e;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SELF, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const { fileKeys, openFile, sealFile, readHeader, sha256hex, isBlobName, syncDir, FORMAT_VERSION } = fc;

const OWN_TMP = /^\.([0-9a-f]{64})\.e\d+-[0-9a-f]{12}$/;
const SERVER_TMP = /^\.([0-9a-f]{64})\.w\d+-[0-9a-f]{12}$/;
const LOCK = '.encrypt-files.lock';

// Only one run at a time. A lock left by a run that was killed names a process that no longer exists, and is taken over.
function lock(dir) {
  const file = path.join(dir, LOCK);
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try {
        alive = !!pid && pid !== process.pid && (process.kill(pid, 0), true);
      } catch {}
      if (alive) throw Object.assign(new Error(`Another run of this script is going (process ${pid}). Wait for it to finish. If no other run is going, delete ${file} and start again.`), { code: 'LOCKED' });
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not take ${file}.`);
}

/**
 * Does the work on one folder of stored files. `env` holds the key settings. `check` only looks. `onStep(step, name)`
 * is told 'written' (the new file is on the disk) and 'checked' (it was read back) for each file, before it takes the
 * name: the tests stop a run there to show nothing is lost.
 */
export function encryptFiles({ dir, env = process.env, check = false, onStep = () => {}, now = Date.now() } = {}) {
  const keys = fileKeys(env);
  const out = { dir, keyIds: [...keys.byId.keys()], current: keys.current?.id || null, problems: keys.problems, plain: 0, encrypted: 0, reencrypted: 0, already: 0, wouldEncrypt: 0, wouldReencrypt: 0, leftovers: 0, gone: 0, damaged: [], unknown: [], newer: [], failed: [], other: [] };
  if (keys.badCurrent) return { ...out, stop: 'FILE_ENCRYPTION_KEY is set but is not a key.' };
  if (!keys.current && !check) return { ...out, stop: 'FILE_ENCRYPTION_KEY is not set, so there is no key to encrypt with.' };
  if (!fs.existsSync(dir)) return { ...out, stop: `There is no folder of stored files at ${dir}. Is DATA_DIR right?` };
  const unlock = check ? () => {} : lock(dir);
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === LOCK) continue;
      if (name.startsWith('.')) {
        // A file this script was writing when an earlier run stopped, or one the server was writing when it crashed
        // (an hour old: the server writes a file in well under a second). The real file under that name is untouched.
        const own = OWN_TMP.test(name);
        if (!own && !SERVER_TMP.test(name)) continue;
        if (!check && (own || now - fs.statSync(path.join(dir, name)).mtimeMs > 3600_000)) (fs.rmSync(path.join(dir, name), { force: true }), out.leftovers++);
        continue;
      }
      if (!isBlobName(name)) {
        out.other.push(name);
        continue;
      }
      const file = path.join(dir, name);
      let raw, before;
      try {
        before = fs.statSync(file);
        raw = fs.readFileSync(file);
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw e;
      }
      let data;
      let old = false;
      if (sha256hex(raw) === name) {
        data = raw;
        out.plain++;
      } else {
        const h = readHeader(raw);
        if (!h || h === 'damaged') {
          out.damaged.push(name);
          continue;
        }
        if (h.version !== FORMAT_VERSION) {
          out.newer.push(name);
          continue;
        }
        if (!keys.byId.has(h.keyId)) {
          out.unknown.push({ name, keyId: h.keyId });
          continue;
        }
        try {
          data = openFile(raw, name, keys).data;
        } catch {
          out.damaged.push(name);
          continue;
        }
        if (keys.current && h.keyId === keys.current.id) {
          out.already++;
          continue;
        }
        old = true;
      }
      if (check || !keys.current) {
        out[old ? 'wouldReencrypt' : 'wouldEncrypt']++;
        continue;
      }
      const sealed = sealFile(data, name, keys.current);
      const tmp = path.join(dir, `.${name}.e${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
      try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try {
          fs.writeSync(fd, sealed);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        out.failed.push({ name, why: `could not write the encrypted copy: ${e.message}` });
        continue;
      }
      onStep('written', name);
      // Read back from the disk, not from memory: what counts is what is there.
      let ok = false;
      try {
        const back = openFile(fs.readFileSync(tmp), name, keys);
        ok = back.keyId === keys.current.id && back.data.equals(data);
      } catch {}
      if (!ok) {
        fs.rmSync(tmp, { force: true });
        out.failed.push({ name, why: 'the encrypted copy did not read back the same, so the original was kept' });
        continue;
      }
      onStep('checked', name);
      // Only now does the original go, and only if it is still the file we read: gone means the server deleted it
      // meanwhile, and changed means the server wrote it again. Either way it is left to the server.
      let now2;
      try {
        now2 = fs.statSync(file);
      } catch {}
      if (!now2 || now2.ino !== before.ino || now2.size !== before.size || now2.mtimeMs !== before.mtimeMs) {
        fs.rmSync(tmp, { force: true });
        out.gone++;
        continue;
      }
      fs.renameSync(tmp, file);
      syncDir(dir);
      out[old ? 'reencrypted' : 'encrypted']++;
    }
  } finally {
    unlock();
  }
  return out;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The summary a person reads, and whether everything is done. */
export function report(r, check = false) {
  const lines = [];
  if (r.problems.length) lines.push(...r.problems.map((p) => `Settings: ${p}`));
  if (r.stop) return { ok: false, lines: [...lines, r.stop, 'Nothing was changed.'] };
  lines.push(`Folder: ${r.dir}`);
  lines.push(r.keyIds.length ? `Keys in the settings: ${r.keyIds.map((k) => `key id ${k}${k === r.current ? ' (current: new files are written with it)' : ' (old: only read)'}`).join(', ')}.` : 'No key in the settings.');
  if (check) {
    if (r.current) lines.push(`${plural(r.already, 'file is', 'files are')} encrypted with the current key and read back correctly.`);
    lines.push(`${plural(r.wouldEncrypt, 'file is', 'files are')} not encrypted${r.current ? ' and would be encrypted by a run without --check' : ''}.`);
    if (r.wouldReencrypt) lines.push(`${plural(r.wouldReencrypt, 'file is', 'files are')} encrypted with an old key${r.current ? ' and would be moved to the current one' : ''}.`);
  } else {
    lines.push(`Encrypted now: ${r.encrypted}. Moved from an old key to the current one: ${r.reencrypted}. Already done before: ${r.already}.`);
    if (r.leftovers) lines.push(`Removed ${plural(r.leftovers, 'half-written copy', 'half-written copies')} left by a run that was stopped (the files themselves were not touched).`);
    if (r.gone) lines.push(`${plural(r.gone, 'file was', 'files were')} deleted or written again by the server while this ran, and left to it.`);
  }
  if (r.unknown.length) {
    const by = {};
    for (const u of r.unknown) by[u.keyId] = (by[u.keyId] || 0) + 1;
    lines.push(`${plural(r.unknown.length, 'file was', 'files were')} encrypted with a key that is not in the settings (${Object.entries(by).map(([k, n]) => `key id ${k}: ${n}`).join(', ')}). They were left as they are. Add that key to FILE_ENCRYPTION_KEYS_OLD and run this again.`);
  }
  if (r.damaged.length) lines.push(`${plural(r.damaged.length, 'file fails', 'files fail')} its check and cannot be read with any key: ${r.damaged.join(', ')}. They were left as they are. Put them back from a backup.`);
  if (r.newer.length) lines.push(`${plural(r.newer.length, 'file was', 'files were')} written by a newer version of the software and left alone: ${r.newer.join(', ')}.`);
  if (r.failed.length) lines.push(...r.failed.map((f) => `Not done, and the original is kept: ${f.name}: ${f.why}. Run this again.`));
  if (r.other.length) lines.push(`${plural(r.other.length, 'name in the folder is', 'names in the folder are')} not a stored file and ${r.other.length === 1 ? 'was' : 'were'} left alone: ${r.other.slice(0, 10).join(', ')}.`);
  const ok = !r.unknown.length && !r.damaged.length && !r.newer.length && !r.failed.length && (check || !!r.current);
  if (ok && !check) lines.push('Every stored file is now encrypted with the current key.');
  return { ok, lines };
}

// The settings, as the server would see them: the environment first, then .env.local, then .env.
function loadSettings() {
  for (const f of ['.env.local', '.env']) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parseEnv(text))) if (process.env[k] === undefined) process.env[k] = v;
  }
}

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--new-key')) {
    console.log(crypto.randomBytes(32).toString('base64'));
    console.error('A new key. Keep a copy somewhere safe and apart from the server and its backups: without it nobody can read what was encrypted with it, not even the people who wrote this software. Put it in FILE_ENCRYPTION_KEY. If a key was set before, move that one to FILE_ENCRYPTION_KEYS_OLD.');
    process.exit(0);
  }
  if (args.some((a) => a !== '--check')) {
    console.error('Usage: node scripts/encrypt-files.mjs [--check | --new-key]');
    process.exit(2);
  }
  loadSettings();
  const check = args.includes('--check');
  const dir = path.join(path.resolve(process.env.DATA_DIR || './data'), 'blobs');
  let r;
  try {
    r = encryptFiles({ dir, check });
  } catch (e) {
    console.error(e.code === 'LOCKED' ? e.message : `Stopped: ${e.message}. Every file is either as it was or fully encrypted. Run this again.`);
    process.exit(1);
  }
  const { ok, lines } = report(r, check);
  for (const l of lines) (ok ? console.log : console.error)(l);
  process.exit(r.stop ? 2 : ok ? 0 : 1);
}
