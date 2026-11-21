// Running the product yourself: the numbers the health check holds the server to, and the security contact that
// /.well-known/security.txt and /security/disclosure are made from. Shared by those pages and by the server
// (src/server/selfhost.ts), so the page and the check cannot disagree.
//
// securityContacts() and replyDays() read the environment: server code and server components only.

type Env = Record<string, string | undefined>;

/** GET /api/health fails when less than this is free on the disk of DATA_DIR: 1 GB (10^9 bytes). */
export const HEALTH_MIN_FREE_BYTES = 1_000_000_000;
/** It fails when the internal timer (src/server/cron.ts) has not finished a run for this long. It runs every 15 minutes. */
export const TIMER_STALE_MINUTES = 30;
/** How long one answer of the health check is reused, so calling it in a loop does not write to the disk in a loop. */
export const HEALTH_CACHE_MS = 10_000;

/** The names of the checks, in the order the answer gives them, with what each means when it fails. */
export const HEALTH_CHECKS = {
  database: 'The database cannot be opened or read.',
  data_folder: 'DATA_DIR cannot be written to.',
  disk_space: 'Less than 1 GB is free on the disk that holds DATA_DIR.',
  file_store: 'Storing files is stopped (the server log says why, under [files]).',
  timer: `The internal timer has not finished a run in the last ${TIMER_STALE_MINUTES} minutes, or its last run failed (the server log says why, under [cron]).`,
} as const;
export type HealthCheck = keyof typeof HEALTH_CHECKS;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * SECURITY_CONTACT as RFC 9116 wants it: each entry a mailto: address or an https: address. An email address on its own
 * becomes mailto:. Several entries are separated by commas. Anything else is left out (securityContactWarning says so).
 */
export function securityContacts(env: Env = process.env): string[] {
  const out: string[] = [];
  for (const raw of String(env.SECURITY_CONTACT || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/[\s<>"]/.test(raw)) continue;
    if (EMAIL.test(raw) && raw.length < 255) out.push(`mailto:${raw}`);
    else if (/^mailto:/i.test(raw) && EMAIL.test(raw.slice(7))) out.push(`mailto:${raw.slice(7)}`);
    else if (/^https:\/\/[^/\s]+/i.test(raw)) {
      try {
        out.push(new URL(raw).toString());
      } catch {}
    }
  }
  return [...new Set(out)];
}

/** How the page shows a contact: an address without "mailto:". */
export const contactWords = (c: string) => (c.startsWith('mailto:') ? c.slice(7) : c);

/** SECURITY_REPLY_DAYS: the days within which the operator says a report is answered, 1 to 90, or null when not said. */
export function replyDays(env: Env = process.env): number | null {
  const raw = String(env.SECURITY_REPLY_DAYS || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 90 ? n : null;
}

/** Said once when the server starts with a SECURITY_CONTACT that holds nothing usable, or a reply time that is not a number of days. */
export function securityContactWarning(env: Env = process.env): string | null {
  const lines: string[] = [];
  if (String(env.SECURITY_CONTACT || '').trim() && !securityContacts(env).length)
    lines.push('[config] SECURITY_CONTACT holds no email address and no https address, so /.well-known/security.txt is not served. Example: SECURITY_CONTACT=security@example.org');
  if (String(env.SECURITY_REPLY_DAYS || '').trim() && replyDays(env) === null)
    lines.push('[config] SECURITY_REPLY_DAYS must be a whole number of days from 1 to 90. It is not, so /security/disclosure promises no time.');
  return lines.length ? `\n${lines.join('\n')}\n` : null;
}

/** Expires in security.txt: 360 days from `now`, at midnight UTC (RFC 9116 asks for less than a year). */
export const SECURITY_TXT_DAYS = 360;

/**
 * The text of /.well-known/security.txt (RFC 9116), or null when no contact is set: then there is no file at all,
 * because an empty one would say that nobody is there. `base` is the public address of the server (APP_URL).
 * Expires is counted from the moment the file is asked for, because the contact is read from the running settings
 * each time; whoever changes SECURITY_CONTACT changes the file at once.
 */
export function securityTxt(base: string, env: Env = process.env, now = Date.now()): string | null {
  const contacts = securityContacts(env);
  if (!contacts.length) return null;
  const exp = new Date(now + SECURITY_TXT_DAYS * 864e5);
  exp.setUTCHours(0, 0, 0, 0);
  const root = base.replace(/\/+$/, '');
  return [
    '# How to report a security weakness in this server. Read the page under Policy first.',
    ...contacts.map((c) => `Contact: ${c}`),
    `Expires: ${exp.toISOString().replace('.000Z', 'Z')}`,
    `Canonical: ${root}/.well-known/security.txt`,
    `Policy: ${root}/security/disclosure`,
    '',
  ].join('\n');
}
