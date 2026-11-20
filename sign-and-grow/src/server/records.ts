// Keeping closed envelopes for a set time, and no longer: the account's retention rule, a template's own period, the
// one email 14 days before, "Keep it", "Purge now", legal holds, the purge itself and the disposition record. The
// numbers and words are in src/lib/retention.ts, which the pages read too. The routes are in routes-retention.ts.
//
// The rules, in short:
//   - Off by default. With the rule on, a closed envelope (completed, voided, declined, expired) reaches its date the
//     given number of days after it closed (closedAt below), or after a template's own period when it was started
//     from one that has a period.
//   - 14 days before its date its sender and the account's admins get one email that lists it. Nothing is purged
//     without that email having gone 14 days before: a later date is moved, never an earlier one.
//   - "Keep it" (sender or admin, with a reason in the audit trail) keeps it one more period from that day.
//   - "Purge now" (sender or admin, with a level) waits 14 days, can be cancelled in that time, then cannot be undone.
//   - A legal hold (admins, on an envelope or a folder) keeps it from every way of deleting or purging: isHeld() is
//     asked by DELETE /envelopes/:id, closing an account, purgeUser and the purge. Every refused attempt is recorded.
//     So is an open dispute (evidence.ts disputeOpen): a disputed envelope is not purged while that is open.
//   - A purge keeps the record: the envelope row, its audit trail with its chain values (lines whose details were
//     taken out are marked redacted_at, see verifyChain in envelopes.ts) and the fingerprint of its signed PDF.
//
// Nothing here calls into another module while it is being loaded, so the modules that import it may be imported by
// it in turn.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, dataDir } from './db.ts';
import { bad, id, now, str, baseUrl } from './util.ts';
import { sendMail } from './mail.ts';
import { audit, type Actor } from './envelopes.ts';
import { pruneStampImages } from './stamps.ts';
import { rememberGoneMail } from './bounces.ts';
import { forgetCommentHooks } from './commentrules.ts';
import { disputeOpen } from './evidence.ts';
import { record } from './seclog.ts';
import type { Ctx } from './router.ts';
import { dataPlace } from '../lib/dataplace.ts';
import {
  RETENTION_NOTICE_DAYS, RETENTION_CLOSED, PURGE_LEVELS, LEVEL_NAME, KEPT_AT, isPurgeLevel, removesAt, retentionStays, removedOn,
  validDays, dueAt, daysText, HOLD_TRUTH, RETENTION_MIN_DAYS, RETENTION_MAX_DAYS, type PurgeLevel,
} from '../lib/retention.ts';

const DAY = 864e5;
const SYSTEM: Actor = { name: 'System' };
const day = (t: string | null | undefined) => String(t || '').slice(0, 10);
const NOTICE_MS = RETENTION_NOTICE_DAYS * DAY;
const isClosed = (s: string) => RETENTION_CLOSED.includes(s);
/** The lower of two levels: a purge never removes more than its email said. */
const lower = (a: PurgeLevel, b: PurgeLevel): PurgeLevel => (PURGE_LEVELS.indexOf(a) <= PURGE_LEVELS.indexOf(b) ? a : b);

// When an envelope closed: completed when everyone finished, otherwise the line that voided, declined or ended it.
// An envelope from before those lines were written falls back to its last change.
const CLOSED_AT = `COALESCE(CASE WHEN e.status='completed' THEN e.completed_at END,
  (SELECT MAX(x.at) FROM audit x WHERE x.envelope_id=e.id AND x.action IN ('Envelope voided','Declined','Envelope expired')), e.updated_at)`;
export const closedAt = (envelopeId: string): string | null => get(`SELECT ${CLOSED_AT} c FROM envelopes e WHERE e.id=?`, envelopeId)?.c || null;

// ---- The disposition record ---------------------------------------------------------------------------------------

type LogWhat = 'policy' | 'template_period' | 'keep' | 'hold' | 'hold_lifted' | 'override_asked' | 'refused' | 'purge_asked' | 'purge_cancelled' | 'noticed' | 'purged';

/** One line of the account's retention record (retention_log). Never changed afterwards (the triggers in db.ts). */
export function logLine(accountId: string, envelopeId: string | null, what: LogWhat, o: { level?: string | null; sha256?: string | null; who?: string | null; detail?: string | null } = {}) {
  run('INSERT INTO retention_log (account_id, envelope_id, at, what, level, sha256, who, detail) VALUES (?,?,?,?,?,?,?,?)',
    accountId, envelopeId, now(), what, o.level || null, o.sha256 || null, o.who ? str(o.who, 300) : null, o.detail ? str(o.detail, 2000) : null);
}

// The same events in the security record (src/server/seclog.ts), which never throws.
function secLine(kind: 'retention.changed' | 'legal_hold.placed' | 'legal_hold.lifted' | 'envelope.retention_purged' | 'purge.asked' | 'purge.cancelled', accountId: string, o: { c?: Ctx | null; about?: [string, string | null]; details?: Record<string, unknown>; system?: boolean; operator?: boolean } = {}) {
  record(kind as any, { c: o.c || null, accounts: accountId, about: o.about || null, details: o.details || {}, ...(o.system ? { by: { type: 'system' } } : o.operator ? { by: { type: 'operator' } } : {}) });
}

/** When an account is deleted: its record keeps what happened to which envelope, without names or words (purgeUser). */
export function forgetRetentionLog(accountId: string) {
  run('UPDATE retention_log SET account_id=NULL, who=NULL, detail=NULL, gone_at=? WHERE account_id=?', now(), accountId);
}
/** From the timer: lines of deleted accounts, a year after the account went (the trigger refuses earlier). */
export const dropOldRetentionLog = () => Number(run("DELETE FROM retention_log WHERE account_id IS NULL AND gone_at IS NOT NULL AND gone_at < ?", new Date(Date.now() - 366 * DAY).toISOString()).changes);

/** The record of an account, newest first. */
export const retentionLog = (accountId: string, limit = 200) =>
  all('SELECT id, envelope_id, at, what, level, sha256, who, detail FROM retention_log WHERE account_id=? ORDER BY id DESC LIMIT ?', accountId, limit);

// A reason someone typed that starts with =, +, - or @ gets a ' in front, so it cannot run as a formula in a spreadsheet.
const csvCell = (v: any) => `"${String(v ?? '').replace(/^[=+\-@]/, "'$&").replace(/"/g, '""')}"`;
/** The record as a CSV file: the certificate of what was purged when, by what rule or whom, with each fingerprint. */
export function retentionCsv(accountId: string): string {
  const rows = all('SELECT id, at, what, envelope_id, level, sha256, who, detail FROM retention_log WHERE account_id=? ORDER BY id', accountId);
  return '﻿' + [['line', 'at', 'what', 'envelope_id', 'level', 'signed_pdf_sha256', 'who', 'detail'].join(','), ...rows.map((r) => [r.id, r.at, r.what, r.envelope_id, r.level, r.sha256, r.who, r.detail].map(csvCell).join(','))].join('\r\n');
}

// ---- Legal holds ----------------------------------------------------------------------------------------------------

/** The holds that are on now, for each of these envelopes that has one. Every way of deleting or purging asks this. */
export function isHeld(envelopeIds: string[]): Map<string, any[]> {
  const out = new Map<string, any[]>();
  for (const eid of new Set(envelopeIds.filter(Boolean))) {
    const e = get('SELECT account_id, folder, kind FROM envelopes WHERE id=?', eid);
    const inFolder = e?.kind === 'envelope' && e.folder ? ' OR (h.folder=? AND h.account_id=?)' : '';
    const holds = all(`SELECT h.* FROM legal_holds h WHERE h.lifted_at IS NULL AND (h.envelope_id=? OR h.id IN (SELECT hold_id FROM legal_hold_items WHERE envelope_id=?)${inFolder}) ORDER BY h.set_at`,
      eid, eid, ...(inFolder ? [e.folder, e.account_id] : []));
    if (holds.length) out.set(eid, holds);
  }
  return out;
}

/** The holds that are on in these accounts. */
export const activeHolds = (accountIds: string[]): any[] =>
  accountIds.length ? all(`SELECT * FROM legal_holds WHERE lifted_at IS NULL AND account_id IN (${accountIds.map(() => '?').join(',')}) ORDER BY set_at`, ...accountIds) : [];

/** How a hold is named in a sentence: "the hold on folder "Claims" set on 2026-11-20 by Ada Admin (matter M-12)". */
export const holdName = (h: any) => `the hold on ${h.folder ? `folder "${h.folder}"` : `envelope ${h.envelope_id}`} set on ${day(h.set_at)} by ${h.set_by}${h.matter ? ` (matter ${h.matter})` : ''}`;

/**
 * Refuses when any of these envelopes is held, after writing the attempt to the record of each. `what` says what was
 * tried, for the record: 'delete', 'purge', 'close the account'.
 */
export function assertNotHeld(envelopeIds: string[], who: string, what: string) {
  const held = isHeld(envelopeIds);
  if (!held.size) return;
  for (const [eid, holds] of held) {
    const acct = holds[0].account_id;
    logLine(acct, eid, 'refused', { who, detail: `Refused to ${what}: the envelope is on legal hold (${holds.map((h) => h.id).join(', ')}).` });
  }
  const one = held.size === 1;
  throw bad(`${one ? 'This envelope is' : `${held.size} of these envelopes are`} on legal hold, so ${one ? 'it' : 'they'} cannot be deleted or purged while the hold is on. Only an admin of the account can lift a hold, under Settings, Your data. Nothing was deleted, and this attempt was recorded.`, 409,
    { code: 'legal_hold', held: [...held.keys()] });
}

/** Before an envelope leaves its folder: a hold on that folder keeps covering it (legal_hold_items). */
export function holdsFollow(envelopeId: string) {
  for (const h of isHeld([envelopeId]).get(envelopeId) || [])
    run('INSERT OR IGNORE INTO legal_hold_items (hold_id, envelope_id) VALUES (?,?)', h.id, envelopeId);
}

/** What a hold covers now. */
function holdCovers(h: any): string[] {
  if (h.envelope_id) return [h.envelope_id];
  return [...new Set([...all('SELECT envelope_id FROM legal_hold_items WHERE hold_id=?', h.id).map((r) => r.envelope_id),
    ...all("SELECT id FROM envelopes WHERE account_id=? AND kind='envelope' AND folder=?", h.account_id, h.folder).map((r) => r.id)])]
    .filter((eid) => get('SELECT 1 x FROM envelopes WHERE id=?', eid));
}

/** An admin puts an envelope or a folder on hold. Answers the hold and how many envelopes it covers now. */
// An integration key with the "send" scope works with envelopes, not with what keeps them: it neither places nor lifts a hold.
const assertHoldKey = (c: Ctx) => {
  if (c.auth?.via === 'api_key' && (c.auth as any).scope !== 'admin') throw bad('An API key with the "send" scope cannot place or lift a legal hold. An admin can, in the app or with a key of the "admin" scope.', 403);
};

export function placeHold(c: Ctx, o: { envelopeId?: string | null; folder?: string | null; reason: any; matter?: any }) {
  if (!c.admin) throw bad('Only an admin of the account can put something on legal hold. Ask an admin of your team.', 403);
  assertHoldKey(c);
  const reason = str(o.reason, 500).trim();
  const matter = str(o.matter, 120).trim() || null;
  if (reason.length < 3) throw bad('Say why it is held, in a few words (for example the claim or the request it is kept for). The reason is kept with the hold, for the admins. Nothing was put on hold.');
  const folder = o.folder == null ? '' : str(o.folder, 80).trim();
  if (!o.envelopeId && !folder) throw bad('Say what to hold: an envelope, or the name of a folder. Nothing was put on hold.');
  if (o.envelopeId) {
    const e = get("SELECT id, kind FROM envelopes WHERE id=? AND account_id=?", o.envelopeId, c.account.id);
    if (!e || e.kind !== 'envelope') throw bad('Envelope not found.', 404);
    if (get('SELECT 1 x FROM legal_holds WHERE envelope_id=? AND lifted_at IS NULL', e.id)) throw bad('This envelope is already on hold. Nothing changed.', 409, { code: 'already_held' });
  } else if (get('SELECT 1 x FROM legal_holds WHERE account_id=? AND folder=? AND lifted_at IS NULL', c.account.id, folder))
    throw bad(`The folder "${folder}" is already on hold. Nothing changed.`, 409, { code: 'already_held' });
  const h = { id: id('hold'), account_id: c.account.id, envelope_id: o.envelopeId || null, folder: o.envelopeId ? null : folder, reason, matter, set_by_id: c.user.id, set_by: c.user.name, set_at: now() };
  const covered = tx(() => {
    run('INSERT INTO legal_holds (id, account_id, envelope_id, folder, reason, matter, set_by_id, set_by, set_at) VALUES (?,?,?,?,?,?,?,?,?)', h.id, h.account_id, h.envelope_id, h.folder, h.reason, h.matter, h.set_by_id, h.set_by, h.set_at);
    const ids = holdCovers(h);
    for (const eid of ids) {
      if (h.folder) run('INSERT OR IGNORE INTO legal_hold_items (hold_id, envelope_id) VALUES (?,?)', h.id, eid);
      // The reason and the matter stay with the hold, for the admins: the record of the envelope says that it is held.
      audit(eid, c.actor, 'Put on legal hold', `${h.folder ? `Its folder "${h.folder}" was put on legal hold` : 'It was put on legal hold'} by an admin of the account. While the hold is on, it cannot be deleted or purged.`);
      cancelQueued(eid, 'It was put on legal hold.');
    }
    logLine(h.account_id, h.envelope_id, 'hold', { who: `${c.user.name} <${c.user.email}>`, detail: `${h.folder ? `Folder "${h.folder}"` : `Envelope ${h.envelope_id}`} put on hold (${h.id}), covering ${ids.length} envelope(s). Reason: ${reason}${matter ? `. Matter: ${matter}` : ''}` });
    return ids.length;
  });
  secLine('legal_hold.placed', h.account_id, { c, about: ['legal_hold', h.id], details: { folder: !!h.folder, envelope_id: h.envelope_id, covers: covered } });
  return { hold: holdView(get('SELECT * FROM legal_holds WHERE id=?', h.id), true), covers: covered };
}

/** Takes a hold off: an admin with a reason, or two of the people who run the server (operatorLift). */
function lift(h: any, by: { name: string; actor: Actor; log: string }, reason: string) {
  return tx(() => {
    if (!run('UPDATE legal_holds SET lifted_at=?, lifted_by=?, lift_reason=? WHERE id=? AND lifted_at IS NULL', now(), by.name, reason, h.id).changes) return 0;
    const ids = holdCovers(h);
    for (const eid of ids) audit(eid, by.actor, 'Legal hold lifted', `${h.folder ? `The hold on its folder "${h.folder}"` : 'The legal hold'} was lifted by ${by.name.endsWith('GrowSigning') ? 'the people who run this server' : 'an admin of the account'}.${isHeld([eid]).size ? ' Another hold still covers it.' : ''}`);
    logLine(h.account_id, h.envelope_id, 'hold_lifted', { who: by.log, detail: `${h.folder ? `Folder "${h.folder}"` : `Envelope ${h.envelope_id}`}: hold ${h.id} lifted. Reason: ${reason}` });
    return ids.length;
  });
}

export function liftHold(c: Ctx, holdId: string, reasonIn: any) {
  if (!c.admin) throw bad('Only an admin of the account can lift a legal hold. Ask an admin of your team.', 403);
  assertHoldKey(c);
  const h = get('SELECT * FROM legal_holds WHERE id=? AND account_id=?', holdId, c.account.id);
  if (!h) throw bad('Hold not found.', 404);
  if (h.lifted_at) throw bad(`This hold was lifted on ${day(h.lifted_at)}. Nothing changed.`, 409);
  const reason = str(reasonIn, 500).trim();
  if (reason.length < 3) throw bad('Say why the hold can be lifted, in a few words. The reason is kept with the hold. Nothing was changed.');
  const n = lift(h, { name: c.user.name, actor: c.actor, log: `${c.user.name} <${c.user.email}>` }, reason);
  secLine('legal_hold.lifted', h.account_id, { c, about: ['legal_hold', h.id], details: { covers: n } });
  return { lifted: true, covered: n };
}

/**
 * The people who run the server lift a hold when a court order or their own legal duty requires it: one asks, a
 * different one confirms within 7 days. Both are written to the record, and the account's admins are emailed.
 */
export async function operatorLift(holdId: string, op: { name: string; email: string }, reasonIn: any) {
  const h = get('SELECT * FROM legal_holds WHERE id=?', holdId);
  if (!h) throw bad('Hold not found.', 404);
  if (h.lifted_at) throw bad(`This hold was lifted on ${day(h.lifted_at)}. Nothing changed.`, 409);
  const reason = str(reasonIn, 500).trim();
  if (reason.length < 3) throw bad('Say what requires the hold to be lifted (the court order, or the legal duty). Nothing was changed.');
  const fresh = h.override_at && Date.parse(h.override_at) > Date.now() - 7 * DAY;
  if (!fresh || h.override_by === op.email.toLowerCase()) {
    run('UPDATE legal_holds SET override_by=?, override_reason=?, override_at=? WHERE id=?', op.email.toLowerCase(), reason, now(), h.id);
    logLine(h.account_id, h.envelope_id, 'override_asked', { who: `${op.name}, GrowSigning`, detail: `Asked to lift hold ${h.id}. Reason: ${reason}. A second person who runs this server has to confirm within 7 days.` });
    return { lifted: false, waiting_for_second: true };
  }
  const first = get('SELECT name FROM users WHERE lower(email)=?', h.override_by)?.name || h.override_by;
  const why = `${h.override_reason} / ${reason}`;
  const n = lift(h, { name: `${first} and ${op.name}, GrowSigning`, actor: { name: `${first} and ${op.name}, GrowSigning` }, log: `${first} (asked) and ${op.name} (confirmed), GrowSigning` }, `Lifted by the people who run this server: ${why}`);
  secLine('legal_hold.lifted', h.account_id, { operator: true, about: ['legal_hold', h.id], details: { covers: n, by_operator: true } });
  for (const a of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", h.account_id))
    await sendMail({ to: a.email, subject: 'A legal hold on your GrowSigning account was lifted by the people who run the service', heading: 'A legal hold was lifted',
      lines: [`Two people who run this GrowSigning server lifted ${holdName(h)}.`, `What they gave as the reason: ${why}`,
        'What it covered can be deleted and purged again by the usual rules. Envelopes the retention rule had reached get a new email 14 days before anything is purged.',
        'If you did not expect this, contact the people who run this server.'],
      cta: { label: 'Open Your data', url: `${baseUrl()}/app/settings?tab=data` } });
  return { lifted: true, covered: n };
}

export const holdView = (h: any, admin: boolean) => ({
  id: h.id, envelope_id: h.envelope_id, folder: h.folder, set_by: h.set_by, set_at: h.set_at,
  // The reason and the matter are for the admins. A member sees that it is held, by whom and since when.
  ...(admin ? { reason: h.reason, matter: h.matter, lifted_at: h.lifted_at, lifted_by: h.lifted_by, lift_reason: h.lift_reason, override_asked_at: h.override_at || null } : {}),
});

// ---- The rule ----------------------------------------------------------------------------------------------------------

export function policyOf(accountId: string) {
  const a = get('SELECT retention_days, retention_level, retention_name, retention_code FROM accounts WHERE id=?', accountId) || {};
  return { on: a.retention_days != null, days: a.retention_days ?? null, level: (isPurgeLevel(a.retention_level) ? a.retention_level : 'documents') as PurgeLevel, name: a.retention_name || null, code: a.retention_code || null };
}

/** The period that applies to one envelope, or null when the account's rule is off. */
export function periodFor(e: { account_id: string; template_id?: string | null }): { days: number; from: 'account' | 'template'; template?: string } | null {
  const p = policyOf(e.account_id);
  if (!p.on) return null;
  const t = e.template_id ? get("SELECT subject, retention_days FROM envelopes WHERE id=? AND kind='template' AND account_id=?", e.template_id, e.account_id) : null;
  return t?.retention_days ? { days: t.retention_days, from: 'template', template: t.subject || 'Untitled template' } : { days: p.days, from: 'account' };
}

/** How the rule is said in an email or an audit line: "keep closed envelopes for 365 days (Contracts, GRS 2.1)". */
const ruleText = (p: ReturnType<typeof policyOf>, days: number) => `keep closed envelopes for ${daysText(days)}${p.name || p.code ? ` (${[p.name, p.code].filter(Boolean).join(', ')})` : ''}`;

/** What PUT /account/retention changes. `dry` answers what would happen without saving. */
export function setPolicy(c: Ctx, b: any) {
  if (!c.admin) throw bad('Only an admin of the account can change how long closed envelopes are kept.', 403);
  const before = policyOf(c.account.id);
  // Left out, the period stays as it is; null (or "on": false) switches the rule off.
  const days = b.on === false || b.days === null || b.days === '' ? null : b.days === undefined ? before.days : Number(b.days);
  if (days !== null && !validDays(days)) throw bad(`"days" must be a whole number from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS}, or null to switch the rule off. Nothing was saved.`);
  const level = b.level == null ? before.level : b.level;
  if (!isPurgeLevel(level)) throw bad(`"level" must be one of ${PURGE_LEVELS.map((l) => `"${l}"`).join(', ')}. Nothing was saved.`);
  const name = b.name === undefined ? before.name : str(b.name, 120).trim() || null;
  const code = b.code === undefined ? before.code : str(b.code, 80).trim() || null;
  const tpls: [string, number | null][] = [];
  if (b.templates != null) {
    if (typeof b.templates !== 'object' || Array.isArray(b.templates)) throw bad('"templates" must be an object of template ids and days, such as {"tpl_x": 3650}, with null to use the account\'s period. Nothing was saved.');
    for (const [tid, v] of Object.entries(b.templates)) {
      if (!get("SELECT 1 x FROM envelopes WHERE id=? AND account_id=? AND kind='template'", tid, c.account.id)) throw bad(`There is no template ${str(tid, 60)} in this account. Nothing was saved.`, 404);
      const n = v === null || v === '' ? null : Number(v);
      if (n !== null && !validDays(n)) throw bad(`The period of template ${str(tid, 60)} must be a whole number of days from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS}, or null. Nothing was saved.`);
      tpls.push([tid, n]);
    }
  }
  // What switching on or shortening would bring into the queue at once: those get the email now and go in 14 days.
  const soon = days === null ? 0 : all(`SELECT e.id, e.template_id, ${CLOSED_AT} closed FROM envelopes e WHERE e.account_id=? AND e.kind='envelope' AND e.purged_at IS NULL AND e.status IN ('completed','voided','declined','expired')`, c.account.id)
    .filter((e) => {
      const own = tpls.find(([t]) => t === e.template_id)?.[1];
      const t = own !== undefined ? own : e.template_id ? get('SELECT retention_days d FROM envelopes WHERE id=?', e.template_id)?.d : null;
      return Date.parse(dueAt(e.closed, t || days)) - NOTICE_MS <= Date.now();
    }).length;
  const answer = { would_notice_now: soon, notice_days: RETENTION_NOTICE_DAYS };
  if (b.dry_run === true) return answer;
  tx(() => {
    run('UPDATE accounts SET retention_days=?, retention_level=?, retention_name=?, retention_code=? WHERE id=?', days, level, name, code, c.account.id);
    for (const [tid, n] of tpls) {
      const was = get('SELECT retention_days d FROM envelopes WHERE id=?', tid)?.d ?? null;
      if (was === n) continue;
      run('UPDATE envelopes SET retention_days=? WHERE id=?', n, tid);
      logLine(c.account.id, tid, 'template_period', { who: `${c.user.name} <${c.user.email}>`, detail: `Template ${tid}: ${was ? daysText(was) : "the account's period"} became ${n ? daysText(n) : "the account's period"}.` });
    }
    if (before.days !== days || before.level !== level || before.name !== name || before.code !== code)
      logLine(c.account.id, null, 'policy', { level, who: `${c.user.name} <${c.user.email}>`,
        detail: `${before.on ? `Was: keep for ${daysText(before.days)}, then remove ${LEVEL_NAME[before.level].toLowerCase()}` : 'Was: off'}. Now: ${days === null ? 'off' : `keep for ${daysText(days)}, then remove ${LEVEL_NAME[level].toLowerCase()}`}${name || code ? ` (${[name, code].filter(Boolean).join(', ')})` : ''}.` });
  });
  secLine('retention.changed', c.account.id, { c, about: ['account', c.account.id], details: { days, level, was_days: before.days, was_level: before.level, templates: tpls.length } });
  return { ...answer, policy: policyOf(c.account.id) };
}

// ---- The queue ---------------------------------------------------------------------------------------------------------

/** Clears a notice and a request, so nothing goes without a new email 14 days before. Call inside tx(). */
function cancelQueued(envelopeId: string, why: string) {
  const q = get('SELECT * FROM retention_queue WHERE envelope_id=?', envelopeId);
  if (!q?.noticed_at && !q?.asked_at) return;
  run('UPDATE retention_queue SET noticed_at=NULL, goes_at=NULL, level=NULL, asked_level=NULL, asked_at=NULL, asked_by=NULL, asked_by_id=NULL WHERE envelope_id=?', envelopeId);
  audit(envelopeId, SYSTEM, 'Purge called off', `${q.asked_at ? 'The purge that was asked for' : 'The purge the retention rule had announced'}${q.goes_at ? ` for ${day(q.goes_at)}` : ''} will not happen: ${why} If it is due again later, the sender and the admins are emailed 14 days before.`);
}

const queueRow = (e: any) => {
  run('INSERT OR IGNORE INTO retention_queue (envelope_id, account_id) VALUES (?,?)', e.id, e.account_id);
  return get('SELECT * FROM retention_queue WHERE envelope_id=?', e.id);
};

/** Where one envelope stands, for its page and for the API. */
export function retentionFacts(c: Ctx, e: any) {
  if (e.kind !== 'envelope') return null;
  const holds = (isHeld([e.id]).get(e.id) || []).map((h) => holdView(h, c.admin));
  const q = get('SELECT * FROM retention_queue WHERE envelope_id=?', e.id) || {};
  const closed = isClosed(e.status) ? closedAt(e.id) : null;
  const period = closed ? periodFor(e) : null;
  const due = period && closed ? dueAt(closed, period.days) : null;
  const kept = q.kept_until && (!due || q.kept_until > due) ? q.kept_until : null;
  const policy = policyOf(e.account_id);
  return {
    closed_at: closed, period, due_at: due ? kept || due : null, rule_level: policy.on ? policy.level : null,
    noticed_at: q.noticed_at || null, goes_at: q.goes_at || null, level: q.asked_level || q.level || null,
    kept_until: q.kept_until || null, kept_reason: q.kept_reason || null, kept_by: q.kept_by || null,
    asked: q.asked_at ? { at: q.asked_at, by: q.asked_by, level: q.asked_level } : null,
    holds, held: holds.length > 0, disputed: disputeOpen(e.id),
    purged_at: e.purged_at || null, purged_level: e.purged_level || null, purged_sha256: e.purged_sha256 || null,
    may_purge: !e.purged_at && !!closed && !holds.length, may_hold: c.admin,
    stays: retentionStays(dataPlace().backups),
  };
}

/** "Keep it": one more period from today, with a reason in the audit trail. Calls off a purge that was asked for. */
export function keepIt(c: Ctx, e: any, reasonIn: any) {
  if (e.purged_at) throw bad(`This envelope was purged on ${day(e.purged_at)}. That cannot be undone, so there is nothing left to keep.`, 409);
  if (!isClosed(e.status)) throw bad('Only a closed envelope reaches the end of its retention period. This one is still out, so there is nothing to keep it from yet.');
  const reason = str(reasonIn, 500).trim();
  if (reason.length < 3) throw bad('Say why it is kept, in a few words. The reason goes into its audit trail. Nothing was changed.');
  const period = periodFor(e);
  const q = queueRow(e);
  if (!period && !q.asked_at) throw bad('The account keeps closed envelopes without an end date, and nobody asked to purge this one, so there is nothing to keep it from. Nothing was changed.');
  const until = period ? new Date(Date.now() + period.days * DAY).toISOString() : null;
  tx(() => {
    run('UPDATE retention_queue SET kept_until=?, kept_reason=?, kept_by=?, noticed_at=NULL, goes_at=NULL, level=NULL, asked_level=NULL, asked_at=NULL, asked_by=NULL, asked_by_id=NULL WHERE envelope_id=?',
      until || q.kept_until, reason, c.user.name, e.id);
    audit(e.id, c.actor, 'Kept past its retention date', `${reason}${until ? `. Kept until ${day(until)}; the sender and the admins are emailed 14 days before that` : ''}${q.asked_at ? '. The purge that was asked for is called off' : ''}.`);
    logLine(e.account_id, e.id, 'keep', { who: `${c.user.name} <${c.user.email}>`, detail: `Kept${until ? ` until ${day(until)}` : ''}. Reason: ${reason}` });
  });
  return { kept_until: until };
}

/** "Purge now": the sender or an admin, on a closed envelope, at a level. It waits 14 days and can be called off. */
export async function askPurge(c: Ctx, e: any, levelIn: any) {
  if (!isPurgeLevel(levelIn)) throw bad(`Choose what to remove: "level" must be one of ${PURGE_LEVELS.map((l) => `"${l}"`).join(', ')}. Nothing was changed.`);
  if (e.purged_at) throw bad(`This envelope was already purged on ${day(e.purged_at)}.`, 409);
  if (!isClosed(e.status)) throw bad(e.status === 'draft' ? 'This is a draft. Delete it instead: a draft goes for good at once.' : 'Only a closed envelope can be purged. This one is still out for signature: void it first if it should not be signed.', 400);
  assertNotHeld([e.id], `${c.user.name} <${c.user.email}>`, 'purge it');
  if (disputeOpen(e.id)) throw bad('A person named on this envelope disputes it, and GrowSigning has not closed that dispute yet, so it cannot be purged until then. Nothing was changed.', 409, { code: 'disputed' });
  const q = queueRow(e);
  if (q.asked_at) throw bad(`A purge was already asked for on ${day(q.asked_at)}. It goes on ${day(q.goes_at)} unless it is called off. Nothing changed.`, 409);
  const goes = new Date(Date.now() + NOTICE_MS).toISOString();
  tx(() => {
    // One statement decides, so two requests at the same moment leave one request and one line.
    if (!run('UPDATE retention_queue SET asked_level=?, asked_at=?, asked_by=?, asked_by_id=?, noticed_at=?, goes_at=?, level=? WHERE envelope_id=? AND asked_at IS NULL', levelIn, now(), c.user.name, c.user.id, now(), goes, levelIn, e.id).changes)
      throw bad('A purge was asked for on this envelope a moment ago. Nothing changed.', 409);
    audit(e.id, c.actor, 'Purge asked for', `${LEVEL_NAME[levelIn as PurgeLevel]} will be removed on ${day(goes)}. Until then the sender or an admin can call it off on the envelope page. After that it cannot be undone.`);
    logLine(e.account_id, e.id, 'purge_asked', { level: levelIn, who: `${c.user.name} <${c.user.email}>`, detail: `Goes on ${day(goes)}.` });
  });
  secLine('purge.asked', e.account_id, { c, about: ['envelope', e.id], details: { level: levelIn } });
  await notify(e.account_id, [{ ...e, goes_at: goes, level: levelIn, asked_by: c.user.name }]);
  return { goes_at: goes, level: levelIn };
}

export function cancelPurge(c: Ctx, e: any) {
  const q = get('SELECT * FROM retention_queue WHERE envelope_id=?', e.id);
  if (e.purged_at) throw bad(`This envelope was purged on ${day(e.purged_at)}. That cannot be undone.`, 409);
  if (!q?.asked_at) {
    if (q?.noticed_at) throw bad(`Nobody asked to purge this one: the account's retention rule reaches it on ${day(q.goes_at)}. To keep it, choose "Keep it" and give a reason.`, 409, { code: 'rule' });
    throw bad('No purge was asked for on this envelope. Nothing changed.', 409);
  }
  tx(() => {
    run('UPDATE retention_queue SET asked_level=NULL, asked_at=NULL, asked_by=NULL, asked_by_id=NULL, noticed_at=NULL, goes_at=NULL, level=NULL WHERE envelope_id=?', e.id);
    audit(e.id, c.actor, 'Purge called off', `The purge asked for on ${day(q.asked_at)} will not happen.`);
    logLine(e.account_id, e.id, 'purge_cancelled', { who: `${c.user.name} <${c.user.email}>` });
  });
  secLine('purge.cancelled', e.account_id, { c, about: ['envelope', e.id] });
  const f = retentionFacts(c, e);
  return { cancelled: true, rule_due_at: f?.due_at || null };
}

// ---- The email 14 days before ------------------------------------------------------------------------------------------

/** One email to each person concerned: the sender of each envelope, and every admin of the account for all of them. */
async function notify(accountId: string, list: any[]) {
  if (!list.length) return 0;
  const admins = all("SELECT u.id, u.name, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", accountId);
  const people = new Map<string, { name: string; email: string; items: any[] }>();
  const add = (u: any, item: any) => {
    if (!u?.email) return;
    const p = people.get(u.id) || { name: u.name, email: u.email, items: [] as any[] };
    if (!p.items.includes(item)) p.items.push(item);
    people.set(u.id, p);
  };
  for (const e of list) {
    add(get('SELECT id, name, email FROM users WHERE id=?', e.sender_id), e);
    for (const a of admins) add(a, e);
  }
  const policy = policyOf(accountId);
  const stays = retentionStays(dataPlace().backups);
  let sent = 0;
  for (const p of people.values()) {
    const n = p.items.length;
    const asked = p.items.filter((e) => e.asked_by);
    await sendMail({
      to: p.email,
      subject: n === 1 ? `An envelope will be purged on ${day(p.items[0].goes_at)}` : `${n} envelopes will be purged, the first on ${day(p.items.map((e) => e.goes_at).sort()[0])}`,
      heading: n === 1 ? 'An envelope will be purged in 14 days' : `${n} envelopes will be purged in 14 days`,
      lines: [
        asked.length === n ? `Someone asked to purge ${n === 1 ? 'this closed envelope' : 'these closed envelopes'}.` : `Your account's retention rule says to ${ruleText(policy, policy.days || 0)}, counted from the day each one closed.${asked.length ? ' For some of them, someone asked for it.' : ''}`,
        'On the day given, GrowSigning removes from each envelope what is named after it. That cannot be undone.',
        ...p.items.map((e) => `"${e.subject || 'Untitled'}" (envelope ${e.id}): on ${day(e.goes_at)}, ${LEVEL_NAME[e.level as PurgeLevel].toLowerCase()}${e.asked_by ? `, asked for by ${e.asked_by}` : ''}${e.hidden_at ? '. Its sender removed it from their lists; the admins find it under Removed by its sender' : ''}.`),
        'To keep one: open it and choose "Keep it", with a reason. It is then kept for another period. A purge someone asked for can be called off on the envelope page. An admin can also put an envelope or a folder on legal hold: nothing held is purged.',
        'What stays after a purge:',
        ...stays.map((s) => `- ${s}`),
      ],
      cta: { label: n === 1 ? 'Open the envelope' : 'Open your envelopes', url: `${baseUrl()}/app/envelopes${n === 1 ? `/${p.items[0].id}` : ''}` },
    });
    sent++;
  }
  return sent;
}

// ---- The purge ------------------------------------------------------------------------------------------------------------

const NOT_WAITING = "status!='queued' AND NOT (status='failed' AND next_try_at IS NOT NULL)";

// A file taken off the disk once nothing points at it any more (the same checks as removeUnusedBlobs in
// routes-trust.ts, kept here so that this module needs nothing from a routes file).
function dropBlobs(shas: string[]) {
  pruneStampImages();
  for (const sha of new Set(shas.filter((s) => /^[0-9a-f]{64}$/.test(String(s || ''))))) {
    if (get('SELECT 1 x FROM files WHERE sha256=? OR original_sha256=?', sha, sha) || get('SELECT 1 x FROM envelopes WHERE final_sha256=?', sha) || get('SELECT 1 x FROM earlier_signatures WHERE copy_sha256=?', sha)
      // An email still carrying it as an attachment; its text may name the fingerprint, which holds nothing.
      || get('SELECT 1 x FROM emails WHERE payload LIKE ?', `%"sha256":"${sha}"%`) || get('SELECT 1 x FROM clickwrap_versions WHERE file_sha256=?', sha)) continue;
    fs.rmSync(path.join(dataDir(), 'blobs', sha), { force: true });
  }
}

const parse = (s: any) => {
  try {
    return JSON.parse(s || '[]');
  } catch {
    return [];
  }
};

/** Level 'documents'. Answers the stored files to take off the disk afterwards. */
function removeDocuments(e: any): string[] {
  const shas: string[] = [];
  // The pages: a file goes with its last document. One a template or another envelope also uses stays with it.
  for (const d of all('SELECT id, file_id FROM documents WHERE envelope_id=?', e.id)) {
    run('DELETE FROM documents WHERE id=?', d.id);
    const f = get('SELECT id, sha256, original_sha256 FROM files WHERE id=?', d.file_id);
    if (!f || get('SELECT 1 x FROM documents WHERE file_id=?', f.id) || get('SELECT 1 x FROM clickwraps WHERE draft_file_id=?', f.id)) continue;
    run('DELETE FROM files WHERE id=?', f.id);
    shas.push(f.sha256, f.original_sha256);
  }
  // Files signers attached (also one uploaded through this link and never attached), as forgetEnvelopes finds them.
  const attached = [...all("SELECT id FROM files WHERE account_id IS NULL AND via_envelope=? AND id NOT IN (SELECT value FROM fields WHERE type='attachment' AND value IS NOT NULL AND envelope_id!=?)", e.id, e.id).map((f) => f.id),
    ...all("SELECT value v FROM fields WHERE envelope_id=? AND type='attachment' AND value IS NOT NULL", e.id).map((f) => f.v),
    ...all('SELECT answers FROM earlier_signatures WHERE envelope_id=?', e.id).flatMap((s) => (parse(s.answers) as any[]).filter((a) => a?.type === 'attachment').map((a) => a.value))];
  for (const fid of attached) {
    const f = get('SELECT sha256 FROM files WHERE id=? AND account_id IS NULL', fid);
    if (f) (shas.push(f.sha256), run('DELETE FROM files WHERE id=?', fid));
  }
  run("UPDATE fields SET value=NULL WHERE envelope_id=? AND type='attachment'", e.id);
  // Stamp pictures: the field no longer points at its impression, which goes once nothing else does (pruneStampImages).
  run("UPDATE fields SET value=NULL, stamp_meta=NULL WHERE envelope_id=? AND type='stamp'", e.id);
  for (const s of all('SELECT id, answers, copy_sha256 FROM earlier_signatures WHERE envelope_id=?', e.id)) {
    shas.push(s.copy_sha256);
    run('UPDATE earlier_signatures SET copy_sha256=NULL, answers=? WHERE id=?', JSON.stringify((parse(s.answers) as any[]).filter((a) => a?.type !== 'attachment' && a?.type !== 'stamp')), s.id);
  }
  // The signed PDF: its fingerprint stays (purged_sha256), so Verify a document can still answer for the file.
  shas.push(e.final_sha256);
  run('UPDATE envelopes SET purged_sha256=COALESCE(final_sha256, purged_sha256), final_sha256=NULL, final_size=NULL WHERE id=?', e.id);
  // Our stored copies of the emails keep their words but not their attachments.
  for (const m of all("SELECT id, payload FROM emails WHERE envelope_id=? AND payload LIKE '%\"sha256\"%'", e.id)) {
    let p: any = null;
    try {
      p = JSON.parse(m.payload);
    } catch {}
    if (p?.attachments?.length) (shas.push(...p.attachments.map((a: any) => a.sha256)), run('UPDATE emails SET payload=? WHERE id=?', JSON.stringify({ ...p, attachments: [] }), m.id));
  }
  return shas;
}

/** Level 'values'. Answers the texts that are to be taken out of the audit trail too (the reasons). */
function removeValues(e: any, gone: string): string[] {
  const texts: string[] = [];
  run('UPDATE fields SET value=NULL, calc_num=NULL, prefill=NULL, stamp_meta=NULL WHERE envelope_id=?', e.id);
  run('UPDATE earlier_signatures SET answers=?, signature_png=NULL, initials_png=NULL WHERE envelope_id=?', '[]', e.id);
  for (const r of all("SELECT id, decline_reason FROM recipients WHERE envelope_id=? AND decline_reason IS NOT NULL AND decline_reason!=''", e.id)) texts.push(r.decline_reason);
  run('UPDATE recipients SET signature_png=NULL, initials_png=NULL, decline_reason=CASE WHEN decline_reason IS NULL OR decline_reason=\'\' THEN decline_reason ELSE ? END WHERE envelope_id=?', gone, e.id);
  const v = get('SELECT void_reason FROM envelopes WHERE id=?', e.id)?.void_reason;
  if (v) (texts.push(v), run('UPDATE envelopes SET void_reason=? WHERE id=?', gone, e.id));
  run('UPDATE comments SET body=? WHERE envelope_id=?', gone, e.id);
  forgetCommentHooks(e.id);
  return texts;
}

/** Level 'personal'. Answers the names, addresses, numbers and browsers to take out of the audit trail. */
function removePersonal(e: any, gone: string): string[] {
  const keep = (v: any) => (v == null || v === '' ? v : gone);
  const found: string[] = [];
  const note = (...v: any[]) => found.push(...v.filter((x) => typeof x === 'string' && x.trim().length >= 2).map((x) => x.trim()));
  const sender = get('SELECT name, email FROM users WHERE id=?', e.sender_id);
  note(sender?.name, sender?.email);
  for (const r of all('SELECT * FROM recipients WHERE envelope_id=?', e.id)) {
    note(r.name, r.email, r.phone, r.ip, r.user_agent, r.sender_name, r.self_name);
    // A private note to one person often greets them by name, so it goes as a whole.
    try {
      const w = JSON.parse(r.witness_chosen || 'null');
      note(w?.name, w?.email);
    } catch {}
    run(`UPDATE recipients SET name=?, email=?, phone=?, ip=?, user_agent=?, sender_name=?, self_name=?, witness_statement=?, note=?, witness_chosen=NULL, device_hash=NULL WHERE id=?`,
      gone, r.email ? gone : r.email, keep(r.phone), keep(r.ip), keep(r.user_agent), keep(r.sender_name), keep(r.self_name), keep(r.witness_statement), keep(r.note), r.id);
  }
  for (const m of all('SELECT id, name, email FROM recipient_members WHERE envelope_id=?', e.id)) (note(m.name, m.email), run('UPDATE recipient_members SET name=?, email=? WHERE id=?', gone, gone, m.id));
  for (const s of all('SELECT id, name, email, ip FROM earlier_signatures WHERE envelope_id=?', e.id)) (note(s.name, s.email, s.ip), run('UPDATE earlier_signatures SET name=?, email=?, ip=? WHERE id=?', gone, gone, keep(s.ip), s.id));
  for (const m of all('SELECT id, name, email FROM comments WHERE envelope_id=?', e.id)) (note(m.name, m.email), run('UPDATE comments SET name=?, email=? WHERE id=?', gone, keep(m.email), m.id));
  run('UPDATE comment_threads SET party_name=CASE WHEN party_name IS NULL THEN NULL ELSE ? END WHERE envelope_id=?', gone, e.id);
  for (const d of all('SELECT id, name, email, ip, user_agent FROM disputes WHERE envelope_id=?', e.id))
    (note(d.name, d.email, d.ip, d.user_agent), run('UPDATE disputes SET name=?, email=?, ip=?, user_agent=?, detail=CASE WHEN detail IS NULL THEN NULL ELSE ? END WHERE id=?', gone, keep(d.email), keep(d.ip), keep(d.user_agent), gone, d.id));
  for (const t of all('SELECT id, to_masked FROM texts WHERE envelope_id=?', e.id)) (note(t.to_masked), run('UPDATE texts SET to_masked=?, body=?, to_phone=NULL WHERE id=?', gone, gone, t.id));
  for (const s of all('SELECT id, dest, ip FROM signer_codes WHERE envelope_id=?', e.id)) (note(s.dest, s.ip), run('UPDATE signer_codes SET dest=?, ip=NULL WHERE id=?', gone, s.id));
  for (const a of all('SELECT DISTINCT ip, user_agent FROM audit WHERE envelope_id=?', e.id)) note(a.ip, a.user_agent);
  const env = get('SELECT form_ip, message FROM envelopes WHERE id=?', e.id);
  note(env?.form_ip);
  run("UPDATE envelopes SET form_ip=NULL, message=CASE WHEN message='' THEN '' ELSE ? END WHERE id=?", gone, e.id);
  run('UPDATE reached SET email=? WHERE envelope_id=?', gone, e.id);
  // Our stored copies of the emails about it go, as when an envelope is deleted. News from the mail provider about
  // them still counts against the account (bounces.ts), and one still waiting for the mail server is left to go out.
  rememberGoneMail(e.id, e.account_id);
  run(`DELETE FROM emails WHERE envelope_id=? AND ${NOT_WAITING}`, e.id);
  run('DELETE FROM webhook_deliveries WHERE envelope_id=?', e.id);
  return found;
}

/** Takes these texts out of a line, longest first, so a name inside an address goes with the address. */
function scrub(s: string, texts: string[], gone: string, personal: boolean): string {
  let out = String(s ?? '');
  for (const t of [...new Set(texts)].sort((a, b) => b.length - a.length)) {
    if (!t) continue;
    const lit = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A name in Latin letters is matched as a whole word, so "Will" does not take a piece out of "willing". Any other
    // script is matched as written: a name of two characters is a whole name there.
    const re = /@/.test(t) ? new RegExp(lit, 'gi') : /^[A-Za-z0-9 .'-]+$/.test(t) ? new RegExp(`(?<![A-Za-z0-9])${lit}(?![A-Za-z0-9])`, 'g') : new RegExp(lit, 'g');
    out = out.replace(re, gone);
  }
  // At the personal level, any other email address or internet address in the line goes too.
  if (personal) out = out.replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[A-Za-z]{2,}/g, gone).replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, gone);
  return out;
}

/**
 * Purges one envelope at a level, for good. Refuses (answers false) when it is not closed, already purged, held or
 * disputed: the caller asked in the moment before, and this checks again inside the same transaction.
 */
export function purgeEnvelope(envelopeId: string, level: PurgeLevel, by: { name: string; why: string }): boolean {
  const t = now();
  const gone = removedOn(day(t));
  const shas = tx(() => {
    const e = get('SELECT * FROM envelopes WHERE id=?', envelopeId);
    if (!e || e.kind !== 'envelope' || e.purged_at || !isClosed(e.status) || isHeld([e.id]).size || disputeOpen(e.id)) return null;
    const personal = level === 'personal';
    const files = removeDocuments(e);
    const texts = level === 'documents' ? [] : removeValues(e, gone);
    if (personal) texts.push(...removePersonal(e, gone));
    if (personal) run('UPDATE envelopes SET subject=? WHERE id=?', scrub(e.subject, texts, gone, false), e.id);
    // The audit trail keeps every line and its chain values. A line whose words change is marked with the time of
    // the purge, so the chain says it can no longer be recomputed instead of calling the record altered.
    if (texts.length || personal)
      for (const a of all('SELECT seq, actor, detail, ip, user_agent FROM audit WHERE envelope_id=?', e.id)) {
        const detail = scrub(a.detail, texts, gone, personal);
        const actor = personal && a.actor !== 'System' && scrub(a.actor, texts, gone, true) !== a.actor ? gone : a.actor;
        const ip = personal && a.ip ? gone : a.ip;
        if (detail === a.detail && actor === a.actor && ip === a.ip && !(personal && a.user_agent)) continue;
        run('UPDATE audit SET detail=?, actor=?, ip=?, user_agent=?, redacted_at=? WHERE seq=?', detail, actor, ip, personal && a.user_agent ? gone : a.user_agent, t, a.seq);
      }
    run('UPDATE envelopes SET purged_at=?, purged_level=? WHERE id=?', t, level, e.id);
    run('DELETE FROM retention_queue WHERE envelope_id=?', e.id);
    const sha = get('SELECT purged_sha256 s FROM envelopes WHERE id=?', e.id)?.s || null;
    // The line that says what happened is written after the others changed, as an ordinary line of the chain.
    audit(e.id, SYSTEM, 'Purged', `${by.why} Removed: ${LEVEL_NAME[level].toLowerCase()}. ${KEPT_AT[level]}${sha ? ` The fingerprint of the signed PDF stays: ${sha}.` : ''}`);
    logLine(e.account_id, e.id, 'purged', { level, sha256: sha, who: personal ? by.name.replace(/<[^>]*>/g, '').trim() : by.name, detail: by.why });
    return { files, account: e.account_id };
  });
  if (!shas) return false;
  dropBlobs(shas.files);
  secLine('envelope.retention_purged', shas.account, { system: true, about: ['envelope', envelopeId], details: { level } });
  return true;
}

// ---- The timer --------------------------------------------------------------------------------------------------------

/**
 * Run from the timer (cron.ts): emails what reaches its date within 14 days, once, and purges what is due. A purge
 * waits for its email by 14 days at least, whatever happened to the rule in between.
 */
export async function retentionTick(): Promise<{ noticed: number; purged: number }> {
  const rows = all(`SELECT e.id, e.account_id, e.sender_id, e.subject, e.status, e.hidden_at, e.template_id, ${CLOSED_AT} closed_at, a.retention_days acct_days,
      q.envelope_id q, q.noticed_at, q.goes_at, q.level q_level, q.kept_until, q.asked_at, q.asked_level, q.asked_by
    FROM envelopes e JOIN accounts a ON a.id=e.account_id LEFT JOIN retention_queue q ON q.envelope_id=e.id
    WHERE e.kind='envelope' AND e.purged_at IS NULL AND e.status IN ('completed','voided','declined','expired') AND (a.retention_days IS NOT NULL OR q.asked_at IS NOT NULL OR q.noticed_at IS NOT NULL)`);
  const t = Date.now();
  const fresh = new Map<string, any[]>();
  const due: { id: string; level: PurgeLevel; why: string; by: string }[] = [];
  for (const r of rows) {
    const blocked = isHeld([r.id]).size > 0 || disputeOpen(r.id);
    if (blocked) {
      if (r.noticed_at || r.asked_at) tx(() => cancelQueued(r.id, isHeld([r.id]).size ? 'It is on legal hold.' : 'A person named on it disputes it.'));
      continue;
    }
    if (r.asked_at) {
      // At the personal level the name of who asked stays out of the record of the envelope too: the account's own
      // retention record keeps it.
      if (r.goes_at && Date.parse(r.goes_at) <= t) due.push({ id: r.id, level: r.asked_level, why: `${r.asked_level === 'personal' ? 'The sender or an admin of the account' : r.asked_by} asked for this purge on ${day(r.asked_at)}, and nobody called it off in the 14 days after.`, by: r.asked_by });
      continue;
    }
    const period = periodFor(r);
    const policy = policyOf(r.account_id);
    let ruleDue = period ? Date.parse(dueAt(r.closed_at, period.days)) : null;
    if (ruleDue !== null && r.kept_until && Date.parse(r.kept_until) > ruleDue) ruleDue = Date.parse(r.kept_until);
    if (ruleDue === null || ruleDue - NOTICE_MS > t) {
      // Off, kept, or a longer period now: what was announced does not happen.
      if (r.noticed_at) tx(() => cancelQueued(r.id, ruleDue === null ? 'The account\'s retention rule was switched off.' : 'The period that applies to it is longer now.'));
      continue;
    }
    if (!r.noticed_at) {
      const goes = new Date(Math.max(ruleDue, t + NOTICE_MS)).toISOString();
      run('INSERT OR IGNORE INTO retention_queue (envelope_id, account_id) VALUES (?,?)', r.id, r.account_id);
      if (!run('UPDATE retention_queue SET noticed_at=?, goes_at=?, level=? WHERE envelope_id=? AND noticed_at IS NULL', new Date(t).toISOString(), goes, policy.level, r.id).changes) continue;
      logLine(r.account_id, r.id, 'noticed', { level: policy.level, detail: `Emailed to the sender and the admins. Goes on ${day(goes)}.` });
      fresh.set(r.account_id, [...(fresh.get(r.account_id) || []), { ...r, goes_at: goes, level: policy.level }]);
      continue;
    }
    // A purge never removes more than its email said: a level raised since applies from the next email on.
    const goesAt = Math.max(ruleDue, Date.parse(r.noticed_at) + NOTICE_MS);
    if (goesAt <= t) due.push({ id: r.id, level: lower(isPurgeLevel(r.q_level) ? r.q_level : 'documents', policy.level), why: `The account's retention rule: ${ruleText(policy, period!.days)}${period!.from === 'template' ? ` (the period of the template "${period!.template}")` : ''}. The sender and the admins were emailed on ${day(r.noticed_at)}.`, by: 'The retention rule' });
    else if (r.goes_at !== new Date(goesAt).toISOString()) run('UPDATE retention_queue SET goes_at=? WHERE envelope_id=?', new Date(goesAt).toISOString(), r.id);
  }
  let noticed = 0;
  for (const [accountId, list] of fresh) (await notify(accountId, list), (noticed += list.length));
  let purged = 0;
  for (const d of due) if (purgeEnvelope(d.id, d.level, { name: d.by, why: d.why })) purged++;
  dropOldRetentionLog();
  return { noticed, purged };
}

// ---- Closing an account -----------------------------------------------------------------------------------------------

/** The holds that keep a login from being closed: those in an account it owns alone (which would be deleted with it). */
export function holdsBlockingClose(userId: string): any[] {
  const owned = all("SELECT a.id FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role='owner' AND (SELECT COUNT(*) FROM memberships x WHERE x.account_id=a.id)=1", userId).map((a) => a.id);
  return activeHolds(owned);
}

/** Refuses to close or delete a login while an account that goes with it holds something, after recording the attempt. */
export function assertMayClose(userId: string, who: string) {
  const holds = holdsBlockingClose(userId);
  if (!holds.length) return;
  // Once a day for each hold, so the timer that finds a closing login every few minutes does not fill the record.
  for (const h of holds) {
    const detail = `Refused to close the account: ${holdName(h)} is on.`;
    if (!get('SELECT 1 x FROM retention_log WHERE account_id=? AND what=? AND detail=? AND at > ?', h.account_id, 'refused', detail, new Date(Date.now() - DAY).toISOString()))
      logLine(h.account_id, h.envelope_id, 'refused', { who, detail });
  }
  throw bad(`Your account cannot be closed while something in it is on legal hold: ${holds.map(holdName).join('; ')}. ${HOLD_TRUTH} An admin lifts a hold under Settings, Your data. Nothing was changed, and this attempt was recorded.`, 409, { code: 'legal_hold', holds: holds.map((h) => h.id) });
}
