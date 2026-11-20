import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// SQLite via Node's built-in driver: no native build step, one file on disk.
// getBuiltinModule keeps bundlers from trying to resolve `node:sqlite` themselves.

const g = globalThis as any;

export const dataDir = () => path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || './data');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, verify_token TEXT,
  title TEXT, company TEXT, signature_png TEXT, initials_png TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'seedling',
  brand_color TEXT, brand_logo TEXT, default_reminder_days INTEGER NOT NULL DEFAULT 0,
  default_expire_days INTEGER NOT NULL DEFAULT 120,
  stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, PRIMARY KEY (account_id, user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL, created_at TEXT NOT NULL, accepted_at TEXT
);
CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, account_id TEXT, sha256 TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
  pages INTEGER NOT NULL, page_sizes TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, sender_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'envelope', status TEXT NOT NULL DEFAULT 'draft',
  subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', ordered INTEGER NOT NULL DEFAULT 0,
  reminder_days INTEGER NOT NULL DEFAULT 0, expire_days INTEGER NOT NULL DEFAULT 120, expires_at TEXT,
  folder TEXT, template_id TEXT, powerform_id TEXT, bulk_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT, completed_at TEXT, last_reminder_at TEXT,
  void_reason TEXT, final_sha256 TEXT, final_size INTEGER, sheets INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS envelopes_account ON envelopes(account_id, kind, status);
CREATE INDEX IF NOT EXISTS envelopes_final ON envelopes(final_sha256);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_env ON documents(envelope_id);
CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'signer', role_name TEXT, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  routing_order INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  token TEXT UNIQUE, access_code TEXT, note TEXT, sent_at TEXT, viewed_at TEXT, completed_at TEXT,
  decline_reason TEXT, consent_at TEXT, ip TEXT, user_agent TEXT, signature_png TEXT, initials_png TEXT, reassigned_from TEXT
);
CREATE INDEX IF NOT EXISTS recipients_env ON recipients(envelope_id);
CREATE INDEX IF NOT EXISTS recipients_email ON recipients(email);
CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL, recipient_id TEXT, type TEXT NOT NULL, page INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, required INTEGER NOT NULL DEFAULT 1,
  label TEXT, value TEXT, options TEXT, group_name TEXT, validation TEXT, readonly INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fields_env ON fields(envelope_id);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, envelope_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ip TEXT, user_agent TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_env ON audit(envelope_id, seq);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, company TEXT, created_at TEXT NOT NULL, UNIQUE(account_id, email)
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, url TEXT NOT NULL,
  secret TEXT NOT NULL, events TEXT NOT NULL DEFAULT '*', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT NOT NULL, event TEXT NOT NULL, envelope_id TEXT,
  status INTEGER, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_email TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL,
  link TEXT, envelope_id TEXT, status TEXT NOT NULL, error TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS powerforms (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, template_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bulk_batches (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, sender_id TEXT NOT NULL, template_id TEXT NOT NULL, name TEXT NOT NULL,
  total INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, account_id TEXT, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  account_id TEXT NOT NULL, key TEXT NOT NULL, envelope_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (account_id, key)
);
CREATE TABLE IF NOT EXISTS credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT NOT NULL,
  at TEXT NOT NULL, UNIQUE (account_id, reason, ref)
);
CREATE INDEX IF NOT EXISTS credits_account ON credits(account_id);
CREATE TABLE IF NOT EXISTS retired_tokens (token TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, retired_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS abuse_reports (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL, account_id TEXT NOT NULL, reporter TEXT, reason TEXT NOT NULL, detail TEXT,
  ip TEXT, status TEXT NOT NULL DEFAULT 'open', at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS support_requests (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, topic TEXT NOT NULL, message TEXT NOT NULL, envelope_id TEXT,
  user_id TEXT, account_id TEXT, status TEXT NOT NULL DEFAULT 'open', at TEXT NOT NULL
);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS never alters an existing table, so each
// one is added here if it is missing. Only ever append to this list.
const COLUMNS: [table: string, column: string, definition: string][] = [
  ['users', 'notify', 'TEXT'],
  ['users', 'locale', 'TEXT'],
  ['accounts', 'suspended_at', 'TEXT'],
  ['accounts', 'suspended_reason', 'TEXT'],
  ['accounts', 'renews_at', 'TEXT'],
  ['accounts', 'cancel_at', 'TEXT'],
  ['payments', 'receipt_url', 'TEXT'],
  ['payments', 'charge_id', 'TEXT'],
  ['payments', 'refunded_at', 'TEXT'],
  ['recipients', 'check_code', 'TEXT'],
  ['recipients', 'locale', 'TEXT'],
  ['envelopes', 'test_mode', 'INTEGER NOT NULL DEFAULT 0'],
  ['envelopes', 'locale', 'TEXT'],
  ['webhook_deliveries', 'body', 'TEXT'],
  ['envelopes', 'expiry_warned_at', 'TEXT'],
  ['recipients', 'muted', 'INTEGER NOT NULL DEFAULT 0'],
  ['accounts', 'cancel_ref', 'TEXT'],
  ['accounts', 'dormant_nudged_at', 'TEXT'],
  ['envelopes', 'date_format', 'TEXT'],
  ['users', 'closing_at', 'TEXT'],
  ['accounts', 'closing_at', 'TEXT'],
  ['files', 'text', 'TEXT'],
  ['recipients', 'unopened_alerted_at', 'TEXT'],
  ['recipients', 'dead_link_alerted_at', 'TEXT'],
  ['webhooks', 'alerted_at', 'TEXT'],
  ['payments', 'kind', "TEXT NOT NULL DEFAULT 'plan'"],
  ['payments', 'credits', 'INTEGER NOT NULL DEFAULT 0'],
  ['payments', 'refunded_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['powerforms', 'alerted_at', 'TEXT'],
  ['accounts', 'promo_code', 'TEXT'],
  ['accounts', 'promo_at', 'TEXT'],
];

function migrate(d: any) {
  for (const [table, column, definition] of COLUMNS) {
    const have = d.prepare(`PRAGMA table_info(${table})`).all().some((c: any) => c.name === column);
    if (!have) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  d.exec('CREATE INDEX IF NOT EXISTS recipients_check ON recipients(check_code)');
}

export function db(): any {
  if (!g.__tsdb) {
    const dir = dataDir();
    fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
    const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite');
    const d = new DatabaseSync(path.join(dir, 'sign.db'));
    d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    d.exec(SCHEMA);
    migrate(d);
    g.__tsdb = d;
  }
  return g.__tsdb;
}

const norm = (p: any[]) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
export const all = (sql: string, ...p: any[]): any[] => db().prepare(sql).all(...norm(p)).map((r: any) => ({ ...r }));
export const get = (sql: string, ...p: any[]): any => {
  const r = db().prepare(sql).get(...norm(p));
  return r ? { ...r } : null;
};
export const run = (sql: string, ...p: any[]) => db().prepare(sql).run(...norm(p));

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// Content-addressed blob store on disk.
const blobPath = (sha: string) => path.join(dataDir(), 'blobs', sha);
export function saveBlob(buf: Uint8Array): string {
  db();
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (!fs.existsSync(blobPath(sha))) fs.writeFileSync(blobPath(sha), buf);
  return sha;
}
export function readBlob(sha: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('bad blob id');
  return fs.readFileSync(blobPath(sha));
}

// Server secret used for HMACs. Set APP_SECRET in production; otherwise one is generated and kept in the data dir.
export function secret(): string {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  if (!g.__tssecret) {
    db();
    const f = path.join(dataDir(), 'secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    g.__tssecret = fs.readFileSync(f, 'utf8').trim();
  }
  return g.__tssecret;
}
