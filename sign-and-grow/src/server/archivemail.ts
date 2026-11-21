// Archive copies of emails: a council's records officer or a freedom-of-information team gets a copy of every email
// the account sends about its documents, and nobody can sign from the archive.
//
// How it goes, in mail.ts:
//   1. recordMail writes an email about an envelope (Mail.envelopeId). If its account has a confirmed archive address,
//      archiveDraft() makes the copy right then, while the whole email is known, with every signing link, security
//      code and one-time code taken out, and it is kept on that row (emails.archive_draft).
//   2. When that email has left (the mail server took it, or on a machine without one it went to the outbox),
//      takeArchiveCopies() turns the draft into one email for each confirmed address, each its own email to that
//      address (never a Bcc), with the same attachments. They are stored and tried again like every other email.
//   3. archiveCheck() is asked before a copy is handed over, by the first try and by the timer: a copy waits while
//      sending is paused on the account, and goes nowhere once its address was removed or paused.
// A copy is stored with envelope_id empty and its envelope in archive_envelope, so it is never one of the envelope's
// own emails: not on the envelope page, not in its record, not in the evidence pack, not counted towards any limit,
// and news about it from the mail provider (routes-bounces.ts) never marks a recipient or a login.
//
// This file imports nothing from mail.ts but its type, so mail.ts can call it. The routes, the email that asks an
// address to confirm and the news from the mail provider are in routes-archive.ts.
import { all, get, run } from './db.ts';
import { baseUrl, fmtCode, now } from './util.ts';
import type { Mail } from './mail.ts';
import { ARCHIVE_LINK_REMOVED, ARCHIVE_CODE_REMOVED, ARCHIVE_SUBJECT, ARCHIVE_WHY, archiveFirstLine } from '../lib/archivemail.ts';

// ---- Taking out what opens or signs a document ----------------------------------------------------------------

// The pages of ours that open nothing: a link to one of them, with nothing after its path, stays in a copy.
const PUBLIC_PATHS = new Set(['', '/', '/help', '/check', '/verify', '/security', '/security/processing']);
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
// A signing link without its host, as some lines may write it.
const SIGN_PATH = /\/sign\/[A-Za-z0-9_-]{8,}\S*/g;
// "123456 is your code" and its kind, whatever email it is in.
const CODE_SAID = /\b\d{4,10}(?=\s+is\s+your\s+code\b)/gi;
// In an email that carries a one-time code (one with an end time, Mail.expiresAt): every number of 5 to 10 digits
// that stands alone. Not part of a date or a time, and never a year.
const LONE_NUMBER = /(?<![\d:./-])\d{5,10}(?![\d:./-])/g;

/** Every secret that opens or signs something of this envelope: the links and security codes of the people on it and
 *  of the members of its groups, current and replaced. Longest first, so no secret is cut by a shorter one. */
function secretsOf(envelopeId: string): { tokens: string[]; codes: string[] } {
  const rows = all(`SELECT token t, check_code c FROM recipients WHERE envelope_id=?
    UNION ALL SELECT token, check_code FROM recipient_members WHERE envelope_id=?
    UNION ALL SELECT token, check_code FROM retired_tokens WHERE envelope_id=? OR recipient_id IN (SELECT id FROM recipients WHERE envelope_id=?)`, envelopeId, envelopeId, envelopeId, envelopeId);
  const tokens = [...new Set(rows.map((r) => String(r.t || '')).filter((t) => t.length >= 8))].sort((a, b) => b.length - a.length);
  const codes = [...new Set(rows.map((r) => String(r.c || '')).filter((c) => c.length >= 6))].sort((a, b) => b.length - a.length);
  return { tokens, codes };
}

type Secrets = { tokens: string[]; codes: string[]; codeMail: boolean };

/** A link that stays in a copy: to another site, or to one of our pages that opens nothing, with nothing after it. */
function keeps(link: string): boolean {
  let u: URL, ours: URL;
  try {
    u = new URL(link);
    ours = new URL(baseUrl());
  } catch {
    return false;
  }
  if (u.host.toLowerCase() !== ours.host.toLowerCase()) return !/\/sign\//.test(u.pathname);
  return PUBLIC_PATHS.has(u.pathname.replace(/\/$/, '')) && !u.search && !u.username && !u.password;
}

/** One piece of text with every link of ours, signing link, security code and one-time code taken out. */
export function scrub(text: any, s: Secrets): string {
  let out = String(text ?? '');
  // Links first, so a secret inside one goes with the whole link. Full stops and brackets after a link are kept.
  out = out.replace(URL_RE, (m) => {
    const link = m.replace(/[.,;:!?)\]]+$/, '');
    return keeps(link) ? m : ARCHIVE_LINK_REMOVED + m.slice(link.length);
  });
  out = out.replace(SIGN_PATH, ARCHIVE_LINK_REMOVED);
  for (const t of s.tokens) out = out.split(t).join(ARCHIVE_LINK_REMOVED);
  for (const c of s.codes) out = out.split(fmtCode(c)).join(ARCHIVE_CODE_REMOVED).split(c).join(ARCHIVE_CODE_REMOVED);
  out = out.replace(CODE_SAID, ARCHIVE_CODE_REMOVED);
  if (s.codeMail) out = out.replace(LONE_NUMBER, ARCHIVE_CODE_REMOVED);
  return out;
}

/** The copy of an email, before it is addressed: every text scrubbed, every button and listed link said in words. */
export function archiveMail(m: Mail, s: Secrets): Mail {
  const x = (t: any) => scrub(t, s);
  return {
    to: '', subject: `${ARCHIVE_SUBJECT}${x(m.subject)}`, heading: x(m.heading),
    lines: [
      ...m.lines.map(x),
      ...(m.links || []).map((l) => `${x(l.label)}${l.note ? ` (${x(l.note)})` : ''}: ${ARCHIVE_LINK_REMOVED}`),
      ...(m.cta ? [`${x(m.cta.label)}: ${ARCHIVE_LINK_REMOVED}`] : []),
      ...(m.code ? [`Security code: ${ARCHIVE_CODE_REMOVED}`] : []),
    ],
    ...(m.footnote ? { footnote: x(m.footnote) } : {}),
    ...(m.brand ? { brand: m.brand } : {}),
    ...(m.fromName ? { fromName: m.fromName } : {}),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
  };
}

// ---- 1. When an email about a document is written ----------------------------------------------------------------

/** The account an email about an envelope belongs to, when it has a confirmed archive address. */
const archivingAccount = (envelopeId: string): string | null => {
  const e = get('SELECT account_id FROM envelopes WHERE id=?', envelopeId);
  return e && get('SELECT 1 x FROM archive_addresses WHERE account_id=? AND confirmed_at IS NOT NULL LIMIT 1', e.account_id) ? e.account_id : null;
};

/** The copy to keep on the row of an email about an envelope, as JSON, or null when its account archives nothing. */
export function archiveDraft(m: Mail): string | null {
  if (!m.envelopeId) return null;
  const accountId = archivingAccount(m.envelopeId);
  if (!accountId) return null;
  const mail = archiveMail(m, { ...secretsOf(m.envelopeId), codeMail: !!m.expiresAt });
  return JSON.stringify({ accountId, envelopeId: m.envelopeId, mail });
}

// ---- 2. When it has left -----------------------------------------------------------------------------------------

export type ArchiveCopy = { mail: Mail; addressId: string; envelopeId: string; attachments: any[] };

/**
 * The copies of an email that has just left, one for each confirmed address of its account, and none twice: the
 * draft is taken off the row in the same step that reads it. A paused address gets none and counts it as missed.
 */
export function takeArchiveCopies(id: number | bigint): ArchiveCopy[] {
  const row = get('SELECT to_email, archive_draft, payload FROM emails WHERE id=?', id);
  if (!row?.archive_draft || !run('UPDATE emails SET archive_draft=NULL WHERE id=? AND archive_draft IS NOT NULL', id).changes) return [];
  let d: any, attachments: any[] = [];
  try {
    d = JSON.parse(row.archive_draft);
    attachments = JSON.parse(row.payload || '{}').attachments || [];
  } catch {
    return [];
  }
  const at = now();
  const out: ArchiveCopy[] = [];
  for (const a of all('SELECT * FROM archive_addresses WHERE account_id=? AND confirmed_at IS NOT NULL ORDER BY added_at', d.accountId)) {
    if (a.paused_at) {
      run('UPDATE archive_addresses SET missed=missed+1 WHERE id=?', a.id);
      continue;
    }
    // The first line, in the html and in the text, says what this is; the email's own heading follows it.
    out.push({ mail: { ...d.mail, to: a.email, heading: archiveFirstLine(row.to_email, at), lines: [ARCHIVE_WHY, d.mail.heading, ...(d.mail.lines || [])].filter(Boolean) }, addressId: a.id, envelopeId: d.envelopeId, attachments });
  }
  return out;
}

/** Marks a row written by recordMail as the copy for one address, with the attachments of the email it copies. */
export function markArchiveRow(mid: number | bigint, c: ArchiveCopy) {
  let payload: any = {};
  try {
    payload = JSON.parse(get('SELECT payload FROM emails WHERE id=?', mid)?.payload || '{}');
  } catch {}
  payload.attachments = c.attachments;
  run('UPDATE emails SET archive_to=?, archive_envelope=?, payload=? WHERE id=?', c.addressId, c.envelopeId, JSON.stringify(payload), mid);
}

// ---- 3. Before a copy is handed over -------------------------------------------------------------------------------

/**
 * For a row with archive_to (a copy, or the email that asks an address to confirm): 'wait' while sending is paused on
 * the account, a reason when it must not go any more, or null when it may go now. Instead of tooLate in mail.ts: a
 * copy holds no link that could run out, and it is a record, so it goes however late a pause makes it.
 */
export function archiveCheck(row: any): 'wait' | { why: string; quiet: boolean } | null {
  const a = get('SELECT a.*, acc.suspended_at FROM archive_addresses a JOIN accounts acc ON acc.id=a.account_id WHERE a.id=?', row.archive_to);
  if (!a) return { why: 'Not sent: the archive address was removed by then.', quiet: true };
  if (!row.payload) return { why: 'Not sent again: there was nothing stored to send it with.', quiet: true };
  if (!row.archive_envelope) {
    // The email that asks an address to confirm: only while its link still works.
    if (a.confirmed_at && !a.paused_at) return { why: 'Not sent again: the address was confirmed by then.', quiet: true };
    if (!a.confirm_until || a.confirm_until <= now() || (row.expires_at && row.expires_at <= now())) return { why: 'Not sent again: the link in it had run out by then.', quiet: true };
    return a.suspended_at ? 'wait' : null;
  }
  if (!a.confirmed_at) return { why: 'Not sent: the archive address was not confirmed.', quiet: true };
  if (a.paused_at) {
    run('UPDATE archive_addresses SET missed=missed+1 WHERE id=?', a.id);
    return { why: 'Not sent: copies to this archive address were paused by then.', quiet: true };
  }
  return a.suspended_at ? 'wait' : null;
}

/** SQL on emails: not an archive copy, or confirmation email, that waits for its account's pause to be lifted. */
export const ARCHIVE_NOT_WAITING = 'NOT (archive_to IS NOT NULL AND archive_to IN (SELECT a.id FROM archive_addresses a JOIN accounts c ON c.id=a.account_id WHERE c.suspended_at IS NOT NULL))';

/** A copy handed over: counted on its address, for Settings. */
export function noteArchiveSent(row: any) {
  if (row?.archive_to && row.archive_envelope) run('UPDATE archive_addresses SET copies=copies+1, last_copy_at=? WHERE id=?', now(), row.archive_to);
}

// ---- Deleting --------------------------------------------------------------------------------------------------

/** Our stored copies about an envelope that was deleted or purged. One still waiting to be sent goes out first, like
 *  every email about it (NOT_WAITING in routes-trust.ts and records.ts). Asked by the timer as well. */
export function forgetArchiveCopies(envelopeId?: string): number {
  const waiting = "status='queued' OR (status='failed' AND next_try_at IS NOT NULL)";
  if (envelopeId) return Number(run(`DELETE FROM emails WHERE archive_envelope=? AND NOT (${waiting})`, envelopeId).changes);
  return Number(run(`DELETE FROM emails WHERE archive_envelope IS NOT NULL AND NOT (${waiting}) AND (archive_envelope NOT IN (SELECT id FROM envelopes) OR archive_envelope IN (SELECT id FROM envelopes WHERE purged_at IS NOT NULL))`).changes);
}
