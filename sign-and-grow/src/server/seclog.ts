// The security record of an account: who signed in, and who changed what. One line per event and account in
// security_events (db.ts), chained by hash per account like the audit trail of an envelope, never changed, and kept
// for SECURITY_LOG_DAYS (the triggers in db.ts refuse anything else, whatever code asks). What it is about is named by
// ids only: never a password, token, code, key, email address or anything from a document. The admins read it under
// Settings, Security; a security system pulls it with an admin key (GET /account/security-events) or hears it through
// a webhook that asks for "security.event". Five alerts email the admins, at most once an hour each.
//
// Call record() with one line where something happens. It never throws: a line that cannot be written is said in the
// server log, and what the person did goes on.
import { all, get, run } from './db.ts';
import { sha256, now, baseUrl, id } from './util.ts';
import { sendMail } from './mail.ts';
import { deliver } from './webhooks.ts';
import type { Ctx } from './router.ts';
import type { Auth } from './auth.ts';
import type { ZipEntry } from './zip.ts';
import { SECURITY_KINDS, SECURITY_ALERTS, isSecurityKind, securityLogWords, type SecurityKind, type ActorType, type SecurityAlert } from '../lib/seclog.ts';
import { securityLogDays, ALERT_FAILED_SIGNINS_HOUR, ALERT_DELETES_HOUR, ALERT_EVERY_MINUTES, KEY_NEW_ADDRESS_PER_DAY } from '../lib/policy.ts';

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

const lineHash = (prev: string, accountId: string, r: any) =>
  sha256(JSON.stringify([prev, accountId, r.at, r.actor_type, r.actor_id || '', r.kind, r.outcome, r.about_type || '', r.about_id || '', r.details, r.ip || '', r.ua || '']));

/** Writes one line to each account it belongs to. Answers how many lines were written. */
export function record(kind: SecurityKind, o: SecurityOpts = {}): number {
  try {
    if (!isSecurityKind(kind)) throw new Error(`"${kind}" is not a kind of security event`);
    const who = o.by || actorOf(o.c);
    const ids = [...new Set((o.accounts !== undefined && o.accounts !== null ? [o.accounts].flat() : o.member ? memberAccounts(o.member) : [o.c?.account?.id]).filter(Boolean) as string[])];
    // An operator is staff of whoever runs this server, and the system is nobody: neither leaves an address behind.
    const own = who.type === 'user' || who.type === 'api_key';
    const ip = own ? (o.ip ?? o.c?.ip ?? null) : null;
    const ua = own ? String(o.ua ?? o.c?.ua ?? '').slice(0, 300) || null : null;
    const line = {
      at: now(), actor_type: who.type, actor_id: who.id || null, kind, outcome: o.failed ? 'failure' : 'success',
      about_type: o.about?.[1] ? o.about[0] : null, about_id: o.about?.[1] || null,
      details: JSON.stringify(clean(o.details || {})), ip: ip && ip !== 'unknown' ? ip : null, ua,
    };
    const seqs: number[] = [];
    for (const accountId of ids) {
      if (!get('SELECT 1 x FROM accounts WHERE id=?', accountId)) continue;
      const prev = get('SELECT hash FROM security_events WHERE account_id=? ORDER BY seq DESC LIMIT 1', accountId)?.hash || '';
      seqs.push(Number(run('INSERT INTO security_events (account_id, at, actor_type, actor_id, ip, ua, kind, outcome, about_type, about_id, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        accountId, line.at, line.actor_type, line.actor_id, line.ip, line.ua, kind, line.outcome, line.about_type, line.about_id, line.details, prev, lineHash(prev, accountId, line)).lastInsertRowid));
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

const userName = (uid: string) => get('SELECT name, email FROM users WHERE id=?', uid);
/** How one line leaves the app (the API, the webhook, the CSV, the export). People are named by their id; their
 * name and email address only when the account switched that on (security_log_emails). */
export function eventView(r: any, emails: boolean) {
  const person = (type: string, uid: string | null) => {
    if (!emails || type !== 'user' || !uid) return {};
    const u = userName(uid);
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

/** For the screen inside the app, where an admin sees the team anyway: names of people and keys as they are now. */
export function screenView(r: any) {
  const v = eventView(r, false);
  const nameOf = (type: string, oid: string | null): string => {
    if (type === 'system') return 'GrowSigning on its own';
    if (type === 'operator') return 'The GrowSigning team';
    if (!oid) return 'Unknown';
    if (type === 'user') return userName(oid)?.name || 'A login that no longer exists';
    if (type === 'api_key') {
      const k = get('SELECT name, prefix FROM api_keys WHERE id=?', oid);
      return k ? `API key "${k.name}" (${k.prefix}...)` : 'An API key that was revoked';
    }
    if (type === 'invite') {
      const i = get('SELECT email FROM invites WHERE id=?', oid);
      return i ? `An invitation to ${i.email}` : 'An invitation that no longer exists';
    }
    if (type === 'webhook') return `Webhook ${v.details?.host || oid}`;
    if (type === 'envelope') return `Envelope ${oid}`;
    if (type === 'template') return `Template ${oid}`;
    return oid;
  };
  return { ...v, actor_name: nameOf(r.actor_type, r.actor_id), about_name: v.about ? nameOf(v.about.type, v.about.id) : null };
}

export type Filter = { kinds?: string[]; person?: string | null; from?: string | null; to?: string | null };
export function filterSql(accountId: string, f: Filter): [string, any[]] {
  const w = ['account_id=?'];
  const p: any[] = [accountId];
  const kinds = (f.kinds || []).filter(isSecurityKind);
  if (kinds.length) (w.push(`kind IN (${kinds.map(() => '?').join(',')})`), p.push(...kinds));
  if (f.person) (w.push("(actor_id=? OR (about_type='user' AND about_id=?))"), p.push(f.person, f.person));
  if (f.from) (w.push('at >= ?'), p.push(f.from));
  if (f.to) (w.push('at < ?'), p.push(f.to));
  return [w.join(' AND '), p];
}

const cell = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
export const CSV_HEAD = ['seq', 'at', 'kind', 'what', 'outcome', 'actor_type', 'actor_id', 'actor_name', 'actor_email', 'about_type', 'about_id', 'about_name', 'about_email', 'ip', 'user_agent', 'details', 'hash'];
export function csvLine(r: any, emails: boolean): string {
  const v = eventView(r, emails) as any;
  return [v.seq, v.at, v.kind, v.what, v.outcome, v.actor.type, v.actor.id, v.actor.name, v.actor.email, v.about?.type, v.about?.id, v.about?.name, v.about?.email, v.ip, v.user_agent, JSON.stringify(v.details), v.hash].map(cell).join(',');
}

/** The chain of one account, from its oldest line still kept. Lines older than the days are gone, so the first line
 * kept points at one that is not there any more: that is where checking starts. */
export function verifySecurityChain(accountId: string): { ok: boolean; lines: number; head: string; broken_at: number | null } {
  const rows = all('SELECT * FROM security_events WHERE account_id=? ORDER BY seq', accountId);
  let prev = rows[0]?.prev_hash || '';
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== lineHash(prev, accountId, r)) return { ok: false, lines: rows.length, head: prev, broken_at: r.seq };
    prev = r.hash;
  }
  return { ok: true, lines: rows.length, head: prev, broken_at: null };
}

/** The record as files in the account's export (routes-trust.ts), for admins: one CSV, oldest first. */
export function* securityExport(accountId: string): Generator<ZipEntry> {
  const emails = emailsOn(accountId);
  const lines = [CSV_HEAD.map(cell).join(',')];
  for (const r of all('SELECT * FROM security_events WHERE account_id=? ORDER BY seq', accountId)) lines.push(csvLine(r, emails));
  yield { name: 'security/security-events.csv', data: Buffer.from('﻿' + lines.join('\r\n')) };
}

// ---- Keeping ------------------------------------------------------------------------------------------------------

/** The timer (cron.ts): lines older than SECURITY_LOG_DAYS go, and so do lines of accounts that no longer exist. */
export function purgeSecurityLog(): number {
  const days = securityLogDays();
  run('UPDATE security_log_keep SET days=? WHERE id=1', days);
  const cut = new Date(Date.now() - days * 864e5).toISOString();
  const n = Number(run('DELETE FROM security_events WHERE at < ?', cut).changes) + Number(run('DELETE FROM security_events WHERE account_id NOT IN (SELECT id FROM accounts)').changes);
  run('DELETE FROM security_alerts_sent WHERE at < ?', new Date(Date.now() - 864e5).toISOString());
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

async function alert(accountId: string, rule: SecurityAlert, subject: string, lines: string[]) {
  const a = get('SELECT id, name, security_alerts_off FROM accounts WHERE id=?', accountId);
  if (!a || alertsOff(a).includes(rule)) return;
  // At most once an hour for each alert and account, decided in one statement, so two events at the same moment
  // send one email.
  const t = now();
  if (!run('INSERT INTO security_alerts_sent (account_id, rule, at) VALUES (?,?,?) ON CONFLICT(account_id, rule) DO UPDATE SET at=excluded.at WHERE security_alerts_sent.at <= ?',
    accountId, rule, t, new Date(Date.now() - ALERT_EVERY_MINUTES * 60_000).toISOString()).changes) return;
  for (const m of admins(accountId))
    await sendMail({ to: m.email, subject: `Security alert for ${a.name}: ${subject}`, heading: subject,
      lines: [...lines, `We send this alert at most once an hour. Every event is listed under Settings, Security, where an admin can also switch this alert off. Nobody at GrowSigning watches the record for you: this email is the alert.`],
      cta: { label: 'Open Settings, Security', url: `${baseUrl()}/app/settings?tab=security` } });
}

const whoSaid = (r: any): string => {
  if (r.actor_type === 'api_key') {
    const k = get('SELECT name FROM api_keys WHERE id=?', r.actor_id);
    return k ? `the API key "${k.name}"` : 'an API key';
  }
  if (r.actor_type === 'user') return userName(r.actor_id)?.name || 'someone';
  return r.actor_type === 'operator' ? 'the GrowSigning team' : 'GrowSigning';
};
const from = (r: any) => (r.ip ? ` from the internet address ${r.ip}` : '');
const at = (r: any) => `${r.at.slice(0, 16).replace('T', ' ')} UTC`;

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
        const name = userName(r.actor_id)?.name || 'a member of the team';
        await alert(r.account_id, 'failed_signins', 'Many failed sign-ins',
          [forPerson >= ALERT_FAILED_SIGNINS_HOUR ? `In the last hour, ${forPerson} sign-ins to the login of ${name} failed. The latest was at ${at(r)}${from(r)}.` : `In the last hour, ${fromIp} sign-ins failed from the internet address ${r.ip}, to logins of ${team}. The latest was at ${at(r)}, for ${name}.`,
            'If that was not someone on your team who forgot a password, someone may be trying to guess one. Ask the person to choose a long password they use nowhere else, and to switch on two-step login under Settings, Profile.']);
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
        [`${whoSaid(r)} exported ${d.whose === 'own' ? 'every document they sent in' : 'every document of'} ${team} at ${at(r)}${from(r)}: ${d.envelopes ?? 'all'} ${d.envelopes === 1 ? 'envelope' : 'envelopes'}, as one ZIP file.`,
          'If nobody on your team meant to, ask who it was. A copy that was downloaded cannot be taken back.']);
    } else if (r.kind === 'envelope.deleted' || r.kind === 'envelope.purged') {
      const n = get("SELECT COUNT(*) n FROM security_events WHERE account_id=? AND kind IN ('envelope.deleted','envelope.purged') AND at > ?", r.account_id, hourAgo()).n;
      if (n >= ALERT_DELETES_HOUR)
        await alert(r.account_id, 'many_deleted', 'Many envelopes were deleted',
          [`In the last hour, ${n} envelopes and templates were deleted in ${team}. The latest was deleted by ${whoSaid(r)} at ${at(r)}${from(r)}.`,
            'An envelope someone signed is only taken out of the lists: an admin can find it under Envelopes, Removed, and put it back. Drafts, templates and envelopes nobody signed are gone for good.']);
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
