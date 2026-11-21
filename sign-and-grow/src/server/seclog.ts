// The security record of an account: who signed in, and who changed what. One line per event and account in
// security_events (db.ts), kept for SECURITY_LOG_DAYS. Triggers in db.ts refuse an UPDATE, a DELETE before the days
// are over, and an INSERT over a number already used. Each line carries a fingerprint of itself and of the line
// before, keyed with the server's secret (APP_SECRET), and security_heads holds the newest line of each account under
// the same key. So a line rewritten, or the newest lines taken away, by someone who can write the database but does
// not have the secret, shows on the screen. Someone who has both, or who puts back an older copy of the whole
// database, does not show: an account that needs a copy nobody here can change sends the record to its own system.
// What a line is about is named by ids only. Call sites never write a password, token, code or key, and values that
// look like one are left out (clean below), also from the browser's name. Names a person typed (an account's name,
// a key's name) are written as typed. Nothing from a document is written.
// The admins read it under Settings, Security; a security system pulls it with an admin key
// (GET /account/security-events) or hears it through a webhook that asks for "security.event". Five alerts email the
// admins, at most once an hour each; what the hour held back is said in one more email when the hour is over.
//
// Call record() with one line where something happens. It never throws: a line that cannot be written is said in the
// server log, and what the person did goes on.
import { all, get, run } from './db.ts';
import { hmac, now, baseUrl, id } from './util.ts';
import { sendMail } from './mail.ts';
import { deliver } from './webhooks.ts';
import type { Ctx } from './router.ts';
import type { Auth } from './auth.ts';
import type { ZipEntry } from './zip.ts';
import { SECURITY_KINDS, SECURITY_KIND_LIST, SECURITY_ALERTS, isSecurityKind, securityLogWords, securityDetail, securityDevice, type SecurityKind, type ActorType, type SecurityAlert } from '../lib/seclog.ts';
import { SOURCE_LOCALE, t } from '../lib/i18n.ts';
import { securityLogDays, ALERT_FAILED_SIGNINS_HOUR, ALERT_DELETES_HOUR, ALERT_EVERY_MINUTES, KEY_NEW_ADDRESS_PER_DAY } from '../lib/policy.ts';
import { stampText } from '../lib/dates.ts';

export type Who = { type: ActorType; id?: string | null };
export type SecurityOpts = {
  /** The request: its internet address and browser, and who did it (the person or the key) unless `by` says. */
  c?: Ctx | null;
  /** Who did it, when that is not the person or key of the request: the person signing in, an operator, the system. */
  by?: Who | null;
  /** The accounts it is written to. Without this and `member`: the account of the request. */
  accounts?: string | (string | null | undefined)[] | null;
  /** Written to every account this login belongs to (a sign-in, a password change). */
  member?: string | null;
  /** What it is about, by kind and id: ['user', id], ['api_key', id], ['envelope', id] and the like. */
  about?: [type: string, id: string | null | undefined] | null;
  details?: Record<string, unknown>;
  failed?: boolean;
  ip?: string | null;
  ua?: string | null;
};

// ---- Writing ----------------------------------------------------------------------------------------------------

// Names of details that are never kept, and values that look like a key, a signing secret or a password hash. Every
// call site writes only what it chose; this is the second line, so a careless detail cannot put a secret in for 400 days.
const SECRET_NAME = /password|secret|token|cookie|^(code|codes|otp|key|hash|key_hash|pass|pw)$/i;
const SECRET_VALUE = /tsk_[A-Za-z0-9_-]{6,}|whsec_|scrypt\$|-----BEGIN/;
function clean(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return SECRET_VALUE.test(v) ? '[left out]' : v.slice(0, 300);
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) if (!SECRET_NAME.test(k) && x !== undefined) out[k] = clean(x, depth + 1);
    return out;
  }
  return null;
}

export function actorOf(c?: Ctx | null): Who {
  if (c?.auth?.via === 'api_key') return { type: 'api_key', id: c.auth.keyId || null };
  if (c?.user) return { type: 'user', id: c.user.id };
  return { type: 'system', id: null };
}

const memberAccounts = (userId: string): string[] => all('SELECT account_id FROM memberships WHERE user_id=?', userId).map((m) => m.account_id as string);

// Keyed with the server's secret: whoever can write the table but does not have the secret cannot make a line, or a
// chain of lines, that checks. The same key signs the newest line of each account (security_heads).
const lineHash = (prev: string, accountId: string, r: any, key?: string) =>
  hmac(`security-record-line:${JSON.stringify([prev, accountId, r.at, r.actor_type, r.actor_id || '', r.kind, r.outcome, r.about_type || '', r.about_id || '', r.details, r.ip || '', r.ua || ''])}`, key);
const headMac = (accountId: string, seq: number, hash: string, at: string, key?: string) => hmac(`security-record-head:${JSON.stringify([accountId, Number(seq), hash, at])}`, key);
// After APP_SECRET was changed (docs/runbooks.md), lines written under the secret before still check when that one
// is given as APP_SECRET_RETIRED (several separated by commas). Only for checking: new lines use the secret of today.
const retired = (): string[] => String(process.env.APP_SECRET_RETIRED || '').split(',').map((x) => x.trim()).filter(Boolean);
const lineChecks = (prev: string, accountId: string, r: any) => r.hash === lineHash(prev, accountId, r) || retired().some((k) => r.hash === lineHash(prev, accountId, r, k));
const headChecks = (h: any) => h.mac === headMac(h.account_id, h.seq, h.hash, h.at) || retired().some((k) => h.mac === headMac(h.account_id, h.seq, h.hash, h.at, k));
// What a browser calls itself is whatever the caller sent: something in it that looks like a key or a secret is
// left out like in the details.
const cleanUa = (ua: unknown): string | null => {
  const s = String(ua ?? '').slice(0, 300);
  return !s ? null : SECRET_VALUE.test(s) || /\b(bearer|basic)\s+\S{8,}/i.test(s) ? '[left out]' : s;
};

/** Writes one line to each account it belongs to. Answers how many lines were written. */
export function record(kind: SecurityKind, o: SecurityOpts = {}): number {
  try {
    if (!isSecurityKind(kind)) throw new Error(`"${kind}" is not a kind of security event`);
    const who = o.by || actorOf(o.c);
    const ids = [...new Set((o.accounts !== undefined && o.accounts !== null ? [o.accounts].flat() : o.member ? memberAccounts(o.member) : [o.c?.account?.id]).filter(Boolean) as string[])];
    // An operator is staff of whoever runs this server, and the system is nobody: neither leaves an address behind.
    const own = who.type === 'user' || who.type === 'api_key';
    const ip = own ? (o.ip ?? o.c?.ip ?? null) : null;
    const ua = own ? cleanUa(o.ua ?? o.c?.ua) : null;
    const line = {
      at: now(), actor_type: who.type, actor_id: who.id || null, kind, outcome: o.failed ? 'failure' : 'success',
      about_type: o.about?.[1] ? o.about[0] : null, about_id: o.about?.[1] || null,
      details: JSON.stringify(clean(o.details || {})), ip: ip && ip !== 'unknown' ? ip : null, ua,
    };
    const seqs: number[] = [];
    for (const accountId of ids) {
      if (!get('SELECT 1 x FROM accounts WHERE id=?', accountId)) continue;
      const prev = get('SELECT hash FROM security_events WHERE account_id=? ORDER BY seq DESC LIMIT 1', accountId)?.hash || '';
      const hash = lineHash(prev, accountId, line);
      // The line and the note of which line is the newest are written together or not at all, also inside a
      // transaction of the caller (a savepoint nests where BEGIN cannot).
      run('SAVEPOINT security_line');
      try {
        const seq = Number(run('INSERT INTO security_events (account_id, at, actor_type, actor_id, ip, ua, kind, outcome, about_type, about_id, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          accountId, line.at, line.actor_type, line.actor_id, line.ip, line.ua, kind, line.outcome, line.about_type, line.about_id, line.details, prev, hash).lastInsertRowid);
        run('INSERT INTO security_heads (account_id, seq, hash, at, mac) VALUES (?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET seq=excluded.seq, hash=excluded.hash, at=excluded.at, mac=excluded.mac',
          accountId, seq, hash, line.at, headMac(accountId, seq, hash, line.at));
        run('RELEASE security_line');
        seqs.push(seq);
      } catch (e) {
        run('ROLLBACK TO security_line');
        run('RELEASE security_line');
        throw e;
      }
    }
    // Alerts and webhooks after the statement that called this has finished: inside a transaction that is undone,
    // the lines are gone again and nothing is sent about them (afterwards reads them back first).
    if (seqs.length) setImmediate(() => void afterwards(seqs).catch((e) => console.error('[seclog] after', kind, e)));
    return seqs.length;
  } catch (e) {
    console.error('[seclog] could not write', kind, e);
    return 0;
  }
}

// ---- Sign-ins -------------------------------------------------------------------------------------------------

const methodOf = (via?: string | null): string => (via ? String(via).toLowerCase() : 'password');

/** A session was made for this person (signInAs). `passed`: after a code; a remembered device shows on the request. */
export function signedIn(c: Ctx, u: any, via?: string | null, passed?: boolean) {
  const step = passed ? 'code' : (c as any).twoStepPassed ? 'remembered_device' : null;
  record('signin.succeeded', { c, by: { type: 'user', id: u.id }, member: u.id, about: ['user', u.id], details: { method: methodOf(via), ...(step ? { second_step: step } : {}) } });
}
/** A new login was made and signed in at once (createLogin in routes-account.ts): sign-up, with a password or a provider. */
export function signedUp(c: Ctx, u: any, via?: string | null) {
  if (!u?.id) return;
  record('signin.succeeded', { c, by: { type: 'user', id: u.id }, member: u.id, about: ['user', u.id], details: { method: via ? methodOf(via) : 'sign_up', new_login: true } });
}
/** A sign-in that was refused for a wrong password, or for a wrong code at the second step. A login with two-step
 * login never shows which of the two it was (twostep.ts), so the record of such a login does not either. */
export function signInFailed(c: Ctx, u: any, reason: 'wrong_password' | 'wrong_password_or_code', via?: string | null) {
  if (!u?.id) return;
  record('signin.failed', { c, by: { type: 'user', id: u.id }, member: u.id, about: ['user', u.id], failed: true, details: { method: methodOf(via), reason } });
}

// ---- API keys from new addresses -----------------------------------------------------------------------------

/** Every request with a key (router.ts): the first time a key is used from an address, a line says so. */
export function keyUsedFrom(auth: Auth | null, ip: string, ua: string) {
  if (auth?.via !== 'api_key' || !auth.keyId || !ip || ip === 'unknown') return;
  try {
    if (get('SELECT 1 x FROM api_key_addresses WHERE key_id=? AND ip=?', auth.keyId, ip)) return;
    // A key that keeps arriving from new addresses (a leaked key behind many proxies) writes a limited number of lines
    // a day. The addresses past the limit are not remembered, so they are written on a later day.
    const today = get("SELECT COUNT(*) n FROM security_events WHERE account_id=? AND kind='api_key.new_address' AND about_id=? AND at > ?", auth.account.id, auth.keyId, new Date(Date.now() - 864e5).toISOString()).n;
    if (today >= KEY_NEW_ADDRESS_PER_DAY) return;
    const first = !get('SELECT 1 x FROM api_key_addresses WHERE key_id=?', auth.keyId);
    if (!run('INSERT OR IGNORE INTO api_key_addresses (key_id, ip, at) VALUES (?,?,?)', auth.keyId, ip, now()).changes) return;
    record('api_key.new_address', { accounts: auth.account.id, by: { type: 'api_key', id: auth.keyId }, about: ['api_key', auth.keyId], ip, ua, details: { first_use: first } });
  } catch (e) {
    console.error('[seclog] key address', e);
  }
}

// ---- Settings -----------------------------------------------------------------------------------------------

/** One line for the settings that changed between two rows: "value" settings with what they were and are, the
 * personal or bulky ones ("changed") only by name. Nothing is written when nothing changed. */
export function settingsChanged(o: SecurityOpts, before: any, after: any, fields: Record<string, 'value' | 'changed'>) {
  const settings: Record<string, unknown> = {};
  for (const [k, how] of Object.entries(fields)) {
    const a = before?.[k] ?? null, b = after?.[k] ?? null;
    if (String(a) === String(b)) continue;
    settings[k] = how === 'value' ? { from: a, to: b } : { changed: true };
  }
  if (Object.keys(settings).length) record('settings.changed', { ...o, details: { ...(o.details || {}), settings } });
}

// ---- Reading --------------------------------------------------------------------------------------------------

// A name or an email address is given only for someone who is on this team now. A line about someone who has left
// names them by id alone: what they are called today, and where they can be reached today, is not this team's.
const memberNow = (accountId: string, uid: string) => get('SELECT u.name, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id=?', accountId, uid);
const userName = (uid: string) => get('SELECT name, email FROM users WHERE id=?', uid);
/** How one line leaves the app for a machine (the API and the webhook). People are named by their id; by their
 * name and email address too only when the account switched that on (security_log_emails) and they are on the team. */
export function eventView(r: any, emails: boolean) {
  const person = (type: string, uid: string | null) => {
    if (!emails || type !== 'user' || !uid) return {};
    const u = memberNow(r.account_id, uid);
    return u ? { name: u.name, email: u.email } : {};
  };
  let details: any = {};
  try {
    details = JSON.parse(r.details || '{}');
  } catch {}
  return {
    seq: r.seq, at: r.at, kind: r.kind, what: SECURITY_KINDS[r.kind as SecurityKind] || r.kind, outcome: r.outcome,
    actor: { type: r.actor_type, id: r.actor_id, ...person(r.actor_type, r.actor_id) },
    about: r.about_type ? { type: r.about_type, id: r.about_id, ...person(r.about_type, r.about_id) } : null,
    ip: r.ip, user_agent: r.ua, details, prev_hash: r.prev_hash, hash: r.hash,
  };
}
export const emailsOn = (accountId: string): boolean => !!get('SELECT security_log_emails e FROM accounts WHERE id=?', accountId)?.e;

/** For an admin who is signed in (the screen, their download, their export), who sees the team anyway: people and
 * keys by the names they have now, a document by its title, the browser as "Mac, Safari", the details as
 * sentences. Never an id in the words. */
export function screenView(r: any) {
  const v = eventView(r, false);
  const w = (key: string, vars: Record<string, any> = {}) => t(SOURCE_LOCALE, `security.who.${key}`, vars);
  const nameOf = (type: string, oid: string | null): string => {
    if (type === 'system') return w('system');
    if (type === 'operator') return w('operator');
    if (!oid) return w('unknown');
    // An admin of an organisation above the account was never on its team: named with their organisation
    // ("Grace Central of Government of Example"), as the line itself kept them, never as someone who left.
    if (type === 'user') return memberNow(r.account_id, oid)?.name || (v.details?.by_organisation || /^org\./.test(r.kind) ? (v.details?.by_name && v.details?.organisation ? `${v.details.by_name} of ${v.details.organisation}` : v.details?.organisation ? `an admin of ${v.details.organisation}` : '') : '') || w('gone_user');
    if (type === 'api_key') {
      const k = get('SELECT name, prefix FROM api_keys WHERE id=? AND account_id=?', oid, r.account_id);
      return k ? w('key', { name: k.name, prefix: k.prefix }) : w('gone_key');
    }
    if (type === 'invite') {
      // Only while it is open: once accepted, the address is that of a person, who may have left since.
      const i = get('SELECT email FROM invites WHERE id=? AND account_id=? AND accepted_at IS NULL', oid, r.account_id);
      return i ? w('invite', { email: i.email }) : w('gone_invite');
    }
    if (type === 'webhook') return v.details?.host ? w('webhook', { host: v.details.host }) : w('other');
    if (type === 'envelope' || type === 'template') {
      const e = get('SELECT subject title FROM envelopes WHERE id=? AND account_id=?', oid, r.account_id);
      return e?.title ? w(type === 'template' ? 'template' : 'document', { title: e.title }) : w('gone_document');
    }
    if (type === 'account') return '';
    return w('other');
  };
  return { ...v, actor_name: nameOf(r.actor_type, r.actor_id), about_name: v.about ? nameOf(v.about.type, v.about.id) || null : null,
    device: securityDevice(r.ua), said: securityDetail(r.kind, v.details) };
}

export type Filter = { kinds?: string[]; person?: string | null; from?: string | null; to?: string | null; q?: string | null };
export function filterSql(accountId: string, f: Filter): [string, any[]] {
  const w = ['account_id=?'];
  const p: any[] = [accountId];
  const kinds = (f.kinds || []).filter(isSecurityKind);
  if (kinds.length) (w.push(`kind IN (${kinds.map(() => '?').join(',')})`), p.push(...kinds));
  if (f.person) (w.push("(actor_id=? OR (about_type='user' AND about_id=?))"), p.push(f.person, f.person));
  if (f.from) (w.push('at >= ?'), p.push(f.from));
  if (f.to) (w.push('at < ?'), p.push(f.to));
  // The search box: every word typed has to be found in a line, in what happened, in the name or email address of
  // a person on the team, in the name of a key, in the internet address or in the details.
  for (const word of String(f.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5)) {
    const any: string[] = ["instr(lower(details), ?) > 0", "instr(lower(COALESCE(ip, '')), ?) > 0"];
    const vals: any[] = [word, word];
    const hit = SECURITY_KIND_LIST.filter((k) => SECURITY_KINDS[k].toLowerCase().includes(word) || (word === 'failed' && k === 'signin.failed'));
    if (hit.length) (any.push(`kind IN (${hit.map(() => '?').join(',')})`), vals.push(...hit));
    if (word === 'failed') any.push("outcome='failure'");
    const ids = [
      ...all('SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND (instr(lower(u.name), ?) > 0 OR instr(lower(u.email), ?) > 0) LIMIT 50', accountId, word, word),
      ...all('SELECT id FROM api_keys WHERE account_id=? AND instr(lower(name), ?) > 0 LIMIT 50', accountId, word),
    ].map((x) => x.id);
    if (ids.length) (any.push(`(actor_id IN (${ids.map(() => '?').join(',')}) OR about_id IN (${ids.map(() => '?').join(',')}))`), vals.push(...ids, ...ids));
    w.push(`(${any.join(' OR ')})`);
    p.push(...vals);
  }
  return [w.join(' AND '), p];
}

// A browser's name, a key's name and an account's name are words anyone may have typed. A spreadsheet runs a cell
// that starts with = + - @ as a formula, so such a cell gets a ' in front and opens as the text it is.
const cell = (v: any) => {
  const t = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
};
export const CSV_HEAD = ['seq', 'at', 'kind', 'what', 'said', 'outcome', 'actor_type', 'actor_id', 'actor_name', 'actor_email', 'about_type', 'about_id', 'about_name', 'about_email', 'ip', 'user_agent', 'details', 'hash'];
/** One line of the file. `named`: for an admin who is signed in, with the names the screen shows. Email addresses
 * only when the account switched them on. */
export function csvLine(r: any, emails: boolean, named = false): string {
  const v = eventView(r, emails) as any;
  const s = named ? screenView(r) : null;
  return [v.seq, v.at, v.kind, v.what, securityDetail(r.kind, v.details).join(' '), v.outcome, v.actor.type, v.actor.id, s ? s.actor_name : v.actor.name, v.actor.email, v.about?.type, v.about?.id, s ? s.about_name : v.about?.name, v.about?.email, v.ip, v.user_agent, JSON.stringify(v.details), v.hash].map(cell).join(',');
}

/** How many of the newest lines the screen checks each time it opens. An account with more has its older lines
 * checked by whoever pulls them: each line names the fingerprint of the one before. */
export const CHAIN_CHECK_MAX = 20_000;

/**
 * Checks the newest lines of one account (up to `max`): every line's fingerprint, that each follows the one before,
 * and that the newest line is the one last noted in security_heads. `why`: "line" when a line does not match (it was
 * changed, or put in, outside the app), "missing" when the newest lines are gone, or the note itself was changed.
 * Lines older than the days are gone by design, so the first line kept points at one that is not there any more:
 * that is where checking starts. What this cannot show is said at the top of this file.
 */
export function verifySecurityChain(accountId: string, max = CHAIN_CHECK_MAX): { ok: boolean; lines: number; checked: number; head: string; broken_at: number | null; why: 'line' | 'missing' | null } {
  const lines = Number(get('SELECT COUNT(*) n FROM security_events WHERE account_id=?', accountId).n);
  const rows = all('SELECT * FROM (SELECT * FROM security_events WHERE account_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq', accountId, max);
  let prev = rows[0]?.prev_hash || '';
  for (const r of rows) {
    if (r.prev_hash !== prev || !lineChecks(prev, accountId, r)) return { ok: false, lines, checked: rows.length, head: prev, broken_at: r.seq, why: 'line' };
    prev = r.hash;
  }
  const head = get('SELECT * FROM security_heads WHERE account_id=?', accountId);
  const last = rows[rows.length - 1];
  const out = { lines, checked: rows.length, head: prev };
  if (!head) return last ? { ok: false, ...out, broken_at: null, why: 'missing' } : { ok: true, ...out, broken_at: null, why: null };
  if (!headChecks(head)) return { ok: false, ...out, broken_at: null, why: 'missing' };
  if (last && last.seq === head.seq && last.hash === head.hash) return { ok: true, ...out, broken_at: null, why: null };
  if (last && last.seq > head.seq) return { ok: false, ...out, broken_at: last.seq, why: 'line' };
  // The newest line noted is not there. That is as it should be only when it was old enough for the purge.
  const kept = Number(get('SELECT days FROM security_log_keep WHERE id=1')?.days) || securityLogDays();
  const purged = Date.parse(head.at) < Date.now() - kept * 864e5;
  return purged && !last ? { ok: true, ...out, broken_at: null, why: null } : { ok: false, ...out, broken_at: null, why: 'missing' };
}

/** How many lines one file of the export holds, so a long record is never one very large text in memory. */
export const EXPORT_FILE_LINES = 50_000;
/** The record as files in the account's export (routes-trust.ts), for admins: CSV, oldest first, with the names the
 * screen shows. One file, or several of EXPORT_FILE_LINES lines each. */
export function* securityExport(accountId: string, perFile = EXPORT_FILE_LINES): Generator<ZipEntry> {
  const emails = emailsOn(accountId);
  const head = CSV_HEAD.map(cell).join(',');
  const total = Number(get('SELECT COUNT(*) n FROM security_events WHERE account_id=?', accountId).n);
  let after = 0;
  for (let file = 1; ; file++) {
    const rows = all('SELECT * FROM security_events WHERE account_id=? AND seq > ? ORDER BY seq LIMIT ?', accountId, after, perFile);
    if (!rows.length && file > 1) return;
    yield { name: total > perFile ? `security/security-events-${file}.csv` : 'security/security-events.csv', data: Buffer.from('﻿' + [head, ...rows.map((r) => csvLine(r, emails, true))].join('\r\n')) };
    if (rows.length < perFile) return;
    after = rows[rows.length - 1].seq;
  }
}

// ---- Keeping ------------------------------------------------------------------------------------------------------

/** The timer (cron.ts): lines older than SECURITY_LOG_DAYS go, and so do lines of accounts that no longer exist, and
 * the note of an address a key was used from that long ago (used from there again, it is a new address again). */
export function purgeSecurityLog(): number {
  const days = securityLogDays();
  run('UPDATE security_log_keep SET days=? WHERE id=1', days);
  const cut = new Date(Date.now() - days * 864e5).toISOString();
  const n = Number(run('DELETE FROM security_events WHERE at < ?', cut).changes) + Number(run('DELETE FROM security_events WHERE account_id NOT IN (SELECT id FROM accounts)').changes);
  run('DELETE FROM security_alerts_sent WHERE at < ? AND held = 0', new Date(Date.now() - 864e5).toISOString());
  run('DELETE FROM api_key_addresses WHERE at < ?', cut);
  return n;
}
export const securityWords = () => securityLogWords(securityLogDays());

// ---- Alerts and the webhook ----------------------------------------------------------------------------------

export const alertsOff = (a: any): SecurityAlert[] => {
  try {
    const l = JSON.parse(a?.security_alerts_off || '[]');
    return Array.isArray(l) ? l.filter((x) => x in SECURITY_ALERTS) : [];
  } catch {
    return [];
  }
};

const admins = (accountId: string) => all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", accountId);
const hourAgo = () => new Date(Date.now() - 3600_000).toISOString();
const alertEvery = () => new Date(Date.now() - ALERT_EVERY_MINUTES * 60_000).toISOString();

/** True when this is the first time in the hour for this account and name (an alert, or "an alert was switched
 * off"): decided in one statement, so two at the same moment are one. Otherwise it is counted as held back. */
export function oncePerHour(accountId: string, rule: string): boolean {
  if (run('INSERT INTO security_alerts_sent (account_id, rule, at) VALUES (?,?,?) ON CONFLICT(account_id, rule) DO UPDATE SET at=excluded.at, held=0 WHERE security_alerts_sent.at <= ?',
    accountId, rule, now(), alertEvery()).changes) return true;
  run('UPDATE security_alerts_sent SET held = held + 1 WHERE account_id=? AND rule=?', accountId, rule);
  return false;
}

const ALERT_FOOT = 'We send this alert at most once an hour. Every line is listed under Settings, Security, where an admin can also switch this alert off. Nobody at GrowSigning watches the record for you: this email is the alert.';
async function alert(accountId: string, rule: SecurityAlert, subject: string, lines: string[]) {
  const a = get('SELECT id, name, security_alerts_off FROM accounts WHERE id=?', accountId);
  if (!a || alertsOff(a).includes(rule)) return;
  // At most once an hour for each alert and account. What the hour holds back is said when it is over (sendHeldAlerts).
  if (!oncePerHour(accountId, rule)) return;
  for (const m of admins(accountId))
    await sendMail({ to: m.email, subject: `Security alert for ${a.name}: ${subject}`, heading: subject, lines: [...lines, ALERT_FOOT],
      cta: { label: 'Open Settings, Security', url: `${baseUrl()}/app/settings?tab=security` } });
}

// The kinds of line behind each alert, for the email that follows an hour in which more of them happened.
const ALERT_KINDS: Record<SecurityAlert, SecurityKind[]> = {
  failed_signins: ['signin.failed'], api_key_created: ['api_key.created'], owner_handed_over: ['owner.handed_over'], everything_exported: ['export.made'], many_deleted: ['envelope.deleted', 'envelope.purged'],
};
/**
 * The timer (cron.ts): an alert that fired again within its hour sent no second email then. Once the hour is over,
 * the admins get one email that says what else happened since, so nothing an alert is for goes unsaid: a second API
 * key made minutes after the first is named here. Answers how many emails of this kind went out.
 */
export async function sendHeldAlerts(): Promise<number> {
  let sent = 0;
  for (const h of all('SELECT * FROM security_alerts_sent WHERE held > 0 AND at <= ?', alertEvery())) {
    // Taken first, in one statement, so two timers never both send it.
    if (!run('UPDATE security_alerts_sent SET held=0, at=? WHERE account_id=? AND rule=? AND held > 0 AND at=?', now(), h.account_id, h.rule, h.at).changes) continue;
    const a = get('SELECT id, name, security_alerts_off FROM accounts WHERE id=?', h.account_id);
    if (h.rule.startsWith('off:')) {
      // An alert that was switched off again within the hour of the email that said so: still off now, say it once more.
      const rule = h.rule.slice(4) as SecurityAlert;
      if (a && rule in SECURITY_ALERTS && alertsOff(a).includes(rule)) for (const m of admins(a.id)) {
        await sendMail({ to: m.email, subject: `A security alert of ${a.name} is switched off`, heading: 'A security alert is switched off',
          lines: [`This alert was switched on and off more than once in the last hour, and is off now: ${SECURITY_ALERTS[rule]}.`, 'What it is about is still written to the security record, but nobody is emailed about it. If that was not agreed, switch it on again under Settings, Security.'],
          cta: { label: 'Open Settings, Security', url: `${baseUrl()}/app/settings?tab=security` } });
        sent++;
      }
      continue;
    }
    if (!a || !(h.rule in SECURITY_ALERTS) || alertsOff(a).includes(h.rule)) continue;
    const kinds = ALERT_KINDS[h.rule as SecurityAlert];
    // The lines that were held back: the newest of their kind, as many as were counted.
    const rows = all(`SELECT * FROM security_events WHERE account_id=? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 400`, a.id, ...kinds)
      .filter((r) => h.rule !== 'everything_exported' || JSON.parse(r.details || '{}').everything).slice(0, Math.min(Number(h.held), 200)).reverse();
    if (!rows.length) continue;
    const said = rows.slice(0, 20).map((r) => `${at(r)}: ${SECURITY_KINDS[r.kind as SecurityKind]}, by ${whoSaid(r)}${from(r)}. ${securityDetail(r.kind, JSON.parse(r.details || '{}')).join(' ')}`.trim());
    for (const m of admins(a.id)) {
      await sendMail({ to: m.email, subject: `Security alert for ${a.name}: ${rows.length} more since the last alert`, heading: 'More happened since the last alert',
        lines: [`After our alert "${SECURITY_ALERTS[h.rule as SecurityAlert]}", this also happened in ${a.name} while we were holding further emails of that alert back:`, said.join('\n'),
          ...(rows.length > said.length ? [`And ${rows.length - said.length} more: they are all under Settings, Security.`] : []), ALERT_FOOT],
        cta: { label: 'Open Settings, Security', url: `${baseUrl()}/app/settings?tab=security` } });
      sent++;
    }
  }
  return sent;
}

const whoSaid = (r: any): string => {
  if (r.actor_type === 'api_key') {
    const k = get('SELECT name FROM api_keys WHERE id=?', r.actor_id);
    return k ? `the API key "${k.name}"` : 'an API key';
  }
  if (r.actor_type === 'user') return memberNow(r.account_id, r.actor_id)?.name || 'someone who is no longer on the team';
  return r.actor_type === 'operator' ? 'the GrowSigning team' : 'GrowSigning';
};
const from = (r: any) => (r.ip ? ` from the internet address ${r.ip}` : '');
const at = (r: any) => stampText(r.at, false);

async function afterwards(seqs: number[]) {
  for (const seq of seqs) {
    const r = get('SELECT * FROM security_events WHERE seq=?', seq);
    if (!r) continue;
    const d = JSON.parse(r.details || '{}');
    const team = get('SELECT name FROM accounts WHERE id=?', r.account_id)?.name || 'your account';
    if (r.kind === 'signin.failed') {
      const forPerson = get("SELECT COUNT(*) n FROM security_events WHERE account_id=? AND kind='signin.failed' AND actor_id=? AND at > ?", r.account_id, r.actor_id, hourAgo()).n;
      const fromIp = r.ip ? get("SELECT COUNT(*) n FROM security_events WHERE account_id=? AND kind='signin.failed' AND ip=? AND at > ?", r.account_id, r.ip, hourAgo()).n : 0;
      if (forPerson >= ALERT_FAILED_SIGNINS_HOUR || fromIp >= ALERT_FAILED_SIGNINS_HOUR) {
        const name = memberNow(r.account_id, r.actor_id)?.name || 'a member of the team';
        await alert(r.account_id, 'failed_signins', 'Many failed sign-ins',
          [forPerson >= ALERT_FAILED_SIGNINS_HOUR ? `In the last hour, ${forPerson} sign-ins to the login of ${name} failed. The latest was at ${at(r)}${from(r)}.` : `In the last hour, ${fromIp} sign-ins failed from the internet address ${r.ip}, to logins of ${team}. The latest was at ${at(r)}, for ${name}.`,
            'If that was not someone on your team who forgot a password, someone may be trying to guess one. Ask the person to choose a long password they use nowhere else, and to switch on two-step login under Settings, Security.']);
      }
    } else if (r.kind === 'api_key.created') {
      await alert(r.account_id, 'api_key_created', 'An API key was made',
        [`${whoSaid(r)} made the API key "${d.name || 'API key'}" with the "${d.scope === 'admin' ? 'admin' : 'send'}" scope in ${team} at ${at(r)}${from(r)}.`,
          'If nobody on your team meant to, revoke it under Settings, API and webhooks: whatever has the key can work in the account until then.']);
    } else if (r.kind === 'owner.handed_over') {
      const was = d.from ? userName(d.from)?.name : null;
      const is = d.to ? userName(d.to)?.name : null;
      await alert(r.account_id, 'owner_handed_over', 'The account has a new owner',
        [`${was || 'The owner'} handed ${team} to ${is || 'another member'} at ${at(r)}${from(r)}. The new owner can close the account, hand it on and decide who is an admin.`,
          `If that was not meant to happen, ask ${is || 'the new owner'} to hand it back on the Team tab.`]);
    } else if (r.kind === 'export.made' && d.everything) {
      await alert(r.account_id, 'everything_exported', 'Everything was exported',
        [`${whoSaid(r)} exported ${d.whose === 'own' ? 'every document they sent in' : 'every document of'} ${team} at ${at(r)}${from(r)}: ${d.envelopes ?? 'all'} ${d.envelopes === 1 ? 'document' : 'documents'}, as one ZIP file.`,
          'If nobody on your team meant to, ask who it was. A copy that was downloaded cannot be taken back.']);
    } else if (r.kind === 'envelope.deleted' || r.kind === 'envelope.purged') {
      const n = get("SELECT COUNT(*) n FROM security_events WHERE account_id=? AND kind IN ('envelope.deleted','envelope.purged') AND at > ?", r.account_id, hourAgo()).n;
      if (n >= ALERT_DELETES_HOUR)
        await alert(r.account_id, 'many_deleted', 'Many documents were deleted',
          [`In the last hour, ${n} documents and templates were deleted in ${team}. The latest was deleted by ${whoSaid(r)} at ${at(r)}${from(r)}.`,
            'A document someone signed is only taken out of the lists: an admin can find it under Documents, in "Removed by its sender", and put it back. Drafts, templates and documents nobody signed are gone for good.']);
    }
    // The webhook: only to webhooks that asked for "security.event" by name. A webhook for every event ("*") does not
    // get these, because they carry the internet addresses of the team.
    const hooks = all('SELECT * FROM webhooks WHERE account_id=? AND active=1', r.account_id).filter((h) => String(h.events).split(',').includes('security.event'));
    if (hooks.length) {
      const body = JSON.stringify({ id: id('evt'), event: 'security.event', created_at: now(), security_event: eventView(r, emailsOn(r.account_id)), text: `${team}: ${SECURITY_KINDS[r.kind as SecurityKind] || r.kind}` });
      for (const h of hooks) void deliver(h, 'security.event', null, body).catch(() => {});
    }
  }
}
