// npm run setup: what a new install needs before it starts. For now one thing: a key for FILE_ENCRYPTION_KEY, so the
// stored files and the encrypted columns of the database (src/server/colcrypt.ts) are encrypted from the first day.
//
// It writes the key into .env in the folder it is started in, readable only by its owner, and never replaces a key
// that is already set (in the environment, in .env.local or in .env): a new key in place of an old one would lock
// everything written with the old one. The key is not printed, so it does not end up in a log; it is in .env.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseEnv } from 'node:util';

const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const has = (text) => !!text && !!(parseEnv(text).FILE_ENCRYPTION_KEY || '').trim();

const where = (process.env.FILE_ENCRYPTION_KEY || '').trim() ? 'the environment' : has(read('.env.local')) ? '.env.local' : has(read('.env')) ? '.env' : null;
if (where) {
  console.log(`FILE_ENCRYPTION_KEY is already set in ${where}. It was left as it is: a new key in its place would lock everything written with it.`);
  process.exit(0);
}

const key = crypto.randomBytes(32).toString('base64');
const file = path.resolve('.env');
const before = read(file);
const line = `# Written by npm run setup on ${new Date().toISOString().slice(0, 10)}. Keep a copy of this key apart from the server and its backups.\nFILE_ENCRYPTION_KEY=${key}\n`;
fs.writeFileSync(file, before == null ? line : `${before.replace(/\n?$/, '\n')}${line}`, { mode: 0o600 });
try {
  fs.chmodSync(file, 0o600);
} catch {}
const data = path.join(path.resolve(process.env.DATA_DIR || './data'), 'sign.db');
console.log(`A new encryption key is in ${file} (FILE_ENCRYPTION_KEY). Stored files and the signatures, typed answers, comments, stored emails, decline reasons and help messages in the database are encrypted with it from the next start.`);
console.log('Keep a copy of it somewhere safe and apart from the server and its backups. Without it nobody can read what was encrypted with it, not even the people who wrote this software. A backup of the data folder alone cannot be read, which is the point.');
if (fs.existsSync(data)) console.log('This server already holds data. What was stored before stays as it was until you run: node scripts/encrypt-files.mjs and node scripts/encrypt-columns.mjs (the server also encrypts the database values by itself, a batch at a time).');
